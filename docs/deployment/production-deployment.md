# Linux 生产镜像部署与恢复

本流程用于 Linux Docker 首次安装、生产部署和恢复。首次安装使用仓库根目录的 [compose.prod.yml](../../compose.prod.yml) 和 [install-docker.sh](../../scripts/production/install-docker.sh)；开发构建使用 `apps/sync-server/docker-compose.yml`。候选镜像按源码提交标识，版本标签本身不代表生产部署通过验收；生产镜像须按下文核对 digest、签名、备份与恢复结果后再部署。后续补丁更新以[生产签名包自更新](production-self-update.md)为标准，基础镜像仍由本流程交付与灾难恢复。

## 全新 Linux 主机一条命令安装

先安装 Docker Engine、Docker Compose v2、Cosign、Git 和 curl。若 GHCR 镜像需要认证，先在 root 的 Docker 凭据中用具有 `read:packages` 权限的 Token 登录：`sudo docker login ghcr.io -u 602star`，提示输入密码时粘贴 Token。确认主机端口 `8787` 只允许可信内网访问。随后运行：

```bash
sudo git clone --depth 1 https://github.com/602star/zichan.git /opt/zichan/source && sudo bash /opt/zichan/source/scripts/production/install-docker.sh v0.5.5
```

脚本读取该 Release 的 `image-digest.txt`，验证格式和 Cosign 签名，创建 UID 1000 持有的 `/opt/zichan/state`、`/opt/zichan/backups`、`/opt/zichan/runtime`，然后调用生产部署脚本及 Compose，等待健康检查通过。打开 `http://<服务器内网IP>:8787/admin/` 首次设置管理员，用户端为 `http://<服务器内网IP>:8787/`。仅支持 `linux/amd64`。它会拒绝已有数据、运行目录或生产容器；现有 1Panel 部署、升级或迁移须沿用原有挂载和身份，按下文操作。v0.5.5 镜像包含记账入口统一到根路径的修复。

## 开发与生产部署对照

| 项目 | 开发 Compose `apps/sync-server/docker-compose.yml` | 生产 Compose `compose.prod.yml` |
| --- | --- | --- |
| 镜像 | 在部署主机从当前源码 `build` | 使用 GHCR 已签名、固定 SHA-256 digest 的镜像；部署脚本验签和检查架构 |
| 持久数据 | Docker 命名卷 `zichan-data`、`zichan-backups` | 宿主机目录 `/opt/zichan/state`、`/opt/zichan/backups`、`/opt/zichan/runtime` 绑定挂载 |
| 程序更新目录 | 没有持久挂载 `/app/runtime` | 持久挂载 `/app/runtime`，保留已安装的签名更新包 |
| 网络 | Linux 宿主机网络，服务监听 `127.0.0.1:8787` | Linux 宿主机网络，默认监听 `0.0.0.0:8787`，须用防火墙限制可信内网 |
| HTTP 与反向代理 | `ALLOW_INSECURE_HTTP=0`，信任本机代理 `127.0.0.1` | 默认 `ALLOW_INSECURE_HTTP=1`，信任本机代理 `127.0.0.1`；公网 HTTPS 模式设置 `ZICHAN_HOST=127.0.0.1` 和 `ZICHAN_ALLOW_INSECURE_HTTP=0` |
| 启动方式 | `docker compose up -d --build`，适合开发及隔离测试 | `scripts/production/deploy.sh`，检查目录权限、服务器身份、备份基线及健康状态 |

两套 Compose 都覆盖了镜像的 `TRUSTED_PROXIES=private` 默认值。1Panel 直接创建的桥接网络容器不使用这两套 Compose；它的镜像、端口映射、环境变量及宿主机挂载目录由 1Panel 中的配置决定。

## 主机准备

宿主机安装 Docker Compose 和 Cosign，并取得私有 GHCR 镜像的只读访问凭据；在宿主机执行 `docker login ghcr.io`。Restic 用于后续异机备份和恢复，不是首次启动容器的前提。生产 Compose 只含一个业务容器，默认通过宿主机网络监听 `0.0.0.0:8787`，并允许 HTTP 注册、登录、同步及管理。这个默认入口面向受防火墙保护的可信私有局域网：只允许可信内网访问 8787，不要把它开放到公网。已发布的镜像不会因本仓库 Compose 变化而改变；通过 1Panel 直接创建旧镜像容器时，需要在容器环境变量中设置 `HOST=0.0.0.0` 和 `ALLOW_INSECURE_HTTP=1` 并重建。

公网部署应先设置 `ZICHAN_HOST=127.0.0.1` 和 `ZICHAN_ALLOW_INSECURE_HTTP=0`，由宿主机 HTTPS 反向代理转发到 `127.0.0.1:8787`。代理保留外部 Host，并把 `X-Forwarded-Proto` 覆盖为单一值 `https`；服务只信任实际代理地址 `127.0.0.1`。没有测试域名时只能验收本机业务与备份恢复，不能算真实 HTTPS 入口通过。

通过 1Panel 直接创建容器并用 `https://域名/admin/` 打开管理页时，v0.5.6 镜像默认使用 `TRUSTED_PROXIES=private`，信任直接连接容器的私有网段代理，包括常见 Docker 网桥地址；不必逐个填写 `172.x` 地址。1Panel 应保留原始 `Host` 和 `X-Forwarded-For`，并让 `X-Forwarded-Proto` 保持单一有效值。若 HTTPS 在 1Panel 前一跳终止，1Panel 的 `$scheme` 可能是 `http`：v0.5.5 会把浏览器的 HTTPS `Origin` 误判为不同源并返回 403；v0.5.6 在 `ALLOW_INSECURE_HTTP=1` 时改用浏览器 `Origin` 与保留的 `Host` 核对同源，默认 `private` 即可使用。若旧容器显式覆盖了 `TRUSTED_PROXIES=127.0.0.1`，升级镜像不会改动这个值，需在 1Panel 删除覆盖值或设为 `private` 后重建；否则日志与限流可能只看到网桥 IP。`ALLOW_INSECURE_HTTP=0` 的严格模式仍要求可信代理提供 `X-Forwarded-Proto: https`。生产 Compose 使用宿主机网络，仍默认仅信任 `127.0.0.1`，可通过 `ZICHAN_TRUSTED_PROXIES` 覆盖。

1Panel 的反向代理目标若是 `http://127.0.0.1:宿主机映射端口`，而业务容器实际监听 `8787`，则中间经过 Docker 端口映射；业务容器看到的代理对端通常是网桥网关，而不是 `127.0.0.1`。**v0.5.3 镜像**没有上述默认值，需将实际网桥对端地址设为 `TRUSTED_PROXIES`，或升级镜像。v0.5.4 在 `ALLOW_INSECURE_HTTP=1` 时还可用浏览器的 `Origin` 与代理保留的 `Host` 验证管理页同源。`private` 会信任这些网段发来的转发头，必须限制后端端口仅由代理和受信任内网访问；若客户端可直连并伪造转发头，应改用精确代理 IP/CIDR。`ALLOW_INSECURE_HTTP=0` 仍要求可信代理提供 HTTPS 协议。

预建并保护目录，容器 UID 1000 必须拥有读写权限；运行目录存放已安装的服务程序版本：

```bash
sudo install -d -m 700 -o 1000 -g 1000 /opt/zichan/state /opt/zichan/backups /opt/zichan/runtime
```

**已有 `/srv/zichan` 部署不要直接切换默认目录。** 新默认值只影响尚未设置 `ZICHAN_STATE_DIR`、`ZICHAN_BACKUP_DIR`、`ZICHAN_RUNTIME_DIR` 的生产 Compose 和脚本。现有节点可继续显式设置这三个变量指向旧目录；若要迁到 `/opt/zichan`，先停服、完成并校验备份，再复制三个目录及权限，核对 `server-id` 和密钥后更新挂载。1Panel 中创建的容器须在 1Panel 修改宿主机挂载路径；仓库 Compose 的默认值不会自动修改它。不要以空的 `/opt/zichan/state` 重建已有节点。

从开发命名卷迁移时，先停服，执行完整备份及 `verify-backup`，再将备份恢复到**空**的 `/opt/zichan/state`；不要直接切换到空挂载。部署脚本默认拒绝空状态目录；只有确认是在创建全新服务器时，才对首次部署单次设置 `ZICHAN_ALLOW_FIRST_BOOT=yes`。`/opt/zichan/state/server/server.secret` 是首次启动生成的服务器密钥，必须和数据库、`server-id`、节点签名密钥一起持久保留。部署脚本在后续启动时检查服务器 ID 和密钥哈希未变。生产配置不使用临时 `SYNC_SECRET`。

## 按 digest 部署

推送稳定版标签后，[统一发布工作流](../../.github/workflows/release.yml)自动构建并签名 `ghcr.io/602star/zichan-sync:v<版本>` 镜像，同时保留 `sha-<commit>` 标签。从 Release 的 `image-digest.txt` 或作业摘要取得不可变镜像引用；部署必须使用 `@sha256:<digest>`。镜像工作流从仓库 Secret 注入 Release 只读 Token，并固定更新公钥；部署时不再复制这两份文件到宿主机。主机上执行：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
export ZICHAN_TZ=Asia/Shanghai
bash scripts/production/deploy.sh
```

默认可从私有局域网访问 `http://<服务器内网IP>:8787/`，同步服务器地址使用 `http://<服务器内网IP>:8787`。旧 `/app/` 入口会跳转到根路径；若浏览器仍显示旧页，应先从根路径刷新应用缓存。若使用上文的公网 HTTPS 模式，在部署前另执行：

```bash
export ZICHAN_HOST=127.0.0.1
export ZICHAN_ALLOW_INSECURE_HTTP=0
```

这两个变量属于 Compose 配置；1Panel 直接创建容器时，填写的是容器环境变量 `HOST` 和 `ALLOW_INSECURE_HTTP`。修改现有容器环境变量后需重建容器，保留原有的状态、备份和运行目录挂载；新部署可使用 `/opt/zichan/state`、`/opt/zichan/backups` 和 `/opt/zichan/runtime`。`0.0.0.0` 表示所有网卡，包括公网网卡；即使官方客户端拒绝公网 HTTP 地址，服务端一旦暴露仍会接收明文请求，必须由主机防火墙限制 8787。

仅创建全新服务器时，将最后一行改为 `ZICHAN_ALLOW_FIRST_BOOT=yes bash scripts/production/deploy.sh`；迁移和回退不得设置此开关。已有节点首次接入自更新启动器时，须先停服完成并校验完整备份，另设置 `ZICHAN_BASELINE_BACKUP=/opt/zichan/backups/<记录>`；部署脚本会复验备份并比对服务器身份。

脚本校验 Cosign 的 GitHub Actions OIDC 签名（接受此仓库版本标签发布流水线及旧版 `main` 镜像流水线）、仅在本机缺少该 digest 时拉取镜像，并检查 `linux/amd64`、Compose 配置、挂载目录、更新凭据、健康状态与持久身份。运行中的生产容器需要重建时，Compose 操作会通过共享维护锁执行；发现已有锁则拒绝部署。生产 Compose 在 [compose.prod.yml](../../compose.prod.yml)。Compose 不设置 `pull_policy: always`；Cosign 验签仍需访问镜像仓库，当前不能保证完全离线恢复。持久运行目录有已安装版本时，换镜像 digest **不会**回滚应用程序；同 schema 的程序回滚必须通过管理后台已安装版本执行。跨 schema 更新须先实现并验收独立迁移与恢复流程。

最终生产镜像带固定自更新启动器、初始版本的两个服务端打包入口与 Web 构建目录；另保留 `/app/dist` 下的两个维护入口供宿主机备份恢复调用。不包含 TypeScript 编译产生的 `.js`、声明文件或 source map。容器 CI 检查这些文件，并实测启动、健康端点及备份维护入口。打包后的服务端程序仍包含可分析的运行逻辑；镜像精简不能代替主机和容器访问控制。

## 加密备份运送

业务容器创建并验证 `/backups/<记录>`。主机将 `RESTIC_REPOSITORY` 指向独立机器的 SFTP 仓库或有版本保留的异地目标，`RESTIC_PASSWORD_FILE` 指向权限为 `0600`、位于业务状态、备份和 Git 目录之外的解密凭据。恢复所需凭据须在源主机之外另存一份。凭据不进 Git、镜像、业务容器环境变量或日志。仓库首次由运维执行 `restic init`。之后每份已完成备份执行：

```bash
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/ship-backup.sh /opt/zichan/backups/<记录>
```

运送脚本先通过业务镜像的维护入口校验数据库、附件和密钥清单，上传后执行 `restic check --read-data`。生产应使用独立权限的异机账户。`scripts/production/systemd/` 提供每日北京时间 05:00 的主机运送定时器，调用 `ship-latest.sh`，只有验证成功才记录已运送的备份路径。安装时将脚本固定到 `/opt/zichan`，配置 `/etc/zichan/backup-transport.env` 后启用 timer；运送窗口应晚于实际自动备份窗口。自动备份保持关闭，直到异机恢复演练及备份维护窗口通过。`TZ=Asia/Shanghai` 必须同时用于容器与维护窗口验收，检查管理页及 `backup-executor.json` 的下次执行时间。

## 整机恢复

原节点必须停止或隔离，确保同一服务器身份不会同时在线。在另一台空白 Linux 主机准备目录、Docker、Cosign、Restic、GHCR 只读凭据、匹配的已签名镜像 digest 和解密凭据。用 `restic snapshots` 找到快照 ID 和备份的原始绝对路径：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/restore-host.sh <快照ID> /opt/zichan/backups/<记录>
export ZICHAN_BASELINE_BACKUP=/opt/zichan/backups/<记录>
bash scripts/production/deploy.sh
```

恢复脚本拒绝非空状态目录，下载到临时隔离目录，运行完整 `verify-backup`，将已验证记录留在本机备份目录，再离线恢复并核对 `server-id`。首次部署用这个记录作 `ZICHAN_BASELINE_BACKUP`。启动后还需实际检查账号、附件、代表性同步读取和宿主机 HTTPS 路由。恢复会撤销旧会话，客户端需重新登录。测试机上的另一目录只能演练操作路径，不能证明机器损坏后的异机恢复。

## 共享维护锁

自动备份认领窗口前会在 `/opt/zichan/state/server/maintenance.lock` 原子建目录，直到备份和服务恢复完毕才释放。主机侧 `with-maintenance-lock.sh COMMAND` 使用同一锁，只有备份执行器处于 `disabled` 或 `waiting` 且心跳在 30 秒内才运行命令；未来升级执行器须复用这个入口。进程异常退出时锁会保留以安全失败；只有确认备份进程已经退出、数据已校验后，运维才可人工清理锁。当前尚未实现完整跨版本迁移和自动回退执行器。

## 上线前仍需验收

2026-10-28 至 29 的候选镜像曾验证签名与 digest 拉取、隔离目录恢复、备份运送、维护锁、时区解析、健康检查和无 schema 迁移时的旧镜像回退。那次 Restic 仓库仍在同一测试机，不能证明异机灾备。正式上线前需用真实异机目标完成空白主机恢复，独立保管凭据并测量 RPO/RTO；检查正式域名的 HTTPS 反向代理，并观察一次真实自动备份窗口和次日定时运送。跨版本迁移与写入后的回滚边界按 [1.0 升级方案](production-upgrade-1.0.md) 另行验收。
