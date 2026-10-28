# 云同步与统一服务器 `@zichan/sync-server`

> 当前账号保护采用[服务器托管与默认离线访问](ledger-protection.md)：登录后自动解锁，断网时用同一账号密码打开本机缓存。

当前产品仅提供个人账本。多人账本的界面、接口和底层成员格式已移除；服务器同步组仍可在多节点保存同一个人的账本副本。


独立 `/<安全路径>/admin/` 后台、账号角色、邀请有效期、密码恢复和管理审计见 [服务器管理后台](server-admin.md)。安全路径默认自动生成，完整地址见启动日志。当前服务端从空数据目录安装 schema 27。

`@zichan/sync-server` 可在一个进程中提供 Web、密文同步和管理员 API，适合云主机、NAS 或家中常开的固定 IP 电脑。`ENABLE_WEB` 与 `ENABLE_SYNC` 可独立开关；`BASE_PATH=/home-ledger` 会把 Web、同步和管理端点统一挂到安全路径下。
只把 `apps/web/dist` 上传到静态文件托管只能得到浏览器前端，浏览器没有权限启动 Node 同步服务；需要同步时必须另外运行本服务，或直接使用其 Web + API 一体化部署。

与用户和账本相关的服务端持久状态包含登录账号与昵称、可选的已验证或待验证邮箱及通知偏好、邮件验证码摘要与配额通知队列、OPAQUE 注册记录、设备会话的 refresh token HMAC、随机托管凭据或恢复码包装的密钥封套、加密托管凭据、密文提交、密文附件分块、已加密 `.zcbak` 归档及必要目录元数据，不保存账号密码。服务器自身另外持久化 `server.secret`、`custody.key`、`server-id`、`opaque.server-setup` 和首次初始化使用的 `owner-setup.secret`。账本字段、附件文件名、MIME、明文 SHA-256 和正文不会以明文上传；备份归档的创建时间、原因、类型、显示标签、大小和代次属于服务器可见的目录元数据。同步组内使用统一账号登录；账本附件采用 V2 加密格式，由服务器后台复制密文。节点复制与统一登录的迁移边界见 [账本副本架构](ledger-replica-architecture.md)。

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
| GET/POST/DELETE | `/api/v4/replication/grants...` | 查看、签发或撤销固定节点身份的限期复制授权；新授权可选择活动时自动续期 |
| POST | `/api/v4/replication/join` | 目标节点管理员原子建立独立统一登录账本账号与空副本 |
| GET/PUT/DELETE | `/api/v4/replication/links...` | 查看、续签或停用服务器后台复制链路 |
| GET | `/api/v4/ledger/readiness`、`/api/v4/ledger/group-health` | 核对本节点完整性；中继按持久成员目录和近期签名报告汇总副本组 |
| GET/DELETE | `/api/v4/ledger/group-members...` | 查看账本副本组成员；明确移出成员时同时撤销其复制授权 |
| GET/PUT | `/api/v3/key-envelope` | 同步密码包装的账本密钥封套 |
| GET/POST | `/api/v3/commits` | 分页拉取或幂等追加密文提交 |
| POST | `/api/v3/blobs/status` | 批量查询加密对象状态与配额 |
| POST/PUT | `/api/v3/blobs/uploads...` | 初始化、续传分块并原子完成上传 |
| GET | `/api/v3/blobs/:id/manifest`、`chunks/:index` | 下载密文清单与分块 |
| DELETE/POST | `/api/v3/blobs/:id`、`:id/restore` | 移入回收区或恢复 |
| GET/POST | `/api/v3/backups` | 列出或登记已完成上传的加密 `.zcbak` 归档 |
| DELETE | `/api/v3/backups/:archiveId` | 删除备份目录项并把对应密文对象移入回收区 |
| GET | `/api/admin/overview`、`/api/admin/users`、`/api/admin/logs` | 管理员查看运行、用户与日志状态 |
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
- `COMMIT_QUOTA_BYTES`：普通用户与只读运维的默认密文提交配额，默认 20 GiB；管理员可逐用户覆盖。
- `ATTACHMENT_QUOTA_BYTES`：普通用户与只读运维的默认附件配额，默认 20 GiB；管理员可逐用户覆盖。所有者和管理员的两类配额均无限，仍受单文件大小和服务器实际磁盘空间限制。
- `ATTACHMENT_MAX_FILE_BYTES`：单个明文附件上限，默认 100 MiB。
- `ATTACHMENT_TRASH_RETENTION_MS`：回收区保留期，默认 30 天。
- 上述四项是管理后台「系统设置」的部署初始值；所有者在页面保存后，以数据库中的设置为准。普通账号的专属配额优先于默认配额。监控中心的分钟级与小时级指标保留天数也可在「记录保留」中调整。
- 设置保存在当前服务器。加入服务器同步组后，应在各节点配置相同的默认配额与附件上限，避免不同节点对同一账号采用不同的上传边界。
- `REGISTRATION_MODE`：`open`、`invite` 或 `closed`，新服务器默认 `invite`；仅所有者可在管理页动态修改。已有库的策略不被部署默认值覆盖。
- `SYNC_SECRET`、`SERVER_ID`：访问令牌签名和服务器身份配置；生产部署必须稳定保存。
- `TRUSTED_PROXIES`：允许提供 `X-Forwarded-*` 的代理 IP 或 CIDR（IPv4/IPv6），兼容显式的 `loopback/private`；优先限定到实际代理地址，不要在直接暴露 8787 时信任任意来源。代理链从右向左检查，到首个不受信任的地址为止。代理必须覆盖 `X-Forwarded-Proto` 为单一的 `https`；经代理的请求不能依靠 `X-Forwarded-For: 127.0.0.1` 获得本机 HTTP 豁免。
- `ALLOW_INSECURE_HTTP`：默认 `0`。设为 `1` 时，私有局域网的明文 HTTP 也可用于账号登录、同步、浏览器 Cookie 会话与管理后台（Cookie 不设置 Secure）；公网部署仍必须使用 HTTPS。仓库开发启动器默认设为 `1`，仅面向可信家庭局域网，切勿在公网暴露时开启。

明文 HTTP 下的能力与边界：浏览器把 `crypto.subtle` 与 Web Locks 限制在安全上下文。本应用在缺少它们时改用随包提供的纯 JavaScript 后端（`@noble/ciphers` / `@noble/hashes`）与 IndexedDB 事务租约，因此局域网 HTTP 可以正常解锁、记账、附件、备份；支持 SharedWorker 的浏览器还可共用一份数据库同时打开多个标签页，缺少 SharedWorker 时退回单标签页互斥。AES-GCM（16 字节 tag）、SHA-256 和 HMAC-SHA256 在两个后端逐字节一致，现有账本与新写入可双向互读。Argon2id 仍由 `hash-wasm` 提供，是唯一没有回退的能力，缺少 WebAssembly 时明确拒绝解锁并说明原因。两点必须如实知悉：其一，明文 HTTP 无法保证传输中的页面代码和托管凭据不被截取或篡改，账本静态存储虽仍加密，但请仅在可信内网开启；其二，该退化路径下「记住设备七天」存不了不可导出的原生密钥，只能落原始密钥字节，保护强度低于原生路径，界面不得把它当作同等保护。另外局域网 HTTP 不是安全上下文，Service Worker 不可用，关闭浏览器后完全断网重新打开网页不受保证。

有效对象、回收区和未完成上传都计入配额。上传会话 24 小时过期；服务启动及每小时清理过期暂存和到期回收对象。
同一账本在各节点的 V2 附件按副本计量，并计入账本账号的附件配额；管理后台的账号详情显示实际用量。
账户 OPAQUE 注册记录、稳定 accountId、设备会话、密钥封套、加密提交、配额、备份与附件索引保存在 server.sqlite。开发期当前结构为 schema 27，只从空数据目录初始化；已有数据库版本不匹配时停止启动。密文提交协议为 v3，拉取使用 after 与 limit 游标分页。

## 认证与传输边界

OPAQUE 注册和登录都由客户端与服务器交换 PAKE 消息，账号密码不发送到服务器。注册完成 token 有效 5 分钟；登录中间状态绑定用户名和来源 IP、有效 60 秒且只能消费一次。客户端校验 OPAQUE 返回的服务器静态公钥，调用方也可传入已信任公钥拒绝身份变化。

空服务器关闭普通注册。未设置安全路径时，首次和日常访问均使用 `/admin/`；配置 `ADMIN_ACCESS_PATH` 后使用 `/<安全路径>/admin/`，未创建所有者时访问 `/admin/` 也会跳转到初始化页。通过 Web 引导设置管理员用户名和密码即可，无需读取初始化密钥。配置安全路径并创建所有者后，`/admin/` 返回 404。初始化请求使用同源管理通道，认领标记进入短期签名的 OPAQUE 注册完成凭据；用户与唯一所有者在同一 SQLite 事务中创建，并发创建只有一个成功。已有所有者后不能再次初始化或绕过注册策略。旧版密钥接口暂时保留兼容，但不再是 Web 初始化的前置条件。普通成员注册遵循 `REGISTRATION_MODE`；管理员不能禁用自己。

登录成功后，访问令牌有效 15 分钟，refresh token 每次使用后立即轮换且旧 token 不能再使用，设备会话最长 7 天。服务器只持久化 refresh token 的 HMAC-SHA-256。禁用用户会同时撤销其全部会话，用户和管理员都可按设备查看最近 IP、最后访问时间并单独撤销。管理 API 复用同一 Bearer 会话并在每次请求时检查数据库角色：无有效会话返回 401，成员访问返回 403。

同站 Web 登录使用 `X-Zichan-Session: cookie`，服务器验证请求 Origin 后，把 refresh token 写入 HttpOnly、SameSite=Lax 的账本 Cookie，以支持统一登录的跨站顶层跳转；管理 Cookie 仍为 SameSite=Strict。生产 HTTPS 下同时设置 Secure。Cookie 路径限定为部署前缀下的 `/api/auth`，登录与刷新 JSON 不返回 refresh token；刷新不能同时提供 JSON token。Cookie 为会话级；可选的七天设备解锁授权独立于 Cookie，详见账本保护说明。跨域 CORS 不允许这个自定义头，也不开放 credential。代理部署需保留公共 Host 并覆盖单一 `X-Forwarded-Proto: https`；当部署显式设置 `ALLOW_INSECURE_HTTP=1` 时，私有局域网明文 HTTP 也可使用同站 Cookie 会话与管理后台，此时 Cookie 不带 Secure，请仅在可信内网开启。

桌面和附加跨站连接使用独立 JSON token 传输；桌面 Stronghold 只保存刷新会话，不保存账号密码。后台同步不进行密码登录：令牌被拒绝时最多受控刷新一次，刷新失效后要求用户明确重新登录；网络错误和 5xx 保留会话用于重试。

账号级账本保护与整账本替换适用于当前的个人账本。

公网部署必须由 Caddy 等反向代理终止 HTTPS，且只向代理暴露 8787。客户端会拒绝向公网 HTTP 域名或地址发送认证信息与 Bearer token；本机和 RFC1918/本地 IPv6 地址仍可用于明确配置的家庭局域网 HTTP。唯一例外是经审查加入放行名单的主机（`packages/core/src/transport-policy.ts` 的 `PLAIN_HTTP_HOST_ALLOWLIST`）：它只取得明文传输许可，不会被当作局域网主机，也不参与「设备本地 / 共享」的范围划分。

放行名单必须同时被两道闸门读取，缺一即不可用：(1) 应用层 `assertSecureSyncUrl`（`@zichan/db`）在构造请求前放行；(2) 托管 Web 的同步服务器把同一名单拼进 `Content-Security-Policy` 的 `connect-src`（`apps/sync-server/src/server.ts`），否则浏览器会在应用层放行之后掐断请求，表现为「连接失败」而看不到任何与响应头有关的线索。局域网 HTTP 部署设置 `ALLOW_INSECURE_HTTP=1` 后，托管网页的 `connect-src` 还允许 `http:`：CSP 无法表达所有私有 IP 段，实际目标仍须先通过应用层的私网地址规则，服务端才接受明文同步。该开关按部署全局生效；未开启时服务端返回 `426 HTTPS_REQUIRED`。公网 HTTPS 网页向局域网 HTTP 发请求仍可能被浏览器混合内容或私有网络规则阻止，应为这些节点配置可信 HTTPS，或从局域网节点自己的网页管理。`test.ojco.de` 因是不终止 TLS 的测试部署而在名单内，该域名启用 HTTPS 后应立即移除。同步与管理 API 允许官方 Web 等任意 Origin 发起无 Cookie 的跨域请求；实际访问控制来自 OPAQUE、Bearer 会话、角色检查、设备撤销、限流和配额，响应绝不启用跨域凭据 Cookie。

### 安全加入已绑定的远端账本

当登录账号已经绑定另一个 `ledgerId` 时，客户端不会先重置本机或尝试重新绑定服务器。用户需明确输入
“替换本机”和远端账本加密密码；客户端以只读 `GET /api/v3/replica` 确认绑定关系，获取并解锁远端
密钥封套，再在隔离数据库中分页拉取和解密全部提交，直至提交图收敛，并完成一致性、导入载荷和唯一活动
设置校验。该预检传输要求副本已存在，不能通过 `/bind` 改写远端状态。
密钥封套会在建立提交传输时再次比对完整摘要；若其消失或变化，预检只报错，不回写或“修复”服务器。
提交图即使形式上已收敛，只要包含任何经解密后无法通过领域校验的无效提交，也会拒绝加入。

### 个人账本替换与恢复点

明确确认“替换旧账本”时，服务端先在同一 SQLite 事务内保存旧副本身份、原密钥封套、全部加密提交和原托管设置，并保留旧副本槽位及其附件、备份目录关联。原账本的副本提交、密钥包或磁盘空间核对失败时拒绝替换。替换成功后旧节点复制链路停用，旧授权撤销；新账本使用新的副本 ID、流世代和托管密钥。

账号可通过 `GET /api/v3/replica/recovery` 查看自己的替换前检查点，通过明确确认的 `POST /api/v3/replica/recovery/restore` 恢复。恢复前会给当前账本另建检查点，恢复后使用检查点保存的原托管凭据解锁旧数据，并重新授权节点复制。网页“账本保护”中的高级恢复入口会先把当前本机账本备份到浏览器以外；恢复后暂停此连接，要求退出并重新从服务器加入。整机文件损坏仍需使用独立的服务器备份。

只有预检完成后，客户端才创建本机设备级保护备份，并在一个本机 SQLite 事务中替换账本与设备同步状态，
随后采用远端密钥、整理附件并持久化匹配的服务器/副本身份。采用密钥、附件整理或客户端身份持久化失败时，
会恢复原数据库、原设备同步状态、原密钥和原服务器配置；连接、
密码、密文提交或预检任一阶段失败都保留原账本。

全新浏览器首次进入仍需分页取回并验证全部加密提交，界面会显示已接收数与远端总数；账本越大，这一步越久。附件正文和缩略图不会因首次恢复全部进入浏览器缓存，预览与导出按需下载。服务器之间的 V2 附件由后台分块复制。

### 加密账本备份副本

桌面端先把 `.zcbak` 原子保存到便携目录 `data/backups`，再以最多 4 MiB 的有界分块把同一份已加密归档
上传到所有已启用的同步服务器，并登记 `/api/v3/backups` 目录项。服务器只校验密文对象存在和目录元数据，
获授权托管的服务器可以解密归档；某台服务器失败不会删除本机文件或其他已成功副本。客户端上传后会按小时/日/周清理该服务器上的自动备份目录，
手动和导入前保护备份保持固定。设置页可列出、下载、演练和恢复服务器归档；如果归档属于旧密钥封套代次，
客户端会要求输入创建该归档时的账本加密密码，并且只在本次内存流程中使用。

## 多服务器桥接与附件同步

客户端把完整 URL 作为连接配置的唯一真值，并提供“当前网站 / 本机 / 局域网 / 公网”向导；协议、Host、端口和 Path 只是同一 URL 的高级编辑视图。公网 HTTP 会被拒绝（经审查放行的主机除外），本机及私有局域网可明确使用 HTTP；请求不接受跨 Origin 重定向。

同一账本可同时启用多台独立服务器。配置多台节点前须由管理员建立同步组。若已配置节点属于同一账本、世代相符、通过近期的后台目录核对且形成连通复制组，浏览器会记录该组并只与当前网站节点同步；当前节点不可用时改用组内另一节点。服务器之间负责其余提交及 V2 附件传输，节点暂时离线不会使浏览器退回多服务器搬运。新增或更换节点会使本机的组记录失效，需重新核对。账本只同步经过身份固定的服务器别名、`serverId`、OPAQUE 公钥与用户选择共享的 URL，不同步用户名、密码、refresh session 或 localhost 默认地址。新设备先登录任意一台服务器恢复账本后，会看到其余服务器为“需要登录”。

新版节点加入流程允许目标服务器只先创建节点管理员账号。源账本账号签发短期授权后，目标节点管理员可让服务器自动创建独立的统一登录账本账号和空副本，再由后台复制提交及 V2 附件。节点管理员账号不会因此获得账本访问权；新账本账号只能通过身份节点的一次性授权码登录目标网站。附属节点从同步组接收统一身份与账本副本。

自动同步先完成提交，再在网页运行且可联网时逐批处理本机可用附件；每批最多 8 个对象或约 64 MiB，单个超过此限的对象仍单独处理。游标按账本、副本及节点身份保存在本机，关闭网页后再次打开可续跑；同步页显示当前批次的扫描、上传和失败状态。一轮扫描完成后核对并发布附件承诺目录。手动同步仍可一次处理全部当前引用；未核对的旧连接仍可能逐台上传。附件按明文 SHA-256 在本机内容寻址；远端 ID 是带密钥的 HMAC，不暴露明文哈希。旧版 V1 将 ID 限定在服务器、账本和用户名范围，新版 V2 将 ID 限定在账本范围，同账本节点可直接复制密文。正文按 4 MiB 分块独立 AES-256-GCM 加密和校验，重试只发送缺失分块。

正文和缩略图在已有远端副本时默认留在服务器，查看、保存或导出备份时才按需取回。旧版 V1 对象必须由持有账本密钥的客户端读取并重新上传为 V2；客户端可查询当前副本中旧对象的源账号路由。手动同步会显示旧附件检查、按对象完成的迁移数量、逻辑字节量和失败数量；迁移期间须保持网页打开，失败对象在下次同步中重试。未核对的旧连接仍可能由浏览器补传缺失附件，已核对的节点组则由服务器后台按缺块直接互传，关闭浏览器后仍可继续。界面展示附件数量、密文容量和本轮已核对字节；已核对量不等于实际传输量。节点对提交逻辑元数据、V2 附件清单、删除状态、密钥包、账号身份、账本能力与附件承诺目录进行签名目录摘要比对；每个已绑定副本在后台逐块校验本地新版附件密文，损坏对象隔离后由下一轮复制补回。客户端发布附件承诺目录后，`/api/v4/ledger/readiness` 会实时核对已启用对端与本地证据，只有全部通过才将本节点标为 `READY`；整组三节点真实大账本验收仍未完成。元数据删除并同步成功后，远端对象先进入回收区；V2 删除标记会在节点间传播，显式恢复也会传播。

局域网节点每轮向中继签名上报本地副本状态，并保存中继签名返回的组目录与健康快照；任一节点的 `/api/v4/ledger/group-health` 都可显示整组状态。缺报或快照超过 60 秒即降级。授权过期或撤销仍保留成员并显示异常；只有账本管理者明确移出，才会从整组统计中消失。成员目录目前由中继管理，不是所有者签名的多节点控制链，也不能代替真实部署的三节点故障验收。

## Docker 与 HTTPS

```bash
cd apps/sync-server
docker compose up -d --build --remove-orphans
```

Compose 将父目录 `/state` 挂载到 `zichan-data`，实际 `DATA_DIR` 为 `/state/server`；这使恢复命令可以原子替换数据子目录。Compose 只运行同步服务器，默认把宿主机 `127.0.0.1:8787` 映射到容器的 8787，不占用 80/443；由部署者自行配置 HTTPS 反向代理并转发到 `http://127.0.0.1:8787`。代理在另一台主机时，可将 `SYNC_BIND_ADDRESS` 设为代理可访问的宿主机地址，并用防火墙限制来源。反向代理须保留公共 Host，并覆盖单一 `X-Forwarded-Proto: https`；`TRUSTED_PROXIES` 应配置为实际代理地址或网段。生产环境应固定 `SYNC_SECRET`、域名和 `BASE_PATH`，限制宿主机对数据卷的访问，不要把上游 8787 端口直接开放到公网。首次部署通过启动日志显示的后台路径显式创建 Owner，再对外开放服务；普通注册不应被当作取得管理员权限的入口。已有服务器按管理后台提示完成初始化，切勿为了重新初始化而删除账本数据。若密钥、`server.secret`、`server-id`、数据库或旧 JSON 状态曾进入源码目录或版本控制，应按已泄露处理：停止服务、保留加密数据备份，轮换 `SYNC_SECRET`，撤销设备会话后重新登录。

首次启动会在持久卷中生成 `/state/server/server.secret`；后续 `compose up` 会复用它。显式传入 `SYNC_SECRET` 时必须长期保留同一值，不能在每次启动时重新生成。备份卷须先准备为容器内 `node` 用户可写，再执行下述维护命令。

## 备份、迁移与恢复演练

服务器当前 schema 为 27（`single_user_replica_storage_v27`）。启动及备份恢复只接受当前 schema marker，不提供旧 schema 的原地升级；升级部署前应核对数据版本并完成独立备份。旧版本数据的处理需另行确定支持边界和迁移方案。

服务器数据目录另存节点签名私钥 `node-signing.key`，供节点间复制使用。备份会包含该文件；数据库一旦绑定其公钥，私钥丢失时服务器拒绝自动生成新节点身份。

维护命令要求先停止服务器。备份先用 SQLite `VACUUM INTO` 生成一致快照，再复制 `server.secret`、`custody.key`、`server-id`、OPAQUE 服务器 setup 和附件目录；账号角色与设备会话都在 SQLite 中，不存在单独的管理密钥文件。每个文件写入 SHA-256 清单，全部校验通过后才原子提升备份目录。`server.sqlite`、`server.secret`、`server-id` 和 `opaque.server-setup` 是恢复必需文件。恢复会先预检到暂存目录，再保留原数据为 `*.before-restore-*` 并原子替换。

```bash
# Windows/本机部署
npm run server:backup -- --data-dir D:\ledger-server --output D:\ledger-backups\2026-07-19
npm run server:verify-backup -- --backup D:\ledger-backups\2026-07-19
npm run server:restore -- --data-dir D:\ledger-server --backup D:\ledger-backups\2026-07-19

# Docker：先停服务，并把宿主机备份目录挂到 /backup
docker compose stop sync-server
docker compose run --rm -v ./backups:/backup sync-server \
  node dist/maintenance.mjs backup --data-dir /state/server --output /backup/2026-07-19
docker compose run --rm -v ./backups:/backup sync-server \
  node dist/maintenance.mjs verify-backup --backup /backup/2026-07-19
```

恢复演练应恢复到隔离目录，使用临时端口启动，检查 `/api/ready`，再在管理后台执行数据库和附件校验，并用测试客户端拉取一份带图片的账本。恢复后保留恢复前目录，直到所有设备完成一次同步。当前服务器及备份工具只接受 schema 27；恢复工具撤销旧会话并清除未完成登录及密码重置码，需要重新登录。旧 PBKDF2/固定证明/一次性 challenge 认证、旧 JSON 状态、人工管理 Token 与旧 SQLite 基线都不读取、不转换。
