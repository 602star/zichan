# Linux 生产镜像部署与恢复

本流程用于提交 SHA 候选镜像。候选镜像按源码提交标识，版本标签本身不代表生产部署通过验收；生产镜像须按下文核对 digest、签名、备份与恢复结果后再部署。后续补丁更新以[生产签名包自更新](production-self-update.md)为标准，基础镜像仍由本流程交付与灾难恢复。

## 主机准备

宿主机安装 Docker Compose、Cosign、Restic，并取得私有 GHCR 镜像的只读访问凭据；在宿主机执行 `docker login ghcr.io`。生产 Compose 只含一个业务容器，HTTPS 反向代理在宿主机运行，转发到 `127.0.0.1:8787`，保留外部 Host，并把 `X-Forwarded-Proto` **覆盖**为单一值 `https`。服务只信任实际代理地址 `127.0.0.1`。没有测试域名时只能验收本机业务与备份恢复，不能算真实 HTTPS 入口通过。

预建并保护目录，容器 UID 1000 必须拥有读写权限；运行目录存放已安装的服务程序版本：

```bash
sudo install -d -m 700 -o 1000 -g 1000 /srv/zichan/state /srv/zichan/backups /srv/zichan/runtime
```

从开发命名卷迁移时，先停服，执行完整备份及 `verify-backup`，再将备份恢复到**空**的 `/srv/zichan/state`；不要直接切换到空挂载。部署脚本默认拒绝空状态目录；只有确认是在创建全新服务器时，才对首次部署单次设置 `ZICHAN_ALLOW_FIRST_BOOT=yes`。`/srv/zichan/state/server/server.secret` 是首次启动生成的服务器密钥，必须和数据库、`server-id`、节点签名密钥一起持久保留。部署脚本在后续启动时检查服务器 ID 和密钥哈希未变。生产配置不使用临时 `SYNC_SECRET`。

## 按 digest 部署

手工触发 GitHub Actions 的 `Sync server candidate image`，从作业摘要或 `sync-server-image-digest` 构件取得完整镜像引用。流水线只生成 `sha-<commit>` 候选标签，部署引用必须是 `@sha256:<digest>`。镜像工作流从仓库 Secret 注入私有 Release 只读 Token，并固定更新公钥；部署时不再复制这两份文件到宿主机。主机上执行：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
export ZICHAN_TZ=Asia/Shanghai
bash scripts/production/deploy.sh
```

仅创建全新服务器时，将最后一行改为 `ZICHAN_ALLOW_FIRST_BOOT=yes bash scripts/production/deploy.sh`；迁移和回退不得设置此开关。已有节点首次接入自更新启动器时，须先停服完成并校验完整备份，另设置 `ZICHAN_BASELINE_BACKUP=/srv/zichan/backups/<记录>`；部署脚本会复验备份并比对服务器身份。

脚本校验 Cosign 的 GitHub Actions OIDC 签名（只接受此仓库 `main` 的镜像流水线）、仅在本机缺少该 digest 时拉取镜像，并检查 `linux/amd64`、Compose 配置、挂载目录、更新凭据、健康状态与持久身份。运行中的生产容器需要重建时，Compose 操作会通过共享维护锁执行；发现已有锁则拒绝部署。生产 Compose 在 [docker-compose.prod.yml](../../apps/sync-server/docker-compose.prod.yml)。Compose 不设置 `pull_policy: always`；Cosign 验签仍需访问私有镜像仓库，当前不能保证完全离线恢复。持久运行目录有已安装版本时，换镜像 digest **不会**回滚应用程序；同 schema 的程序回滚必须通过管理后台已安装版本执行。跨 schema 更新须先实现并验收独立迁移与恢复流程。

最终生产镜像带固定自更新启动器、初始版本的两个服务端打包入口与 Web 构建目录；另保留 `/app/dist` 下的两个维护入口供宿主机备份恢复调用。不包含 TypeScript 编译产生的 `.js`、声明文件或 source map。容器 CI 检查这些文件，并实测启动、健康端点及备份维护入口。打包后的服务端程序仍包含可分析的运行逻辑；镜像精简不能代替主机和容器访问控制。

## 加密备份运送

业务容器创建并验证 `/backups/<记录>`。主机将 `RESTIC_REPOSITORY` 指向独立机器的 SFTP 仓库或有版本保留的异地目标，`RESTIC_PASSWORD_FILE` 指向权限为 `0600`、位于业务状态、备份和 Git 目录之外的解密凭据。恢复所需凭据须在源主机之外另存一份。凭据不进 Git、镜像、业务容器环境变量或日志。仓库首次由运维执行 `restic init`。之后每份已完成备份执行：

```bash
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/ship-backup.sh /srv/zichan/backups/<记录>
```

运送脚本先通过业务镜像的维护入口校验数据库、附件和密钥清单，上传后执行 `restic check --read-data`。生产应使用独立权限的异机账户。`scripts/production/systemd/` 提供每日北京时间 05:00 的主机运送定时器，调用 `ship-latest.sh`，只有验证成功才记录已运送的备份路径。安装时将脚本固定到 `/opt/zichan`，配置 `/etc/zichan/backup-transport.env` 后启用 timer；运送窗口应晚于实际自动备份窗口。自动备份保持关闭，直到异机恢复演练及备份维护窗口通过。`TZ=Asia/Shanghai` 必须同时用于容器与维护窗口验收，检查管理页及 `backup-executor.json` 的下次执行时间。

## 整机恢复

原节点必须停止或隔离，确保同一服务器身份不会同时在线。在另一台空白 Linux 主机准备目录、Docker、Cosign、Restic、GHCR 只读凭据、匹配的已签名镜像 digest 和解密凭据。用 `restic snapshots` 找到快照 ID 和备份的原始绝对路径：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/restore-host.sh <快照ID> /srv/zichan/backups/<记录>
export ZICHAN_BASELINE_BACKUP=/srv/zichan/backups/<记录>
bash scripts/production/deploy.sh
```

恢复脚本拒绝非空状态目录，下载到临时隔离目录，运行完整 `verify-backup`，将已验证记录留在本机备份目录，再离线恢复并核对 `server-id`。首次部署用这个记录作 `ZICHAN_BASELINE_BACKUP`。启动后还需实际检查账号、附件、代表性同步读取和宿主机 HTTPS 路由。恢复会撤销旧会话，客户端需重新登录。测试机上的另一目录只能演练操作路径，不能证明机器损坏后的异机恢复。

## 共享维护锁

自动备份认领窗口前会在 `/srv/zichan/state/server/maintenance.lock` 原子建目录，直到备份和服务恢复完毕才释放。主机侧 `with-maintenance-lock.sh COMMAND` 使用同一锁，只有备份执行器处于 `disabled` 或 `waiting` 且心跳在 30 秒内才运行命令；未来升级执行器须复用这个入口。进程异常退出时锁会保留以安全失败；只有确认备份进程已经退出、数据已校验后，运维才可人工清理锁。当前尚未实现完整跨版本迁移和自动回退执行器。

## 上线前仍需验收

2026-10-28 至 29 的候选镜像曾验证签名与 digest 拉取、隔离目录恢复、备份运送、维护锁、时区解析、健康检查和无 schema 迁移时的旧镜像回退。那次 Restic 仓库仍在同一测试机，不能证明异机灾备。正式上线前需用真实异机目标完成空白主机恢复，独立保管凭据并测量 RPO/RTO；检查正式域名的 HTTPS 反向代理，并观察一次真实自动备份窗口和次日定时运送。跨版本迁移与写入后的回滚边界按 [1.0 升级方案](production-upgrade-1.0.md) 另行验收。
