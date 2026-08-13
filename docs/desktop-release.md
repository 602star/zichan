# 桌面发布与安装验收

桌面发布使用 `.github/workflows/desktop-release.yml`。推送 `v*` 标签或手工运行
**Desktop Release** 后，GitHub 的全新 Windows Runner 会构建 MSI/NSIS、检查签名、
静默安装 MSI、启动应用 8 秒、卸载并上传候选安装包。推送标签只构建候选物，不自动创建
GitHub Release；真正发布必须在一个已经存在的标签上手工运行工作流并显式勾选 `publish`。

## 版本与发布说明

发布前同步修改：

- 根目录和所有 npm workspace 的 `package.json`、`package-lock.json`
- `apps/desktop/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/Cargo.lock`
- `apps/desktop/src-tauri/tauri.conf.json`
- `docs/release-notes.md` 的一级标题

版本号使用 SemVer。发布说明至少包含用户可见变化、`ledger.sqlite`/附件/备份目录、
同步是否需要重新登录、恢复建议和已知限制。当前项目未发布，不维护开发期 schema 或备份兼容。
`npm run release:check` 会统一校验这些版本来源、发布说明以及当前开发 schema 文档；稳定标签必须
严格等于 `v<版本号>`。`npm run test:release` 覆盖版本漂移和安装包/更新清单不一致的失败路径。

## Windows 签名

在仓库 Actions Secrets 中配置：

- `WINDOWS_CERTIFICATE_BASE64`：PFX 文件的 Base64 内容。
- `WINDOWS_CERTIFICATE_PASSWORD`：PFX 密码。
- `TAURI_SIGNING_PRIVATE_KEY`：`tauri signer generate` 生成的 updater 私钥内容。
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：上述 updater 私钥的密码；无密码私钥可留空。
- `TAURI_SIGNING_PUBLIC_KEY`：与私钥同批生成的公钥文件**整体内容再做 Base64 编码**后的值，
  格式必须与 Tauri updater 的 `pubkey` 配置一致。

流水线把证书临时导入当前 Runner 用户证书库，通过临时 Tauri 配置使用 SHA-256 和
RFC 3161 时间戳签名，并对生成的 `.exe`/`.msi` 执行 `Get-AuthenticodeSignature`。
稳定通道缺少 Windows 证书、updater 私钥或 updater 公钥时立即失败；预览通道可以构建
未带 Authenticode 的测试安装包，但 updater 产物仍必须签名。

工作流生成更新清单后会再次核对清单版本、发布标签、安装包文件名、清单引用的压缩包和
分离签名；随后使用 `TAURI_SIGNING_PUBLIC_KEY` 对每个 updater archive 做真实 Minisign 验签，
因此错误公钥、错误私钥、伪造 `.sig` 或产物被改写都会阻断发布。发布前还会通过 GitHub API
确认目标标签已经存在，发布动作不会代替维护者创建标签。

## 本地发布检查

```bash
npm run typecheck
npm test
npm run build:web
npm run release:check
npm run test:release
npm run release:check -w @zichan/desktop
npm run build -w @zichan/desktop -- --ci
```

普通 CI 还会在独立任务中运行桌面 Rust 的 `cargo fmt --check`、`cargo check` 和
`cargo test`。数据库门禁由三种实际运行时共同承担：Node SQLite 与 sql.js 执行 schema 115、
Dashboard JSON 聚合及精确金额查询；Rust 从已构建的 `@zichan/db` 导出同一份 DDL，在
SQLCipher/SQLite 中执行并验证 JSON1 与字符串 SQL，不维护手抄的第二份 schema。CI 还会构建
sync-server 生产 bundle，并从仓库根目录构建 Docker 镜像。容器烟测只绑定
Runner 的 `127.0.0.1`，使用临时密钥和临时数据目录，依次验证 `/api/health` 与 `/api/ready`，
不会推送镜像或发布产物。Rust、服务端构建、容器和 Playwright 失败日志会作为 Actions artifact 保留。

安装验收脚本可单独运行：

```powershell
./scripts/test-windows-installer.ps1 -MsiPath `
  ./apps/desktop/src-tauri/target/release/bundle/msi/资产生命周期_0.1.0_x64_zh-CN.msi
```

脚本从卸载注册表定位实际安装目录，不猜测固定路径；测试失败时仍在 `finally` 中停止进程并卸载。
正式发布还应在一台无 Node、Rust 和源码目录的 Windows 机器手工确认首次启动、WebView2、
备份恢复、系统休眠恢复和卸载后用户数据保留策略。
