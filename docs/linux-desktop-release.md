# Linux 桌面发行版

首批支持 Ubuntu/Debian x86_64 的 `.deb` 和 Linux x86_64 AppImage。发布构建固定在 Ubuntu 22.04 runner 上执行；Windows 本机无需安装 WSL。发行包包含 Tauri 应用、固定版本的 Node.js、同步服务器和 Web 静态资源，不依赖用户机器另装 Node.js。

## 构建

在 Ubuntu 22.04 安装 `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、`libayatana-appindicator3-dev`、`librsvg2-dev`、`libxdo-dev`、`libssl-dev`、`patchelf`、`libfuse2`、`xvfb`、`xauth`、`dbus-x11` 与基础编译工具，然后安装 Rust 和 `.node-version` 指定的 Node.js。Ubuntu 26.04 的 FUSE 包名为 `libfuse2t64`。运行 `npm ci` 和 `npm run build:desktop:linux`。CI 入口为 `.github/workflows/linux-desktop-release.yml`，支持手动触发和 `v*` 标签触发。

Linux 专用的 `tauri.linux-release.conf.json` 使用 ASCII 包名 `zichan`，保留中文窗口标题，并把 `resources/` 放到 Tauri 应用资源目录的 `server/` 下。用户数据使用 Tauri 的 Linux 应用数据目录（受 `XDG_DATA_HOME` 控制）；安装、升级、卸载均不把数据库、附件或备份写入包管理器拥有的目录。AppImage 也使用相同的用户数据目录，不把数据写进只读镜像。

`build-desktop.sh` 校验 Node 版本、发行元数据、类型、Rust 格式与测试，再生成 `.deb` 和 AppImage。linuxdeploy 会给 AppImage 内置 Node 写入 `$ORIGIN` RPATH；`finalize-appimage.mjs` 只接受这项变更，更新 AppImage 内资源清单并重新封装。`verify-linux-artifacts.mjs` 解包两种产物，逐文件核对服务资源 SHA-256、内置 Node 的 x86_64 ELF 格式、执行权限和运行库，检查 `.deb` 的 WebKitGTK 依赖，最后生成 `.sha256` 旁车。Linux release 启动时也复验资源清单。

## 安装与升级验收

CI 在临时 XDG 数据目录下安装旧 `.deb`、打开应用窗口并写入用户数据哨兵，再升级到新 `.deb`，分别启动安装版和 AppImage，卸载 `.deb` 后确认哨兵仍在。未提供历史包时，CI 从当前包重新制作一个仅降低 Debian 版本字段的旧包，用于验证包管理器的安装与升级机制。此流程不能证明跨应用版本的数据迁移；手动触发工作流时填写本仓库已有的 `previous_release_tag`，会下载该历史版本的真实 `.deb` 与 `.sha256` 旁车并执行跨版本验收。

CI 验收使用独立的 Ubuntu runner，不会在开发者机器上执行安装或卸载。Ubuntu 26.04 测试机已完成 `.deb` 与 AppImage 的资源校验和安装、升级、卸载、启动验收；该构建的运行库基线仍是 26.04。面向较早发行版发布时，仍需在固定的 Ubuntu 22.04 CI runner 构建并查看其实际验收结果。
