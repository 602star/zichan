# 云同步与统一服务器 `@zichan/sync-server`

独立 `/admin/` 后台、三类账号角色、邀请有效期、密码恢复和管理审计见 [服务器管理后台](server-admin.md)。当前服务端 schema 为 9。

`@zichan/sync-server` 可在一个进程中提供 Web、端到端加密同步和管理员 API，适合云主机、NAS 或家中常开的固定 IP 电脑。`ENABLE_WEB` 与 `ENABLE_SYNC` 可独立开关；`BASE_PATH=/home-ledger` 会把 Web、同步和管理端点统一挂到安全路径下。
只把 `apps/web/dist` 上传到静态文件托管只能得到浏览器前端，浏览器没有权限启动 Node 同步服务；需要同步时必须另外运行本服务，或直接使用其 Web + API 一体化部署。

与用户和账本相关的服务端持久状态只包含 OPAQUE 注册记录、设备会话的 refresh token HMAC、账本加密密码包装的密钥封套、密文提交、密文附件分块、已加密 `.zcbak` 归档及必要目录元数据，不保存账号密码。服务器自身另外持久化 `server.secret`、`server-id`、`opaque.server-setup` 和首次初始化使用的 `owner-setup.secret`。账本字段、附件文件名、MIME、明文 SHA-256 和正文不会以明文上传；备份归档的创建时间、原因、类型、显示标签、大小和代次属于服务器可见的目录元数据。不同服务器可使用不同用户名和账号密码；这些登录凭据不参与账本加密。附件对象 ID 和分块密钥由会话中的账本附件密钥按服务器、账本和用户名作用域派生。

## 当前 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health`、`/api/ready` | 存活信息；SQLite 完整性与就绪状态 |
| POST | `/api/auth/register/start`、`/api/auth/register/finish` | OPAQUE 两阶段注册；客户端产生注册记录 |
| POST | `/api/auth/login/start`、`/api/auth/login/finish` | OPAQUE 两阶段登录；成功后创建设备会话 |
| GET | `/api/auth/me` | 返回当前账号、角色、设备会话与账本绑定状态 |
| POST | `/api/auth/refresh`、`/api/auth/logout` | 轮换 refresh token 或注销当前设备 |
| GET/POST | `/api/auth/devices`、`/api/auth/devices/:id/revoke` | 查看并撤销账号设备 |
| GET/POST | `/api/v3/replica[/bind]` | 查询或绑定账本副本 |
| GET/PUT | `/api/v3/key-envelope` | 同步密码包装的账本密钥封套 |
| GET/POST | `/api/v3/commits` | 分页拉取或幂等追加密文提交 |
| POST | `/api/v3/blobs/status` | 批量查询加密对象状态与配额 |
| POST/PUT | `/api/v3/blobs/uploads...` | 初始化、续传分块并原子完成上传 |
| GET | `/api/v3/blobs/:id/manifest`、`chunks/:index` | 下载密文清单与分块 |
| DELETE/POST | `/api/v3/blobs/:id`、`:id/restore` | 移入回收区或恢复 |
| GET/POST | `/api/v3/backups` | 列出或登记已完成上传的加密 `.zcbak` 归档 |
| DELETE | `/api/v3/backups/:archiveId` | 删除备份目录项并把对应密文对象移入回收区 |
| GET | `/api/admin/status`、`/api/admin/users`、`/api/admin/logs` | 管理员查看运行、用户与日志状态 |
| GET/POST | `/api/admin/devices` | 管理员查看和撤销用户设备会话 |
| GET/POST | `/api/admin/registration`、`/api/admin/invites` | 管理注册模式与邀请码 |
| GET/POST | `/api/admin/quotas` | 查看或调整用户提交与附件配额 |
| GET | `/api/admin/database/verify` | 执行 SQLite `quick_check` 并确认 WAL/结构版本 |

配置 `BASE_PATH` 后需加前缀，例如 `/home-ledger/api/v3/commits`。

## 运行与容量

```bash
npm start -w @zichan/sync-server

# 固定 IP 电脑的一体化入口
npm run start:server
```

Windows 也可双击 `scripts\windows\start-sync-server.cmd`。该开发入口显式把 `DATA_DIR` 指向仓库内被忽略的
`.runtime/sync-server`，构建并启动同步 API 与 Web 管理页面，默认监听 8787。便携桌面内置服务器则固定使用
`<exe-root>/data/server`；两者都不读取或回退 AppData。它们面向可信家庭局域网并启用局域网 HTTP，不应将 8787 直接暴露到公网。

`npm run build -w @zichan/sync-server` 会生成独立的 `dist/server.mjs`，已包含工作区共享包；直接启动、
桌面启动器和 Docker 最终镜像都运行该入口，不依赖仓库中的 `node_modules`。

关键环境变量：

- `DATA_DIR`：完整服务器数据目录；包含 `server.sqlite`、服务器身份/密钥和 `blobs/`。独立 sync-server
  开发运行可使用 workspace `server-data`，脚本和便携内置入口必须显式传入；便携 bundle 缺少该变量时直接失败。
- `COMMIT_QUOTA_BYTES`：每个用户的默认密文提交配额，默认 512 MiB；管理员可逐用户覆盖。
- `ATTACHMENT_QUOTA_BYTES`：默认用户配额，默认 2 GiB；管理员可逐用户覆盖。
- `ATTACHMENT_MAX_FILE_BYTES`：单个明文附件上限，默认 100 MiB。
- `ATTACHMENT_TRASH_RETENTION_MS`：回收区保留期，默认 30 天。
- `REGISTRATION_MODE`：`open`、`invite` 或 `closed`，新服务器默认 `invite`；仅所有者可在管理页动态修改。已有库的策略不被部署默认值覆盖。
- `SYNC_SECRET`、`SERVER_ID`：访问令牌签名和服务器身份配置；生产部署必须稳定保存。
- `TRUSTED_PROXIES`：允许提供 `X-Forwarded-*` 的代理 IP 或 CIDR（IPv4/IPv6），兼容显式的 `loopback/private`；优先限定到实际代理地址，不要在直接暴露 8787 时信任任意来源。代理链从右向左检查，到首个不受信任的地址为止。代理必须覆盖 `X-Forwarded-Proto` 为单一的 `https`；经代理的请求不能依靠 `X-Forwarded-For: 127.0.0.1` 获得本机 HTTP 豁免。
- `ALLOW_INSECURE_HTTP`：默认 `0`。仅家中私有局域网明确接受风险时设为 `1`；公网账号登录、同步与管理都必须使用 HTTPS。

有效对象、回收区和未完成上传都计入配额。上传会话 24 小时过期；服务启动及每小时清理过期暂存和到期回收对象。
账户 OPAQUE 注册记录、稳定 `accountId`、唯一服务器所有者、单次登录状态、设备会话、持久限流、邀请码、密码重置码摘要、账本密钥封套、提交、配额、备份索引、附件索引和管理日志统一保存在 `server.sqlite`。数据库启用 WAL、`synchronous=FULL`、外键、事务提交、提交 ID 唯一约束。当前结构为 `server_password_recovery_v9`（schema 9）；支持 schema 6/7/8 的追加升级，保留账号 ID、原用户、所有者、注册策略及账本绑定，不重置业务数据。其他结构停止启动，不自动删除数据。密文提交协议仍为 v3，拉取使用 `after` + `limit` 游标分页，请求体按端点限制大小。

## 认证与传输边界

OPAQUE 注册和登录都由客户端与服务器交换 PAKE 消息，账号密码不发送到服务器。注册完成 token 有效 5 分钟；登录中间状态绑定用户名和来源 IP、有效 60 秒且只能消费一次。客户端校验 OPAQUE 返回的服务器静态公钥，调用方也可传入已信任公钥拒绝身份变化。

空服务器关闭普通注册。首次访问 `/admin/`，通过 Web 引导设置管理员用户名和密码即可，无需读取初始化密钥。初始化请求使用同源管理通道，认领标记进入短期签名的 OPAQUE 注册完成凭据；用户与唯一所有者在同一 SQLite 事务中创建，并发创建只有一个成功。已有所有者后不能再次初始化或绕过注册策略。旧版密钥接口暂时保留兼容，但不再是 Web 初始化的前置条件。普通成员注册遵循 `REGISTRATION_MODE`；管理员不能禁用自己。

登录成功后，访问令牌有效 15 分钟，refresh token 每次使用后立即轮换且旧 token 不能再使用，设备会话最长 7 天。服务器只持久化 refresh token 的 HMAC-SHA-256。禁用用户会同时撤销其全部会话，用户和管理员都可按设备查看最近 IP、最后访问时间并单独撤销。管理 API 复用同一 Bearer 会话并在每次请求时检查数据库角色：无有效会话返回 401，成员访问返回 403。

同站 Web 登录使用 `X-Zichan-Session: cookie`，服务器验证请求 Origin 后，把 refresh token 写入 HttpOnly、SameSite=Strict 的 Cookie；生产 HTTPS 下同时设置 Secure。Cookie 路径限定为部署前缀下的 `/api/auth`，登录与刷新 JSON 不返回 refresh token；刷新不能同时提供 JSON token。当前 Cookie 为会话级，尚未开启“可信设备自动解锁”。跨域 CORS 不允许这个自定义头，也不开放 credential。代理部署需保留公共 Host 并覆盖单一 `X-Forwarded-Proto: https`；即便设置 `ALLOW_INSECURE_HTTP=1`，局域网 HTTP 也不能使用不安全的 Web Cookie 会话，请改用 HTTPS 或桌面 Bearer 客户端。

桌面和尚未替换的跨站连接使用独立 JSON token 传输；桌面 Stronghold 只保存刷新会话，不保存账号密码。后台同步不进行密码登录：令牌被拒绝时最多受控刷新一次，刷新失效后要求用户明确重新登录；网络错误和 5xx 保留会话用于重试。

公网部署必须由 Caddy 等反向代理终止 HTTPS，且只向代理暴露 8787。客户端会拒绝向公网 HTTP 域名或地址发送认证信息与 Bearer token；本机和 RFC1918/本地 IPv6 地址仍可用于明确配置的家庭局域网 HTTP。同步与管理 API 允许官方 Web 等任意 Origin 发起无 Cookie 的跨域请求；实际访问控制来自 OPAQUE、Bearer 会话、角色检查、设备撤销、限流和配额，响应绝不启用跨域凭据 Cookie。

### 安全加入已绑定的远端账本

当登录账号已经绑定另一个 `ledgerId` 时，客户端不会先重置本机或尝试重新绑定服务器。用户需明确输入
“替换本机”和远端账本加密密码；客户端以只读 `GET /api/v3/replica` 确认绑定关系，获取并解锁远端
密钥封套，再在隔离数据库中分页拉取和解密全部提交，直至提交图收敛，并完成一致性、导入载荷和唯一活动
设置校验。该预检传输要求副本已存在，不能通过 `/bind` 改写远端状态。
密钥封套会在建立提交传输时再次比对完整摘要；若其消失或变化，预检只报错，不回写或“修复”服务器。
提交图即使形式上已收敛，只要包含任何经解密后无法通过领域校验的无效提交，也会拒绝加入。

只有预检完成后，客户端才创建本机设备级保护备份，并在一个本机 SQLite 事务中替换账本与设备同步状态，
随后采用远端密钥、整理附件并持久化匹配的服务器/副本身份。采用密钥、附件整理或客户端身份持久化失败时，
会恢复原数据库、原设备同步状态、原密钥和原服务器配置；连接、
密码、密文提交或预检任一阶段失败都保留原账本。

### 加密账本备份副本

桌面端先把 `.zcbak` 原子保存到便携目录 `data/backups`，再以最多 4 MiB 的有界分块把同一份已加密归档
上传到所有已启用的同步服务器，并登记 `/api/v3/backups` 目录项。服务器只校验密文对象存在和目录元数据，
不能解密归档；某台服务器失败不会删除本机文件或其他已成功副本。客户端上传后会按小时/日/周清理该服务器上的自动备份目录，
手动和导入前保护备份保持固定。设置页可列出、下载、演练和恢复服务器归档；如果归档属于旧密钥封套代次，
客户端会要求输入创建该归档时的账本加密密码，并且只在本次内存流程中使用。

## 多服务器桥接与附件同步

客户端把完整 URL 作为连接配置的唯一真值，并提供“当前网站 / 本机 / 局域网 / 公网”向导；协议、Host、端口和 Path 只是同一 URL 的高级编辑视图。公网 HTTP 会被拒绝，本机及私有局域网可明确使用 HTTP；请求不接受跨 Origin 重定向。

同一账本可同时启用多台独立服务器。每台服务器分别注册、登录并持有自己的设备会话和密码；客户端在一轮同步中从全部服务器拉取、合并提交 DAG，再向全部服务器推送，因此可以在局域网服务器和公网服务器之间桥接。账本只同步经过身份固定的服务器别名、`serverId`、OPAQUE 公钥与用户选择共享的 URL，不同步用户名、密码、refresh session 或 localhost 默认地址。新设备先登录任意一台服务器恢复账本后，会看到其余服务器为“需要登录”。

普通提交同步完成后，客户端把本机可用正文上传到所有健康服务器。附件按明文 SHA-256 在本机内容寻址；远端 ID 是服务器、账本、用户和密码域内的 HMAC，不暴露明文哈希。正文按 4 MiB 分块独立 AES-256-GCM 加密和校验，重试会重建同一清单并只发送缺失分块。

缩略图自动下载。大正文默认留在服务器，查看、保存或导出备份时才取回；若服务器 B 缺少而 A 已有，客户端会从 A 解密并按 B 的密码重新加密中继。元数据删除并同步成功后，远端对象先进入回收区；冲突分支重新引用时可自动恢复。

## Docker 与 HTTPS

```bash
cd apps/sync-server
SYNC_SECRET=$(openssl rand -hex 32) \
docker compose up -d
```

Compose 将父目录 `/state` 挂载到 `zichan-data`，实际 `DATA_DIR` 为 `/state/server`；这使恢复命令可以原子替换数据子目录。Caddy 负责 HTTPS，且会等待 `/api/ready` 通过。生产环境应固定 `SYNC_SECRET`、域名和 `BASE_PATH`，限制宿主机对数据卷的访问，不要把上游 8787 端口映射到公网。首次部署通过 `/admin/` 和数据目录内的 `owner-setup.secret` 初始化 Owner；普通注册不应被当作取得管理员权限的入口。已有服务器按管理后台提示完成初始化，切勿为了重新初始化而删除账本数据。若密钥、`server.secret`、`server-id`、数据库或旧 JSON 状态曾进入源码目录或版本控制，应按已泄露处理：停止服务、保留加密数据备份，轮换 `SYNC_SECRET`，撤销设备会话后重新登录。

## 备份、迁移与恢复演练

维护命令要求先停止服务器。备份先用 SQLite `VACUUM INTO` 生成一致快照，再复制 `server.secret`、`server-id`、OPAQUE 服务器 setup 和附件目录；账号角色与设备会话都在 SQLite 中，不存在单独的管理密钥文件。每个文件写入 SHA-256 清单，全部校验通过后才原子提升备份目录。`server.sqlite`、`server.secret`、`server-id` 和 `opaque.server-setup` 是恢复必需文件。恢复会先预检到暂存目录，再保留原数据为 `*.before-restore-*` 并原子替换。

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

恢复演练应恢复到隔离目录，使用临时端口启动，检查 `/api/ready`，再在管理后台执行数据库和附件校验，并用测试客户端拉取一份带图片的账本。迁移成功后保留恢复前目录，直到所有设备完成一次同步。当前服务器及备份工具接受 schema 9 和可追加升级的 schema 6/7/8；恢复工具撤销旧会话并清除未完成登录及密码重置码，需要重新登录。旧 PBKDF2/固定证明/一次性 challenge 认证、旧 JSON 状态、人工管理 Token 与旧 SQLite 基线都不读取、不转换。
