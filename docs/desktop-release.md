# 桌面发布与安装验收

桌面发布使用 `.github/workflows/desktop-release.yml`。推送 `v*` 标签或手工运行
**Desktop Release** 后，GitHub 的全新 Windows Runner 会构建 MSI/NSIS、检查签名、
静默安装 MSI、启动应用 8 秒、卸载并上传安装包。

## 版本与发布说明

发布前同步修改：

- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`

版本号使用 SemVer。发布说明至少包含用户可见变化、`ledger.sqlite`/附件/备份目录、
同步是否需要重新登录、恢复建议和已知限制。当前项目未发布，不维护开发期 schema 或备份兼容。

## Windows 签名

在仓库 Actions Secrets 中配置：

- `WINDOWS_CERTIFICATE_BASE64`：PFX 文件的 Base64 内容。
- `WINDOWS_CERTIFICATE_PASSWORD`：PFX 密码。

流水线把证书临时导入当前 Runner 用户证书库，通过临时 Tauri 配置使用 SHA-256 和
RFC 3161 时间戳签名，并对生成的 `.exe`/`.msi` 执行 `Get-AuthenticodeSignature`。
未配置证书时仍构建并执行安装烟测，但产物明确是未签名测试包。

## 本地发布检查

```bash
npm run typecheck
npm test
npm run build:web
npm run release:check -w @zichan/desktop
npm run build -w @zichan/desktop -- --ci
```

安装验收脚本可单独运行：

```powershell
./scripts/test-windows-installer.ps1 -MsiPath `
  ./apps/desktop/src-tauri/target/release/bundle/msi/资产生命周期_0.1.0_x64_zh-CN.msi
```

脚本从卸载注册表定位实际安装目录，不猜测固定路径；测试失败时仍在 `finally` 中停止进程并卸载。
正式发布还应在一台无 Node、Rust 和源码目录的 Windows 机器手工确认首次启动、WebView2、
备份恢复、系统休眠恢复和卸载后用户数据保留策略。
