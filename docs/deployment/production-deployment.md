# Linux Docker 与 1Panel 部署

Linux 命令行和 1Panel 共用仓库根目录的 [compose.yml](../../compose.yml)：一个 `sync-server` 容器、一个宿主机目录 `/opt/zichan/data`。目录下的 `server/` 保存数据库和服务器身份，`backups/` 保存本机备份，`runtime/` 保存已安装的签名更新包。开发环境仍使用 `apps/sync-server/docker-compose.yml`，从源码构建并使用测试卷。

Compose 默认使用 `ghcr.io/602star/zichan-sync:v0.5.8`、桥接网络、宿主机 `8787` 端口和受防火墙保护的 HTTP。无顶层 `name`，1Panel 会使用面板填写的编排名；命令行生产脚本显式使用项目名 `zichan-prod`。直接导入 Compose 不会执行镜像验签和服务器身份检查；生产脚本会从 Release 读取 digest、验证 Cosign 签名、检查备份及身份，然后使用同一份 Compose。镜像仅支持 `linux/amd64`。

| 项目 | 开发环境 | Linux 命令行生产 | 1Panel 生产 |
| --- | --- | --- | --- |
| 配置 | `apps/sync-server/docker-compose.yml` | 根目录 `compose.yml` | 同一份根目录 `compose.yml` |
| 镜像 | 本机源码构建 | Release digest，脚本验签 | 默认版本标签，可按需固定 digest |
| 数据 | Docker 测试卷 | `/opt/zichan/data` 一个绑定目录 | 同一个默认绑定目录 |
| 网络 | 开发环境配置 | 桥接网络，宿主机端口可配置 | 同一网络和端口配置 |
| 启动 | 手动构建 | 安装／部署脚本检查身份和备份 | 由面板创建编排 |

## 全新安装

先安装 Docker Engine、Docker Compose v2、Cosign、Git 和 curl。若 GHCR 需要认证，使用具有 `read:packages` 权限的 Token 执行 `sudo docker login ghcr.io -u 602star`。仅在全新主机上运行：

```bash
sudo git clone --depth 1 https://github.com/602star/zichan.git /opt/zichan/source && sudo bash /opt/zichan/source/scripts/production/install-docker.sh v0.5.8
```

脚本拒绝已有数据和旧三目录布局，创建 UID 1000 拥有的 `/opt/zichan/data/{server,backups,runtime}`，验签镜像并等待服务健康。管理员首次设置地址为 `http://<内网IP>:8787/admin/`，用户端为根路径 `/`。

在 1Panel 全新创建编排时，导入 [compose.yml](../../compose.yml) 即可。短格式绑定挂载会自动创建 `/opt/zichan/data`，容器启动时创建子目录并设置权限，再切换到 UID 1000 运行。面板中的编排名与实际 Docker 项目名应一致。若 Docker/1Panel 的旧实现仍报宿主机目录不存在，可在宿主机运行 `sudo install -d -m 700 -o 1000 -g 1000 /opt/zichan/data` 后重试。

已有 `zichan` 和 `zichan-1panel` 两条编排记录时，这是先前顶层 `name` 与 1Panel 项目名不一致留下的两个 Docker 项目；合并文件不会自动删除它们。先核对运行容器挂载仍为 `/opt/zichan/data:/state`，在拟保留的 1Panel 项目中导入新文件，停止旧项目并启动新项目，确认 `/api/health` 的 `serverId` 未变，再移除多余的编排记录。删除时不要勾选删除宿主机数据。旧版 `prepare` 容器也可在新服务健康后单独删除。

`/admin/` 在服务器尚未设置所有者时显示初始化表单，设置成功后显示管理员登录；没有预设账号或密码。状态取自持久化数据库。若以为是全新安装却显示登录，先核对反向代理指向的容器、`/api/health` 的 `serverId` 及 `/opt/zichan/data/server` 内容。浏览器自动填充也可能在表单中显示旧账号；不要删除数据来重置页面。

## 旧部署迁移

**现有服务器不能直接改用空的 `/opt/zichan/data`。** 先停服，完成并验证备份，记录 `server-id` 和密钥摘要，再将旧 `/state/server` 的完整内容复制到 `/opt/zichan/data/server`、旧 `/backups` 复制到 `/opt/zichan/data/backups`、旧 `/app/runtime` 复制到 `/opt/zichan/data/runtime`。保留所有权限与密钥，确认 UID 1000 可读写后切换挂载，并在启动后核对服务器身份及代表性数据。原生产版默认的 `/opt/zichan/state/server`、`/opt/zichan/backups`、`/opt/zichan/runtime` 也按此规则迁移。脚本检测到这些默认旧目录中的数据会拒绝部署，避免以空目录生成另一台服务器。旧 `ZICHAN_STATE_DIR`、`ZICHAN_BACKUP_DIR`、`ZICHAN_RUNTIME_DIR` 配置需改为单个 `ZICHAN_DATA_DIR`。

原有 `/srv/zichan` 等自定义路径同样需要迁移，或者将已经整理为 `server/`、`backups/`、`runtime/` 三个子目录的专用目录指定给 `ZICHAN_DATA_DIR`。不要把源码目录或别的应用的共享目录当作数据目录。本机备份与业务数据共用一个宿主机目录，仍需用 Restic 运送到异机或独立存储。

## 网络与反向代理

容器内 `HOST=0.0.0.0`，因为 Docker 桥接端口映射需要容器监听所有接口；宿主机默认发布 `0.0.0.0:8787`。仅经同机 HTTPS 反向代理访问时，在启动前设置：

```bash
export ZICHAN_BIND_IP=127.0.0.1
export ZICHAN_ALLOW_INSECURE_HTTP=0
```

原来用于宿主机网络的 `ZICHAN_HOST=127.0.0.1` 不再适用，生产脚本遇到它会拒绝部署并提示改用 `ZICHAN_BIND_IP`。1Panel 的 HTTPS 代理应保留外部 `Host`、客户端地址，并提供单一有效的 `X-Forwarded-Proto: https`。默认 `ZICHAN_TRUSTED_PROXIES=private` 适配 Docker 网桥代理；若后端端口允许不可信客户端直连并伪造转发头，应改为实际代理 IP/CIDR，并用防火墙限制直连。`ZICHAN_ALLOW_INSECURE_HTTP=1` 仅用于受控内网 HTTP；公网须使用 HTTPS 入口。

## 按 digest 部署与更新

正式 Release 中的 `image-digest.txt` 给出不可变的镜像引用。命令行生产部署示例：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
bash scripts/production/deploy.sh
```

脚本验证 Cosign OIDC 签名和 `linux/amd64`，检查目录、镜像内更新凭据、已有身份、备份基线及健康状态。已有服务器首次接入自更新启动器时，先准备经过验证的完整备份，并设置 `ZICHAN_BASELINE_BACKUP=/opt/zichan/data/backups/<记录>`；仅创建全新服务器时才能单次设置 `ZICHAN_ALLOW_FIRST_BOOT=yes`。运行中的生产容器重建会使用共享维护锁。自更新细节见[生产签名包自更新](production-self-update.md)。

已安装程序保存在 `/opt/zichan/data/runtime/current`；只修改镜像标签并重建，不会覆盖已安装的程序版本。日常同 schema 更新使用管理后台签名更新包，基础镜像更新用新 digest 运行部署脚本。1Panel 手动更新基础镜像应在**原项目**拉取并重建，并用 `/api/health` 核对实际运行版本。跨 schema 更新须先有独立迁移与恢复流程。

## 异机备份与恢复

Restic 凭据必须在数据目录及源码目录之外，模式为 `0600`。`RESTIC_REPOSITORY` 指向独立机器，首次使用先 `restic init`。业务容器生成并验证 `/state/backups/<记录>` 后，主机运送：

```bash
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/ship-backup.sh /opt/zichan/data/backups/<记录>
```

原节点必须停止或隔离，避免相同身份同时上线。在另一台主机准备空的 `/opt/zichan/data/server`、可写的 `backups/` 和 `runtime/`，以及 Docker、Cosign、Restic、镜像和解密凭据。恢复示例：

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<64位摘要>'
export RESTIC_REPOSITORY='sftp:backup-user@backup-host:/srv/restic/zichan'
export RESTIC_PASSWORD_FILE='/etc/zichan/restic-password'
bash scripts/production/restore-host.sh <快照ID> /opt/zichan/data/backups/<记录>
export ZICHAN_BASELINE_BACKUP=/opt/zichan/data/backups/<记录>
bash scripts/production/deploy.sh
```

恢复脚本验证备份并核对 `server-id`。上线前还要检查账号、附件、代表性同步读取和 HTTPS 路由。维护锁位于 `/opt/zichan/data/server/maintenance.lock`；异常退出后的锁只能在确认没有备份或部署进程、数据已校验后人工清理。自动异机恢复和跨 schema 回滚尚未实现。
