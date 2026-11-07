# 资产生命周期记账系统

面向日常收支、法币与数字资产、定投、游戏赛季和物品资产的本地优先账本。账号登录后打开服务器托管的个人账本；已在本机打开过的账本可使用同一账号密码离线访问。数据保护边界见[账本保护与离线访问](docs/guides/ledger-protection.md)。

## 项目结构

| 目录 | 职责 |
| --- | --- |
| `packages/core` | 平台无关的数据模型、金额计算、成本批次和报表口径 |
| `packages/db` | SQLite 表结构、仓储、备份和同步提交 |
| `packages/logger` | 结构化诊断日志 |
| `apps/web` | React + Vite 账本与管理界面 |
| `apps/sync-server` | Web 入口、账号、加密同步、副本组和管理接口 |
| `apps/desktop` | Tauri 桌面与移动端原生壳 |

金额和数量计算使用 `@zichan/core` 中的 `decimal.js` 辅助函数。浏览器账本使用 IndexedDB 中的 SQLite 数据，桌面与移动端使用原生 SQLite；服务器存储加密同步提交和附件，并托管授权账本的解密凭据。详细架构见[数据模型设计背景](docs/legacy-design/data-model.md)、[持久化层](docs/db.md)、[云同步](docs/architecture/cloud-sync.md)和[桌面端](docs/guides/desktop.md)。

## 开发与验证

需要 `.node-version` 指定的 Node.js 26.13.0 LTS 和 npm。首次安装及常用命令：

```bash
npm install
npm run quality:setup  # 安装独立的 Lint、覆盖率与浏览器测试工具
npm run dev            # Web 开发服务
npm test               # 各工作区测试
npm run typecheck      # TypeScript 类型检查
npm run lint           # 静态检查
npm run build:web      # Web 生产构建
npm run build          # 共享包构建
```

需要覆盖率或浏览器回归时，使用 `npm run test:coverage`、`npm run test:e2e` 和 `npm run test:e2e:account`；根目录的 E2E 命令会先构建 Web 与服务器，直接运行 `tools/e2e` 中的用例则需先构建，见[脚本说明](scripts/README.md)。桌面和移动端的构建、签名与验收命令见[桌面端](docs/guides/desktop.md)及[发布说明](docs/deployment/desktop-release.md)。

Windows 可用 `npm start` 启动服务、`npm stop` 停止；`npm run start:all` 同时启动开发 Web 和服务器。桌面端使用 `npm run dev -w @zichan/desktop`。启动脚本、端口和产物路径见[脚本说明](scripts/README.md)。

## 使用与部署文档

从[文档目录](docs/README.md)查找功能说明、部署手册、发布说明和待办。常用入口：[Web 应用](docs/guides/web.md)、[服务器管理](docs/guides/server-admin.md)、[生产部署与恢复](docs/deployment/production-deployment.md)、[Windows 便携版](docs/deployment/desktop-release.md)。

Linux Docker 首次安装使用根目录的[生产 Compose](compose.prod.yml)和[安装脚本](scripts/production/install-docker.sh)。已安装 Docker Compose v2、Cosign、Git 和 curl，且可拉取 GHCR 镜像后，在全新服务器执行：

```bash
sudo git clone --depth 1 https://github.com/602star/zichan.git /opt/zichan/source && sudo bash /opt/zichan/source/scripts/production/install-docker.sh v0.5.6
```

命令只用于全新安装，自动取得 v0.5.6 镜像摘要并验签，在 `/opt/zichan/{state,backups,runtime}` 保存数据。已有 1Panel 容器或服务器数据时按[生产部署与恢复](docs/deployment/production-deployment.md)迁移，不能直接运行首次安装命令。默认在可信内网开放 `8787`；公网接入前请按部署文档配置 HTTPS 与防火墙。

1Panel 中全新创建 Compose 项目可用[单目录配置](compose.1panel.yml)：已固定 v0.5.6 镜像摘要，仅把宿主机 `/opt/zichan/data` 挂载一次，初始化任务会将内部状态、备份和更新目录设为容器 UID 1000 可写。已有容器不能直接改用空目录；迁移步骤见[生产部署说明](docs/deployment/production-deployment.md)。

运行日志、测试截图、缓存和个人 memory 不提交到仓库。可复现的行为与操作步骤写进对应主题文档；过程记录保留在[工作日志](docs/worklog.md)，版本变化见[发布说明](docs/release-notes.md)。
