# 生产同步服务器签名包自更新

生产更新采用后台下载签名的服务端程序包、停服备份、切换持久版本目录、重启验收的方式。基础 Docker 镜像仍按 digest 和 Cosign 签名交付；后续稳定版更新由同一容器内的固定启动器完成。镜像重建保留 `/srv/zichan/runtime` 时继续运行已安装版本；换镜像 digest 不会回滚这个已安装版本。更新包不能改变服务器 schema；跨 schema 更新必须先交付迁移、恢复和写入边界验收。

## Actions 发布

在 GitHub 创建 `production-release` Environment，限定从 `main` 运行；若仓库套餐支持，另设置审批和版本标签规则集。在该 Environment 下保存 `ZICHAN_UPDATE_SIGNING_KEY_PEM` Secret（Ed25519 私钥 PEM）及 `ZICHAN_UPDATE_PUBLIC_KEY_SHA256` Variable（由对应公钥 PEM 文件计算的 SHA-256）。不要把私钥放进仓库、镜像、生产主机或普通 Actions 构件。工作流 [sync-server-self-update-release.yml](../../.github/workflows/sync-server-self-update-release.yml) 由人工在 `main` 选择已有的稳定版标签触发：无密钥作业检出标签、检查它指向 `main` 的祖先提交、运行类型和服务器测试、构建未签名包；独立签名作业再次核对标签提交和公钥指纹，先创建草稿并核对资产，再发布正式 GitHub Release。Release 含 `latest.json`、`zichan-<版本>.feed.json` 和 `zichan-<版本>.json`。不重新覆盖既有 Release；失败后须调查产物与标签，不得改写同版本已安装资产。当前私有仓库的 GitHub 页面提示规则集在现有套餐下不会强制执行，因此工作流的标签提交复核只是发布时检查，不能代替服务端标签保护。

在受控发布机上生成首次密钥对，并把私钥 PEM **内容**录入 Secret、公钥文件固定到仓库的 `apps/sync-server/keys/update-public.pem`，公钥哈希录入 Variable：

```bash
umask 077
openssl genpkey -algorithm ed25519 -out update-private.pem
openssl pkey -in update-private.pem -pubout -out update-public.pem
sha256sum update-public.pem
```

签名作业另输出 `sync-update-public-key` 构件和公钥 SHA-256，并核对它与镜像内固定的公钥一致。部署方独立核对公钥指纹；以后同一更新通道继续使用这把密钥。轮换密钥需要交付新的基础镜像或先完成受信任的迁移，不能仅替换远端清单。

## 镜像凭据与主机目录

创建仅能读取 `602star/zichan` 的 GitHub fine-grained PAT，仓库权限只给 Contents 读取，并将其内容录入仓库 Actions Secret `ZICHAN_RELEASE_READ_TOKEN`。生产镜像工作流以 BuildKit secret 注入构建，最终镜像包含 UID 1000 可读、模式 `0600` 的 `/keys/github-token` 和固定的 `/app/bootstrap/update-public.pem`；私钥永不进入镜像。镜像应保持私有：有权拉取镜像的人可以离线提取 Token，Token 泄露或轮换时必须撤销旧凭据并构建新镜像。GHCR 镜像读取凭据仍用于初次部署和灾难恢复。主机另外准备 UID 1000 拥有、模式 `0700` 的 `/srv/zichan/runtime`、`/srv/zichan/state` 与 `/srv/zichan/backups`。

```bash
sudo install -d -m 700 -o 1000 -g 1000 /srv/zichan/runtime /srv/zichan/state /srv/zichan/backups
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<已签名镜像摘要>'
bash scripts/production/deploy.sh
```

`deploy.sh` 在切换前验证镜像签名、架构、数据和运行目录权限，并检查镜像内 Token 与公钥可读。现有节点必须复用原来的 `/srv/zichan/state`；首次换用自更新镜像前先停服，用原镜像的维护入口完成独立备份及 `verify-backup`，然后设置 `ZICHAN_BASELINE_BACKUP=/srv/zichan/backups/<记录>`。部署脚本会再次用目标镜像验证备份及 `server-id`，并在启动后核对 `server.secret` 与节点签名密钥未变。不可把隔离测试 Compose 的空命名卷接到生产。

## 更新、备份和失败处理

所有者重新登录后在「系统设置 → 版本更新」检查并安装更高的稳定版。更新器从私有 Releases API 读取最新正式发布，验 Ed25519 清单与包 SHA-256，且要求目标 schema 与当前程序一致。更新包仅含服务端与 Web 运行文件。切换后，固定启动器等待旧服务完全退出，在 `/backups/pre-update-<任务ID>` 创建完整离线备份并运行 `verify-backup`；回滚前同样创建 `/backups/pre-rollback-<任务ID>`。备份失败则切回原版本；目标版 60 秒内不能通过版本、健康和就绪检查也切回原版本。更新历史记录对应备份路径。备份目录异常或已有损坏的同任务备份时拒绝继续，不自动删除备份。程序回退不恢复数据库，只有 schema 未变时才允许使用。

本机备份还应通过现有 Restic 流程运送到独立主机。发布和自更新期间不能把程序备份当作异机灾备；生产自动备份窗口、维护锁和异机恢复仍须单独验收。

## 生产数据验收关口

首次替换生产基础镜像前，在隔离 Linux 主机恢复一份**完整、已验证**的生产备份，且原节点不能与恢复副本同时对外服务。记录基线版本、schema、`server-id`、节点公钥、账号与账本数量、代表性附件哈希和 `/api/ready`。使用与正式部署一致的镜像内 Token 和公钥，执行一次真实 `0.4.0 → 0.4.1` 的后台更新；核对预更新备份的 `verify-backup`、更新历史、版本、同一身份、账本和附件读取。保留 runtime、state 和 backups 后重建容器，再复核版本和数据。另做签名错误、包摘要错误、备份失败、目标版启动失败与断电重启演练，确认旧服务可用且数据未丢。最后在**另一台空白主机**用异机 Restic 备份恢复，量测 RPO/RTO。没有这些实测结果，不宣布真实生产数据完成验收。

隔离主机可在更新前后运行只读验收脚本，证据文件须放在状态、备份和 Git 目录之外；脚本核对版本、节点身份、公钥、密钥哈希、运行目录、就绪状态和更新前备份。账号、账本及代表性附件的业务读取仍需在后台实际操作验证。

```bash
export ZICHAN_IMAGE='ghcr.io/602star/zichan-sync@sha256:<已签名镜像摘要>'
bash scripts/production/accept-self-update.sh before /etc/zichan/acceptance-baseline.json
# 在后台执行签名更新，确认已自动重启。
bash scripts/production/accept-self-update.sh after /etc/zichan/acceptance-baseline.json
```

生产数据、备份、异机恢复与跨版本验收的实际结果应记录在工作日志；测试环境的结果不能代替真实生产数据验收。
