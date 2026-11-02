# Windows 便携版发布与验收

便携通道只构建 Windows x64 ZIP，不安装服务、启动项、文件关联或卸载项。ZIP 解压后直接运行，所有应用持久状态随根目录下的 `data/` 移动。0.3.3 起可从应用设置下载签名 ZIP，由独立助手退出旧进程后替换程序并保留 `data/`；见[客户端签名更新](client-self-update.md)。独立的 MSI/NSIS 通道见 [Windows 安装版布局与验收](windows-installer.md)。

## 发布物契约

```text
资产生命周期_0.1.0_windows-x64_portable/
├─ zichan.exe
├─ portable-mode.json
├─ portable-files.json
├─ README-便携版.txt
├─ NOTICE.txt
├─ server/
│  ├─ node.exe
│  ├─ server.mjs
│  └─ web/
└─ runtime/
   └─ webview2/
```

空白发行物不得包含 `data/`、数据库、附件、`.hold`、账号会话、服务器身份、PDB、更新签名或安装器。首次启动后才在 EXE 同级创建 `data/`。`portable-files.json` 记录版本、x64、WebView2 与 Node.js 版本，以及除清单自身外每个文件的字节数与 SHA-256。

最终输出为：

```text
apps/desktop/src-tauri/target/release/portable/
├─ 资产生命周期_0.1.0_windows-x64_portable.zip
└─ 资产生命周期_0.1.0_windows-x64_portable.zip.sha256
```

ZIP 含一个同名顶层目录；`.sha256` 使用 `<64 位十六进制>  <ZIP 文件名>` 格式。

## 版本与一致性

发布前同步根目录及各 workspace `package.json`、`package-lock.json`、Tauri/Cargo 版本和 `docs/release-notes.md` 一级标题。版本使用 SemVer，稳定标签若启用必须严格为 `v<版本号>`。

`npm run release:check` 同时校验：

- 所有 npm、Cargo、Tauri 与发布说明版本一致。
- Tauri 禁用 bundle，WebView 安装模式为 `skip`。
- Windows 主窗口配置 `create=false`，由 Rust 完成便携路径检查后再创建。
- 当前开发 schema 文档与运行时契约存在。
- `.node-version` 固定一个精确的发行版 Node.js 版本；组包时核对内置 `node.exe` 的实际版本。
- WebView2 runtime lock 的固定版本、x64、微软来源 URL 和 SHA-256 合法。
- 便携 README 与 NOTICE 存在。

`npm run test:release` 覆盖版本漂移、错误 Tauri 配置、runtime lock、x64 PE Machine、便携目录清单、敏感文件禁入以及 ZIP 内外层校验。安装包使用独立配置与门禁。

## WebView2 固定版准备

锁文件 `scripts/release/webview2-runtime.lock.json` 当前固定 Microsoft WebView2 Fixed Version x64 `151.0.4129.101`，包括官方 CAB URL、CAB SHA-256 和解包后 257 个文件的规范化树 SHA-256。微软只在下载页保留最新两个大版本的最新补丁，因此锁定 CAB 应归档在受控构建缓存中，不能在普通构建时查询“最新版”。

微软说明固定版运行时超过 250 MB、必须用 `expand` 等工具正确解包、不能从 UNC/网络位置运行；Windows 10 上 120+ 的未打包程序还需要 AppContainer 读取 ACL。详见 [WebView2 分发说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution) 和 [Runtime 发布记录](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/runtime/)。

首次准备：

```cmd
scripts\windows\setup-webview2-runtime.cmd
```

脚本只下载锁中的 URL，先校验 CAB SHA-256，再用 `expand.exe` 解包到：

```text
.tools/webview2-fixed/151.0.4129.101/x64/
```

准备元数据 `.zichan-webview2-runtime.json` 与可执行文件一起保存。已有手工 CAB 时使用 `--cab <路径>`；`--check` 不联网，但会重新计算完整 runtime 文件树并与锁比对。升级 runtime 必须先从微软官方页确认新版本和 URL，独立计算 CAB/文件树 SHA-256，更新锁并完成 Windows 10/11 回归，不能只改版本号。

## 本地构建

前置条件：`.node-version` 指定的精确 Node.js 版本、npm 依赖、Rust/MSVC C++ 工具、`perl.exe` 和已经准备的 WebView2 固定版。SQLCipher 的 vendored OpenSSL release 构建需要 Perl；一般开发命令仍允许根 `package.json` 中的 Node.js 范围。

```cmd
scripts\windows\build-desktop.cmd
```

入口按顺序执行：

1. 检查 Node、npm、Rust、Perl 和锁定 WebView2。
2. 运行 `npm run release:check`、`npm run test:release`、`npm run test:scripts`、`npm run build:server`、`npm run typecheck`、`npm test`。
3. 使用锁定的 Cargo 依赖运行 `tauri build --no-bundle --ci -- --locked`。
4. 验证桌面、Node 和 WebView2 都是 x64 PE，核对内置 Node.js 版本，在独立暂存目录组装便携包并逐文件校验，使用 PowerShell `Compress-Archive` 创建 ZIP。
5. 发布前校验暂存 ZIP 的中央目录、安全路径与外层 SHA-256，并解压复验每项哈希；全部通过后才替换输出 ZIP 与校验文件。

普通 `tauri build` 不是 v0.1 发布入口；发布脚本显式 `--no-bundle`，不会产生安装器或 updater payload。
打包器不会删除已有的同名便携目录；使用 `--no-archive` 或 `--keep-directory` 时，目录已存在会直接失败。请将发布 ZIP 解压到独立测试目录运行，不要把 `target/release/portable/` 当作长期数据目录。并发打包同一输出目录会被锁文件拒绝；异常终止留下锁文件时，确认没有构建进程后再移除。

`.github/workflows/windows-portable-release.yml` 在版本标签或手动触发时，从干净检出执行完整 Windows 构建和 ZIP 验证。Windows 10 NTFS、Windows 10 exFAT 与 Windows 11 的实际界面和迁移验收仍按下方矩阵执行。

## Windows Sandbox / VM 验收

正式交付前至少覆盖 Windows 11 NTFS、Windows 10 NTFS 和 Windows 10 exFAT：

1. 在运行前后快照 `%APPDATA%`、`%LOCALAPPDATA%` 中相关候选路径；首次启动、完整工作流、重启后不得由应用或 WebView 创建/修改持久数据。
2. 在目录 A 建账本、交易、附件、备份、表单草稿、同步配置和本机服务器状态，正常退出后移动完整根目录到含中文和空格的目录 B，并在另一盘符/用户下验证原密码解锁及全部状态保留。
3. Windows 11 使用包内固定版；Windows 10 NTFS 验证 ACL 和固定版；Windows 10 exFAT 验证 Evergreen 回退以及未安装时的明确失败。
4. 验证 UNC/网络盘、只读目录、第二实例、资源缺失、服务器身份残缺、8787 端口冲突、磁盘写满和强制结束恢复均失败封闭且不回退 AppData。
5. 确认局域网服务器只在用户启用后监听 `0.0.0.0:8787`，应用不主动创建防火墙规则；Windows 自身弹窗与系统记录不计为应用持久数据。
6. 退出后完整目录可立即移动或重新压缩；运行中复制和同时运行两个克隆副本明确不支持。

可用以下命令复核外层 ZIP：

```powershell
Get-FileHash -Algorithm SHA256 .\资产生命周期_0.1.0_windows-x64_portable.zip
node scripts/release/verify-artifacts.mjs `
  --artifact .\资产生命周期_0.1.0_windows-x64_portable.zip `
  --version 0.1.0 `
  --node-version (Get-Content .node-version).Trim()
```

## 延后到 1.0

以下能力不进入 0.x：GitHub 远程发布、PFX/Authenticode、updater 密钥与清单、自动更新/回滚、MSI/NSIS、系统注册、安装/卸载验收，以及正式数据库迁移基线。1.0 审批时再恢复对应工作流和 Secrets，并以当时最终 schema 冻结长期兼容基线；不得复用 v0.1 已停用的安装器假设。
