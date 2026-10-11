# 云同步与统一服务器 `@zichan/sync-server`

> 当前账号保护采用[云端托管与私密模式](ledger-protection.md)：托管账号登录后自动解锁，私密账号使用恢复码。最新验收见[交付记录](release-readiness.md)。


独立 `/admin/` 后台、账号角色、邀请有效期、密码恢复和管理审计见 [服务器管理后台](server-admin.md)。当前服务端 schema 为 22。

`@zichan/sync-server` 可在一个进程中提供 Web、密文同步和管理员 API，适合云主机、NAS 或家中常开的固定 IP 电脑。`ENABLE_WEB` 与 `ENABLE_SYNC` 可独立开关；`BASE_PATH=/home-ledger` 会把 Web、同步和管理端点统一挂到安全路径下。
只把 `apps/web/dist` 上传到静态文件托管只能得到浏览器前端，浏览器没有权限启动 Node 同步服务；需要同步时必须另外运行本服务，或直接使用其 Web + API 一体化部署。

与用户和账本相关的服务端持久状态包含登录账号与昵称、可选的已验证或待验证邮箱及通知偏好、邮件验证码摘要与配额通知队列、OPAQUE 注册记录、设备会话的 refresh token HMAC、随机托管凭据或恢复码包装的密钥封套、加密托管凭据、密文提交、密文附件分块、已加密 `.zcbak` 归档及必要目录元数据，不保存账号密码。服务器自身另外持久化 `server.secret`、`custody.key`、`server-id`、`opaque.server-setup` 和首次初始化使用的 `owner-setup.secret`。账本字段、附件文件名、MIME、明文 SHA-256 和正文不会以明文上传；备份归档的创建时间、原因、类型、显示标签、大小和代次属于服务器可见的目录元数据。不同服务器可使用不同用户名和账号密码；这些登录凭据不参与账本加密。旧版 V1 附件对象 ID 和分块密钥包含服务器与用户名作用域；新版 V2 只按账本派生，可由服务器后台原样复制。节点复制与统一登录的迁移边界见 [账本副本架构](ledger-replica-architecture.md)。

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
| GET/PUT | `/api/v4/account/encryption-key` | 读取或更新身份节点保存的加密账号私钥包；密码与登录密码分开 |
| GET/POST | `/api/v4/ledger/control`、`/api/v4/ledger/control/events` | 读取和追加签名成员控制事件；增加及移除成员时可原子保存对应密钥包 |
| GET/PUT | `/api/v4/ledger/member-envelope` | 读取本人或由所有者发放当前代次的成员密钥包 |
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
- `REGISTRATION_MODE`：`open`、`invite` 或 `closed`，新服务器默认 `invite`；仅所有者可在管理页动态修改。已有库的策略不被部署默认值覆盖。
- `SYNC_SECRET`、`SERVER_ID`：访问令牌签名和服务器身份配置；生产部署必须稳定保存。
- `TRUSTED_PROXIES`：允许提供 `X-Forwarded-*` 的代理 IP 或 CIDR（IPv4/IPv6），兼容显式的 `loopback/private`；优先限定到实际代理地址，不要在直接暴露 8787 时信任任意来源。代理链从右向左检查，到首个不受信任的地址为止。代理必须覆盖 `X-Forwarded-Proto` 为单一的 `https`；经代理的请求不能依靠 `X-Forwarded-For: 127.0.0.1` 获得本机 HTTP 豁免。
- `ALLOW_INSECURE_HTTP`：默认 `0`。设为 `1` 时，私有局域网的明文 HTTP 也可用于账号登录、同步、浏览器 Cookie 会话与管理后台（Cookie 不设置 Secure）；公网部署仍必须使用 HTTPS。仓库开发启动器默认设为 `1`，仅面向可信家庭局域网，切勿在公网暴露时开启。

明文 HTTP 下的能力与边界：浏览器把 `crypto.subtle` 与 Web Locks 限制在安全上下文。本应用在缺少它们时改用随包提供的纯 JavaScript 后端（`@noble/ciphers` / `@noble/hashes`）与 IndexedDB 事务租约，因此局域网 HTTP 可以正常解锁、记账、附件、备份与多标签互斥。AES-GCM（16 字节 tag）、SHA-256 和 HMAC-SHA256 在两个后端逐字节一致，现有账本与新写入可双向互读。Argon2id 仍由 `hash-wasm` 提供，是唯一没有回退的能力，缺少 WebAssembly 时明确拒绝解锁并说明原因。两点必须如实知悉：其一，明文 HTTP 无法保证传输中的页面代码和托管凭据不被截取或篡改，账本静态存储虽仍加密，但请仅在可信内网开启；其二，该退化路径下「记住设备七天」存不了不可导出的原生密钥，只能落原始密钥字节，保护强度低于原生路径，界面不得把它当作同等保护。另外局域网 HTTP 不是安全上下文，Service Worker 不可用，关闭浏览器后完全断网重新打开网页不受保证。

有效对象、回收区和未完成上传都计入配额；已登记迁移且对应 V2 仍可用的旧 V1 对象不再重复计入逻辑配额，但仍占用物理磁盘。V1 转换开始前须预留至少一个最大新附件的配额空余，并为 V1、V2 和备份预留磁盘空间。上传会话 24 小时过期；服务启动及每小时清理过期暂存和到期回收对象。
同一账本副本的 V2 附件由所有成员共用容量和账本宿主账号的附件配额；成员不能通过各自账号重复占用一份限额。管理后台的账号详情显示实际共享用量，成员账号不能单独修改该配额。旧版 V1 对象和管理后台部分按用户名汇总的运维视图仍待迁移。
账户 OPAQUE 注册记录、稳定 `accountId`、唯一服务器所有者、单次登录状态、设备会话、持久限流、邀请码、密码重置码摘要、账本密钥封套、提交、配额、备份索引、附件索引和管理日志统一保存在 `server.sqlite`。数据库启用 WAL、`synchronous=FULL`、外键、事务提交、提交 ID 唯一约束。常规启动的当前结构为 schema 24，支持 schema 6 至 23 的追加升级；停服完成旧影子结构退役后为 schema 25。升级保留账号 ID、原用户、所有者、注册策略及账本绑定，不重置业务数据。账本请求及会话可选择有权限的副本；其他未知结构停止启动，不自动删除数据。密文提交协议仍为 v3，拉取使用 `after` + `limit` 游标分页，请求体按端点限制大小。

## 认证与传输边界

OPAQUE 注册和登录都由客户端与服务器交换 PAKE 消息，账号密码不发送到服务器。注册完成 token 有效 5 分钟；登录中间状态绑定用户名和来源 IP、有效 60 秒且只能消费一次。客户端校验 OPAQUE 返回的服务器静态公钥，调用方也可传入已信任公钥拒绝身份变化。

空服务器关闭普通注册。首次访问 `/admin/`，通过 Web 引导设置管理员用户名和密码即可，无需读取初始化密钥。初始化请求使用同源管理通道，认领标记进入短期签名的 OPAQUE 注册完成凭据；用户与唯一所有者在同一 SQLite 事务中创建，并发创建只有一个成功。已有所有者后不能再次初始化或绕过注册策略。旧版密钥接口暂时保留兼容，但不再是 Web 初始化的前置条件。普通成员注册遵循 `REGISTRATION_MODE`；管理员不能禁用自己。

登录成功后，访问令牌有效 15 分钟，refresh token 每次使用后立即轮换且旧 token 不能再使用，设备会话最长 7 天。服务器只持久化 refresh token 的 HMAC-SHA-256。禁用用户会同时撤销其全部会话，用户和管理员都可按设备查看最近 IP、最后访问时间并单独撤销。管理 API 复用同一 Bearer 会话并在每次请求时检查数据库角色：无有效会话返回 401，成员访问返回 403。

同站 Web 登录使用 `X-Zichan-Session: cookie`，服务器验证请求 Origin 后，把 refresh token 写入 HttpOnly、SameSite=Lax 的账本 Cookie，以支持统一登录的跨站顶层跳转；管理 Cookie 仍为 SameSite=Strict。生产 HTTPS 下同时设置 Secure。Cookie 路径限定为部署前缀下的 `/api/auth`，登录与刷新 JSON 不返回 refresh token；刷新不能同时提供 JSON token。Cookie 为会话级；可选的七天设备解锁授权独立于 Cookie，详见账本保护说明。跨域 CORS 不允许这个自定义头，也不开放 credential。代理部署需保留公共 Host 并覆盖单一 `X-Forwarded-Proto: https`；当部署显式设置 `ALLOW_INSECURE_HTTP=1` 时，私有局域网明文 HTTP 也可使用同站 Cookie 会话与管理后台，此时 Cookie 不带 Secure，请仅在可信内网开启。

桌面和附加跨站连接使用独立 JSON token 传输；桌面 Stronghold 只保存刷新会话，不保存账号密码。后台同步不进行密码登录：令牌被拒绝时最多受控刷新一次，刷新失效后要求用户明确重新登录；网络错误和 5xx 保留会话用于重试。

旧版账号级保护、更换密钥包和整账本替换只适用于原个人账本。会话选中第二账本时这些写入接口拒绝请求；原账本一旦启用签名成员控制链，也拒绝旧保护写入、旧密钥包写入和单账号整账本替换。成员账本通过成员控制事件和当前成员密钥包轮换密钥，旧版保护读取暂时保留给原账号的迁移解锁路径。

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

明确确认“替换旧账本”时，服务端先在同一 SQLite 事务内保存旧副本身份、原密钥封套、全部加密提交和原保护设置，并保留旧副本槽位及其附件、备份目录关联。旧账号提交影子表与副本表的序号、密文和密钥包不一致，或磁盘空间不足时拒绝替换。替换成功后旧节点复制链路停用，旧授权撤销；新账本使用新的副本 ID 与流世代。旧托管密钥不会被错误地沿用到使用新密码创建的私密账本。

账号可通过 `GET /api/v3/replica/recovery` 查看自己的替换前检查点，通过明确确认的 `POST /api/v3/replica/recovery/restore` 恢复。恢复前会给当前账本另建检查点，恢复后仍需用旧账本密码或原托管方式解锁旧数据，并重新授权节点复制。网页“账本保护”中的高级恢复入口会先把当前本机账本备份到浏览器以外；恢复后暂停此连接，要求退出并重新从服务器加入。检查点保留的是原加密数据，并不能找回已经遗失的私密账本密码。整机文件损坏仍需使用独立的服务器备份。

只有预检完成后，客户端才创建本机设备级保护备份，并在一个本机 SQLite 事务中替换账本与设备同步状态，
随后采用远端密钥、整理附件并持久化匹配的服务器/副本身份。采用密钥、附件整理或客户端身份持久化失败时，
会恢复原数据库、原设备同步状态、原密钥和原服务器配置；连接、
密码、密文提交或预检任一阶段失败都保留原账本。

全新浏览器首次进入仍需分页取回并验证全部加密提交，界面会显示已接收数与远端总数；账本越大，这一步越久。附件正文和缩略图不会因首次恢复全部进入浏览器缓存，预览与导出按需下载。服务器之间的 V2 附件由后台分块复制。

### 加密账本备份副本

桌面端先把 `.zcbak` 原子保存到便携目录 `data/backups`，再以最多 4 MiB 的有界分块把同一份已加密归档
上传到所有已启用的同步服务器，并登记 `/api/v3/backups` 目录项。服务器只校验密文对象存在和目录元数据，
私密模式服务器不能解密归档，获授权托管的服务器可以解密；某台服务器失败不会删除本机文件或其他已成功副本。客户端上传后会按小时/日/周清理该服务器上的自动备份目录，
手动和导入前保护备份保持固定。设置页可列出、下载、演练和恢复服务器归档；如果归档属于旧密钥封套代次，
客户端会要求输入创建该归档时的账本加密密码，并且只在本次内存流程中使用。

## 多服务器桥接与附件同步

客户端把完整 URL 作为连接配置的唯一真值，并提供“当前网站 / 本机 / 局域网 / 公网”向导；协议、Host、端口和 Path 只是同一 URL 的高级编辑视图。公网 HTTP 会被拒绝（经审查放行的主机除外），本机及私有局域网可明确使用 HTTP；请求不接受跨 Origin 重定向。

同一账本可同时启用多台独立服务器。迁移期未核对成组的旧连接仍由客户端从各服务器拉取、合并提交 DAG、再逐台推送。若已配置节点属于同一账本、世代相符、通过近期的后台目录核对且形成连通复制组，浏览器会记录该组并只与当前网站节点同步；当前节点不可用时改用组内另一节点。服务器之间负责其余提交及 V2 附件传输，节点暂时离线不会使浏览器退回多服务器搬运。新增或更换节点会使本机的组记录失效，需重新核对。账本只同步经过身份固定的服务器别名、`serverId`、OPAQUE 公钥与用户选择共享的 URL，不同步用户名、密码、refresh session 或 localhost 默认地址。新设备先登录任意一台服务器恢复账本后，会看到其余服务器为“需要登录”。

新版节点加入流程允许目标服务器只先创建节点管理员账号。源账本账号签发短期授权后，目标节点管理员可让服务器自动创建独立的统一登录账本账号和空副本，再由后台复制提交及 V2 附件。节点管理员账号不会因此获得账本访问权；新账本账号只能通过身份节点的一次性授权码登录目标网站。原先为每台服务器独立注册并绑定账本的流程在迁移期间仍可使用。

自动同步先完成提交，再在网页运行且可联网时逐批处理本机可用正文与旧 V1 转换；每批最多 8 个对象或约 64 MiB，单个超过此限的对象仍单独处理。游标按账本、副本及节点身份保存在本机，关闭网页后再次打开可续跑；同步页显示当前批次的扫描、上传、旧版转存和失败状态。一轮扫描完成后核对并发布附件承诺目录。手动同步仍可一次处理全部当前引用；未核对的旧连接仍可能逐台上传。附件按明文 SHA-256 在本机内容寻址；远端 ID 是带密钥的 HMAC，不暴露明文哈希。旧版 V1 将 ID 限定在服务器、账本和用户名范围，新版 V2 将 ID 限定在账本范围，同账本节点可直接复制密文。正文按 4 MiB 分块独立 AES-256-GCM 加密和校验，重试只发送缺失分块。

正文和缩略图在已有远端副本时默认留在服务器，查看、保存或导出备份时才按需取回。旧版 V1 对象必须由持有账本密钥的客户端读取并重新上传为 V2；客户端可查询当前副本中旧对象的源账号路由。手动同步会显示旧附件检查、按对象完成的迁移数量、逻辑字节量和失败数量；迁移期间须保持网页打开，失败对象在下次同步中重试。未核对的旧连接仍可能由浏览器补传缺失附件，已核对的节点组则由服务器后台按缺块直接互传，关闭浏览器后仍可继续。界面展示附件数量、密文容量和本轮已核对字节；已核对量不等于实际传输量。节点对提交逻辑元数据、V2 附件清单、删除状态、密钥包、账号身份、签名成员控制链和当前成员密钥封套进行签名目录摘要比对；每个已绑定副本在后台逐块校验本地新版附件密文，损坏对象隔离后由下一轮复制补回。客户端发布附件承诺目录后，`/api/v4/ledger/readiness` 会实时核对已启用对端与本地证据，只有全部通过才将本节点标为 `READY`；整组三节点真实大账本验收仍未完成。元数据删除并同步成功后，远端对象先进入回收区；V2 删除标记会在节点间传播，显式恢复也会传播。

局域网节点每轮向中继签名上报本地副本状态，并保存中继签名返回的组目录与健康快照；任一节点的 `/api/v4/ledger/group-health` 都可显示整组状态。缺报或快照超过 60 秒即降级。授权过期或撤销仍保留成员并显示异常；只有账本管理者明确移出，才会从整组统计中消失。成员目录目前由中继管理，不是所有者签名的多节点控制链，也不能代替真实部署的三节点故障验收。

## Docker 与 HTTPS

```bash
cd apps/sync-server
SYNC_SECRET=$(openssl rand -hex 32) \
docker compose up -d
```

Compose 将父目录 `/state` 挂载到 `zichan-data`，实际 `DATA_DIR` 为 `/state/server`；这使恢复命令可以原子替换数据子目录。Caddy 负责 HTTPS，且会等待 `/api/ready` 通过。生产环境应固定 `SYNC_SECRET`、域名和 `BASE_PATH`，限制宿主机对数据卷的访问，不要把上游 8787 端口映射到公网。首次部署通过 `/admin/` 显式创建 Owner，再对外开放服务；普通注册不应被当作取得管理员权限的入口。已有服务器按管理后台提示完成初始化，切勿为了重新初始化而删除账本数据。若密钥、`server.secret`、`server-id`、数据库或旧 JSON 状态曾进入源码目录或版本控制，应按已泄露处理：停止服务、保留加密数据备份，轮换 `SYNC_SECRET`，撤销设备会话后重新登录。

## 备份、迁移与恢复演练

从 schema 6 至 12 首次升级到 schema 13 时，服务器会在 SQLite 内复制旧提交密文到按副本分区的新表；此步骤不复制图片等附件文件。升级前应先完成并验证独立备份，并为提交数据的临时双份占用预留空间。启动过程会按提交字节数、索引和 WAL 余量检查数据库所在磁盘；空间不足会停止迁移并保留旧数据。大账本的首次启动可能等待此数据库迁移完成。

新版本在服务器数据目录中另存节点签名私钥 `node-signing.key`，供后续节点间复制使用。备份会包含该文件；数据库一旦绑定其公钥，私钥丢失时服务器拒绝自动生成新节点身份。恢复旧备份时按旧版本身份规则升级。

维护命令要求先停止服务器。备份先用 SQLite `VACUUM INTO` 生成一致快照，再复制 `server.secret`、`custody.key`、`server-id`、OPAQUE 服务器 setup 和附件目录；账号角色与设备会话都在 SQLite 中，不存在单独的管理密钥文件。每个文件写入 SHA-256 清单，全部校验通过后才原子提升备份目录。`server.sqlite`、`server.secret`、`server-id` 和 `opaque.server-setup` 是恢复必需文件。恢复会先预检到暂存目录，再保留原数据为 `*.before-restore-*` 并原子替换。

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

恢复演练应恢复到隔离目录，使用临时端口启动，检查 `/api/ready`，再在管理后台执行数据库和附件校验，并用测试客户端拉取一份带图片的账本。迁移成功后保留恢复前目录，直到所有设备完成一次同步。当前服务器及备份工具接受 schema 22 和可追加升级的 schema 6 至 21；恢复工具撤销旧会话并清除未完成登录及密码重置码，需要重新登录。旧 PBKDF2/固定证明/一次性 challenge 认证、旧 JSON 状态、人工管理 Token 与旧 SQLite 基线都不读取、不转换。
