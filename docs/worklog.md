# 工作日志 Worklog

A running record of what the coding agent did on this project — what changed, why, and how
it was verified. Newest entries first. (Requested: “记录你做什么操作”.)

---

## 2026-09-12 — 托管账号与发布就绪验收

- 统一当前文档中的云端托管、私密恢复码及独立管理员入口；旧日期条目仅作历史操作记录，不代表现行设计。
- 补全主动改密、自助设备撤销、唯一 Owner 本机恢复、生产 Web 离线资源和原生离线入口。
- 完成隔离 HTTPS 备份恢复、手机 360/390 px 和真实 Windows 便携目录移动、离线冷启动、强制退出后恢复验收；测量并优化大账本计算和密码库加载。
- 最终全量回归发现两个浏览器等待时序问题，分别补上替换后的重载等待、旧页面关闭后的 Service Worker 激活等待，针对性复验通过。最终交付状态持续记录在 [release-readiness.md](release-readiness.md)。
## 2026-09-01 — 快速记账时间推荐与弹窗背景修复

- 修复快速记账只设置宽高、未设置面板背景造成的透明问题；桌面补齐实体背景、边框、圆角和阴影，手机使用带安全区的底部实体面板。
- 快记默认值改为“显式模板 / 草稿优先，个人同时段习惯其次，饭点规则兜底”：05:00–10:00 早餐、10:30–14:30 午餐、17:00–21:00 晚餐、21:00–02:00 夜宵。推荐只预填分类与描述，金额始终为空，并在弹窗内展示原因和恢复推荐按钮。
- 个人习惯从不受页面筛选影响的最近最多 1000 笔支出中取近 60 天样本，区分工作日与周末、匹配当前时间前后 90 分钟；至少 3 笔且第一名占比达到 60% 才覆盖内置饭点。停用或不可用分类不会被推荐，餐类细分也不会被隐式启用。
- 验证：全仓 Vitest 521 项、真实 Chrome Playwright 11 项全部通过；ESLint、全部 TypeScript 类型检查和 Web 生产构建通过。

## 2026-09-01 — 账本级自定义导航

- 设置页新增“侧边栏与模块”：用户可逐项显示/隐藏模块、上下调整顺序或恢复当前记账模式的推荐布局；日常收支与设置保留固定入口，隐藏模块不会删除任何历史数据。
- 桌面完整侧栏和平板图标轨直接显示所有已启用模块，不再按轻量模式把其他模块固定塞进“更多功能”。手机底栏复用同一顺序并显示前 3 项，只有已启用的溢出项进入“更多”，未启用模块不会出现在抽屉。
- 导航配置以版本化 JSON 保存到活动 `Setting`，随账本备份和加密同步；当前开发数据库基线更新为 schema 116，不迁移旧开发库。
- 新增导航偏好单元测试和真实 Chrome 流程，覆盖启用模块、调整顺序、刷新持久化、手机端复用以及停用后移除入口。
- 验证：全仓 Vitest 514 项、真实 Chrome Playwright 11 项和发行契约 21 项全部通过；ESLint、全部 TypeScript 类型检查、共享包构建、Web 生产构建和版本/schema 一致性检查通过。

## 2026-09-01 — 新账本零配置支出流程

- 首次初始化主入口改为“直接开始记支出”：固定创建人民币 `spending` 账本和 10 个无金额常用支出模板，随后直接打开快速支出弹窗。导入、演示和其他基础币种/账本模式收进次级入口；不创建账户、余额、持仓、预算、账单或虚假流水，也不迁移或追补旧开发数据。
- 轻量模式导航默认以“日常支出 / 支出报表 / 设置”为主；其他模块由用户在“侧边栏与模块”中按需启用和排序。日常支出页固定为支出视图，但保留双入口：页面“+ 记支出”和模板打开完整的仅支出、无账户表单，商户、地点、标签、备注、附件、分类管理和拆分能力不再被简化入口替代；侧栏/移动端“快记”和首次引导才使用只要求金额的快速弹窗。两种入口的模板都只预填，草稿均可自动保存、确认关闭和恢复。
- 资产转换空状态提供 USD/HKD/EUR/JPY/USDT/BTC/ETH 常用入口，选择时仅按需添加资产定义，不写余额或交易。游戏首次只填游戏名即原子创建“当前赛季”，轻量模式的游戏资金流水不再要求账户；物品空状态提供手机、电脑、家电、车辆快捷分类卡片。
- 同步修正游戏无账户资金流水的数据体检规则：轻量模式允许交易与关联同时无账户，账户/资产模式仍严格要求账户且两侧必须一致。
- 修复按需分类包的状态闭环：显式启用会补齐并显示系统分类，停用会将包内全部分类（包括已有历史引用者）设为不可用于新记账，且不会删除历史分类或改写流水；再次启用可恢复。分类包卡片改为显示真实启用数、完整按钮状态和失败反馈。
- 更新 Playwright 首启与账本工作流，使其覆盖一键初始化、完整支出表单、模板预填、显式快记、刷新持久化、两类支出草稿恢复和嵌套弹窗焦点。
- 验证：全仓 Vitest 510 项、真实 Chrome Playwright 10 项和发行契约 21 项全部通过；ESLint、全部 TypeScript 类型检查、共享包构建、Web 生产构建、版本/schema 一致性检查通过。

## 2026-08-31 — 账号化多服务器同步与纯本地模式重构

- 首次启动在数据库初始化前选择“纯本地”或“连接同步服务器”。Windows 纯本地直接使用便携数据目录；浏览器只有在 IndexedDB、WebCrypto、WASM、Web Locks 可用且持久存储授权确认成功后才能新建纯本地账本。已有浏览器数据失去持久授权时进入只读恢复模式，可重新申请授权、导出 `.zcbak` 或连接服务器。
- 同步连接改为“共享服务器目录 + 当前设备连接”双层模型，持久化内容只保存规范化完整 URL；当前网站、本机、局域网和公网向导以及协议、Host、端口、Path 高级字段均为同一 URL 的编辑视图。支持多台独立服务器同步同一 `ledgerId`，提交 DAG 可在局域网与公网服务器之间桥接。
- 账号认证改为 OPAQUE。每次注册、登录、刷新和携带 Bearer 的管理请求前先匿名校验 `serverId`、OPAQUE 公钥及可选连接链接指纹，禁止跨 Origin 重定向和跨服务器复用凭据。同一身份的备用地址自动合并，服务器 ID 相同但公钥变化时立即阻断。
- 同步服务器默认监听 `0.0.0.0` 并开放注册；第一位成功完成注册的账号在同一 SQLite 事务中成为唯一管理员，后续账号为成员。新增 `/api/auth/me` 与 `/api/admin/*` 账号管理接口，彻底删除人工 Admin Token、`X-Admin-Token`、旧管理路由及相关文件和配置。
- 同一服务器的备用地址不再只保存：主地址网络不可用时逐个匿名核对身份后切换，成功地址同时用于提交和附件同步并成为当前地址；身份变化或账号认证失败不会触发盲目切换。合并地址时保留用户手工指定的“随账本共享 / 仅此设备”范围。
- 修复公网 HTTP 域名绕过：IPv6 ULA/link-local 只对合法 IPv6 字面量按 `fc00::/7`、`fe80::/10` 判断，`fcorp.example`、`fdomain.example` 等域名不再被误认成私网。
- 为支持官方 Web 连接自建服务器，CORS 允许任意 Origin，但不启用 Cookie 凭据，只开放必要方法和 Header；公网地址要求 HTTPS。连接链接和二维码只携带 URL、`serverId` 与 OPAQUE 公钥指纹，不包含密码或会话。
- 服务器模式在浏览器未取得持久授权时可作为非持久本地缓存运行，默认自动同步，并在每次账本写入后触发防抖增量同步。加密公共服务器目录会随账本恢复到新设备，各服务器密码和 refresh session 仍保持独立。
- 当前开发基线直接更新为本地 schema 115、同步服务器 `server_account_owner_v6`（schema 6）；不读取或迁移旧 profile、旧会话凭据、PBKDF2/HMAC 认证、Admin Token 或旧服务器数据库，发现旧开发数据时明确要求重置。
- 验证：全仓 Vitest 与覆盖率各通过 496 项用例；浏览器 Playwright 首启与账本工作流 7/7；ESLint、全部 TypeScript 类型检查、共享包/Web/同步服务器生产构建、21 项发行契约及版本一致性检查通过；桌面 Rust `fmt`、`check` 通过，`cargo test` 为 20 项通过、1 项按约定忽略。

---

## 2026-08-30 — 便携版原生备份另存为

- Windows WebView2 不提供可靠的 Blob 下载保存或桌面系统分享，已完成的 `data/backups` 归档会表现为点击「分享 / 下载」没有任何结果。便携桌面现在改用 Windows 原生「另存为」窗口：历史备份和顶栏即时导出均先使用原子本地归档，再复制到用户选择的 `data/` 外位置。
- 导出使用临时文件、`sync_all`、SHA-256 比对和原子替换；取消或失败不触碰原归档，且拒绝把所谓“独立副本”重新保存进便携 `data/`。设置页显示保存中、成功、取消和失败结果。

---

## 2026-08-29 — Windows 脚本目录收敛

- `scripts/` 现只保留可直接执行的开发启动/停止、Windows 双击入口和便携构建链；发布构建测试迁至 `tools/release/tests/`，CI 专用 schema 契约导出器迁至 `tools/ci/`。
- 根 npm 命令、GitHub Actions 和脚本说明已同步到新位置；目录内不再包含 `*.test.*` 文件，日常启动与构建命令保持不变。
- v0.1 完全便携发行仍明确只支持 Windows x64。后续可单独做 i686 Debug 编译冒烟，但在引入 x86 Node、WebView2、打包契约和验收矩阵前，不将其作为可运行或可发布的便携版本。

---

## 2026-08-29 — 便携版规范化路径 SQLite 修复

- Windows 便携根目录规范化为 `\\?\` 扩展路径后，SQLx 不再把该路径拼接并重新解析为 SQLite URL；数据库连接改为直接接收 `Path`，避免把扩展路径中的 `?` 误解为 URL 查询参数。
- 新增规范化数据库路径回归测试，覆盖实际 portable 目录的 Windows 连接方式。打包器也会在同名输出目录已有 `data/` 时拒绝覆盖，避免本地构建删除正在验证的便携账本。

---

## 2026-08-29 — 便携 WebAssembly 与诊断可复制性修复

- 桌面 CSP 对本地 `sql.js` 仅加入 `wasm-unsafe-eval`，允许 WebAssembly 编译而不放宽为 JavaScript `unsafe-eval`；避免便携版在数据库初始化阶段被 CSP 拦截。
- Windows WebView 显式启用剪贴板访问；数据库初始化失败页新增可选择的完整诊断文本、复制按钮和 `Ctrl+A`/`Ctrl+C` 回退提示，不再要求通过截图转录错误。

---

## 2026-08-29 — 便携同步服务器扩展路径修复

- 内置 Node.js 无法把 Windows `\\?\` 扩展路径作为主脚本或工作目录加载，会在 `lstat 'D:'` 后以 exit code 1 退出。桌面启动器现在在交给 Node 前恢复普通本地路径，入口改为相对 `server.mjs`，并同样规范化 `DATA_DIR`。
- 新增 Windows 回归测试和隔离启动检查，覆盖启动、`/api/health`/`/api/ready` 就绪与标准输入 `shutdown` 正常退出；服务器状态和失败提示不再向界面暴露扩展路径前缀。

---

## 2026-08-28 — P0 数据安全闭环与日常操作入口

- 价格标记表单移除没有行情提供商和刷新链路支撑的“自动”伪入口；v0.1 新增和编辑统一写为手工来源，同时保留旧数据的读取兼容。
- 加入已绑定远端账本改为分阶段安全流程：只读确认副本、用远端账本密码解锁密钥封套、在隔离库拉取并验证全部提交、创建本机保护备份，再事务替换数据库与设备同步状态；采用密钥、附件整理或服务器副本身份持久化失败会恢复原账本、原设备状态、原密钥和原服务器配置。
- 新账本首次初始化即创建或解锁备份密钥。Windows `data/backups` 明确降级为同介质本机恢复点，不再冒充独立副本；归档先本地原子落盘，再分块上传所有已启用同步服务器，单台失败保留本机文件并记录远端结果。设置页新增历史归档的旧账本密码入口，校验、演练与恢复复用同一次内存解锁结果。
- 重置成功路径除数据库和附件外，同时清理 WebView IndexedDB 表单草稿、Stronghold、本机数据密钥、账本密钥封套/会话、同步配置与自动同步、运行时凭据、设备身份和备份安全状态，避免新账本继承旧 `ledgerId`、草稿或密钥；Windows `data/backups` 历史加密归档按恢复点语义保留。
- 报表把用户范围先统一截断到账本 `asOfDate`，主表、趋势、指标、预算、同比/环比、下钻、分页和导出共享同一有效范围，未来流水不再在同页形成不同口径。
- Dashboard 增加统一待办中心，汇总定期账单、定投、耗材、本机/逐服务器备份失败和持久化同步异常；完整成功会清除相应旧错误。备份运行结果仅保存在当前设备，不会被账本设置中的遗留值或其他设备覆盖。定投待办可直接打开预填转换弹窗，保存时在事务内重新核对计划与期次，并把转换和 DCA 执行一起提交。
- `runInAuditBatch` 承载的普通产品命令默认记为用户审计批次并保存整批业务补偿。History 在只回滚事务中预演全部逆向状态，确认后原子撤销整批；确定性冲突阻止撤销，临时错误保持待处理并允许重试；事务已经提交后即使审计摘要或同步提交封存失败也不会重新开放补偿，避免二次撤销。
- 最终门禁实际通过：全仓 Vitest 与覆盖率各为 72 个测试文件、466 项用例；发行契约 16/16；ESLint、全部 TypeScript 类型检查、Web 与同步服务器生产构建通过；系统 Edge Playwright 交互冒烟 4/4。桌面 Rust `fmt`、Debug/Release `check` 通过，`cargo test` 为 16 项通过、1 项按平台条件忽略。

---

## 2026-08-23 — Windows v0.1 完全便携发布基线

- Windows v0.1 改为 portable-only ZIP：`zichan.exe` 同级 `data/` 承载账本、附件、备份、Stronghold、WebView 和内置服务器状态；Release 不读取或回退 AppData。
- 发布脚本改用 `tauri build --no-bundle --ci`，固定并校验 WebView2 x64 Runtime，生成便携标记、逐文件 SHA-256 清单、ZIP 和外层哈希旁车；敏感数据、数据库、PDB 和 updater 产物禁止入包。
- 开发同步服务器显式使用仓库 `.runtime/sync-server`；移动/备份要求完全退出，运行中克隆和两个副本并发不受支持。
- MSI/NSIS、PFX/Authenticode、updater、GitHub 发布和正式 schema 迁移基线统一延期至 1.0，v0.1 不保留活跃安装器门禁。

---

## 2026-08-13 — Windows 桌面主程序与中文安装包修复

**Goal:** 修复多 Cargo 二进制导致的 Tauri 主程序误选，以及中文产品名在默认英文 MSI 代码页下无法链接的问题。

- Cargo 与 Tauri 双层显式固定主程序为 `zichan`；发布验签辅助程序改由 `release-verifier` feature 隔离，普通桌面构建和安装包不再携带内部 verifier。
- WiX MSI 固定使用 `zh-CN` / 代码页 936，NSIS 提供简体中文与英文；解决 WiX `LGHT0311` 中文字符无法写入 codepage 1252 的失败。
- 发布一致性门禁新增主二进制、验签 feature 与 Windows 安装器语言检查；Windows CMD 在构建前执行该门禁、清除旧安装器并在构建后强制确认 `zichan.exe`、MSI 和 NSIS 三类新产物存在。CI 显式启用 feature 测试和验签工具，要求 MSI/NSIS updater archive 都存在并被更新清单引用。
- 验证：全 workspace 类型检查和 421 项应用/共享测试通过；9 项 release 测试、Rust 格式检查、5 项桌面测试与 3 项 verifier 测试通过。`build-desktop.cmd` 在删除旧产物后完整生成 `资产生命周期_0.1.0_x64_zh-CN.msi` 和 `资产生命周期_0.1.0_x64-setup.exe`；生成的 WiX 清单主文件指向 `zichan.exe`，且不再包含 `verify-updater-signature.exe`。

---

## 2026-08-13 — Windows CMD 固定入口与桌面构建前置检查

**Goal:** 为 Windows 双击场景提供可诊断的固定任务入口，同时避免在仓库根目录堆放启动脚本。

- 按要求删除根目录 `start.cmd` / `stop.cmd`；当前使用文档统一指向 npm 命令或 `scripts/windows/`，旧工作日志保留当时的历史事实。
- 新增 `start-all.cmd`、`start-web.cmd`、`start-sync-server.cmd` 和 `build-desktop.cmd`：组合入口一键打开 5173 开发 Web 与 8787 同步/管理服务器两个独立窗口；单项入口分别启动严格占用 5173 的 Web、使用 `%APPDATA%\ZichanLedger\server` 且自带静态 Web 的一体服务器，以及构建包含 Web/同步资源的 Tauri EXE、MSI 与 NSIS 安装包。
- CMD 从自身位置解析仓库根目录，检查 Node.js 22.3+、npm 与依赖目录；桌面构建额外检查 Cargo、Rust 和 Perl。入口不自动安装依赖、不抢占端口、不结束未知程序，失败会保留窗口并传递真实退出码；`.gitattributes` 固定 CMD 为 CRLF，避免 Windows 批处理静默跳过命令。
- 根 Node 约束从 `>=20` 对齐到同步服务实际要求的 `>=22.3`；`scripts/` 已按 `dev/`、`db/`、`release/`、`windows/` 落地分类，npm、CI、发布工作流、内部相对路径和当前文档引用全部同步更新。
- 验证：四个 CMD 均由真实 `cmd.exe` 完成解析与环境检查；Web 返回 HTTP 200；同步服务使用隔离临时目录启动并通过 `/api/ready`，测试后 5173/8787 均无残留。分类后的 PowerShell、Git Bash 与 Node 脚本解析通过，schema 115 实际导出 122 条语句，release consistency 与 7 项发布测试通过。桌面构建的 Web、sync-server 和资源准备通过，release Rust 编译确认本机缺少 Perl；入口已把该条件前移为即时、可操作的预检错误，完整安装包需安装 Perl 后复跑或由 CI 构建。

---

## 2026-08-13 — P1 首次启动、交互恢复、发布门禁与总览读模型

**Goal:** 在不提前引入 1.0 迁移链的前提下，消除演示数据误混入、弹窗无障碍缺口、发布元数据漂移和 Dashboard 全量流水读取。

- 空库解锁后改为“空账本 / 导入备份 / 体验演示”三选一；空账本显式选择基础币种与账本模式，备份先预检和独立演练再原子恢复，演示数据只在明确选择时创建并持续标识。
- `Setting` 增加 `ledgerKind / initializedAt`，当前开发 schema 提升为 115；初始化完成前不执行附件恢复、维护、定期任务和自动备份。个人账本的维护不会注入演示标签、地点、模板、预算或定期流水。
- 浏览器 sql.js 驱动在整个打开周期持有跨标签页独占 Web Lock，第二个标签页会被明确拒绝，避免两个内存快照覆盖同一 IndexedDB；重置入口统一先关闭 Store 并释放锁，再清除本机账本并返回首次启动向导。
- 解锁、首次初始化、返回解锁和重置都使用同步 single-flight，堵住 React busy 状态生效前的双击窗口；重置会先暂停并排空自动备份，防止删除后由晚到任务重新创建 IndexedDB。原生数据库在 open / prepare / dataPath 失败时也会关闭连接。
- 设备备份恢复把数据库提交、设备密钥采用和附件 promotion 明确分段；业务事务一提交便采用新密钥并把 staging 标为可恢复，即使审计收尾或附件落盘失败，重启仍可继续完成。合并恢复只保留本机唯一 Setting，schema 以部分唯一索引保证一个活动设置，备份预检拒绝多个活动设置。
- 拒绝旧开发库的路径保持物理零写入：sql.js 纯读关闭不再导出覆盖快照，SQLCipher schema 探测不启用 WAL；未标记旧表也不会被补写 migration marker。
- 新增统一 portal `DialogShell` 和根级 `AppErrorBoundary`；弹窗具备焦点锁、Escape、焦点恢复、嵌套滚动锁和 ARIA 语义，渲染失败可重试、返回总览或复制诊断信息而不重置账本。
- Dashboard 流水改为 SQL 有界读模型：精确余额聚合、所选期间收支聚合和最近 6 条动态；页面不再读取全部流水、拆分与退款分配，金额从 SQL 到格式化、颜色判断始终使用十进制字符串或 `decimal.js`，不经过 JavaScript 浮点数。
- CI 增加 Rust fmt/check/test、schema 三驱动契约、sync-server 生产构建及 Docker health/ready；发布门禁校验 npm/Tauri/Cargo/lock/发布说明/schema、精确标签、签名材料和安装包/更新清单一致性。
- updater 产物由 Rust 按 Tauri 的 Base64 包装规则执行真实 Minisign 公钥验签；Node SQLite、sql.js 与 SQLCipher 均执行从 `@zichan/db` 导出的同一 schema 115/关键查询契约。
- 正式迁移框架仍按下述决策延后至 1.0；115 只是当前唯一开发基线，不提供 114 → 115 升级链。
- 最终验证：全仓 **421 项**测试通过（core 87 · db 131 · logger 5 · sync-server 19 · web 179），覆盖率门禁同样 421 项通过；全部 workspace typecheck 与 ESLint、共享包/Web/sync-server 生产构建、release consistency/artifact 脚本、Rust fmt/check、8 项 Rust 单测及 1 项 SQLCipher schema 契约均通过。Playwright 新增首次启动与嵌套弹窗回归；本机会话未安装 Playwright 自带 Chromium，系统 Chrome 回退在受管桌面会话中未正常产出结果，CI E2E 继续作为浏览器实跑门禁。

---

## 2026-08-13 — 决策：正式数据库迁移延后至 1.0

**Decision:** 当前仍是 `0.1.0` 开发阶段，不建立从 schema 114 开始的长期迁移链；以 `1.0` 最终结构作为首个正式兼容基线。

- 当前账本继续只接受最新开发 schema；旧 marker、旧表或字段漂移仍走显式重置/备份恢复，不做猜测性原地转换。
- `1.0` 发布准备时重新核定并冻结当时的 schema，正式迁移只承诺 `1.0 → 后续版本`，不预先承诺开发期 schema 114 可升级到 1.0。
- 事务迁移、失败回滚、幂等、未来版本拒绝、sql.js / Node SQLite / Tauri SQLite 一致性及兼容测试矩阵均记为延期事项，实施前必须重新提交详细方案审批。
- 首次启动向导获批后，当前开发基线推进为 `current_schema_2026_08_13_first_run_ledger`（version 115），用于持久化初始化状态与个人/演示账本标识；依照上述开发期规则，不提供 114 → 115 迁移链。

---

## 2026-08-13 — P0 正确性修复与报表增强

**Goal:** 消除设置维护、金额筛选、估值和定期任务中的静默错误，并把期间比较、预算偏差和可下钻驱动纳入报表。

- 设置页快照保持轻量，只新增完整分页的分类目录；不再从 scope 之外的空流水/附件数组执行自检和清理。
- 附件正文自检改为 400 行游标分页遍历全部有效附件；测试流水由 SQLite 在描述、商户和备注中匹配 `测试 / test`，分页读取命中流水及其附件，于一个审计事务中作废流水并移除附件。拆分作为作废历史保留，不进入有效报表。
- 新增 405 条跨页回归，覆盖设置分类计数、第二页附件检查、第二页测试流水及附件清理，以及普通流水不被误处理。验证：Web 目标测试 3 项、`@zichan/db` 与 `@zichan/web` typecheck 通过。
- 流水金额筛选不再用 SQLite `REAL` 或 JavaScript `Number`：基础上下限与高级查询的等于、集合、区间统一比较规范化十进制指数/有效数字，支持超大值和科学计数法；非有限值与超出 SQLite 精确指数边界的条件显式拒绝。
- 定期流水生成改为数据库唯一键 + 原子租约 claim + token/version CAS；不同 store、标签页或进程并发时只允许一个执行者生成流水/审计，晚到失败不能覆盖成功，`latest` 策略的跳过期次同样先 claim。崩溃租约最多两分钟后可由后续执行接管。
- 估值对同币对标记使用 `date / updatedAt / createdAt / id` 稳定决胜，换算路径按最少跳数、最弱边新旧、倒数边数和字典序确定性选择。`ResolvedPrice` 传播路径、价格标记、最旧日期与陈旧状态；非零缺价持仓不计入小计，整体标记为 `partial`，兼容字段中的 0 不再可作为权威估值或假亏损。
- 日常收支报表增加本期/上期/去年同期的收入、支出、净收支对比；进行中范围按账本 `asOfDate` 截断后同口径对比。新增月度预算原定/含结转可用/实际/偏差，以及按相对上期净收支影响绝对值排序的前三分类驱动；驱动可分别下钻本期/上期流水，预算行可下钻对应月份。
- 报表下钻按日期与分类直接使用 SQLite 游标分页，明细 CSV 复用同一条件流式导出；不再出现目标分类落在后续分页时第一页空白的问题。预算偏差表展示完整预算行，清除分类下钻会恢复主报表日期范围。
- 目标验证：`packages/core/test/valuation.test.ts` 14 项、`apps/web/test/report-analysis.test.ts` 与 `reports.test.ts` 共 15 项通过，覆盖标记/路径输入顺序无关性、缺价/陈旧元数据、进行中日期对比、前三驱动和月度预算偏差。
- DB 全量 14 个测试文件、128 项通过，覆盖精确金额的 count/游标分页、大数/科学计数法、共享 SQLite 双 store 并发与过期租约；全 workspace typecheck 通过。
- 最终验证：全仓 **379 项**测试通过（core 87 · db 128 · logger 5 · sync-server 19 · web 140），全部 workspace typecheck 与 ESLint 通过；共享包、Web 和 sync-server 生产构建通过。浏览器实测年度同比/环比、10 条预算偏差、前三驱动及 SQL 分类下钻（6 笔缩到目标 1 笔）；总览、报表、设置、管理均可双向滚动，弹窗关闭后页面滚动锁正确释放。

---

## 2026-07-23 — P2 真实使用、性能、备份流式化与桌面发布门槛

**Goal:** 完成表单防丢、业务补偿撤销、按页面数据读取、超大备份、定期任务可观察性、游戏资金闭环、原生权限收紧和可重复发布验证。

- 当前账本固定为 `current_schema_2026_07_23_p2_release_readiness`（version 110），便携账本固定为 version 7；用户备份统一为二进制 `.zcbak` archive v3，不读取旧 JSON/Base64 备份。
- 通用表单按实体自动保存 IndexedDB 草稿，附件草稿一并恢复；关闭、切页和窗口退出前检查未提交修改。成功保存/删除会清除草稿，关闭确认明确提供“继续编辑”或“保留草稿并关闭”。
- 预算、保存筛选、定期交易、物品使用指标/记录/目标、游戏记录、物品事件与耗材删除改为 CAS 业务命令和补偿撤销；标签、地点、资产、游戏、账号、赛季及物品继续使用归档、合并、引用迁移和影响预览，不开放通用产品级 `remove`。
- 游戏充值、提现、购买、出售和手续费支持仅登记、关联已有流水、同时创建流水；游戏记录不再直接改变余额。删除系统创建的资金流水会作废，撤销时按精确版本恢复，用户关联的流水不被误删。
- 定期任务只承诺应用打开时补齐；执行记录增加成功/跳过/失败、尝试时间、错误、重试次数和指数退避。流水页展示积压预览与历史，并可立即重试；确定性 ID 防止跨设备重复生成。
- Repository 增加 SQL `COUNT`、`limit/offset` 和提交后实体类型变更总线。`useSnapshot(scope)` 以 400 行分页，只订阅页面所需集合；十个主页面通过 `React.lazy` 独立加载，最大业务页面块从 568 KB 降到 81 KB。
- 备份改为 1 MiB AES-GCM 帧流：完整归档头和帧上下文进入认证数据，附件按需读取，不再一次性转 Base64。桌面端新增 begin/append/commit/abort/read-chunk 命令，以临时文件、`sync_all` 和原子 rename 写入 `AppData/backups`。
- 报表新增真实分页 PDF；Canvas 使用系统中文字体渲染页面，再嵌入标准 PDF 1.4。日常收支、定投、转换、游戏和物品报表均可下载，空数据路径有明确保护。
- Tauri CSP 从 `null` 收紧为显式策略；桌面 capability 只保留 SQL load/close 和实际 Stronghold 命令，移除未使用的原生 notification 插件。Rust 修复备份文件名借用错误并通过编译。
- 新增隔离的 ESLint、官方 Vitest V8 coverage 和 Playwright 工具目录；CI 执行 lint、类型、覆盖率阈值、Web 构建，以及“新增流水重载 / 草稿恢复 / PDF 文件头”真实流程。
- 新增桌面发布流水线：可选 PFX 签名、RFC 3161 时间戳、签名校验、全新 Windows Runner 静默安装、启动 8 秒、卸载和安装包上传；发布步骤与 Secret 记录在 `docs/desktop-release.md`。
- 验证：全仓聚合测试 **283 项**通过（core 63 · db 84 · logger 5 · sync-server 17 · web 114）；全 workspace typecheck、共享包/Web/sync-server 生产构建、`cargo fmt --check`、`cargo check` 和 3 项 Rust 单测通过。实际浏览器完成轻量记账、重载持久化、关闭提醒、草稿恢复、按需页面加载和报表生成，控制台无错误。
- 当前环境无法安装新增的隔离质量依赖，因此 ESLint、官方 coverage provider 和独立 Playwright CLI 未在本机执行；其测试发现配置已用现有 Vitest 聚合跑通，正式安装和执行由 CI 完成。内置浏览器不暴露 Blob 下载事件，PDF 下载事件留给 CI Playwright 验证。

---

## 2026-07-23 — P0 收支口径、物品资金闭环与同步会话安全

**Goal:** 消除非法流水状态、退款口径分叉、月末漂移、缺汇率假精确和固定认证证明重放风险，并把物品生命周期的后续资金事件纳入同一账务闭环。

- 当前账本固定为 `current_schema_2026_07_23_cashflow_correctness`（version 109），便携备份固定为 version 6，同步服务器固定为 `server_nonce_auth_sessions_rate_limits_v3`（schema v3）；项目仍不读取或迁移任何开发期旧结构。
- 流水持久化状态只允许 `pending/cleared`；“已对账/部分对账”由关闭对账批次及逐笔明细推导。Repository、服务层、Doctor 和导入预检统一校验流水类型、状态、记录状态、调整方向、退款归属/分配、时间精度/消歧和报表处理枚举；聚合编辑增加显式 `expectedVersion` CAS。
- `transactionReportingEffect()` 成为预算、日历、月度摘要、趋势、分类报表和明细导出的唯一收支解释。退款冻结归属日、币种、金额与分类分配；跨月“回冲原日期”会落在原消费日，报表明细同时显示归属日与实际到账时间。
- 定投提醒和自动执行共用月末锚点周期引擎，覆盖闰年及 29/30/31 日。缺汇率时只汇总已估值金额并列出未估值币种；总览不再显示精确净资产占比或比例条。
- `fixed_asset_cashflow_links` 将购买、维修、升级、耗材和出售统一为“仅登记 / 关联已有流水 / 同时创建流水”。链接一对一冻结资金方向、来源金额、记账金额、实际汇率和流水所有权；保存/编辑/删除同事务执行，用户关联流水不被误作废，系统创建流水随来源作废。
- 同步账号改为 PBKDF2 verifier + 一次性 HMAC nonce challenge；challenge 绑定服务器、用户名、来源 IP 和有效期。登录产生 15 分钟 access token 与轮换 refresh token，设备会话可由用户或管理员查看、撤销，禁用用户会撤销全部会话；客户端串行化同配置认证，避免并发 refresh 竞争。
- 公网同步强制 HTTPS，客户端拒绝向公网 HTTP 发送 verifier 或 Bearer token；私有局域网 HTTP 必须由服务器显式开启。反向代理头仅接受可信代理，CORS 使用白名单，限流状态落 SQLite；远程管理始终要求 HTTPS。
- 清除仓库内服务器密钥、身份和旧 JSON 运行数据，补齐 `.gitignore`。历史运行密钥按已泄露处理，部署文档要求轮换 `SYNC_SECRET` 并撤销设备会话。
- 验证：全 workspace typecheck 通过；`npm test` 共 **277 项**通过（core 63 · db 80 · logger 5 · sync-server 17 · web 112）；共享包、Web、sync-server 生产构建、桌面资源生成、`cargo fmt --check` 和 `cargo check` 均通过。桌面内置服务器从临时数据目录实际启动，`/api/health` 返回协议 3、nonce 认证和设备会话能力，`/api/ready` 确认 SQLite 数据库正常。

---

## 2026-07-22 — P1 核心正确性、密钥分层与完整设备恢复

**Goal:** 把并发覆盖、悬空主数据、退款归属漂移、物品漏记现金流、跨币种误算、同步审计和备份密钥恢复收敛为当前唯一实现。

- 账本基线提升为 `current_schema_2026_07_22_p1_correctness`（version 108），便携账本提升为 version 5；开发期旧 schema、旧备份与旧同步服务器结构继续明确拒绝，不增加兼容迁移。Repository 更新/删除改为 SQL `version` CAS，受影响行数为零抛出 `ConcurrencyError`，防止多个窗口静默互相覆盖。
- 流水聚合服务统一校验启用的对应收支二级叶子分类、精确拆分合计、账户与转账双方、资产精度及日期/时区快照。流水和转换保存本地日、时间精度、IANA 时区、UTC 瞬间、偏移与 DST 歧义选择；金额工具禁止跨币种直接相加。
- 分类、账户、商户和物品分类的产品入口改为“预览影响 → 归档”或“迁移引用 → 合并”，不再直接删除。合并在单一事务/审计批次内更新流水、拆分、预算、模板、定期交易、对账、转换账户等引用，危险的类型错配、层级错配和已关闭对账账户合并会被拒绝。
- 新增 `refund_allocations`：退款创建或编辑时按原单比例或指定项目冻结原日期、原金额、分类路径、拆分和币种。报表读取冻结分配，后续编辑原支出不会追溯改写退款历史；预检与 doctor 校验总额、引用和快照。
- 物品购买新增三种资金模式：仅登记已有物品、关联已有支出、同时创建支出。`fixed_asset_funding_links` 冻结来源金额、记账币种金额和实际汇率；物品、购买事件、支出与资金链接同事务保存，且禁止一笔支出被重复超额分配。
- 远端提交落地写入带来源提交/服务器/副本及 applied/skipped/conflict 结果的操作历史，并通过 `suppressSync` 防止回声；冲突解决形成独立审计批次。服务器 schema 升为 `server_sqlite_wal_key_envelopes_v2`，增加账本密钥封套端点。
- 密钥体系拆分为服务器账号认证和账本端到端加密：Argon2id 密码封套包装随机数据密钥、附件密钥和备份密钥；支持只重包封套的密码修改和保留历史读能力的数据密钥轮换。密文提交使用 key id，已解锁密钥只驻留当前会话。
- 加密备份容器升为 v2，并内含密码包装的密钥封套；文件与原账本密码即可在全新设备解密。可移植备份只含业务账本，完整设备备份另含账本身份、审计、同步游标/冲突和附件传输状态；手动/导入前备份固定保留，自动备份按小时、日、周分层。导入支持密码解锁、SHA-256、预检、恢复演练、合并或精确恢复。
- 新增专项回归覆盖独立设备备份恢复、错误密码/篡改拒绝、并发 CAS、完整设备状态、物品资金原子性与超额分配、主数据合并归档、拆分/资金快照预检、远端审计与冲突解决审计，以及跨币种求和拒绝。
- 验证：全 workspace typecheck 通过；`npm test` 共 **260 项**通过（core 57 · db 74 · logger 5 · sync-server 15 · web 109）；共享包、Web 与 sync-server 生产构建、桌面资源生成、`cargo fmt --check` 和 `cargo check` 通过。桌面内置资源已核对为账本 schema 108 与服务器 schema v2。

---

## 2026-07-19 — 真实银行对账、周期执行与同步服务器 SQLite WAL

**Goal:** 把仍停留在“开关或展示层”的对账、定期交易和预算结转做成真实账务流程，并把同步服务器唯一 JSON 状态文件替换为可事务恢复的 SQLite 服务。

- 账本 schema 提升为 `current_schema_2026_07_19_reconciliation_schedule_rollover`（version 107），便携备份提升为 version 4。流水状态只保留待确认/已清算；是否已对账由关闭的 `reconciliation_sessions` 与逐笔 `reconciliation_items` 推导，不再把一个可随意写入的状态字符串当作对账事实。
- 新增专用银行对账流程：输入账户、币种、账单截止日与银行期末余额，逐笔勾选账户分录，只读计算“上次期末 + 本次勾选 = 核对后余额”和差额。差额非零只能继续核对或创建明确的余额调整流水；调整影响账户余额但排除收入、支出、预算和报表。对账明细锁定财务字段，只能从最新账期逆序撤销并恢复原清算状态。
- 定期交易改用统一周期引擎，以原始开始日期计算日/周/月/年发生日，支持固定日、月末锚点、IANA 时区、结束日期、漏期全部补齐或只补最近一期。`scheduled_executions` 和生成流水使用确定性 ID；应用启动、每分钟、窗口重新聚焦和恢复前台都会幂等执行。1 月 31 日会得到 2 月末、3 月 31 日，不再漂移。
- 预算结转现在参与真实计算：`none`、`positive_only`、`signed` 分别表示不结转、只结余、结余与超支均结转。每月显示上期结转、可用预算、本月实际、剩余与下期结转；跨币种按当前月初价格折算，缺汇率明确标记。
- 同步服务器账户、邀请码、密文提交、配额、附件索引和管理日志统一迁入 `server.sqlite`，启用 WAL、`synchronous=FULL`、外键、busy timeout、事务批量提交、用户内提交 ID 唯一约束和严格 `server_sqlite_wal_v1` 结构。增加 `/api/ready`、请求体上限、提交游标分页、默认/逐用户提交配额、管理员数据库校验与分页日志/用户接口。
- 新增离线维护 CLI：`server:backup` 用 `VACUUM INTO` 创建一致数据库快照，连同服务器身份、密钥和附件写入逐文件 SHA-256 清单；`server:verify-backup` 校验清单和 SQLite；`server:restore` 先在暂存目录预检，再保留恢复前目录并原子提升。服务 PID 文件阻止运行中维护。Docker 数据卷改挂父目录 `/state`，实际数据位于 `/state/server`，从而支持原子目录替换；Caddy 等待就绪检查。
- 桌面启动器、内置服务器资源、Docker、管理后台和部署文档统一只使用 `DATA_DIR`。管理后台显示 WAL/结构、数据库路径、提交容量与两类用户配额，并可在线执行数据库或附件校验；旧 `sync-data.json` / `DATA_FILE` 路径不再读取或转换。
- 验证：全工作区 typecheck 通过；`npm test` 共 **247 项**通过（core 54 · db 67 · logger 5 · sync-server 15 · web 106）；共享包、Web 与 sync-server 生产构建、桌面资源生成、`cargo fmt --check` 和 `cargo check` 通过。打包后的 `dist/server.mjs` 实际启动后 `/api/health` 返回 `sqlite-wal-v1`，`/api/ready` 返回 `quick_check=ok`；强制终止模拟异常掉电后，正式 CLI 仍成功完成备份、校验与隔离目录恢复。

---

## 2026-07-19 — 附件跨设备同步与文件事务保护

**Goal:** 让附件正文与元数据一样可靠地跨设备、跨服务器流转，并消除数据库提交和文件操作分离造成的残留、丢失与误删窗口。

- 当前 schema 提升为 `current_schema_2026_07_19_attachment_cas_and_replica_state`（version 106）。
  `Attachment` 只同步明文内容哈希、大小和缩略图信息；本机新增 `attachment_blobs`、`attachment_file_ops`、
  `attachment_replica_blobs`，分别记录 CAS 状态、可恢复文件操作和每台服务器的分块进度。
- 浏览器 IndexedDB 与 Tauri `AppData/attachments` 统一采用 SHA-256 内容寻址。写入执行“临时写入 → 回读校验 →
  SQLite 提交 → 原子提升”；启动会完成已提交操作、丢弃未提交暂存。删除进入 30 天回收区，冲突分支仍引用的正文不会清理，
  哈希路径发现异常内容时移入隔离区。
- 新增附件端到端加密协议：远端对象 ID 为服务器/账本/用户/密码域内 HMAC；正文以 4 MiB 分块 AES-256-GCM 加密，
  每块带 AAD 和密文 SHA-256。稳定分块 nonce 仅在内容专属密钥下复用，使中断后可重建同一清单并只补传缺块。
- 同步服务器 HTTP API 升级为 v3，新增对象状态、分块上传/下载、恢复和删除端点。服务端使用 `server.sqlite` 加密对象目录，
  支持默认及逐用户配额、100 MiB 单文件上限、24 小时上传会话、30 天回收区、每小时清理、启动索引重建和全量分块校验。
  管理日志会记录上传、去重、失败、恢复、回收、配额和校验操作。
- 多服务器同步先传播提交元数据，再把本机正文复制到每台健康服务器。缩略图自动补齐；大正文按查看、保存或备份下载；
  当目标服务器缺副本时，客户端会从已有服务器下载、校验，并按目标服务器的独立密码重新加密中继。
- 同步页现在验证协议 v3、账号密码、附件能力、延迟和配额，并展示每台服务器的附件副本结果。附件管理页显示本机/远端状态并可手动取回；
  管理后台显示用户对象、回收区、上传暂存、可调配额和“校验全部分块”。便携备份导出会先补齐正文，导入在预检后暂存，
  文件日志与账本导入同事务提交，失败不留下正文。
- 回归覆盖数据库回滚后清理、提交后中断恢复、损坏备份拒绝、三台服务器使用不同密码、明文不落服务器磁盘、懒下载、N 向中继、
  软删除恢复、上传清单碰撞和配额拒绝。共享包导出同时区分 Vite 开发源码与 Node `dist` 运行时；同步服务器单独构建会先构建依赖，
  避免生产启动回退到 TypeScript 源码而找不到 `.js` 模块。
- 同步服务器构建新增独立 `dist/server.mjs`，把工作区运行时依赖打入单文件；直接启动和 Docker 都使用该入口。
  `DATA_DIR`/`DATA_FILE` 可指向尚不存在的新目录，启动前会创建父目录；桌面启动器优先采用显式数据目录。
- 验证：`npm test` 共 **242 项**通过（core 54 · db 65 · logger 5 · sync-server 13 · web 105）；全 workspace
  typecheck、共享包/Web/sync-server 生产构建、`cargo fmt --check` 和 2 项原生附件 Rust 单测通过。同步服务器从干净构建链实际启动，
  `/api/health` 返回协议 3 与 `encrypted-blobs-v1`；浏览器管理后台完成连接和全量分块校验，审计日志正确记录且控制台无错误。
  桌面内置资源重新生成并用随包 Node 实际启动，验证 Web、同步、后台、附件校验及自定义 `DATA_DIR` 均使用当前实现；
  独立 bundle 复制到仓库外后也能创建新目录并启动。当前机器未安装 Docker CLI，未执行容器构建。

---

## 2026-07-13 — 多服务器 N 向同步 Protocol v2

**Goal:** 用服务器身份、提交 DAG 和显式合并完整替换开发期逐事件同步，使多设备、多服务器并发修改可验证、可隔离并最终收敛。

- 建立 `ledgerId / serverId / replicaId / streamEpoch / deviceId` 五类身份。本地 schema 提升为
  `current_schema_2026_07_13_sync_commit_dag_v2_merge_resolution`（version 105），增加提交、聚合修订、
  图头、每副本游标/确认和多分支冲突表；旧事件表、游标和快照协议不再接受。
- 本地写入直接生成 `SyncCommitV2`。流水+拆分、转换链+步骤是原子聚合；lot、消耗和转换缓存由转换
  重建。批量操作进行中保持未封口并阻止同步；回调结束后封口已提交内容，应用重启会恢复异常中断
  的残留提交，事务失败仍整体回滚。
- 提交和修订分别形成 DAG；按依赖应用，非重叠字段保守三方合并。同字段分歧、删除/修改分歧及
  后代整批隔离。冲突解决生成 merge commit，声明并覆盖全部分支；其他设备验证祖先关系后自动关单，
  覆盖不完整或伪造的解决声明标为无效。父节点等待、提交/修订循环、非法修订父节点和无法应用的
  业务快照均有隔离与回归测试。
- `syncReplicas()` 统一执行 pull-all、apply、push-all、re-pull 和收敛校验。单台失败不阻塞健康副本；
  从任一服务器拉到的提交会按该服务器独立密码重新加密并中继到其他服务器。客户端严格验证连续
  序号、内容哈希、完整确认集和提交 ID 碰撞，不信任服务器返回的游标或确认。
- 同步服务器状态升级为严格 version 3，并在当时提供第二代 HTTP 提交端点（现已由 2026-07-19 的 HTTP v3 取代）。
  提交按 ID+SHA-256 幂等，AES-256-GCM AAD 绑定协议、账本、提交 ID 和内容哈希；
  服务器只保存密文，并拒绝批内重复 ID/哈希碰撞。管理员状态与日志改为提交口径。
- Web 手动与生命周期同步共用一个多服务器 orchestrator；同步页展示每副本结果和多分支冲突。
  新设备遇到不同账本时必须输入“替换本机”，随后原子清空本地业务/审计/同步表及附件正文，再采用
  远端 `ledgerId` 重建，绝不静默覆盖。
- 删除未使用的 v1 加密封装，只保留当前带 AAD 的密文格式；重写同步、部署、数据库和 Web 文档，
  更新 README，并重新生成 Tauri 内置 Web/server 资源。额外修复 Windows PowerShell 5 对无 BOM 中文
  启停脚本的误解码，`npm run stop:web` 恢复可用。
- 验证：`npm test` 共 **235 项**通过（core 53 · db 65 · logger 5 · sync-server 10 · web 102）；
  全 workspace typecheck、共享包/Web/sync-server 构建、桌面资源生成通过；`cargo fmt --check`、
  `cargo check` 和 2 项 Rust 测试通过；Windows PowerShell 5 脚本解析通过。浏览器运行时烟测因当前
  浏览器安全策略禁止打开本地地址而未执行。

---

## 2026-07-13 — 退款、可撤销流水与资产转换回溯编辑

**Goal:** 补齐日常记账退款与可恢复作废，并让历史资产转换可以安全编辑，而不是直接篡改派生缓存。

- `Transaction` 增加独立 `refund` 类型与原支出关联、冲减金额/币种、有效/作废状态。支持多次部分退款，拒绝超额退款；退款增加账户现金但不计收入，默认回冲原消费日期、分类和预算，也可在设置中改为按退款日期统计。
- 流水新增、编辑、作废和恢复统一经过服务层校验；已对账流水受保护，原支出存在有效退款时不能作废。流水页可从原支出直接发起退款，并能查看、恢复已作废流水；新增、编辑、作废和恢复都提供 10 秒全局撤销。
- 资产转换支持编辑日期/时间、类型、多步金额、手续费口径、参考汇率、账户和卖出批次匹配。保存前显示回溯影响范围，确认后按日期顺序整体重建 lot、消耗、成本与已实现盈亏；若修改导致历史超卖，整笔事务回滚。
- 转换删除语义彻底改为可恢复的“作废”，移除旧 `deleteConversion` 接口。转换页提供编辑、作废记录和恢复；DCA 执行随转换类型、计划和回溯结果同步更新。
- 仪表盘、余额、预算、趋势、分类报表和 CSV 明细统一排除作废记录，并把退款作为负支出。导入预检增加退款来源、金额上限、币种、记录状态与退款拆分上限校验。
- 演示账本的设备退款改为真实关联原消费，不再伪装成收入。流水批量导入统一经过服务层校验，并在重复原支出被跳过时重映射退款关联 ID；doctor 会检查无效退款、超额冲减和退款分类口径。转换与 DCA 执行的保存、撤销纳入同一数据库事务。
- schema 基线提升为 `current_schema_2026_07_13_atomic_refund_conversion`（version 102），便携备份仍为当前完整格式 version 3。转换产生的链路、步骤、lot 和消耗共享同步 `batchId`；远端批次任一关键实体冲突时整批不落地。
- 验证：`npm test` 共 **220 项**通过（core 52 · db 53 · logger 5 · sync-server 9 · web 101），`npm run typecheck`、共享包/Web/sync-server 生产构建和桌面资源生成通过；`cargo fmt --check`、`cargo check` 与 2 项 Rust 单测通过。
- 浏览器实测通过部分退款保存与撤销、流水作废列表恢复、转换编辑影响预览、转换作废后持仓回算与恢复、退款统计设置和数据自检；自检为 0 问题，控制台无 warning/error。

---

## 2026-07-13 — 删除旧版兼容，收敛当前开发基线

**Goal:** 项目尚未发布，不再维护开发期数据库、备份和同步格式的向后兼容；所有运行路径只接受当前结构，避免迁移猜测掩盖数据错误。

- 删除 v2-v21 历史迁移链，数据库固定为 `current_schema_2026_07_13`（schema version 100）。新库直接创建完整结构；发现旧版本、未知表或字段漂移时只显示“重置本地开发数据”，必须由用户确认，不会自动删除账本或附件。
- 便携备份提升为 version 2，要求包含当前全部实体集合；浏览器自动备份使用新存储键。version 1、缺字段备份和旧同步服务器状态文件会在预检/启动阶段被明确拒绝。
- 删除旧分类 ID 与“历史标签”清理、旧报表 `transactionRange` 参数、`operation_log.server_seq`，以及未被产品调用的快照 LWW/revision 同步实现；保留并强化当前加密事件同步及每服务器确认游标。
- 物品二级分类从迁移中移到应用当前默认数据，由首次播种和维护任务统一补齐；同步服务器状态固定为严格 version 2，事件必须携带合法加密载荷。
- 本次改动取代下方“修复旧账本缺少 `category_id`”的临时兼容方案；该条目仅保留为历史记录。
- `npm test` 共 **212 项**通过（core 52 · db 47 · logger 5 · sync-server 9 · web 99）；类型检查、共享包/Web/sync-server 构建和桌面资源生成通过；`cargo fmt --check`、`cargo check` 与 2 项 Rust 单测通过。

---

## 2026-07-13 — 修复旧账本启动时缺少 `category_id`

**Goal:** 修复一键启动后旧数据库从 v15 升级到物品二级分类 schema 时出现 `no such column: category_id`，且不删除现有账本。

- 根因是 migration v16 先执行当前 schema 的 `idx_fixed_assets_category` 建索引语句，之后才给旧 `fixed_assets` 表添加 `category_id`；全新测试库已包含该列，因此原测试未覆盖真实升级顺序。
- v16 现在先幂等添加 `category_id`，再创建当前 schema 表与索引，随后继续映射旧文本分类、补齐物品字段并提交 migration。此前失败的事务没有写入版本号，重启后会原地重试。
- 迁移测试会先移除最新版测试表的 `category_id` 和索引，只保留旧 `category` 字段，再验证完整升级和分类映射，防止最新版建表结构再次掩盖旧库问题。
- `npm test` 共 **215 项**通过；`npm run typecheck`、共享包构建、Web/sync-server 生产构建通过；桌面内置 Web/server resources 已重新生成。

---

## 2026-07-12 — 缺陷审计、事务隔离与持久化修复

**Goal:** 按真实的保存、后台同步、恢复前台和备份流程审计桌面/移动/Web 数据边界，修复会导致数据串扰、假成功或安全失效的问题。

### Data correctness / durability
- 三套 SQL 驱动统一为 FIFO 顶层操作队列；事务回调接收连接绑定的 driver/store，嵌套操作使用 savepoint。用户保存与后台同步并发时不再被误判为同一事务，一个任务回滚不会撤销另一个任务。
- Collection 的“读取旧值 → 写实体 → 写审计”成为原子操作；导入、恢复、转换、物品事件、批量流水和远端事件全部改用显式事务作用域。重叠的审计批次使用隔离 store，不再串 batch id。
- 浏览器 sql.js 只在顶层事务提交后导出，并等待 IndexedDB 写入完成才报告成功；快照写入严格串行，旧快照不能晚到后覆盖新快照。首次演示账本播种合并为一个原子事务。
- React StrictMode 取消初始化时会关闭尚未发布的 driver/store；原生分享备份使用完整时间戳命名，Android/iOS 仅清理超过 24 小时的分享临时文件。

### Native security / device behavior
- 应用锁改为失败关闭：后台立即遮罩，状态查询不可用时仍尝试设备密码回退，验证失败保持锁定，并阻止 StrictMode/前台恢复触发重复验证。
- Stronghold 仅在快照保存成功后发布新同步凭据；写入或删除失败会销毁实例并锁定 vault，已删除配置不会遗留密码。解锁中途失败也会清理部分实例。
- 401/403/认证失败不再被当成离线；生命周期同步异常会形成可见结果。iOS 扫码移除不支持的 `UPC_A` 选项，Android 保留；本机备份分享文件不再互相覆盖。

### Verified
- `npm run typecheck` 通过；`npm test` 共 **215 项**通过（core 52 · db 53 · logger 5 · sync-server 7 · web 98）。新增覆盖并发回滚隔离、审计上下文隔离、Tauri 根事务排队、sql.js 提交/落盘顺序及 Stronghold 写盘失败。
- 共享包、Web 生产包和 sync-server 构建通过；`cargo fmt --check`、`cargo check` 与 2 项 Rust 单测通过。
- Android/iOS 真机工程仍受当前机器缺少 Android SDK/adb、iOS 需要 macOS + Xcode 的限制；平台权限与系统分享面板仍需发布前真机验收。

---

## 2026-07-12 — 原生凭据、生命周期同步与设备能力

**Goal:** 桌面/移动端用 Stronghold 保存同步密码，移动端提供可选应用锁、相机、扫码、位置、通知和系统分享，并把自动同步提升到应用生命周期。

### Security / sync
- 同步服务器配置抽成共享模块；浏览器密码只写 `sessionStorage`，原生端不再使用 Windows 专属 DPAPI 文件，改为用户本机密码解锁的 Stronghold vault。
- 自动同步从同步页移到应用根级：启用且已有 vault 时启动会提示解锁，随后在启动、固定间隔、恢复前台、网络恢复及 Stronghold 解锁时运行；同一时间只允许一个任务，并按服务器更新延迟、错误和 `serverId`。
- 移动应用锁在设置页确认生物识别/设备密码成功后才能开启；启动和离开后台超过 1 秒后恢复时重新验证。同步失败或冲突可选发系统通知。

### Device input / data
- 流水附件与物品图片、发票、保修凭证增加直接拍照入口；移动端物品条形码接原生扫描器。
- 流水地点可主动读取当前位置；migration v21 在交易表保存纬度、经度和精度，地点实体同步保存坐标。
- JSON 备份在 Android/iOS 优先调用仓库内 `system-share` Tauri 插件：Android 以 `FileProvider + ACTION_SEND` 分享缓存中的真实 JSON 文件，iOS 以 `UIActivityViewController` 分享临时文件；浏览器继续使用 Web Share，不支持时回退下载。
- Tauri 配置加入 Stronghold、notification，以及移动端 biometric、barcode-scanner、geolocation 和本地 system-share；iOS plist 写明 Face ID、相机和使用期间定位用途。

### Verified / remaining native check
- `npm run typecheck` 通过；`npm test` 共 **201 项**通过（core 52 · db 51 · logger 5 · sync-server 7 · web 86）。
- 共享包、Web 生产包和 sync-server 构建通过；`cargo fmt --check`、`cargo check` 与 2 项 Rust 单测通过；`tauri build --debug --no-bundle` 成功链接出 `target/debug/zichan.exe`，Stronghold、notification 和 system-share 已进入实际原生依赖图。
- 当前 Windows 环境只有 JDK 11，且没有 Android SDK/adb，无法生成或编译 APK；iOS 仍需 macOS + Xcode。因此 Android/iOS 平台工程编译、权限弹窗和真机分享面板仍是发布前设备验收项。

---

## 2026-07-12 — Tauri 原生 SQLite、外置附件与响应式基础

**Goal:** 桌面与移动端使用原生 `ledger.sqlite`，浏览器保留 sql.js/IndexedDB；同时完成手机、平板和桌面三档响应式壳，不迁移开发期旧数据。

### Native storage
- 新增 `TauriSqlDriver` 与平台驱动选择：Rust 解析 `AppData/ledger.sqlite` 的绝对 URL，Tauri 通过 `tauri-plugin-sql` 打开，浏览器继续使用 sql.js + IndexedDB。
- Rust SQL 桥为每个顶层事务绑定一个连接，执行 `BEGIN IMMEDIATE`；嵌套事务使用 savepoint。连接启用 foreign keys、busy timeout、WAL 和 `synchronous=FULL`。
- SQL 插件不再预加载相对的 AppConfig 数据库；能力仅保留 load/close/select，写入统一经过原生事务桥。
- migration v20 直接重建开发期附件表，不转换旧 Data URL。SQLite 仅保存存储类型、键、缩略图键、大小和 SHA-256。
- Tauri 附件写入 `AppData/attachments`；浏览器使用独立 IndexedDB Blob。便携备份嵌入正文，导入前校验大小、SHA-256 和缩略图；原生备份以 `AppData/backups` 为事实来源并保留 12 份。
- 原生和浏览器“重置数据”分别清理 SQLite/附件目录或 IndexedDB；设置页自检会实际读取附件正文。

### Responsive UI
- 明确手机 `<768px`、平板 `768–1199px`、桌面 `>=1200px`；手机侧栏替换为五项底部导航和“更多”抽屉，平板使用 84px 图标轨。
- 加入安全区、`100dvh`、44px 触控目标和 `interactive-widget=resizes-content`；手机表单全屏，头尾吸附并锁定背景滚动。
- 总览、流水、转换、游戏、物品、历史、设置、同步、服务器后台、日期范围、月历、分类双栏、图表和表格完成单列/双列重排或受控滚动。
- 新增响应式契约测试，覆盖三个断点、导航/抽屉、安全区、动态视口、44px 触控目标、软键盘、分类滚动和高密度业务页。

### Mobile / verified
- 增加 Android/iOS init/dev/build 脚本；Android 需要 SDK/adb/NDK/JDK 17+，iOS 需要 macOS + Xcode。当前机器只有 JDK 11 且没有 Android target，未生成或验证 APK。
- `npm run typecheck` 通过；`npm test` 共 184 项通过（core 52 · db 51 · logger 5 · sync-server 7 · web 69）。
- Web、共享包、sync-server 构建通过；`release:check` 通过。
- `cargo check`、3 项 Rust 单测通过；`tauri build --debug --no-bundle` 产出 `target/debug/zichan.exe`。
- 本地浏览器视觉验收被浏览器安全策略拒绝，未用其他浏览器自动化绕过；响应式视觉仍需在真机/可用浏览器中做截图复核。

---

## 2026-07-11 — 全局日期区间与年月日视图

**Goal:** 把物品资产已验证的年月日浏览体验推广到所有有时间维度的业务，并统一“从 / 至”筛选语义。

### Core / DB / Server
- 新增共享 `DateRange`、日期预设、严格日期校验和日/月/年边界工具；业务日期统一为本地 `YYYY-MM-DD`，起止日均包含。
- 历史估值只使用记录日当日或之前的最新价格标记，避免未来汇率污染早期流水、转换、游戏和报表。
- 操作日志、批量审计和冲突解决查询支持 `since`（包含）/`until`（排除）并下推 SQLite；同步服务器日志接口支持相同区间，进程内保留量由 500 提升至 5000。

### Web
- 新增共享 `DateRangeBar` 和 `TimelineExplorer`，提供今天、本周、本月、上月、近 3 月、今年、全部、自定义，以及列表/年度/月历/单日钻取。
- 流水、账单、资产转换、游戏记录、物品资产和操作历史接入完整年月日视图；总览、五类报表、账户/对账、预算、同步冲突、服务器日志和价格标记接入统一起止日期。
- 账户区间流水会累计此前过账形成正确期初余额；月度账单按原始日期锚点展开，月底不会逐月漂移；报表增加按日/月/年趋势并在导出文件名写入实际区间。
- 物品耗材时间线同时记录安装与更换/丢弃日期；筛选后的游戏赛季不展示无法可靠分摊的每小时指标。

### Docs / Verified
- 更新 `docs/web.md`、`docs/db.md`、`docs/cloud-sync.md` 和本工作日志。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：173 tests 通过（core 52 · db 51 · logger 5 · sync-server 7 · web 58）。
- `npm run build -w @zichan/web`、`npm run build -w @zichan/sync-server` 与 `npm run build` 通过。

---

## 2026-07-11 — 分类管理入口合并

**Goal:** 消除设置页和管理页同时维护收支分类造成的职责重叠，建立唯一分类中心。

### Web / DB
- 管理页重组为“分类与资料中心”，提供收支分类、物品分类、标签与商户、其他资料四个页签；收支分类分为结构管理和快捷显示与排序。
- 设置页移除完整分类管理器，只保留高频/隐藏数量、记账弹窗默认分类范围和“进入分类中心”按钮；按钮会直达快捷显示与排序。
- 分类选择器默认范围写入 `Setting.categoryPickerDefaultScope`，随备份和同步流转；临时“显示隐藏”只作用于当前弹窗。
- migration v19 为现有账本补齐 `frequent` 默认值，避免升级后突然展开数百个隐藏分类。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test -w @zichan/web -- transactions.test.ts`：10 tests 通过。
- `npm test -w @zichan/db -- item-migration.test.ts`：1 test 通过。
- `npm test`：159 tests 通过（core 46 · db 50 · logger 5 · sync-server 7 · web 51）。
- `npm run build -w @zichan/web` 与 `npm run build` 通过。

---

## 2026-07-11 — 大量分类滚动修复

**Goal:** 修复显示隐藏分类后，记账弹窗和设置页二级分类无法完整滚动的问题。

### Web
- 记账分类选择器改为受视口约束的固定双栏滚动区；一级、二级列表分别设置 `min-height: 0` 和纵向滚动，滚轮不再被外层弹窗截走。
- 设置页“快速记账分类”使用响应视口的确定高度；一级分类和二级分类独立滚动，右侧批量操作栏在滚动时保持吸顶。
- 两处滚动容器均限制横向溢出，并使用 `overscroll-behavior: contain`、稳定滚动条和纵向触控手势。

### Docs / Verified
- 更新 `docs/web.md`，明确大量分类在记账和设置中的滚动行为。
- `npm test -w @zichan/web -- --run`：50 tests 通过。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-10 — 模块币种、规范化转换与物品资产完整生命周期

**Goal:** 完成各模块默认币种、买卖手续费口径、持仓成本，以及物品资料、用量、耗材、目标和日期视图。

### Core / DB
- `Setting` 增加日常记账、投资成本、物品资产和游戏结算四个模块默认币种；历史记录保存自身币种，不随设置变化。
- 转换步骤区分成交本金/账户实扣、成交毛额/实际到账，支持来源包含、来源另付、目标扣除和第三资产另付的多条手续费；参考汇率与实际成交/有效汇率分开。
- Lot 同时保存原始付款资产/数量和账面成本币种；组合估值按每个 Lot 的成本币种折算，不再直接相加不同货币。
- 价格标记构建可逆汇率图，支持直接、反向和最短跨币种折算；缺汇率时停止制造虚假汇总并返回明确提示。
- 物品资产加入一级/二级分类、完整资料、附件用途、生命周期事件、次数/公里/小时/自定义用量、耗材寿命和冻结成本基数的目标。
- 月度预算保存创建时币种；migration v16-v18 负责规范化转换/物品模型、残值录入口径和预算币种补齐。

### Web
- 设置页可分别选择全局报表及四模块默认币种；交易、预算、账单、定投、转换、游戏和物品表单使用对应默认值。
- 转换弹窗支持多步骤、多手续费、包含/另付切换、账面折算、市场参考率和本金/实扣/毛额/实收实时预览。
- 物品资产页支持图片、发票、保修、序列号、条形码、购买记录、当前残值/累计损耗录入、用量、耗材、目标和完整时间线。
- 新增概览、年度、月历和日视图，可按日期查看购买、维修、耗材、残值、出售、报废、清退和赠出。
- Dashboard、流水、预算、游戏和报表统一折算到全局报表币种；原币保留展示，缺失汇率有可操作提示。

### Docs / Verified
- 更新 `README.md`、`docs/data-model.md`、`docs/db.md` 和 `docs/web.md`。
- `npm test`：158 tests 通过（core 46 · db 50 · logger 5 · sync-server 7 · web 50）。
- `npm run typecheck`、`npm run build`、`npm run build -w @zichan/web` 均通过。

---

## 2026-07-09 — 记账弹窗放大与完整分类体系

**Goal:** 让日常记账弹窗更适合大量分类，并补齐真实账本可用的默认分类体系。

### Web
- `EntityFormModal` 支持按表单指定弹窗宽度；日常收支表单扩大到 880px，并让二级分类字段横跨整行。
- 分类选择器两栏面板增大：一级分类列更宽，二级分类区更高，适配几十个分类时的查找和滚动。
- 默认分类体系扩展为完整生活账本：食品餐饮、交通出行、购物消费、居家生活、医疗健康、学习成长、休闲娱乐、家庭人情、金融税费、其他支出，以及工作收入、投资资产、其他收入等收入分类。
- 维护任务会把新增内置分类写入现有开发库，并同步内置分类名称、父级、颜色和排序；无自定义子类的旧一级分类会自动清理，避免它们变成可选叶子分类。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：136 tests 通过（core 40 · db 45 · logger 5 · sync-server 7 · web 39）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-09 — 分类选择器与快捷记账入口

**Goal:** 参考 ezBookkeeping 的录入体验，解决二级分类过多挤在普通下拉里的问题，并给侧边栏增加快速记账入口。

### Web
- 通用 `EntityFormModal` 新增 `category` 字段类型：按“一级分类 / 二级分类”两栏展示，支持搜索、当前选择高亮和可选清空。
- 日常收支、交易模板、拆分明细、预算、定期交易和商户默认分类改用新的分类选择器。
- 左侧“日常收支”导航项新增圆形加号，点击后切到流水页并直接打开新增记账弹窗。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：136 tests 通过（core 40 · db 45 · logger 5 · sync-server 7 · web 39）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-09 — 真实流程优化收口与桌面发布检查

**Goal:** 按真实使用流程继续补齐同步、导入、批量整理、数据安全和桌面发布验收。

### Web / DB
- 同步页新增首次配置向导：本机服务器、局域网电脑、公网域名三种入口，可套用到当前服务器并测试连通性。
- 同步 ready 口径改为必须有同步密码；token 只代表已登录，不再被误显示为可直接完成加密同步。
- 冲突保留/字段级合并后自动运行数据自检；遇到转换缓存过期会自动重算，并在同步结果区提示通过或问题数量。
- 导入预览改成业务字段 diff：忽略 `id/createdAt/updatedAt/version/isDeleted`，并显示变化字段示例。
- 批量修改预览显示前几条流水的改前/改后；保存和预览共用同一套补丁逻辑。
- 数据安全状态（最近自检、恢复演练）写入 `settings.dataSafetyStateJson`，通过 migration v14 自动补列，随账本备份迁移。

### Desktop / Docs
- `@zichan/desktop` 新增 `release:check`：构建 Web、构建 sync-server，并执行 Tauri Rust 命令层 `cargo check`。
- 更新 `docs/web.md`、`docs/cloud-sync.md`、`docs/desktop.md`，补同步向导、业务导入预览、批量 before/after、数据安全持久化和桌面发布清单。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：136 tests 通过（core 40 · db 45 · logger 5 · sync-server 7 · web 39）。
- `npm run build -w @zichan/web` 通过。
- `npm run release:check -w @zichan/desktop` 通过。
- `npm run build` 通过（logger/core/db）。

---

## 2026-07-08 — 去旧兼容与真实流程优化

**Goal:** 按“还没发布、没用户就不背旧兼容”的原则，完成真实记账流程 1-9 项，暂不做新手引导。

### Web
- 交易、模板、账单表单的分类选项会随收入/支出动态切换，并只展示二级分类；文本标签字段从类型、表单、筛选、搜索、播种和测试中移除。
- 维护任务改成当前版本基础资料补齐：常用标签、地点、模板、预算、定期交易，并清理开发期临时标签。
- 流水页补高级查询预设；报表明细可带筛选跳回流水页整理；管理页增加搜索和重复名称提示；备份列表改为表格展示大小、校验和操作状态。
- 历史页默认过滤系统初始化和无业务变化日志；同步页默认不启用服务器，测试/验证账号密码带 5 秒超时、延迟和错误提示。

### Sync Server / DB
- 下线状态同步 HTTP 路径：服务端删除状态快照端点，`@zichan/db` 删除对应 HTTP 传输导出，端到端服务器测试只覆盖加密事件流和多服务器 relay。
- 同步服务器数据文件只认当前 v2 envelope；管理后台用户列表移除快照/版本列，只展示事件数和用户状态。
- 新库迁移不再创建交易文本标签列；migration v12 会从现有开发库的 `transactions` 和 `scheduled_transactions` 中删除该列；应用层只使用实体标签 `tagIds`。

### Docs / Tests
- 更新 `docs/web.md`、`docs/db.md`、`docs/cloud-sync.md`、`docs/event-sync-design.md`，去掉状态同步和文本标签描述。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：135 tests 通过（core 40 · db 44 · logger 5 · sync-server 7 · web 39）。
- `npm run build -w @zichan/web` 通过（Vite 仍提示主 chunk 超 500 kB，构建成功）。

---

## 2026-07-08 — 真实记账流程打磨与修复

**Goal:** 按真实账本流程修复筛选、批量整理、历史、报表和同步页里会卡住的点。

### Web
- 新增 `src/db/maintenance.ts` 启动维护任务：补齐常用标签、地点、模板、预算和定期交易，并清理开发期生成的临时标签。
- 首次播种演示数据改为系统审计批次，维护任务也写系统批次；历史页默认显示“用户相关”，隐藏系统初始化和无业务变化日志，仍可切到全部来源审计。
- 交易页基础筛选、高级查询和批量修改的分类选项统一只展示二级分类；日历页默认选择最近有流水的日期。
- 通用实体表单补 `label htmlFor`、`id`、`name`，改善键盘/无障碍和自动化测试识别。
- 报表页日常收支支持本月/上月/近 3 月/全部范围；分类图表和分类表可点击下钻到流水明细，明细支持 CSV 导出。
- 同步页拆分“测试连通性”和“验证账号密码”，保留服务器 ID、延迟、认证状态和错误信息。
- 清理 React inline style 中 `border` 与 `borderColor` 混用的警告点。

### Docs / Tests
- 更新 `docs/web.md` 说明基础资料维护、历史降噪、二级分类收敛、报表下钻和同步测试。
- 新增 web 报表测试，覆盖上月范围和分类明细下钻。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：137 tests 通过（core 40 · db 44 · logger 5 · sync-server 9 · web 39）。
- `npm run build -w @zichan/web` 通过（Vite 仍提示主 chunk 超 500 kB，构建成功）。

---

## 2026-07-08 — 操作历史产品化

**Goal:** 把底层 `operation_log` 做成可查、可解释、可导出的操作历史页。

### Core / DB
- `OperationLogEntry` 增加 `beforePayload`、`afterPayload`、`changedKeys`、`diffJson`、`batchId`、`source`、`actorName`。
- SQLite migration v11 给 `operation_log` 补改前/改后/diff/批次/来源字段，并新增 `audit_batches`、`sync_conflict_resolutions`。
- `SqlLedgerStore` 新增 `withAuditContext`、`createAuditBatch`、`finishAuditBatch`、`listAuditBatches`、`listConflictResolutions`。
- `resolveConflict` 可写入冲突解决记录，保留本地/远程/最终 payload 和 changed keys。

### Web
- 新增左侧“历史”页面：按时间、记录类型、操作类型、实体、来源和关键词筛选。
- 历史列表合并展示实体操作、批量操作和同步冲突解决；右侧详情展示字段级改前/改后和 JSON 快照。
- 日常收支批量修改接入 `audit_batches`，历史页可折叠为一条批量记录并展开查看每条流水 diff。
- 同步冲突保留本地/远程时写入冲突解决记录。
- 历史页支持 CSV/JSON 导出。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：136 tests 通过（core 40 · db 44 · logger 5 · sync-server 9 · web 38）。
- `npm run build -w @zichan/web` 通过（Vite 提示主 chunk 超 500 kB，构建成功）。

---

## 2026-07-08 — 日常账本查询、日历、批量整理与导出

**Goal:** 补齐日历视图、高级 AND/OR 查询、保存筛选、批量修改、报表图表和 CSV/Markdown/Mermaid 导出。

### Core / DB
- 新增 `TransactionSavedView`，用于保存普通筛选 + 高级查询 JSON。
- SQLite migration v10 创建 `transaction_saved_views`，并接入 `LedgerStore`、操作日志、备份导入/导出、预检、快照同步和冲突映射。

### Web
- 流水 selector 新增高级查询模型：组内 `AND`、组间 `OR`，支持日期、时间、类型、一级/二级分类、金额、账户、商户、标签、地点、状态、附件等字段。
- 日常收支页新增保存筛选、可展开高级查询器、日历视图和列表多选。
- 批量修改支持分类、商户、账户、状态、地点、追加/移除标签；金额不开放批量修改。
- 报表页新增“日常收支”页签、分类支出图表，并支持导出 CSV、Markdown 表格和 Mermaid 饼图源码。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：134 tests 通过（core 40 · db 42 · logger 5 · sync-server 9 · web 38）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-08 — 交易录入细节、二级分类、标签地点附件

**Goal:** 参考 ezBookkeeping 的交易录入体验，补齐时间、地点、标签、文本备注、图片附件和二级分类基础。

### Core / DB
- 新增 `TransactionTag`、`TransactionLocation`、`TransactionTemplate`。
- `Transaction` 新增 `time`、`timezone`、`tagIds`、`locationId`、`locationName`，标签统一走实体 `tagIds`。
- SQLite migration v9 创建标签、地点、模板表，并给 `transactions` 补交易时间/地点/标签列。
- 备份导出/导入、预检、snapshot 同步、事件同步实体映射覆盖新实体；导入去重纳入交易时间。

### Web
- 分类工具支持一级/二级路径展示；交易、预算、拆分、账单表单只允许选择叶子分类，保存时也校验不能写入一级分类。
- 通用实体表单支持 `time`、多选、长文本和图片/PDF 文件字段。
- 交易表单新增交易时间、时区、地点、标签、文本备注和附件/图片上传；编辑时预览已有交易附件。
- 交易保存会自动记忆新地点；删除流水时一并软删除其附件。
- 日常收支页新增模板快记按钮；管理页新增标签、地点、交易模板 CRUD。
- 筛选栏补商户、标签、状态、金额范围；搜索覆盖地点和实体标签。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：131 tests 通过（core 40 · db 42 · logger 5 · sync-server 9 · web 35）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-08 — 轻量记账模式

**Goal:** 让日常记账默认只关心消费和收入，不强迫用户维护银行卡、信用卡、还款和对账。

### Core / DB
- 新增 `LedgerMode = 'spending' | 'accounts' | 'assets'`，并在 `Setting.ledgerMode` 持久化。
- SQLite migration v8 给 `settings` 补 `ledger_mode`，旧账本缺省按 `'spending'` 解释。
- 演示数据默认进入轻量记账；真实流程测试写入账户模式，覆盖设置字段的存取。

### Web
- 「日常收支」默认只显示流水、预算、账单；账户 Tab、账户筛选、转账类型、交易状态和对账入口在轻量模式隐藏。
- 收支表单、定期交易表单、商户表单按模式收敛字段；轻量模式保存时会清空账户/转账字段，并拦截转账流水。
- 设置页新增“记账模式”切换：轻量记账、账户记账、完整资产账本。
- 管理页在轻量模式隐藏账户管理段，商户列表不显示默认账户列。

### Docs / Tests
- 更新 `docs/data-model.md`、`docs/db.md`、`docs/web.md` 说明轻量默认和 v8 迁移。
- 新增 web 表单测试，覆盖轻量模式隐藏账户/转账字段、账户模式保留进阶字段。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：129 tests 通过（core 40 · db 41 · logger 5 · sync-server 9 · web 34）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-08 — 日常记账增强（导入暂缓）

**Goal:** 参考成熟记账工具补齐日常记账能力；CSV/银行导入先不做。

### Core / DB
- `Transaction` 扩展为收入、支出、转账三类；新增状态 `pending/cleared/reconciled`、商户、退款关联和转账目标字段。
- 新增 `Category`、`Payee`、`TransactionSplit`、`BudgetCategory`、`ScheduledTransaction`、`ReconciliationSession`。
- 余额引擎支持转账双腿过账：转出账户扣减、转入账户增加；转账不计入月度收入/支出。
- 分类汇总支持拆分明细；一笔消费可拆到多个分类后进入预算和 Top 分类。
- SQLite migration v7 创建记账增强表，并给旧 `transactions` 表补 transfer/status/payee/refund 字段。
- 备份、事件同步、冲突分类和冲突箱实体映射覆盖新增记账实体。

### Web
- 「日常收支」页改为四个工作区：流水、账户、预算、账单。
- 流水区支持收入/支出/转账、状态、商户记忆、退款关联、拆分交易、分类和商户快速新增。
- 账户区显示账户 running balance，可按账户/币种看流水，并可一键把当前账户已清算流水标记为已对账。
- 预算区维护月度分类预算，显示已用、剩余、超支；拆分交易按拆分分类进入预算。
- 账单区维护定期交易，可手动生成下一期 pending 流水并推进下次日期。
- 管理页新增分类、商户、分类预算和定期交易 CRUD；seed 数据补默认分类、商户、预算、账单和转账示例。

### Docs
- 更新 `docs/data-model.md`、`docs/db.md`、`docs/web.md` 的记账模型、迁移、页面和表单说明。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：127 tests 通过（core 40 · db 41 · logger 5 · sync-server 9 · web 32）。
- `npm run build -w @zichan/web` 通过。

---

## 2026-07-07 — 同步服务器路径、日志与连接测试

**Goal:** 完善同步服务器安全路径、管理员日志，以及同步页按服务器测试密码和延迟。

### Sync server
- `@zichan/sync-server` 支持 `BASE_PATH=/xxxxx`，Web、同步 API、账号管理 API 都可挂到端口后的路径前缀；未带前缀访问 `/api/*` 会返回 404。
- `/api/health` 返回 `basePath`；`/api/admin/logs` 返回最近服务日志，支持 `limit` 和 `level` 过滤。
- 日志覆盖登录、注册、限流、同步推送、快照更新、邀请码、用户禁用和注册策略变更；不记录账号密码、会话凭据、authProof、密文内容或邀请码明文。
- 数据文件 v2 envelope 持久化最近 500 条日志。

### Web
- 「同步」页改为结构化服务器列表：中文别名、协议、主机、端口、服务路径、启用状态、用户名、每服务器独立密码和邀请码。
- 每台服务器可单独「测试」，同时检查健康接口、登录密码是否正确、服务器 ID 和连接延迟。
- 同步结果按服务器别名展示推送、应用、冲突和延迟；密码和登录 token 仅保存在当前页面会话内。
- 「服务器管理」Tab 新增最近日志表，并继续支持在线启动本机服务器、检查健康、管理注册/邀请码/用户。

### Docs / deploy
- Docker Compose 与镜像环境变量加入 `BASE_PATH`。
- `apps/desktop/scripts/server.mjs` 启动时打印 Base path。
- 更新 `docs/cloud-sync.md`、`docs/desktop.md` 的多服务器配置、安全路径、日志与测试说明。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test`：123 tests 通过（core 38 · db 40 · logger 5 · sync-server 9 · web 31）。
- `npm run build -w @zichan/web` 通过。
- `node --check apps/desktop/scripts/server.mjs` 通过。

---

## 2026-07-07 — 桌面在线启动本机服务器

**Goal:** Web-only 启动时服务器管理必须是未启用/未连接状态；Tauri 桌面端支持从界面在线启动本机服务器。

### Desktop
- Tauri Rust 端新增 `desktop_server_status`、`desktop_start_server`、`desktop_stop_server` 命令。
- 桌面命令会检测 `127.0.0.1:8787`、校验 `serverId` 并返回数据文件位置；管理页使用已登录管理员账号的会话。
- 在线启动复用 `apps/desktop/scripts/server.mjs`，默认 `HOST=0.0.0.0 PORT=8787`；dist 缺失时尝试执行
  `npm run server:build -w @zichan/desktop`。
- 只停止由桌面在线启动的进程；如果 8787 是外部脚本启动的服务，页面会提示不能安全停止。

### Web
- 新增无依赖 Tauri invoke 适配器；普通浏览器没有 invoke 时自动降级为 Web 模式。
- 移除左侧独立「服务器」导航，把「服务器管理」并入「同步」页 Tab。
- 「服务器管理」默认显示本机服务状态：Web 模式为未启用，Tauri 模式可在线启动/停止。
- 管理连接拆成「检查」和「管理」：未登录时只能健康检查，成员访问管理接口返回 403，不能误认为已授权。

### Verified
- `npm run typecheck -w @zichan/web` 通过。
- `cargo check`（Tauri desktop）通过。
- `npm run build -w @zichan/web` 通过。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：122 tests 通过。

---

## 2026-07-07 — 桌面启动脚本与固定电脑服务模式

**Goal:** 完善桌面端相关启动链路，让 Web 开发、Tauri 桌面壳、纯同步服务、固定电脑一体服务都有清晰入口和清理方式。

### Desktop + scripts
- 根启动脚本新增模式：`web | sync | server | desktop | all`。双击 `start.cmd` 仍默认 Web；
  命令行可用 `start.cmd server`、`start.cmd desktop`，POSIX 可用 `bash scripts/dev-start.sh server`。
- 停止脚本默认清理 `5173` 和 `8787`，也支持按模式停止：`stop.cmd server`、`npm run stop:server`。
- 根 `package.json` 增加 `start:web`、`start:sync`、`start:server`、`start:desktop`、`start:all`
  以及对应 stop 脚本；`npm run server` 直达桌面一体服务。
- `apps/desktop` 的服务器脚本拆成 `server:build` / `server:run` / `server`，便于构建和排错。
- 桌面一体服务默认 `HOST=0.0.0.0`，方便固定 IP 电脑作为局域网服务器；仍可改成 `127.0.0.1` 仅本机访问。
- `server.mjs` 增加 dist 缺失检查和 Windows ESM file URL 兼容，避免直接运行时静默 404。
- `sync-server` 主入口支持 `HOST` 环境变量。

### Docs
- 更新 `README.md`、`docs/desktop.md`、`docs/cloud-sync.md` 的启动命令、端口清理和固定电脑服务器说明。

### Verified
- PowerShell parser：`scripts/dev-start.ps1`、`scripts/dev-stop.ps1` 通过。
- Node syntax：`node --check apps/desktop/scripts/server.mjs` 通过。
- 临时端口 `18787` 实际启动 `npm run server:run -w @zichan/desktop`：`/api/health` 返回 ok，`/` 返回 200；
  验证后已停止临时进程。
- `cargo check`（Tauri desktop）通过。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：122 tests 通过。
- `npm run build -w @zichan/web`、`npm run build -w @zichan/sync-server` 通过。
- 当前环境没有 `bash`，POSIX shell 脚本未能执行 `bash -n`。

---

## 2026-07-07 — 统一服务器与管理后台

**Goal:** 桌面常开电脑、NAS、云服务器都能运行同一套服务；Web、同步、后台可按开关组合。

### Sync server
- `@zichan/sync-server` 从纯同步服务升级为统一服务：`ENABLE_WEB` 托管 Web 构建产物，`ENABLE_SYNC`
  控制 `/api/*` 同步接口，`/api/admin/*` 提供账号角色保护的管理 API。
- 数据文件使用 v2 envelope：`users`、`invites`、`registrationMode`。
- 新增注册策略 `open | invite | closed`、邀请码创建/禁用、用户禁用/启用、运行状态统计。
- 管理 API 只返回元数据：不暴露 `authHash` 或密文 payload。
- 静态 Web 服务支持 `/`、`/app/*` 和 Vite `/assets/*`，可与 `/api/*` 同域部署。

### Web + desktop + deploy
- Web 新增「服务器」页面：连接任意服务器，管理注册策略、邀请码和用户状态。
- 同步页注册增加可选邀请码；`@zichan/db.registerAccount()` 支持 `{inviteCode}`。
- `apps/desktop` 新增 `npm run server -w @zichan/desktop`：构建 Web/同步服务后，用当前用户数据目录启动一体服务；
  默认开放注册，第一位成功完成注册的账号成为管理员。
- Docker 镜像现在同时构建并复制 Web dist；Compose 默认启用 Web+同步，要求显式设置 `SYNC_SECRET`，Caddy 统一反代。
- 更新 `docs/cloud-sync.md`、`docs/desktop.md`、`README.md`。

### Verified
- Targeted: `npm run typecheck -w @zichan/sync-server`；`npm test -w @zichan/sync-server`（8）通过。
- Targeted: `npm run typecheck -w @zichan/web`；`npm run typecheck -w @zichan/db` 通过。
- `npm test`：122 tests 通过（core 38 · db 40 · logger 5 · sync-server 8 · web 31）。
- `npm run typecheck` 全 workspace 通过。
- `npm run build` 通过（logger/core/db）；`npm run build -w @zichan/web` 通过；
  `npm run build -w @zichan/sync-server` 通过。
- 本地 Web dev 地址 `http://127.0.0.1:5173/` 返回 200。
- Docker CLI 未安装，未在本机执行 `docker compose config` / 镜像构建。

---

## 2026-07-07 — 多服务器 N 向事件同步

**Goal:** 让同步服务器拥有稳定 serverId，并把事件确认从单 `server_seq` 升级为按服务器记录，实现多服务器多设备最终收敛。

### 协议与存储
- sync-server 新增稳定 `serverId`：`/api/health` 返回 `{ok, serverId}`；未显式配置时持久化到
  `<DATA_FILE>.server-id`，事件/快照响应也带 `serverId`。
- DB 增加 v6：`sync_known_events`（本机知道的远端事件，可 relay）和 `sync_event_acks`
  （`serverId + eventId -> serverSeq`）。
- `syncEvents()` 先识别服务器 ID，再推送该服务器尚未 ack 的本地/已知事件；拉取后先记录 known event
  与 ack，再静默 apply。旧 `operation_log.server_seq` 只保留兼容/调试，不再决定是否推送。
- 从 S2 拉到的事件会进入 `sync_known_events`，随后同步 S1 时会自动补推给 S1。

### Web + HTTP
- `httpEventTransport` 从 `/api/health` 获取并缓存 serverId；Web localStorage 云和内存 transport 也有 serverId。
- 同步页新增每个端点的 serverId、推送数、应用数、冲突数和错误展示；冲突箱支持 `transaction` 类型。

### Verified
- Targeted: `npm test -w @zichan/db -- event-sync.test.ts` 通过（含两服务器 relay）。
- Targeted: `npm test -w @zichan/sync-server` 通过（含两台真实 HTTP 服务器 relay + 密文断言）。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：120 tests 通过（core 38 · db 40 · logger 5 · sync-server 6 · web 31）。
- `npm run build` 通过（logger/core/db）；`npm run build -w @zichan/web` 通过；`npm run build -w @zichan/sync-server` 通过。

---

## 2026-07-07 — 日常生活收支记账模块

**Goal:** 增加传统记账能力，记录工资、奖金、餐饮、房租、购物等与投资无关的单边收入/支出，并进入余额、备份和同步。

### Core + DB
- `Transaction` 已贯通到 `LedgerStore`，`postingsFromTransaction()` 的收入/支出过账进入现金余额。
- `transaction.ts` 增加分类聚合、月度现金流和分类趋势测试覆盖；交易金额保持正数，方向由 `type` 决定。
- DB 增加 v5 `transactions` 迁移；仓储、事件同步冲突关键字段、快照同步、备份导出/导入都包含 transaction。
- 实体标签在 SQLite 中按 JSON 存储/恢复，避免数组被压成普通字符串。
- 新增 `importTransactions()` 和 `monthlyTransactionSummary()`，支持批量去重导入和月度收入/支出/分类汇总。

### Web
- 新增「日常收支」页面：本月收入/支出/结余、Top 支出分类、近 6 月趋势、日期范围/类型/分类/账户/搜索筛选、流水分组列表。
- 复用 `EntityFormModal` 增加 `transactionForm()`，支持新增/编辑/删除日常流水，默认日期取报表基准日、币种取结算币种。
- Dashboard 增加「本月日常收支」卡片，近期动态展示日常收入/支出；余额派生会计入 transaction postings。
- Seed 增加工资、房租、餐饮、交通、购物、退款等演示流水。

### Verified
- Targeted: `npm test -w @zichan/core`（38）、`npm test -w @zichan/db`（39）、`npm test -w @zichan/web`（31）通过。
- `npm run typecheck` 全 workspace 通过。
- `npm test`：118 tests 通过（core 38 · db 39 · logger 5 · sync-server 5 · web 31）。
- `npm run build` 通过（logger/core/db）；`npm run build -w @zichan/web` 通过。

---

## 2026-07-07 — 数据安全与恢复 + 真实使用打磨

**Goal:** 自动备份、备份校验、导入前预检、恢复演练、冲突数据导出；用真实账本流程跑一遍并修交互。

### 数据安全与恢复
- `@zichan/db` 增加 `preflightImport()` / `validateLedgerBackup()`：校验备份版本、必需数组、重复 ID、
  链路 steps、关键引用（资产/链路/lot/游戏/固定资产等），返回摘要和 error/warning 列表。
- `importLedger()` 现在先跑预检；有硬错误直接拒绝导入，避免坏 JSON 写进当前账本。
- Web 增加 `src/db/backups.ts`：自动备份（IndexedDB KV，60 秒节流，保留 12 份）、手动备份、导入前备份、
  备份下载、恢复演练（临时 sql.js 库导入 + `checkConsistency`）。
- 顶栏导入 JSON 改成：解析 → 预检 → 恢复演练 → 导入前备份 → 用户确认 → 合并导入。
- 设置页新增「备份与恢复」面板：查看备份库、手动备份、对任意备份做恢复演练、下载、导入。
- 同步页冲突箱新增「导出冲突 JSON」，包含本地/远程 payload、字段列表和导出时间。

### 真实使用打磨
- 新增转换表单补「手续费折算」字段；非基础币手续费可明确写入 base 价值。
- 定投录入可关联 DCA 计划，保存后自动写 `dca_execution`，定投报表/提醒不再漏数据。
- 卖出录入默认使用设置里的 lot 匹配方式；保存前校验步骤数量、正数金额、手续费资产、可卖批次、
  手动批次选择，错误信息更具体。
- 通用表单支持默认值；价格、DCA 计划、赛季、游戏记录、固定资产和固定资产事件默认使用报表基准日。
- 新增 `real-workflow.test.ts`：真实流程烟测覆盖新增资产、定投、卖出、固定资产、游戏记录、一致性检查、
  同步关键字段冲突。

### Verified
- `npm run typecheck` 全 workspace 通过。
- `npm test -w @zichan/db`：35 tests 通过。
- `npm test -w @zichan/web`：27 tests 通过。
- `npm test`：106 tests 通过（core 34 · db 35 · logger 5 · sync-server 5 · web 27）。
- `npm run build` 通过（logger/core/db）；`npm run build -w @zichan/web` 通过。

---

## 2026-07-07 — 事件同步落地 + 阶段 B（移动端除外）

**Goal:** 移动端先不做，其余未完成项补齐。

### 事件同步（append-only）
- `@zichan/db` 的事件同步路径补齐测试：`operation_log.server_seq`、游标、`sync_conflicts`、
  `memoryEventTransport`、关键字段冲突分级。`conversion_chain_steps` 现在也参与冲突检测，不再静默覆盖。
- `@zichan/sync-server` 增加 `/api/events`：每用户 append-only 密文事件流，按事件 id 去重，服务器分配
  单调 `seq`；同步服务器只保留事件流 API。
- `httpEventTransport`：逐条事件端到端加密后上传，拉取后本地解密；真实服务器 e2e 断言事件流不泄露
  BTC/ETH 明文。
- Web 同步页改用事件同步：未登录走 localStorage 事件云，登录后走 HTTP 加密事件流；冲突箱读取
  `sync_conflicts`，关键金额/数量/汇率/费用冲突需人工保留本地或远程。

### 阶段 B 产品项
- **定投计划 + 提醒**：DCA plan 进入快照与管理页 CRUD；总览显示下一次执行日、逾期/临近提醒、
  计划金额和默认路径。
- **手续费开关**：设置页增加 `feeCostMode`（真实净流出 / 所有手续费计入成本），服务层、doctor、
  总览和报表按同一口径计算。
- **游戏效率细分**：游戏页增加按账号、按记录类型的收入/支出/净收益条形细分。
- **图表**：报表页按 tab 显示 DCA 累计成本、链路手续费、赛季净收益、固定资产每日成本图表。
- **基准日可配**：设置页增加 `asOfDate`；总览、游戏、固定资产、报表统一使用该日期。
- **附件**：新增通用 `Attachment` 实体、表、迁移、导入导出、同步映射和管理页 CRUD。

### Verified
- Baseline before changes was green.
- Targeted: `npm test -w @zichan/db`（31）和 `npm test -w @zichan/sync-server`（5）通过。
- Web: `npm run typecheck` 全 workspace 通过；`npm test -w @zichan/web`（27）通过；
  `npm run build -w @zichan/web` 通过。

### 剩余
- 移动端仍按用户要求 deferred。

---

## 2026-07-06 — 阶段A：同步正确性 + 服务器生产化

**Goal:** A 里除事件同步外的正确性 + 生产化项（事件同步 B 留下一轮）。

### 正确性修复
- **事务原子化**：驱动加嵌套事务（SAVEPOINT，node:sqlite + sql.js）；`recordSell`/
  `recordConversion`/`deleteConversion`/`mergeInto` 各自包进一个事务；`LedgerStore` 端口 +
  `SqlLedgerStore` 加 `transaction()`。消除"跨多个 put 中途失败留下不一致"。
- **乐观锁**：`SyncTransport` 改为带 `rev`（`pull→{backup,rev}`、`push(backup,baseRev)`）；服务器
  快照带 `rev`，`baseRev` 不匹配返回 409；`syncWithRemote` 捕获 `RevConflictError` 自动
  重拉+重合并+重推。消除并发 push 丢失更新。所有 transport（memory/localStorage/http）改。

### 服务器生产化（apps/sync-server）
- **HMAC 签名令牌**：登录签发 `body.sig`（HMAC-SHA256，7 天过期），无状态、重启不失效；
  secret 持久化到 `<dataFile>.secret` 或 env。校验用 `timingSafeEqual`。
- **限流**：每实例滑动窗口，register/login 10/min、其他 120/min，超限 429。
- **部署**：`Dockerfile`（多阶段，dist 纯 Node 无依赖）+ `docker-compose.yml`（sync-server + Caddy
  自动 HTTPS）+ `Caddyfile`。

### tombstone 回收
- `SqlLedgerStore.purgeTombstonesBefore(cutoff)` + `purgeTombstones(store, days=90)`：物理删除超期
  软删行 + 清理孤儿 steps。设置页加「清理已删除记录（90天前）」按钮。

### 客户端多端点
- 同步页云账户改为**多服务器地址**（每行一个，公网+内网）：登录时逐端点登录（各自 token），
  「立即同步」对每个已登录端点各同步一轮，账号在多台服务器间收敛。

### Verified
- **99 tests** (core 34 · db 29 · logger 5 · sync-server 4 · web 27)；typecheck 干净；web build。
- 单测覆盖：嵌套事务不破坏、乐观锁拒绝/重试、HMAC 篡改拒绝、限流 429、tombstone 物理清除。

### 剩余（A+B 未完）
- **阶段 A**：事件同步（B）+ 冲突分级 —— 最大的一次重写，下一轮专注（先落地设计）。
- **阶段 B**：定投计划+提醒、手续费开关、游戏效率细分、图表、基准日可配、附件 —— 全部未开始。

---

## 2026-07-06 — 固定资产/转换分组折叠+筛选+图表 · 游戏自定义 · 同步设备记录

**Goal:** product polish across Fixed / Convert / Game / Sync + a data-model field.

### Data model
- `FixedAsset.category`（core types + db `tables.ts` + **migration v2** idempotent `ALTER TABLE
  fixed_assets ADD COLUMN category`; PRAGMA-guarded so new & old DBs both work). Seed + form updated.

### Fixed assets (rewrite)
- Status filter (全部/使用中/已售出), grouped by **category**, per-asset **collapsible history**
  (default folded), global **month + event-type** history filters, and a **per-day-cost bar chart**
  for in-use assets. Selector gained `category`.

### Convert (rewrite)
- **Grouped by asset** (`buildConvert` → `groups`): each crypto group header shows holdings / value /
  avg cost / unrealized P&L; groups are **foldable** (first open), with global month + operation
  filters; chains still expand to steps + delete.

### Game
- **Game selector** (dropdown when >1 game) — `buildGameSeason(snap, gameId, seasonId)` filters
  seasons/accounts to the chosen game. Forms default the settlement/quote currency to the configured
  **settlement currency** (`settlementOpts` puts it first) — so "default currency" is customizable.

### Sync
- Device registry now records **applied count** per sync; `DeviceInfo` + `registerSync` extended; the
  device table shows 设备 ID / 上次同步 / 上次应用, refreshed via state after each sync
  (fixes "现在不会显示").

### Verified
- Suite: **95 tests** (core 34 · db 26 · logger 5 · sync-server 3 · web 27); typecheck + web build.
- Vite preview: Fixed shows 4 category groups + chart + collapsible history + filters; Convert shows
  BTC/ETH/GBP/USDT groups with holdings summary + filters; Sync device table shows last-sync time +
  applied count.

---

## 2026-07-05 — 账户 + 端到端加密 + HTTP 同步服务器 + Tauri 桌面壳

**Goal:** accounts / encryption / real HTTP sync server / desktop shell.

### E2E encryption (`@zichan/core`)
- `crypto.ts` — WebCrypto PBKDF2-SHA256 → AES-GCM-256: `encryptJson`/`decryptJson`/`deriveAuthProof`
  (auth proof is a *separate* derivation from the enc key). No DOM/node lib (minimal ambient decls).
  Tests: `crypto.test.ts` (4).

### Sync server + client (`@zichan/sync-server`, `@zichan/db`)
- `apps/sync-server` — pure Node `http`, zero runtime deps: `/api/register|login|events`,
  auth by `sha256(authProof)`, stores encrypted event payloads only. File-persisted.
- `packages/db/http-transport.ts` — `httpEventTransport` encrypts/decrypts per-event payloads +
  `registerAccount` / `loginAccount`. Ambient `fetch` (no lib dep).

### Web + desktop
- **Sync screen** gains a **云账户 (cloud account)** card: server URL / username / password, register +
  login → event sync uses `httpEventTransport` (E2E); password/token in memory only. Falls back to the
  local localStorage event cloud when not logged in.
- **`apps/desktop`** — Tauri 2 shell: `tauri.conf.json` → `../../web/dist`, `Cargo.toml`, `main.rs`/
  `lib.rs`, `capabilities/default.json`, generated icon set.

### Verified
- Suite: **94 tests** (core 34 · db 26 · logger 5 · sync-server 3 · web 26); typecheck clean; web build.
- sync-server e2e: encrypted event sync converges; **server stores ciphertext only**
  (asset codes don't leak).
- **Tauri `cargo build` passed (~2 min) → native `zichan.exe` (~12 MB)**.

---

## 2026-07-05 — 同步网络层 + 多设备 UI + 冲突箱 · 全屏 selector 提取

**Goal:** wire sync's transport + multi-device UI + conflict box; extract remaining screens.

### Selector extraction (task A)
- Extracted `buildConvert` / `buildGameSeason` / `buildFixed` / `buildReport` into
  `src/selectors/{convert,game,fixed,reports}.ts`; screens are now render-only. Reports cells are
  plain strings (no React dep).
- Web tests: `test/{convert,game,fixed,reports}.test.ts` (+11 → **26 web tests**) over the fixtures.

### Sync network layer + UI (task B)
- **`@zichan/db` sync.ts**: `SyncTransport` port (`pull`/`push`), `syncWithRemote(store, transport)`
  (pull → merge → push), `memoryTransport()`. `SyncConflict` now carries both sides' full entities
  for the conflict box. Tests: `sync.test.ts` +2 → 6.
- **web**: `src/db/cloud.ts` — `localEventTransport` (localStorage as a shared event cloud),
  per-tab `getDeviceId` (sessionStorage), device registry. Store now uses the per-tab device id.
- **`Sync` screen** (+ nav): device id, 立即同步 (`syncWithRemote`), device list, and a **conflict
  box** listing entities changed on both sides — shows local vs remote business fields, LWW default,
  and 保留本地 / 保留远程 manual override (§23).

### Verified
- Suite: **87 tests** (core 30 · db 26 · logger 5 · web 26); typecheck clean; web build (82 modules).
- Vite preview end-to-end: sync pushes local → cloud (5 assets); constructed a BTC conflict across
  "devices" → conflict box shows 本地BTC vs 云端BTC, LWW keeps remote; 「保留本地」override flips it
  back and clears the box.

---

## 2026-07-05 — 手动选批次 · web 测试 · doctor · 设置页 · 同步核心

**Goal:** the remaining backlog — manual lot pick, web-layer tests, doctor, settings, sync.

### Service layer (`@zichan/db`)
- **`doctor.ts`** — `checkConsistency` (lot remaining / oversold / orphan consumption / stale chain
  cache) + `recomputeCaches` (rewrite lot remaining/status + chain caches from steps+consumptions).
  Tests: `doctor.test.ts` (4).
- **`sync.ts`** — state-based LWW sync core: `mergeInto(target, snapshot)` + `syncStores(a, b)`;
  conflict detection when both sides changed an entity; idempotent; tombstone propagation.
  Tests: `sync.test.ts` (4). Network/transport + E2E encryption deferred.

### Web
- **Manual lot pick**: AddConversionModal sell + method=manual lists the asset's open lots
  (date/remaining/unit cost), collects `selectedLotIds` in click order → `recordSell`.
- **Settings screen** (+ nav): settlement currency (money symbol follows via `setBaseSymbol`),
  default lot method, run self-check / recompute caches, reset data.
- **Web unit tests**: extracted `buildDashboard` into `src/selectors/dashboard.ts`; added vitest to
  `apps/web` with `test/` (15) over derive, format, and the dashboard selector + a `fixtures.ts`.

### Bugs found (by the new tests / running it)
- `signedMoney(0)` returned `+£0.00` — decimal.js `isPositive()` is true for +0; added `isZero()`
  check (caught by format.test.ts).
- `checkConsistency` threw `[DecimalError] Invalid argument: 01KWRW…` on real data — a ULID
  (starts with a digit) matched a loose `/^\d/` and was fed to `Decimal`. Tightened to a full
  numeric regex; added a ULID regression test. **Caught only by the running app**, not the unit
  tests (which used literal 'GBP'/'BTC' ids) — good argument for the preview smoke test.

### Verified
- Suite: **74 tests** (core 30 · db 24 · logger 5 · web 15); typecheck clean; web build (76 modules).
- Vite preview: self-check reports 「未发现不一致」 on seeded data + recompute (11 chains);
  manual-lot panel lists 5 open BTC lots with unit costs; settings render; header currency dynamic.

---

## 2026-07-05 — 录入表单 + 编辑/删除（gap 1+2）

**Goal:** fill entry/edit gaps — CRUD forms for the remaining entities + edit/delete.

### Service: `deleteConversion`
- `packages/db/src/services.ts` — soft-delete a chain and reverse its lot effects: buy/dca →
  soft-delete produced lots; sell → restore consumed amounts onto lots + remove consumptions.
- Tests: `test/services.test.ts` +2 (delete-buy removes lot; delete-sell restores 0.007 held).

### Generic form framework (web)
- `ui/EntityFormModal.tsx` — field-definition-driven modal; handles add/edit and shows a delete
  button when `onDelete` is passed.
- `forms.tsx` — `EntityFormSpec` factories for asset/account/priceMark/game/gameAccount/
  gameSeason/gameRecord/fixedAsset/fixedEvent (select options come from the snapshot).

### Wired into screens
- New **管理 (Manage)** screen + nav: CRUD lists for assets / accounts / price marks / games /
  game accounts (reusable `Section` component).
- **Game**: add/edit/delete game records (click a row to edit), add season.
- **Fixed**: add/edit fixed assets, add/edit/delete events (click a timeline dot).
- **Convert**: expanded chains get a 「删除此链路」 button → `deleteConversion`.

### Verified (ran it)
- Suite: **51 tests** (core 30 · db 16 · logger 5); web typecheck + build (72 modules) clean.
- Vite preview: Manage renders all 5 sections; account **create → edit → delete** end-to-end
  (new row appears, then removed after delete). Fixed a generics error (`defaults<T>` in
  EntityFormModal).

---

## 2026-07-05 — 服务层 + 导入导出 + 卖出闭环

**Goal:** answer "还有哪里没完善" and fill the highest-value gaps (desktop/mobile deferred).

### Gap review (recorded for later)
Entry/edit UI is the biggest gap (only 新增转换 existed); no game-record / fixed-event /
asset-account / price entry; no edit/delete; no import/export; no balance self-check; no web-layer
tests; sync is v2.

### Added application service layer — `@zichan/db/services`
- `recordConversion(store, {chain, steps})` — save chain, back-fill trace caches, create the
  cost-basis lot for buy/dca.
- `recordSell(store, {chain, steps, method, selectedLotIds?})` — save sell, `matchSell` open lots
  (FIFO/LIFO/average/manual), write consumptions, update lots, back-fill proceeds + realized P&L.
- `exportLedger` / `importLedger` — full JSON backup / restore (upsert merge).
- Tests: `test/services.test.ts` (4) — lot creation, FIFO sell close-out, export→import round-trip
  into a fresh store, bad-version rejection.

### Wired into web
- `AddConversionModal` now calls the services; sells show a **cost-match method** dropdown
  (FIFO/LIFO/average) and run the full lot close-out.
- Header **导出 / 导入 JSON** buttons (`exportLedger` → download blob; file input → `importLedger`
  → `bump`).
- Refactored `seed.ts` to build its DCA/ETH/sell data via the services — business logic is now
  one place, and the seed exercises the service path. Dashboard numbers are byte-identical after
  the refactor (net £6,963.11, unrealized +£126.38, realized +£89.95).

### Verified (ran it)
- Suite: **49 tests** (core 30 · db 14 · logger 5); web typecheck + build (69 modules) clean.
- Vite preview: reseed via services renders identical figures; **新增卖出** end-to-end — a sell
  row appears with 实现盈亏 +£7.64 and BTC holdings drop 0.017501 → 0.016501 (lot remaining
  updated by `recordSell`). Import/export covered by the services round-trip test.

---

## 2026-07-05 — Web 应用（React + Vite）

**Goal:** build `apps/web`, recreating the 5 prototype screens + 3 themes, wired to core + db.

### Added `@zichan/web`
- Scaffold: Vite + React + TS, `index.html`, `styles.css`, `theme.ts` (tokens copied from the
  prototype), `App.tsx` (sidebar/header/theme + screen switch matching the mock's layout).
- **Browser persistence (reuses `@zichan/db`)**: `SqlJsDriver` (sql.js WASM implementing the
  `SqlDriver` port) + IndexedDB blob store (`idb.ts`) + `StoreProvider` context. Same schema/
  repository/audit as node — SQLite everywhere.
- **Data flow**: `snapshot.ts` (load all entities per revision) + `derive.ts` (balances via
  postings, price lookup; crypto holdings from lots, cash from balances, external equity account
  excluded).
- **Screens** (`src/screens/`): Dashboard, Convert, Game, Fixed, Reports — all compute view
  models from `@zichan/core` (`traceChain`, `seasonSummary`, `fixedAssetCost`, `buildDcaReport`,
  `valuePortfolio`/lots). `AddConversionModal` = first end-to-end write flow.
- **Seed** (`seed.ts`): self-consistent demo data — each DCA round is a real GBP→USDT→BTC chain
  that produces its lot; an opening deposit via an equity account; game seasons; fixed assets.

### Fixes / decisions
- **sql.js + Vite**: it's CJS — `optimizeDeps.include: ['sql.js']` (not exclude, which hangs dev);
  `.wasm` loaded via `?url`.
- **Unrealized P&L bug** (found in the running app: −£1,029 instead of +£126): crypto quantity
  must come from **lots**, not chain balances, so value and cost basis share one basis. Fixed in
  Dashboard; reworked the seed so DCA chains + lots + cash outflow are all consistent.

### Verified (ran the app, not just the build)
- `npm run build -w @zichan/web` ✓ (68 modules, wasm copied to dist).
- Vite preview smoke test: sql.js inits, all 5 screens render, figures computed by the core
  (Convert: 0.017501 BTC · 现值 £1,281.07 · 未实现 +£68.72; Dashboard net £6,963.11), and the
  **新增转换** form writes a chain end-to-end (new row appears, expandable, audited).
- Full suite still green: **45 tests** (core 30 · db 10 · logger 5).

---

## 2026-07-05 — DB 层、日志、文档

**Goal:** build the persistence layer, add a logging facility, and write docs.

### Added `@zichan/logger`
- `packages/logger/` — structured, leveled logger (`trace…error`), pluggable sinks
  (`console`/`json`/`memory`/`null`), child loggers with dotted scope + inherited fields and a
  shared live level box. Platform-agnostic (reads `console` off `globalThis`, no DOM/node lib).
- Tests: `test/logger.test.ts` (5) — filtering, scope/field composition, `setLevel` propagation,
  error serialization, JSON sink.

### Added storage port to `@zichan/core`
- `packages/core/src/storage.ts` — `LedgerStore`, `Collection<T>`, `Query<T>`,
  `OperationLogEntry`/`OperationType`. Exported from the core barrel. Defines *what* persistence
  looks like; db implements it.

### Added `@zichan/db`
- `src/driver.ts` — `SqlDriver` async port (`exec/run/all/get/transaction/close`).
- `src/drivers/node-sqlite.ts` — `NodeSqliteDriver` over Node's built-in `node:sqlite`, loaded
  via `process.getBuiltinModule` (see “Decisions” below).
- `src/tables.ts` — declarative table registry; DDL, params, and row⇄entity mapping derive from it.
- `src/schema.ts` — DDL generation + hand-written `conversion_steps`, `operation_log`,
  `schema_migrations`.
- `src/migrations.ts` — idempotent numbered-migration runner (v1 = full schema).
- `src/repository.ts` — `SqlLedgerStore`: generic audited `Collection`s, chain+steps handling,
  operation-log queries.
- `src/index.ts` (driver-agnostic) + `src/node.ts` (`openLedger` convenience; `@zichan/db/node`).
- Tests: `test/repository.test.ts` (7) + `test/integration.test.ts` (3) — CRUD, version/timestamp
  semantics, soft-delete filtering, `where` injection guard, operation log, chain+steps round-trip
  **fed through the core calc engine**, and file-backed persistence across a reopen.

### Operation log (the app's own “记录操作”)
- Every `put`/`remove`/`saveChainWithSteps` writes an `operation_log` row
  `{ at, deviceId, entityType, entityId, op, version, payload, summary }` — durable audit trail
  and the seed of the plan's v2 event-sync.

### Docs
- `docs/db.md`, `docs/logging.md`, this `docs/worklog.md`; updated root `README.md` and root
  scripts to build/test/typecheck all workspaces.

### Decisions / fixes worth remembering
- **`node:sqlite` + Vite:** this Vite version doesn't know the new `node:sqlite` builtin and tried
  to bundle it (tests failed to load). Fixed by loading it through `process.getBuiltinModule`
  (a runtime call no bundler sees) instead of a static `import`.
- **`createdAt` on `put`:** switched `??` → `||` so an empty-string `createdAt` gets stamped
  (callers often construct entities with `createdAt: ''`).
- **Logger platform-agnostic:** defined `ConsoleLike` + `globalThis.console` instead of the ambient
  `Console`/`console`, so no DOM/node lib is needed.

### Verified
- `npm test` → **45 passing** (core 30 · db 10 · logger 5).
- `npm run typecheck` clean · `npm run build` emits `dist` for logger/core/db.

---

## 2026-07-04 — 核心计算库 + 数据模型

**Goal:** import the design handoff and build the core first, redesigning the data model.

- Imported `多资产生命周期记账系统-handoff.zip`; read `README.md`, the full prototype
  `资产记账系统.dc.html`, and its `DCLogic` runtime (`support.js`).
- Reviewed design plan v0.2, flagged ~20 gaps (missing `assets`/`accounts`/`lots`/`price_marks`
  tables, undefined fee/sign conventions, float precision, event-vs-mutable-table conflict, etc.).
- Scaffolded npm monorepo (Node 26, TypeScript, decimal.js, vitest).
- Built `@zichan/core`: entity model v1 (`types.ts`), decimal helpers, balance engine
  (`postings.ts`), conversion-chain cost/proceeds tracing (`conversion.ts`), lots + FIFO/LIFO/
  average/manual sell matching (`lots.ts`), DCA report (`dca.ts`), game-season P&L (`game.ts`),
  fixed-asset daily cost (`fixed.ts`), portfolio valuation (`valuation.ts`).
- Wrote `docs/data-model.md` documenting the redesign and the key conventions (§0), incl. the
  corrected fee-cost model (plan's £251.98 double-counts a mid-chain fee → correct £251.50; a
  `feeCostMode: 'net' | 'sum-all'` switch keeps the alternate figure available).
- Verified: 30 tests passing, typecheck clean, build emits `dist`.
