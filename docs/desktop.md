# 桌面端 `@zichan/desktop`（Tauri 2）

一个供桌面与移动端共用的 **Tauri 2** 外壳。UI、业务计算和仓储仍复用
`@zichan/web` + `@zichan/core` + `@zichan/db`，但持久化已原生化：
`TauriSqlDriver` 通过 `tauri-plugin-sql` 使用 `ledger.sqlite`，附件使用平台文件目录。

## 结构

```
apps/desktop/
  package.json                 # desktop/android/ios/server scripts
  plugins/system-share/        # Android/iOS 原生 JSON 文件分享插件
  src-tauri/
    tauri.conf.json            # 指向 ../../web/dist；devUrl localhost:5173；窗口 1320×880
    Cargo.toml                 # tauri 2 + tauri-plugin-sql + sqlx
    build.rs
    src/lib.rs                 # Tauri 入口、桌面服务器、备份与凭据命令
    src/native_sql.rs          # SQLite 查询及绑定连接的事务桥
    src/native_attachments.rs  # 附件正文/缩略图文件桥
    capabilities/default.json  # 主窗口默认权限
    icons/                     # 由 `npm run icon` 从 icon.png 生成的整套图标
```

- `beforeDevCommand` / `beforeBuildCommand` 会自动先跑 `@zichan/web` 的 dev/build，所以桌面端
  与 web 永远同源，无需手动构建前端。

## 开发 / 打包

```bash
# 前置：Rust 工具链（rustup）+ 平台依赖（Windows 为 MSVC/C++ 工具、WebView2、Perl）
npm run dev   -w @zichan/desktop     # 起 vite + 原生窗口，热更新
npm run build -w @zichan/desktop     # 产出安装包（.msi/.exe，或对应平台）
npm run icon  -w @zichan/desktop     # 从 src-tauri/icons/icon.png 重新生成图标集
npm run release:check -w @zichan/desktop # 打包前检查 web、sync-server 与 Rust 命令层
npm run start:desktop                # 从根目录启动桌面开发壳，并纳入端口清理
```

Windows 可双击 `scripts\windows\build-desktop.cmd` 完成本地正式构建。该入口检查 Node、npm、依赖、Rust 与 Perl，失败时保留错误信息；SQLCipher 使用 vendored OpenSSL，release 构建需要 `perl.exe` 位于 `PATH`。它不会生成正式发布签名。安装包位于 `apps\desktop\src-tauri\target\release\bundle\msi` 和 `bundle\nsis`。

首次 `dev`/`build` 会用 cargo 拉取并编译 Tauri 依赖树（数百个 crate），耗时较久；之后走缓存很快。

## 发布验收清单

- 应用名：`资产生命周期`；窗口标题：`资产生命周期 · Lifecycle Ledger`。
- 版本号：`apps/desktop/package.json` 与 `src-tauri/tauri.conf.json` 同步为 `0.1.0`。
- Bundle ID：`com.zichan.ledger`；图标来自 `src-tauri/icons/icon.png`，改图后运行 `npm run icon -w @zichan/desktop`。
- 主库：Tauri `AppData/ledger.sqlite`（Rust 先解析绝对路径，再交给 `tauri-plugin-sql`；“更多”抽屉会显示实际路径）。
- 附件：Tauri `AppData/attachments/{staging,objects,trash,quarantine}`，正文按 SHA-256 寻址；加密 `.zcbak` 备份：`AppData/backups`。
- 一体服务器数据在 `%APPDATA%\ZichanLedger\server`，包括 `server.sqlite`、`server.secret`、`server-id`、`blobs/` 和 `admin-token.txt`。
- 打包前先跑 `npm run release:check -w @zichan/desktop`，再跑 `npm run build -w @zichan/desktop` 生成安装包。
- 发布说明至少写清：新增功能、数据目录、备份建议、同步服务器是否需要重新登录、已知限制。
- 自动化发布、签名 Secret 和全新 Windows Runner 安装验收见 [desktop-release.md](desktop-release.md)。

原生 SQL、Stronghold 和本地 system-share 依赖均已写入 `Cargo.lock`。未使用的原生 notification
插件已删除，主窗口权限只保留 SQL load/close 与实际调用的 Stronghold 命令。当前环境已通过
`cargo fmt --check`、`cargo check` 和 3 项 Rust 单测；正式安装包由发布流水线完成 bundle、签名及安装测试。

## 原生安全边界

Tauri CSP 明确限制为本应用脚本，禁止对象、外部 frame 和非本源表单；图片仅允许应用资源、
`asset:`、`blob:` 与 `data:`，网络连接保留同步服务所需的 HTTP(S)/WS(S)。桌面 capability
不授予通用 SQL 执行权限，业务写入统一走 Rust 事务桥；移动端相机、生物识别、扫码、定位和分享
权限放在仅 iOS/Android 生效的独立 capability。

## 数据与同步

桌面端和 web 用**同一份前端代码**，`platform-driver.ts` 按运行环境选驱动：普通浏览器使用
sql.js + IndexedDB，Tauri 使用原生 SQLite，不读取或迁移 WebView IndexedDB。云同步仍走
同一套 [端到端加密](cloud-sync.md)。

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
- `REGISTRATION_MODE=invite`：默认邀请码注册。
- `BASE_PATH=/xxxxx`：可选，把 Web、同步和后台都挂到端口后的安全路径。
- `HOST=0.0.0.0`：默认对局域网开放监听；如只想本机访问，可改成 `127.0.0.1`。
- `DATA_DIR=D:\ledger-server` 可指定完整数据目录；未设置时回退到 Windows `%APPDATA%\ZichanLedger\server`。
  主库固定为 `server.sqlite`；备份与恢复使用 `npm run server:backup` / `server:restore`，不要在服务运行时逐文件复制。
- 管理员 Token 会生成到同目录 `admin-token.txt`；Web 的「服务器」页用它管理邀请码和用户状态。
- 桌面/脚本启动器显式设置 `ALLOW_INSECURE_HTTP=1`，仅用于固定私有局域网 IP；客户端会拒绝公网 HTTP，
  远程管理员 API 仍只接受 HTTPS。本机管理可继续使用 `http://localhost:8787`。

可拆分命令：

```bash
npm run server:build -w @zichan/desktop   # 只构建 web + sync-server
npm run server:run   -w @zichan/desktop   # 只运行已构建的一体服务
npm run stop:server                       # 清理 8787 端口
```

如果只想当同步服务器，可启动前设置 `ENABLE_WEB=0`；如果只想托管 Web，可设置 `ENABLE_SYNC=0`。需要隐藏路径时设置 `BASE_PATH=/home-ledger`，同步页的服务器配置里也填写同一个「服务路径」。

## 在线启动

桌面壳内的「同步 → 服务器管理」会检测 Tauri 环境：

- **Tauri 桌面**：可点击「启动本机服务器」在线拉起 `0.0.0.0:8787`，并显示数据文件和管理员 Token 文件位置；如果服务由桌面在线启动，也可在线停止。
- **普通浏览器 Web**：不能直接启动本机进程，页面显示“Web 模式 / 未启用”，并提示在项目目录使用 `npm run start:server`。

在线启动会复用 `apps/desktop/scripts/server.mjs`；如果 `apps/web/dist` 或 `apps/sync-server/dist` 缺失，会先尝试执行 `npm run server:build -w @zichan/desktop`。
安装包使用 `prepare:resources` 生成的内置 `server.mjs`、Node 运行时和 Web 资源；`tauri build` 会自动重新构建并生成这些资源，不能手工维护生成文件。
启动后在「同步」页可为每台同步服务器单独设置中文别名、协议、主机、端口、服务路径、同步用户名和同步密码，并用「测试」检查在线状态、密码是否正确和延迟。账号使用一次性 nonce 登录、15 分钟访问令牌和可轮换设备会话；同一配置的并发同步共享一次认证，避免 refresh token 竞争。管理员后台可查看最近日志、在线设备、最后 IP，并撤销单台设备。

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

当前 Windows 环境只有 JDK 11，且没有 Android SDK/adb，因此没有生成 `gen/android`，也不能在本机证明 APK 构建。
安装前置工具后先执行一次 `mobile:init:android`；生成目录是平台构建产物，不改变共享业务代码。

`android:init` 生成工程后会自动运行 `scripts/configure-android.mjs`，使发布 WebView 能连接家中 `http://192.168.x.x` 同步服务器；重新生成工程后也可单独运行 `npm run android:configure -w @zichan/desktop`。iOS plist 同样允许本地网络 WebView 请求。该例外是为了局域网自托管，事件内容仍为端到端密文；公网服务器必须使用 HTTPS。

移动壳还接入 biometric、barcode-scanner、geolocation 和 system-share：应用锁可选开启；物品表单可扫码，附件可直接调用相机，流水可主动记录当前位置。加密 `.zcbak` 备份不依赖 WebView 的文件分享能力，而是由 `plugins/system-share` 写入原生缓存并打开 Android/iOS 系统分享面板。通知仅在 WebView 提供标准 Web Notification 时可用。iOS 隐私用途说明位于 `src-tauri/Info.ios.plist`；Android 相机和定位权限由对应插件声明并在使用时请求。
