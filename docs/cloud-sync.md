# 云同步与统一服务器 `@zichan/sync-server`

`@zichan/sync-server` 可在一个进程中提供 Web、端到端加密同步和管理员 API，适合云主机、NAS 或家中常开的固定 IP 电脑。`ENABLE_WEB` 与 `ENABLE_SYNC` 可独立开关；`BASE_PATH=/home-ledger` 会把 Web、同步和管理端点统一挂到安全路径下。

服务器只保存账号认证 verifier、设备会话、账本加密密码包装的密钥封套、密文提交、密文附件分块及路由元数据。账本字段、附件文件名、MIME、明文 SHA-256 和正文不会上传。不同服务器可使用不同用户名和账号密码；这些登录凭据不参与账本加密。附件对象 ID 和分块密钥由会话中的账本附件密钥按服务器、账本和用户名作用域派生。

## 当前 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health`、`/api/ready` | 存活信息；SQLite 完整性与就绪状态 |
| POST | `/api/register` | 注册账号，只接收客户端 PBKDF2 verifier |
| POST | `/api/auth/challenge`、`/api/auth/login` | 一次性 nonce 登录，创建设备会话 |
| POST | `/api/auth/refresh`、`/api/auth/logout` | 轮换 refresh token 或注销当前设备 |
| GET/POST | `/api/auth/devices`、`/api/auth/devices/:id/revoke` | 查看并撤销账号设备 |
| GET/POST | `/api/v3/replica[/bind]` | 查询或绑定账本副本 |
| GET/PUT | `/api/v3/key-envelope` | 同步密码包装的账本密钥封套 |
| GET/POST | `/api/v3/commits` | 分页拉取或幂等追加密文提交 |
| POST | `/api/v3/blobs/status` | 批量查询加密对象状态与配额 |
| POST/PUT | `/api/v3/blobs/uploads...` | 初始化、续传分块并原子完成上传 |
| GET | `/api/v3/blobs/:id/manifest`、`chunks/:index` | 下载密文清单与分块 |
| DELETE/POST | `/api/v3/blobs/:id`、`:id/restore` | 移入回收区或恢复 |
| GET | `/admin/status`、`/admin/users`、`/admin/logs` | 运行、用户与日志管理 |
| GET/POST | `/admin/users/:username/devices`、`/admin/sessions/:id/revoke` | 查看和撤销用户设备会话 |
| GET | `/admin/database/verify` | 执行 SQLite `quick_check` 并确认 WAL/结构版本 |
| GET/POST | `/admin/blobs`、`/admin/blobs/verify` | 容量统计与全量分块校验 |
| POST | `/admin/blobs/:username/quota` | 调整用户附件配额 |
| POST | `/admin/users/:username/quota` | 调整用户密文提交配额 |

配置 `BASE_PATH` 后需加前缀，例如 `/home-ledger/api/v3/commits`。

## 运行与容量

```bash
npm start -w @zichan/sync-server

# 固定 IP 电脑的一体化入口
npm run start:server
```

`npm run build -w @zichan/sync-server` 会生成独立的 `dist/server.mjs`，已包含工作区共享包；直接启动、
桌面启动器和 Docker 最终镜像都运行该入口，不依赖仓库中的 `node_modules`。

关键环境变量：

- `DATA_DIR`：完整服务器数据目录，默认 `server-data`；包含 `server.sqlite`、服务器身份/密钥和 `blobs/`。
- `COMMIT_QUOTA_BYTES`：每个用户的默认密文提交配额，默认 512 MiB；管理员可逐用户覆盖。
- `ATTACHMENT_QUOTA_BYTES`：默认用户配额，默认 2 GiB；管理员可逐用户覆盖。
- `ATTACHMENT_MAX_FILE_BYTES`：单个明文附件上限，默认 100 MiB。
- `ATTACHMENT_TRASH_RETENTION_MS`：回收区保留期，默认 30 天。
- `ADMIN_TOKEN`、`REGISTRATION_MODE`、`SYNC_SECRET`、`SERVER_ID`：管理、注册和服务器身份配置。
- `CORS_ALLOWED_ORIGINS`：允许跨域调用 API 的精确 Origin 列表；同源 Web 自动允许。
- `TRUSTED_PROXIES`：允许提供 `X-Forwarded-*` 的代理 IP，或 `loopback/private`；不要在直接暴露 8787 时信任任意来源。
- `ALLOW_INSECURE_HTTP`：默认 `0`。仅家中私有局域网明确接受风险时设为 `1`；远程管理员 API 不受此开关影响，始终要求 HTTPS。

有效对象、回收区和未完成上传都计入配额。上传会话 24 小时过期；服务启动及每小时清理过期暂存和到期回收对象。
账户、一次性 challenge、设备会话、持久限流、邀请码、账本密钥封套、提交、配额、附件索引和管理日志统一保存在 `server.sqlite`。数据库启用 WAL、`synchronous=FULL`、外键、事务提交、提交 ID 唯一约束和严格 schema v3；密文提交拉取使用 `after` + `limit` 游标分页，请求体按端点限制大小。

## 认证与传输边界

登录证明不是固定可重放值。challenge 绑定用户名、服务器 ID、随机 nonce、有效期和来源 IP，成功或失败尝试都会消费；访问令牌有效 15 分钟，refresh token 每次使用后立即轮换，设备会话最长 30 天。禁用用户会同时撤销其全部会话，管理后台可按设备查看最近 IP、最后访问时间并单独撤销。

公网部署必须由 Caddy 等反向代理终止 HTTPS，且只向代理暴露 8787。客户端会拒绝向公网 HTTP 域名或地址发送认证信息与 Bearer token；本机和 RFC1918/本地 IPv6 地址仍可用于明确配置的家庭局域网 HTTP。管理员 Token 只允许本机 HTTP 或 HTTPS 发送。

## 多服务器附件同步

普通提交同步完成后，客户端把本机可用正文上传到所有健康服务器。附件按明文 SHA-256 在本机内容寻址；远端 ID 是服务器、账本、用户和密码域内的 HMAC，不暴露明文哈希。正文按 4 MiB 分块独立 AES-256-GCM 加密和校验，重试会重建同一清单并只发送缺失分块。

缩略图自动下载。大正文默认留在服务器，查看、保存或导出备份时才取回；若服务器 B 缺少而 A 已有，客户端会从 A 解密并按 B 的密码重新加密中继。元数据删除并同步成功后，远端对象先进入回收区；冲突分支重新引用时可自动恢复。

## Docker 与 HTTPS

```bash
cd apps/sync-server
SYNC_SECRET=$(openssl rand -hex 32) \
ADMIN_TOKEN=$(openssl rand -hex 24) \
docker compose up -d
```

Compose 将父目录 `/state` 挂载到 `zichan-data`，实际 `DATA_DIR` 为 `/state/server`；这使恢复命令可以原子替换数据子目录。Caddy 负责 HTTPS，且会等待 `/api/ready` 通过。生产环境应固定 `SYNC_SECRET`、`ADMIN_TOKEN`、域名和 `BASE_PATH`，限制宿主机对数据卷的访问，不要把上游 8787 端口映射到公网。若密钥、`server.secret`、`server-id`、数据库或旧 JSON 状态曾进入源码目录或版本控制，应按已泄露处理：停止服务、保留加密数据备份，轮换 `SYNC_SECRET` 与 `ADMIN_TOKEN`，撤销设备会话后重新登录。

## 备份、迁移与恢复演练

维护命令要求先停止服务器。备份先用 SQLite `VACUUM INTO` 生成一致快照，再复制身份、密钥和附件目录；每个文件写入 SHA-256 清单，全部校验通过后才原子提升备份目录。恢复会先预检到暂存目录，再保留原数据为 `*.before-restore-*` 并原子替换。

```bash
# Windows/本机部署
npm run server:backup -- --data-dir D:\ledger-server --output D:\ledger-backups\2026-07-19
npm run server:verify-backup -- --backup D:\ledger-backups\2026-07-19
npm run server:restore -- --data-dir D:\ledger-server --backup D:\ledger-backups\2026-07-19

# Docker：先停服务，并把宿主机备份目录挂到 /backup
docker compose stop sync-server
docker compose run --rm -v ./backups:/backup sync-server \
  node dist/maintenance.js backup --data-dir /state/server --output /backup/2026-07-19
docker compose run --rm -v ./backups:/backup sync-server \
  node dist/maintenance.js verify-backup --backup /backup/2026-07-19
```

恢复演练应恢复到隔离目录，使用临时端口启动，检查 `/api/ready`，再在管理后台执行数据库和附件校验，并用测试客户端拉取一份带图片的账本。迁移成功后保留恢复前目录，直到所有设备完成一次同步。当前开发服务器只接受 `server_nonce_auth_sessions_rate_limits_v3`；旧固定证明认证、旧 JSON 状态与旧 SQLite 基线不读取、不转换。
