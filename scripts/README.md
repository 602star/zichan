# 启动与构建脚本

`scripts/` 只放可直接运行的启动、停止和构建脚本。用户入口优先使用根 `package.json` 的 npm 命令；Windows 下需要双击时使用 `windows/` 中的薄 CMD 包装，不在仓库根目录增加 CMD。

测试、CI 专用生成器和其他开发工具统一放在仓库根 `tools/`：发布测试位于 `tools/release/tests/`，数据库 schema 契约导出器位于 `tools/ci/`。它们由 npm 命令或 CI 调用，不作为日常双击入口。

## Windows 双击入口

| 脚本 | 用途 | 主要产物或地址 |
|---|---|---|
| `windows/start-all.cmd` | 同一窗口编排开发 Web 与服务器，任一退出会停止同组服务 | Web `5173` + 同步/账号管理 `8787` |
| `windows/start-web.cmd` | 启动 Web 开发服务 | `http://127.0.0.1:5173/` |
| `windows/start-sync-server.cmd` | 构建并启动同步 API + Web 管理入口 | `http://127.0.0.1:8787/`，数据位于仓库 `.runtime/sync-server/` |
| `windows/setup-webview2-runtime.cmd` | 显式下载、校验并解包锁定的 WebView2 固定版 | `.tools/webview2-fixed/<版本>/x64/` |
| `windows/build-desktop.cmd` | 运行门禁并构建 Windows x64 完全便携 ZIP | `apps/desktop/src-tauri/target/release/portable/` |

这些 CMD 会检查 Node.js 22.3+、npm 和依赖目录；桌面构建还会检查 Rust 与 Perl（vendored OpenSSL/SQLCipher 的 Windows release 构建需要 Perl）。它们不会自动安装依赖、抢占端口或结束其他程序。开发服务以前台方式运行，使用 `Ctrl+C` 停止。

CMD 默认在结束或失败时暂停，以便双击运行时看到诊断信息。终端或自动化调用可设置 `ZICHAN_NO_PAUSE=1`；只检查本机基础工具时再设置 `ZICHAN_CHECK_ONLY=1`。

同步服务器入口显式把 `DATA_DIR` 设为仓库内 `.runtime/sync-server`，不使用 AppData。默认只监听 `127.0.0.1:8787`，新数据库采用邀请注册；已有数据库的注册策略不被覆盖。未设置安全路径时，直接打开 `/admin/` 初始化并登录；配置 `ADMIN_ACCESS_PATH` 后使用 `/<安全路径>/admin/`，首次初始化前访问 `/admin/` 会跳转过去。入口也会显示在启动日志中。远程访问应配置受信 HTTPS；单独打开局域网 HTTP 不会获得浏览器账号或管理 Cookie 会话。

## 日常命令

| 命令 | 行为 |
|---|---|
| `npm start` / `npm run start:server` | 构建后提供同站 `/app/`、`/<安全路径>/admin/` 和 `/api/health`，默认端口 8787 |
| `npm run build:server` | 依次构建共享包、服务器和 Web，共享依赖只构建一次 |
| `npm run start:server:built` | 使用现有产物启动；修改源码后须先重新构建 |
| `npm run start:all` | 同时提供服务器与 Vite 热更新页面 |
| `npm run start:web` / `npm run start:sync` | 分别只运行 Vite、只构建并运行 API（无 Web 管理页面） |
| `npm start -- --check` | 只检查依赖、端口和数据目录占用，不构建或创建数据目录 |
| `npm stop` | 请求本仓库启动器停止自己创建的进程；不按端口杀进程 |
| `npm run test:scripts` | 验证启动配置、端口冲突、控制鉴权、正常停止和失败退出 |

启动前明确安装依赖：`npm ci`。启动器不会静默安装，也不会抢占端口。可通过 `PORT`、`WEB_PORT`、`DATA_DIR`、`BASE_PATH`、`HOST` 配置入口；终端打印解析后的地址与数据目录。PowerShell/Bash 包装与 CMD 共用 Node 编排器，支持 `--check` 和 `--no-build`（PowerShell 对应 `-Check`、`-NoBuild`）。

Vite 开发页面（默认 5173）将 `/api/*` 同源代理到后端（默认 8787）。`start:all` 自动传入后端地址；单独运行前端时，可用 `ZICHAN_DEV_API_TARGET=http://127.0.0.1:8787` 指定后端，也可在地址后带后端 `BASE_PATH`。开发页面用后端启动日志中的安全路径打开 `http://127.0.0.1:5173/<安全路径>/admin/`（不带后端 `BASE_PATH`），记账应用仍在 `/app/`。代理保留 Host/Origin 校验并映射 Cookie 路径，不放宽管理会话的跨域限制。修改代理配置或环境变量后重新启动开发服务；只运行前端不会创建服务器账号。

经隧道或反向代理访问开发页面时，Host 是公网域名，Vite 默认白名单（本机名、IP 字面量）不含它，会在代理生效之前直接返回 `403 Blocked request. This host (...) is not allowed.`。此时需要两个声明：前端在 `apps/web/.env.local` 设置 `ZICHAN_DEV_ALLOWED_HOSTS=<主机名>`（逗号分隔，也可用同名环境变量）；后端设置 `TRUSTED_PROXIES=loopback`，否则回环代理不被信任，`X-Forwarded-Proto: https` 会被忽略，后端按 `http://` 推导来源，同站 Cookie 会话以 `SESSION_ORIGIN_REJECTED` 失败（代理必须覆盖为单一的 `X-Forwarded-Proto: https`，见 cloud-sync 说明）。`TRUSTED_PROXIES=loopback` 期间不要直接访问 `http://127.0.0.1:8787` 的 Cookie 会话：没有代理声明协议时该路径会按设计拒绝。放行主机等于把这个无鉴权、可读取整个源码树的开发服务器暴露给该主机，仅在可信隧道下开启。

`.runtime/launchers/` 存放本次编排的本机控制记录，不应提交或分享。停止使用带随机凭据的本机控制通道，先让服务器正常关闭数据库，超时才结束其子进程。`start:all` 是一个生命周期，停止其中一个会同时停止同组服务。手工启动的 `npm run dev`、旧版启动脚本或其他进程不归此启动器管理，请在原窗口用 `Ctrl+C` 退出。

## 便携发布流程

发布门禁包含启动脚本测试，并在全量测试前完成服务器与 Web 构建，避免干净检出时测试缺少产物。Windows 发布入口在同次构建成功后设置内部标记 `ZICHAN_BUILD_PREPARED=1`，让 Tauri 只准备资源、不重复构建；不要手工长期设置此变量。`npm run build:desktop` 执行完整便携发布门禁；只需要裸 EXE 时使用 `npm run build:desktop:binary`。

固定版 WebView2 不在普通构建中静默下载。首次准备或升级锁定版本时运行：

```cmd
scripts\windows\setup-webview2-runtime.cmd
```

下载元数据来自 `release/webview2-runtime.lock.json`。准备脚本要求版本、x64 架构、微软 HTTPS URL、CAB SHA-256 和解包后全文件树 SHA-256 全部匹配；CAB 缓存在 `.tools/`，使用 `expand.exe` 解包并验证 `msedgewebview2.exe`、`msedge.dll`、`icudtl.dat` 及 257 个锁定文件。后续 `--check` 会重新计算文件树，缓存被改写也会失败。若已从微软页面手工下载，可传入：

```cmd
scripts\windows\setup-webview2-runtime.cmd --cab D:\Downloads\Microsoft.WebView2.FixedVersionRuntime.x64.cab
```

正式本机构建运行：

```cmd
scripts\windows\build-desktop.cmd
```

它依次验证固定运行时和 `.node-version`，运行版本一致性、便携发布测试、类型检查和全量测试，以 `tauri build --no-bundle --ci -- --locked` 只生成 `zichan.exe`，随后由 `create-windows-portable.mjs` 组装 ZIP。打包器解析桌面 EXE、Node 和 WebView2 的 PE Machine，确保三者都是 x64，并核对内置 Node.js 版本；拒绝 `data/`、数据库、账号会话、服务器身份、开发目录、source map、PDB 和 updater 产物，生成 `portable-mode.json`、逐文件 SHA-256 清单、ZIP 及 `.zip.sha256`。构建先在独立暂存目录完成 ZIP 解压与完整清单复验，成功后才替换同名 ZIP；已有便携目录一律不会被删除。

Linux x64 发布由 `.github/workflows/linux-desktop-release.yml` 在 Ubuntu 22.04 上运行 `npm run build:desktop:linux`，产出 `.deb`、AppImage 及 SHA-256 旁车，并执行安装、升级、卸载和图形启动验收。详见 `docs/linux-desktop-release.md`。

## 目录职责

```text
scripts/
├─ dev/                         # 多模式开发编排与清理
├─ release/
│  ├─ check-consistency.mjs     # 版本、便携配置、schema 和 runtime lock 门禁
│  ├─ webview2-runtime*.mjs     # runtime lock 解析与准备逻辑
│  ├─ create-windows-portable.mjs
│  └─ verify-artifacts.mjs      # ZIP 文件名和 SHA-256 校验
└─ windows/
   ├─ _check-environment.cmd
   ├─ start-all.cmd
   ├─ start-web.cmd
   ├─ start-sync-server.cmd
   ├─ setup-webview2-runtime.cmd
    └─ build-desktop.cmd
```

```text
tools/
├─ ci/
│  └─ export-schema-contract.mjs
└─ release/
   └─ tests/                    # 发布构建链的 Node 测试
```

MSI/NSIS、安装烟测、PFX/updater 签名和 GitHub 发布工作流在 v0.1 不启用，统一记录为 1.0 发布准备事项。新增脚本必须放入对应职责目录，并同步更新 npm 入口、自动化测试和文档调用点。
