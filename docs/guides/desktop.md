# 桌面端 `@zichan/desktop`（Tauri 2）

一个供桌面与移动端共用的 **Tauri 2** 外壳。UI、业务计算和仓储仍复用
`@zichan/web` + `@zichan/core` + `@zichan/db`。桌面端由自有 Rust 命令桥管理
SQLCipher/SQLite 和附件；Windows 有数据随 ZIP 移动的便携模式，以及数据留在当前用户目录的安装模式。

0.3.3 起 Windows、Linux 原生端和 Android 在“设置 → 应用版本更新”提供签名更新检查与安装入口；各包格式、密钥、测试步骤和系统确认边界见[客户端签名更新手册](../deployment/client-self-update.md)。

## 结构

```
apps/desktop/
  package.json                 # desktop/android/ios/server scripts
  plugins/system-share/        # Android/iOS 原生 JSON 文件分享插件
  src-tauri/
    tauri.conf.json            # 指向 ../../web/dist；devUrl localhost:5173；窗口 1320×880
    Cargo.toml                 # tauri 2 + sqlx/SQLCipher
    build.rs
    src/lib.rs                 # Tauri 入口、便携预检、桌面服务器、备份与凭据命令
    src/native_sql.rs          # SQLite 查询及绑定连接的事务桥
    src/native_attachments.rs  # 附件正文/缩略图文件桥
    capabilities/default.json  # 主窗口默认权限
    icons/                     # 由 `npm run icon` 从 icon.png 生成的整套图标
```

- `beforeDevCommand` / `beforeBuildCommand` 会自动先跑 `@zichan/web` 的 dev/build，所以桌面端
  与 web 永远同源，无需手动构建前端。

## 开发 / Windows 打包

```bash
# 前置：Rust 工具链（rustup）+ 平台依赖（Windows 为 MSVC/C++ 工具、WebView2、Perl）
npm run dev   -w @zichan/desktop     # 起 vite + 原生窗口，热更新
npm run build -w @zichan/desktop -- --no-bundle --ci # 仅构建 Windows 桌面可执行文件
npm run icon  -w @zichan/desktop     # 从 src-tauri/icons/icon.png 重新生成图标集
npm run release:check -w @zichan/desktop # 打包前检查 web、sync-server 与 Rust 命令层
npm run start:desktop                # 从根目录启动桌面开发壳，并纳入端口清理
```

Windows 首次先运行 `scripts\windows\setup-webview2-runtime.cmd` 准备锁定的固定版 WebView2，随后双击
`scripts\windows\build-desktop.cmd` 完成本地正式构建。该入口检查 Node、npm、依赖、Rust 与 Perl，运行
发布门禁，并要求 Node.js 与 `.node-version` 完全一致，以 `--no-bundle` 和 Cargo `--locked` 构建并生成 ZIP。SQLCipher 使用 vendored OpenSSL，release 构建需要
`perl.exe` 位于 `PATH`。产物位于 `apps\desktop\src-tauri\target\release\portable`。
MSI/NSIS 使用独立的 `npm run build:desktop:installer` 入口，布局、签名和 VM 验收见 [windows-installer.md](../deployment/windows-installer.md)。

首次 `dev`/`build` 会用 cargo 拉取并编译 Tauri 依赖树（数百个 crate），耗时较久；之后走缓存很快。
Debug 模式只写仓库内被忽略的 `.runtime/desktop/`；自动化测试可用绝对路径
`ZICHAN_PORTABLE_TEST_ROOT` 覆盖该位置。Release 不读取这个变量，也不存在环境变量路径覆盖。

## 发布验收清单

- 应用名：`资产生命周期`；窗口标题：`资产生命周期 · Lifecycle Ledger`。
- 版本号：`apps/desktop/package.json` 与 `src-tauri/tauri.conf.json` 同步为 `0.1.0`。
- Bundle ID：`com.zichan.ledger`；图标来自 `src-tauri/icons/icon.png`，改图后运行 `npm run icon -w @zichan/desktop`。
- 便携版根目录来自 `zichan.exe` 所在位置；缺少/损坏 `portable-mode.json`、路径不可写或处于网络盘时，启动失败且不回退 AppData。安装版用 `installed-mode.json` 标记，并将用户数据写入 `%LOCALAPPDATA%\com.zichan.ledger`。
- 主库：`data/ledger/ledger.sqlite`；附件：`data/attachments/{staging,objects,trash,quarantine}`；加密 `.zcbak`：`data/backups`。
- Stronghold 位于 `data/security`；WebView 的 localStorage、IndexedDB 和缓存固定在 `data/webview`；一体服务器状态位于 `data/server`。

升级便携版时先正常退出应用和内置服务器，把新 ZIP 解压到新的空目录。仅在新旧版本的数据 schema 均受当前程序支持时，才将旧目录的整个 `data/` 复制进去；当前客户端仅接受 schema 127，内置服务器仅接受 schema 27，旧开发数据不支持直接复制升级。保留旧目录作为回退副本。不要把新资源直接覆盖到旧程序目录：旧的带哈希 JS 文件可能残留，便携资源清单校验会拒绝启动。移动同一版本时则移动整个便携目录。
- 打包前运行 `npm run release:check` 和 `npm run test:release`；正式入口统一为 `scripts\windows\build-desktop.cmd`。
- 发布说明至少写清：新增功能、数据目录、备份建议、同步服务器是否需要重新登录、已知限制。
- 完整 ZIP 契约、WebView2 准备和 Windows Sandbox 验收见 [desktop-release.md](../deployment/desktop-release.md)。

原生 SQL、Stronghold 和本地 system-share 依赖均已写入 `Cargo.lock`。Windows 主窗口在配置中
`create=false`，只有当前模式的目录、磁盘、实例锁和 WebView2 预检全部成功后才手动创建。自动更新仍未启用；安装版生成 MSI/NSIS，便携版保持 ZIP 独立交付。

## 备份另存为

Windows 便携版的 `data/backups` 是同一便携目录内的本机恢复点，不算独立副本。设置页历史备份和顶栏
「导出」在桌面端都会先安全写入该目录，再打开 Windows 原生「另存为」窗口；请选择另一块磁盘、U 盘或受控
目录。应用会校验副本、原子替换目标文件，并拒绝保存回 `data/`；取消窗口或保存失败都不会移动、删除或修改
原备份。桌面端不依赖 WebView 的 Blob 下载或 Android/iOS 专用系统分享插件，因此不会出现“点击无反应”的假成功。

浏览器 Web 继续使用浏览器下载/可用时的系统分享能力；Android/iOS 继续使用原生系统分享面板。

## 原生安全边界

Tauri CSP 明确限制为本应用脚本，禁止对象、外部 frame 和非本源表单；为本地 `sql.js` 编译
WebAssembly 仅额外允许 `wasm-unsafe-eval`，仍禁止 JavaScript `unsafe-eval`；图片仅允许应用资源、
`asset:`、`blob:` 与 `data:`，网络连接保留同步服务所需的 HTTP(S)/WS(S)。桌面 capability
不授予通用 SQL 执行权限，业务写入统一走 Rust 事务桥；移动端相机、生物识别、扫码、定位和分享
权限放在仅 iOS/Android 生效的独立 capability。

数据库初始化失败页会显示可选择的完整诊断文本，并提供“复制诊断信息”按钮；若 WebView 剪贴板仍被
系统策略拒绝，可点击文本框后按 `Ctrl+A`、`Ctrl+C` 手动复制，不需要截图。

Windows Stronghold 仍保持前端插件 API，但由桌面自有的受限命令层托管；快照只能是
`data/security/sync-vault.hold`，salt 只能是同目录 32 字节普通文件，链接、重解析点和目录外路径均拒绝。

## 数据与同步

桌面端和 web 用**同一份前端代码**，`platform-driver.ts` 按运行环境选驱动：普通浏览器使用
sql.js + IndexedDB，Tauri 使用原生 SQLite，不读取或迁移 WebView IndexedDB。云同步仍走
同一套 [端到端加密](../architecture/cloud-sync.md)。

`TauriSqlDriver.transaction()` 会申请一个 Rust 侧连接并执行 `BEGIN IMMEDIATE`；事务内所有
`run/all/get/exec` 都携带 transaction id，嵌套事务使用 savepoint，异常时回滚。数据库连接启用
foreign keys、5 秒 busy timeout、WAL 和 `synchronous=FULL`。前端 FIFO 队列会先完成当前顶层
事务，再启动用户操作、后台同步或关闭请求；事务回调必须使用其传入的连接绑定作用域。

附件先原子写入 `staging` 并校验 SHA-256，再与 SQLite 文件操作日志一起提交，最后原子提升到
`objects/<前两位>/<sha256>`。应用重启会完成已提交提升、清理未提交暂存；删除先进入 `trash`，
哈希路径发生内容碰撞时旧文件进入 `quarantine`。附件通过同步服务器按 4 MiB 加密分块复制，图片缩略图自动取回，正文按查看、保存或备份需要下载。

## 桌面电脑作为服务器

一台常开、固定 IP 的电脑可以直接运行统一服务器，既托管 Web，也提供同步 API 和后台 API：

```bash
npm run server -w @zichan/desktop
# 或从根目录：
npm run start:server
```

这个脚本会先构建 `@zichan/web` 和 `@zichan/sync-server`，再启动 `http://localhost:8787`。
默认监听 `0.0.0.0:8787`，方便同局域网设备通过这台电脑的内网 IP 访问：

- `ENABLE_WEB=1`：浏览器可访问 Web UI。
- `ENABLE_SYNC=1`：其他设备可填该电脑的内网/公网地址同步。
- `REGISTRATION_MODE=open`：默认开放注册；普通注册为成员；部署者在启动日志显示的 `/<安全路径>/admin/` 页面显式创建唯一 Owner。
- `BASE_PATH=/xxxxx`：可选，把 Web、同步和后台都挂到端口后的统一前缀；后台还会在此前缀后自动加专用安全路径。
- `HOST=0.0.0.0`：默认对局域网开放监听；如只想本机访问，可改成 `127.0.0.1`。
- 仓库开发入口显式使用 `.runtime/sync-server`；便携桌面在线启动固定使用 EXE 根目录下的 `data/server`。服务器入口缺少 `DATA_DIR` 时直接失败，不回退 AppData。
  主库固定为 `server.sqlite`；备份与恢复使用 `npm run server:backup` / `server:restore`，不要在服务运行时逐文件复制。
- 账号管理复用正常 OPAQUE 登录与设备会话；管理员可在独立 `/<安全路径>/admin/` 页面管理注册模式、邀请、用户、设备和配额，不存在额外的人工管理凭据。
- 仓库开发启动器、桌面与便携启动器均默认设置 `ALLOW_INSECURE_HTTP=1` 并监听 `0.0.0.0`，固定私有局域网 IP 可用 HTTP 打开网站根路径 `/` 与启动日志显示的后台路径
  （管理 Cookie 不带 Secure，仅在可信内网使用）。已设同名环境变量的部署（如 Tauri 壳与 Docker）不受影响。客户端仍拒绝公网 HTTP，公网登录与管理必须使用 HTTPS。本机管理可继续使用 `http://localhost:8787`。

可拆分命令：

```bash
npm run server:build -w @zichan/desktop   # 只构建 web + sync-server
npm run server:run   -w @zichan/desktop   # 只运行已构建的一体服务
npm run stop:server                       # 清理 8787 端口
```

如果只想当同步服务器，可启动前设置 `ENABLE_WEB=0`；如果只想托管 Web，可设置 `ENABLE_SYNC=0`。需要隐藏路径时设置 `BASE_PATH=/home-ledger`，同步页的服务器配置里也填写同一个「服务路径」。

## 在线启动

桌面壳内的「同步 → 服务器管理」会检测 Tauri 环境：

- **Tauri 桌面**：可点击「启动本机服务器」在线拉起 `0.0.0.0:8787`，并显示数据文件位置；如果服务由桌面在线启动，也可在线停止。首次注册成功的账号自动成为管理员。
- **普通浏览器 Web**：不能直接启动本机进程，页面显示“Web 模式 / 未启用”，并提示在项目目录使用 `npm run start:server`。

在线启动会复用 `apps/desktop/scripts/server.mjs`；如果 `apps/web/dist` 或 `apps/sync-server/dist` 缺失，会先尝试执行 `npm run server:build -w @zichan/desktop`。
便携包使用 `prepare:resources` 生成的内置 `server.mjs`、Node 运行时和 Web 资源；构建会自动重新生成这些资源，不能手工维护生成文件。
启动后在「同步」页可为每台同步服务器单独设置中文别名和完整 URL，也可展开协议、主机、端口、服务路径的高级编辑视图，并用「检查」验证在线状态和服务器身份。每台服务器账号独立，账号使用 OPAQUE 登录、15 分钟访问令牌和可轮换设备会话；同一连接的并发同步共享一次认证，避免 refresh token 竞争。管理员后台复用同一账号会话，可查看最近日志、在线设备、最后 IP，并撤销单台设备。

原生端的同步密码保存在 Tauri Stronghold，不写入配置文件或 WebView 存储。首次使用需设置至少 8 位本机密码并解锁；本机密码只用于打开当前进程的 vault，不会上传。浏览器 Web 不创建 Stronghold，同步密码仅保留在当前标签页会话。

启用自动同步后，应用启动时会提示解锁已有 Stronghold；解锁后立即同步，并继续在固定间隔、恢复前台和网络恢复时运行，离开同步页不会停止。设置页可选择在失败或出现冲突时发送系统通知。

## 移动端

移动端复用同一个 `src-tauri`、`TauriSqlDriver`、附件目录和响应式 UI。首次生成平台工程：

```bash
# Android: Android Studio/SDK、adb、NDK 和 JDK 17+
npm run mobile:init:android
npm run mobile:dev:android
npm run mobile:build:android

# iOS 只能在安装 Xcode 的 macOS 上运行
npm run mobile:init:ios
npm run mobile:dev:ios
npm run mobile:build:ios
```

Windows 开发机仍缺 Android SDK/NDK；Ubuntu 26.04 测试机已用 JDK 17、Android SDK 36、NDK 27 和 Rust `aarch64-linux-android` 目标构建 ARM64 APK。Linux 上编译 vendored OpenSSL 时，需设置 `TARGET_RANLIB="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib"`。先使用 `.node-version` 指定的 Node.js 执行 `npm ci` 和 `mobile:init:android`，再运行 `npm run mobile:build:android -- --apk --target aarch64`。生成的 Release APK 默认未签名；安装测试可用调试密钥签名，正式分发需配置自己的发布密钥。`gen/android` 是平台生成目录，不改变共享业务代码。

GitHub Actions 的 `Android candidate APK` 可从任意已推送的提交手动运行，产物包含 ARM64 未签名 APK、可安装的测试签名 APK、SHA256 校验和与源提交 SHA。测试签名密钥只在当次 CI 运行中生成，不随产物保存；不同运行的测试 APK 不能直接覆盖升级，需卸载旧包。正式分发必须使用持久保管的发布密钥重新签名并验收。Windows 的 `Windows installer acceptance` 与 `Windows portable release verification` 也支持手动候选构建；正式版本号和发布标签由人工验收后决定。

`android:init` 生成工程后会自动运行 `scripts/configure-android.mjs`；`android:dev` 和 `android:build` 也会在每次运行前应用配置。脚本使发布 WebView 能连接家中 `http://192.168.x.x` 同步服务器，并从仓库维护的 `android/MainActivity.kt` 配置 Android 系统栏与刘海屏安全区域；单独执行时使用 `npm run android:configure -w @zichan/desktop`。iOS plist 同样允许本地网络 WebView 请求。该例外是为了局域网自托管；同步提交仍以密文传输，但托管服务器持有账本解密凭据。公网服务器必须使用 HTTPS。

移动壳还接入 biometric、barcode-scanner、geolocation 和 system-share：应用锁可选开启；物品表单可扫码，附件可直接调用相机，流水可主动记录当前位置。加密 `.zcbak` 备份不依赖 WebView 的文件分享能力，而是由 `plugins/system-share` 写入原生缓存并打开 Android/iOS 系统分享面板。通知仅在 WebView 提供标准 Web Notification 时可用。iOS 隐私用途说明位于 `src-tauri/Info.ios.plist`；Android 相机和定位权限由对应插件声明并在使用时请求。

## 桌面端验收重点

Windows 便携端曾用隔离的 WebView2 窗口和本机测试服务器验证：同名附件属于不同账本、停服后继续本地记账并恢复同步、冷启动离线解锁，以及含图片的加密备份精确恢复。备份列表只读取归档头时显示“待校验”，不能把未知预检结果显示成零条实体。新版本仍需在真实安装包中复核这些流程；跨设备网络故障、真实照片传输和长期运行应单独验收。
