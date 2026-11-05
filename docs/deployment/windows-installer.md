# Windows 安装版布局与验收

安装版与便携 ZIP 使用同一个 Tauri 应用，但启动时由安装目录中的标记选择互斥的数据布局。安装目录有且仅有 `installed-mode.json` 时进入安装版；有且仅有 `portable-mode.json` 时进入便携版；标记缺失或同时存在则拒绝启动。安装版不自动迁移便携版的 `data/`，迁移时应使用应用内备份与恢复。

## 路径契约

| 内容 | 安装版位置 | 生命周期 |
| --- | --- | --- |
| `zichan.exe`、`installed-mode.json`、`installed-files.json` | 安装目录 | 安装、升级、卸载管理 |
| `server/node.exe`、`server/server.mjs`、`server/web/` | 安装目录下 `server/` | 只读资源；启动时校验版本、大小、SHA-256 与完整文件集合 |
| 数据库、附件、备份、凭据、同步服务器状态、日志、WebView、实例锁 | `%LOCALAPPDATA%\com.zichan.ledger` | 当前用户拥有；升级和卸载保留 |

安装版在启动前确认数据目录位于本地磁盘、可写、无重解析点，且不与安装目录相互包含。WebView2 使用系统 Evergreen；MSI/NSIS 内含离线 WebView2 安装器。资源清单由 `prepare-resources.mjs` 在打包前生成，安装包不带用户数据。

## 安装包与升级策略

- MSI 由 WiX 构建，按机器安装，需要管理员权限；简体中文代码页支持中文产品名。固定 UpgradeCode 为 `687bf6a9-bf19-505b-81cc-864ac03395d5`。升级用相同安装通道，禁止降级。
- NSIS 默认仅为当前用户安装，不要求机器级安装权限；升级也沿用 NSIS 通道，禁止降级。安装前钩子在确认旧安装标记和应用已退出后清理旧版 `server/`，避免带哈希的旧 Web 文件残留。
- 两种安装器不应混用作交叉升级。卸载应用资源后保留 `%LOCALAPPDATA%\com.zichan.ledger`，用户可在确认备份后手动删除该目录。
- 0.3.3 起安装包还写入 `installer-channel.txt`（`msi` 或 `nsis`）。应用内签名更新据此选择同通道资产；缺少标记的旧安装版需先手动升级。测试构建可用 `build-installer.ps1 -UpdateTest` 生成 updater 签名，完整步骤见[客户端更新手册](client-self-update.md)。
- `0.2.0` 是安装版初始基线。真正的跨版本升级验收需要上一版和更高版本两个安装器，不能把同一版本重装当成升级通过。

## 构建与签名

`v0.5.2` 起，推送正式版本标签时统一发布流水线在完整 CI 通过后自动构建 MSI 与 NSIS `setup.exe`，并在隔离的 Windows runner 上分别执行安装、资源完整性、数据保留和卸载验收。两种安装包及其 SHA-256 旁车文件与 Windows 便携 ZIP 一同进入 GitHub Release。可选的 `Windows installer release and acceptance` 手动运行只用于提前验收，不是正式发布的必要步骤。

当前仓库没有受信任的 Windows 代码签名证书，`v0.5.2` 安装包为**未签名**版本。下载时请核对 Release 中的 `.sha256`，Windows 仍可能显示“未知发布者”或 SmartScreen 警告；SHA-256 只能证明下载文件与发布页所列文件一致，不能代替受信任的发布者签名。后续配置正式证书时，需由仓库所有者完成证书申请或云签名服务的身份验证，再把签名凭据配置到 Actions，开启 `signed` 构建并验收 EXE、MSI、NSIS 的签名和时间戳。

在 Windows x64、锁定的 `.node-version`、Rust/MSVC、Perl 和 npm 依赖齐备时：

```powershell
npm run build:desktop:installer
```

脚本运行发行一致性、测试、服务端和 UI 构建、类型检查，执行 `tauri build --config src-tauri/tauri.installer.conf.json --bundles msi nsis --ci -- --locked`，检查两个安装器与资源清单，并在产物旁写入 `.sha256`。
仅重验现有安装包及资源清单可运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/build-installer.ps1 -VerifyOnly`。

正式签名构建在证书已安装到 Windows 证书库且有私钥时设置 `ZICHAN_SIGNING_THUMBPRINT`（40 位十六进制）、`ZICHAN_TIMESTAMP_URL`（HTTPS RFC 3161 服务），运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/build-installer.ps1 -RequireSignature
```

签名验收要求 EXE、MSI、NSIS 的 Authenticode 状态为 `Valid`，签名证书 thumbprint 与配置一致，且具备时间戳证书。无证书的本机构建仅能用于功能验证，不能视为签名发行包。

## 干净 VM 验收

使用一次性 Windows 10/11 VM，分别执行 MSI 与 NSIS。脚本会安装与卸载软件，不要在开发机上运行。示例：

```powershell
$env:ZICHAN_INSTALLER_VM = '1'
./scripts/windows/test-installer-vm.ps1 -Format nsis -CurrentInstaller <当前版-setup.exe> -CurrentVersion 0.1.0
./scripts/windows/test-installer-vm.ps1 -Format msi -CurrentInstaller <当前版.msi> -CurrentVersion 0.1.0
```

MSI 需在提升权限的 VM Shell 执行。每条测试使用全新 VM 或快照；脚本确认资源完整、程序可启动且数据写入用户目录、安装目录不出现 `data/`，卸载后 EXE 移除而用户数据保留。跨版本测试额外传 `-PreviousInstaller` 和 `-PreviousVersion`，确认升级后数据保留与版本切换。签名包加 `-RequireSignature`。

GitHub 托管 Windows runner 在非交互会话中使用 `-SkipLaunch`，只验收安装/卸载、资源和数据保留；实际启动和 WebView 界面仍须在交互 VM 完成。

人工补充检查：普通用户安装 NSIS、管理员安装 MSI、从开始菜单启动、WebView2 未安装时的离线安装、应用退出后卸载、重启后数据可重新打开、非管理员用户使用 MSI 安装的应用、签名在另一台干净 Windows 上显示为可信发布者。记录 Windows 10/11、安装器版本、SHA-256、签名证书与时间戳、安装/升级/卸载结果。
