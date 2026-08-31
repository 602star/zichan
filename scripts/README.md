# 启动与构建脚本

`scripts/` 只放可直接运行的启动、停止和构建脚本。用户入口优先使用根 `package.json` 的 npm 命令；Windows 下需要双击时使用 `windows/` 中的薄 CMD 包装，不在仓库根目录增加 CMD。

测试、CI 专用生成器和其他开发工具统一放在仓库根 `tools/`：发布测试位于 `tools/release/tests/`，数据库 schema 契约导出器位于 `tools/ci/`。它们由 npm 命令或 CI 调用，不作为日常双击入口。

## Windows 双击入口

| 脚本 | 用途 | 主要产物或地址 |
|---|---|---|
| `windows/start-all.cmd` | 一键打开开发 Web 与同步服务器两个窗口 | Web `5173` + 同步/账号管理 `8787` |
| `windows/start-web.cmd` | 启动 Web 开发服务 | `http://127.0.0.1:5173/` |
| `windows/start-sync-server.cmd` | 构建并启动同步 API + Web 管理入口 | `http://127.0.0.1:8787/`，数据位于仓库 `.runtime/sync-server/` |
| `windows/setup-webview2-runtime.cmd` | 显式下载、校验并解包锁定的 WebView2 固定版 | `.tools/webview2-fixed/<版本>/x64/` |
| `windows/build-desktop.cmd` | 运行门禁并构建 Windows x64 完全便携 ZIP | `apps/desktop/src-tauri/target/release/portable/` |

这些 CMD 会检查 Node.js 22.3+、npm 和依赖目录；桌面构建还会检查 Rust 与 Perl（vendored OpenSSL/SQLCipher 的 Windows release 构建需要 Perl）。它们不会自动安装依赖、抢占端口或结束其他程序。开发服务以前台方式运行，使用 `Ctrl+C` 停止。

CMD 默认在结束或失败时暂停，以便双击运行时看到诊断信息。终端或自动化调用可设置 `ZICHAN_NO_PAUSE=1`；只检查本机基础工具时再设置 `ZICHAN_CHECK_ONLY=1`。

同步服务器入口显式把 `DATA_DIR` 设为仓库内 `.runtime/sync-server`，不使用 AppData。它默认监听 `0.0.0.0:8787` 并允许可信家庭局域网 HTTP；不要直接暴露到公网。普通开发只需 `start-sync-server.cmd`，它同时提供构建后的 Web、同步 API 和管理入口；需要 Vite 热更新时才使用 `start-all.cmd`。

## 便携发布流程

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

它依次验证固定运行时，运行版本一致性、便携发布测试、类型检查和全量测试，以 `tauri build --no-bundle --ci` 只生成 `zichan.exe`，随后由 `create-windows-portable.mjs` 组装 ZIP。打包器解析桌面 EXE、Node 和 WebView2 的 PE Machine，确保三者都是 x64；拒绝 `data/`、数据库、账号会话、服务器身份、开发目录、source map、PDB 和 updater 产物，生成 `portable-mode.json`、逐文件 SHA-256 清单、ZIP 及 `.zip.sha256`。若同名输出目录已有 `data/`，打包器会停止而不是覆盖用户数据；请先退出应用并将该目录移到安全位置，或用其他 `--output` 目录构建。最终验证会检查 ZIP 中央目录、解压到临时目录并重跑完整清单，不能用重新计算外层哈希掩盖包内篡改。

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
