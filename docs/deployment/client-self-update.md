# 0.3.x 客户端签名更新测试

0.3.3 为 Windows 安装版、Windows 便携版、Linux AppImage、Linux `.deb` 和 Android 增加“设置 → 应用版本更新”。打开设置时自动检查，也可手动检查。显示下载进度与本机最近 20 次更新尝试；应用重开后根据实际运行版本确认安装成功。记录保存在当前设备的 WebView 存储中，清除应用网站数据会清除记录。只接受补丁号更高的稳定 `0.3.x`；旧安装包没有这一入口，需要先手动安装 0.3.3，再用下一补丁版演练应用内升级。客户端更新源与服务端/Docker 更新源分别配置。

## 更新方式

| 平台 | 包 | 安装动作 | 数据位置 |
| --- | --- | --- | --- |
| Windows MSI / NSIS | Tauri 签名的同通道安装器 | 下载、验签、运行安装器并重启 | 用户应用数据目录 |
| Windows 便携 | Tauri 签名的完整 ZIP | 解压到同级暂存目录，退出旧程序，替换程序目录；启动失败时恢复旧目录 | 原目录的 `data/` 搬回新目录 |
| Linux AppImage | Tauri 签名的 AppImage | 下载、验签、替换并重启 | XDG 应用数据目录 |
| Linux `.deb` | Tauri 签名的 `.deb` | 下载验签后交给系统安装器；由用户确认 | XDG 应用数据目录 |
| Android | Ed25519 清单 + SHA256 的 APK | 下载验证后打开系统安装界面；由用户确认 | Android 应用私有数据目录 |

Windows 安装版依靠包内 `installer-channel.txt` 选择 MSI 或 NSIS，不跨安装器通道覆盖。便携 ZIP 的顶层目录与必需文件会再次校验，更新包不得包含 `data/`。Android APK 还必须使用与已安装版相同的稳定 Android 包签名密钥，并有更高的 versionCode；更新清单的 Ed25519 密钥不能替代 APK 包签名。Linux `.deb` 不绕过系统包管理器或提权安装。

## 更新源与密钥

- 桌面版在构建时设置 `ZICHAN_CLIENT_UPDATE_URL=https://…/latest.json`；本机测试可在启动前设置同名环境变量。这个 URL 是 Tauri 静态清单，`platforms` 按 `windows-msi-x86_64`、`windows-nsis-x86_64`、`windows-portable-x86_64`、`linux-appimage-x86_64`、`linux-deb-x86_64` 分流，资产 URL 为 HTTPS。Tauri updater 验证下载包的签名。
- Android 在构建时设置 `ZICHAN_ANDROID_UPDATE_URL=https://…/android-latest.json`；清单签名、版本、APK 文件名及 SHA256 由原生层校验。只接受同目录的 HTTPS APK，不跟随重定向。
- 测试公钥分别在 `apps/desktop/src-tauri/installer/update-test.pub` 与 `android-update-test.pub`。对应私钥仅在构建机的忽略目录中。换密钥时必须重新构建客户端；私钥、APK 签名 keystore、Token 和更新包都不提交。
- 新测试机若没有对应私钥，应先生成自己的 Tauri updater 密钥（`npx tauri signer generate --ci -p '' -w <忽略目录>/tauri.key`）及 Android 清单 Ed25519 密钥，并把新公钥写入上述文件后重新构建 0.3.3 基线。不同公钥签的下一版本不能更新已有客户端。
- 私有 GitHub Releases 可供 Linux/Docker 服务端用只读 Token 获取，见[服务端更新手册](self-update-linux.md)。客户端不内置 GitHub Token；其签名清单与包须由部署方放在客户端可访问的 HTTPS 目录。原始仓库保持私有也可以使用单独的更新文件服务。

## 制作本地测试包

先运行 `npm ci`、`npm run release:check`、`npm run test:release`、`npm run typecheck`、`npm test`。Windows 测试构建通过 `TAURI_SIGNING_PRIVATE_KEY` 传入私钥路径或内容；Linux 脚本使用 `TAURI_SIGNING_PRIVATE_KEY_PATH` 指向私钥文件，并传给 Tauri 构建器。有口令时再设置 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。将 `ZICHAN_CLIENT_UPDATE_URL` 设置为准备服务清单的 HTTPS 地址后构建客户端，使地址进入安装包。Tauri updater 需要 Rust 1.90 或更高版本。

- Windows 安装包：`powershell -NoProfile -File scripts/windows/build-installer.ps1 -UpdateTest`。构建器在原安装包配置后叠加 `tauri.update-test.conf.json`，输出 MSI、NSIS 及 updater 签名。
- Windows 便携 ZIP：先按[便携版手册](desktop-release.md)构建，再以 `npx tauri signer sign -f <测试私钥> -p '' <便携 ZIP>` 生成同名 `.sig`；若密钥有口令，改用实际口令或环境变量。
- Linux：在 Linux x86_64 将 `ZICHAN_UPDATE_TEST=1` 后运行 `npm run build:desktop:linux`；脚本在 AppImage 最终封装后重新生成签名，`.deb` 另以 `npx tauri signer sign -f <测试私钥> -p '' <deb 文件>` 签名。
- 用 `node scripts/release/create-client-update-feed.mjs https://updates.example/client/ <输出目录> windows-msi-x86_64=<MSI> windows-nsis-x86_64=<NSIS> windows-portable-x86_64=<ZIP> linux-appimage-x86_64=<AppImage> linux-deb-x86_64=<deb>` 汇总已签名资产；可只包含本次实际测试的平台。脚本输出 `latest.json` 和对应包。
- Android 使用稳定测试 keystore 构建并签名 ARM64 APK，先运行 Android SDK 的 `apksigner verify --verbose <APK>`，再运行 `node scripts/release/create-android-update-feed.mjs <Ed25519 私钥 PEM> <已签名 APK> <输出目录>`。输出 `android-latest.json` 和规范文件名 APK。工作流 `.github/workflows/android-candidate.yml` 从仓库变量 `ZICHAN_ANDROID_UPDATE_URL` 读取候选更新地址，仅在提供稳定测试 keystore 的四个 Secret 时产生已签名 APK；否则只保存未签名候选包，不能用于应用内升级。

不要把 `latest.json` 从 0.3.2 改名冒充 0.3.3，必须从当前版本构建并签名。正式渠道应单独管理签名密钥、Windows 代码签名证书与 Android keystore，先在隔离测试目录完成跨版本验收。

## 0.3.3 → 下一补丁版验收

在各平台先安装 0.3.3，录入测试账本或写入数据哨兵，再构建更高的 0.3.x 包并更新 HTTPS 清单。打开设置确认自动发现，检查下载进度，执行安装后重开应用，核对 `版本`、账本、附件和本地数据目录。分别测试签名错误、包摘要错误、断网及旧版本清单：错误包必须拒绝，已安装程序和数据仍能使用。Windows 便携版另检查同级旧版本目录、异常退出后恢复目录和 `data/` 原样保留；Linux `.deb` 与 Android 需在系统界面确认安装，不能把“已打开安装器”记作升级成功。

2026-11-02 已在隔离 Linux 测试机上完成 0.3.3 → 0.3.4 AppImage 实际升级：两版 `.deb` 与 AppImage 均在 Linux 构建并校验，0.3.4 AppImage 以测试密钥签名、通过独立 HTTPS 源提供；应用内发现版本、触发下载验签、替换 AppImage 并重启，目标文件 SHA256 与发布包一致，原账本重新解锁后可用，界面显示 0.3.4 和“已安装”记录。Linux 虚拟显示器的 WebKit 画面有刷新异常，点击与页面状态使用应用进程的 WebKit 远程检查器完成；真实桌面视觉体验仍需复核。`.deb` 仅完成构建和签名校验，未实测系统安装器确认；Windows 和 Android 仍需对应环境验收。所有步骤只生成本地候选物，不需要 GitHub 推送或远程 Release。
