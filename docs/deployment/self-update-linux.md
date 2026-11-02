# Linux 测试机一键自更新（0.3.x）

此流程只用于单实例 Linux/Docker 测试部署。管理后台“系统设置 → 版本更新”读取签名的 0.3.x 清单，下载完整的服务端与 Web 包，安装到独立版本目录，由镜像内固定启动器重启和健康验证。运行程序保存在 `zichan-update-runtime` 卷中；重新创建容器并保留该卷时仍使用已安装版本。生产环境继续使用 [签名镜像部署](production-deployment.md)，本流程不更新 Docker 镜像。

## 发布格式与信任

- `latest.json` 包含版本、包名、SHA256 和 Ed25519 签名。服务端固定读取 `UPDATE_PUBLIC_KEY_PATH`，先验签再下载；包摘要、版本和所有文件路径还会再次校验。
- 只允许 `0.3.x` 且补丁号高于当前运行版本，更新包的服务器 schema 标识必须与当前程序一致。后台不能提交下载地址、文件路径或命令。
- 默认测试 Compose 通过只读目录 `UPDATE_FEED_DIR` 取包。也可单独配置 `UPDATE_FEED_URL=https://…/latest.json`；下载包必须来自同一 HTTPS 目录，禁止 HTTP 与重定向。三种更新源只能启用一个。
- 私有 GitHub Releases 使用独立 Compose、`UPDATE_GITHUB_REPO=owner/repo` 与只读 `UPDATE_GITHUB_TOKEN_FILE`。Token 只在服务端读取，不进入浏览器；细粒度 Token 仅授予目标仓库 Contents 读取权限。服务端只取正式 `v0.3.x` 发布的 `latest.json` 和完整包，仍执行签名及摘要检查；重定向只允许 GitHub 发布资产域名，并去掉授权头。
- 私钥只留在发布机，公钥单独挂载。密钥、包、数据库和日志不要提交到仓库。若使用本地测试密钥，生产或其他测试机须换独立密钥。

## 从 0.3.1 启动测试实例

在 Linux 测试机的 `0.3.1` 本地提交上执行。测试机需要 Docker Compose、Node.js 22 和 OpenSSL；也可以在构建机生成发布包后复制到测试机。以下目录为示例，均由当前用户创建；请勿复用生产数据卷。

```bash
mkdir -p "$HOME/zichan-update-test/feed" "$HOME/zichan-update-test/keys"
openssl genpkey -algorithm ed25519 -out "$HOME/zichan-update-test/keys/update-private.pem"
openssl pkey -in "$HOME/zichan-update-test/keys/update-private.pem" -pubout -out "$HOME/zichan-update-test/keys/update-public.pem"
chmod 600 "$HOME/zichan-update-test/keys/update-private.pem"
chmod 644 "$HOME/zichan-update-test/keys/update-public.pem"
export ZICHAN_UPDATE_FEED_DIR="$HOME/zichan-update-test/feed"
export ZICHAN_UPDATE_PUBLIC_KEY_FILE="$HOME/zichan-update-test/keys/update-public.pem"
docker compose -f apps/sync-server/docker-compose.self-update.yml up -d --build --wait
```

默认只监听本机 `127.0.0.1:8787`。从远端浏览器访问管理后台时，按[生产部署说明](production-deployment.md)配置宿主机 HTTPS 反向代理；仅在隔离测试网、经 SSH 转发访问本机时可显式设置 `ALLOW_INSECURE_HTTP=1`。首次打开 `/admin/` 创建所有者。

## 制作下一补丁包并更新

在含下一版本（例如 `0.3.3`）的本地提交上构建，保持与测试容器相同的 Node 22/Linux 构建环境。发布包内只含打包好的 Node 服务端与 Web 静态文件，目标容器无需 `npm install`。

```bash
npm ci
npm run build:server
node scripts/release/create-update-package.mjs \
  "$HOME/zichan-update-test/keys/update-private.pem" \
  "$HOME/zichan-update-test/feed"
```

如果在另一台机器构建，复制 `zichan-0.3.3.json`、`zichan-0.3.3.feed.json` 和 `latest.json` 到测试机的 feed 目录，**不要复制私钥到运行容器**。在管理后台重新登录所有者账号（安装与回滚要求最近 5 分钟内登录），进入“系统设置 → 版本更新”。页面自动检查，也可手动检查；发现新版本后点“立即更新至 0.3.3”。下载进度和最近 50 次更新记录会显示在页面；成功后自动刷新。接口增加 `GET /api/admin/updates/versions`、`GET /api/admin/updates/history` 与 `POST /api/admin/updates/rollback`。

手动回滚仅允许选择运行卷里已安装的更早 0.3.x 版本，所有者再次点击确认。回滚也经过固定启动器的健康检查；失败时切回原版本。更新源列出的“已发布版本”只是可见信息，未安装的历史版本不会直接拿来回滚。数据库不随程序回滚，先独立备份并确认两个版本使用相同 schema。

## 私有 GitHub Releases 测试入口

当已有私有仓库中的正式 `v0.3.x` Release 时，Release 必须带该版本的 `latest.json` 与 `zichan-<版本>.json`；发布资产由发布机生成并验签，私钥不上传。测试机准备只读 Token 文件，然后在隔离项目中启动：

```bash
export ZICHAN_UPDATE_GITHUB_REPO='owner/repo'
export ZICHAN_UPDATE_GITHUB_TOKEN_FILE="$HOME/zichan-update-test/keys/github-token"
export ZICHAN_UPDATE_PUBLIC_KEY_FILE="$HOME/zichan-update-test/keys/update-public.pem"
docker compose -f apps/sync-server/docker-compose.self-update.github.yml up -d --build --wait
```

这个 Compose 使用独立的项目名和卷，不能直接复用本地 feed 测试卷。当前任务只在本地构建和测试，没有创建 GitHub Release 或推送；需实际演练私有发布源时，再按批准的发布流程提供资产与 Token。

验收时核对 `/api/health` 的 `version`、`/api/ready`、管理后台与记账入口。执行 `docker compose -f apps/sync-server/docker-compose.self-update.yml up -d --force-recreate --wait` 后再次核对版本，确认卷中安装内容未被镜像初始版本覆盖。可在隔离测试中篡改包字节：安装必须因摘要错误失败，现有服务保持可用。新进程 60 秒内未以目标版本通过健康检查时，启动器切回先前版本并写入 `/app/runtime/update-result.json`；查看容器日志和后台状态核实原因。

本机制不自动迁移或回滚数据库。跨 schema 的改动必须先备份并按[升级方案](production-upgrade-1.0.md)评估恢复边界；不能把程序回退当成数据库回退。测试 Compose 与生产 Compose 使用不同项目名和卷。
