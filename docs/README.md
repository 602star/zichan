# 文档目录

文档默认使用中文。先阅读现行说明；旧版设计和按日期记录的验收材料用于追溯当时决策，不能代替当前行为与验收。项目安装和开发命令见[项目 README](../README.md)。

## 现行使用说明 `guides/`

- **Web 与账号：**[Web 应用](guides/web.md)、[账号入口](guides/web-account-v2.md)、[注册与资料](guides/account-registration.md)、[账号安全](guides/account-security.md)、[离线应用](guides/offline-app.md)。
- **账本与界面：**[账本保护](guides/ledger-protection.md)、[数据保护界面](guides/data-protection-ui.md)、[分类选择器](guides/category-picker-layout.md)、[图标](guides/entity-icons.md)、[交易对象与平台](guides/payee-platform-design.md)。
- **客户端与管理：**[桌面端](guides/desktop.md)、[服务器管理后台](guides/server-admin.md)。

## 架构与数据 `architecture/`

- **存储和同步：**[持久化层](db.md)、[云同步](architecture/cloud-sync.md)、[账本副本架构](architecture/ledger-replica-architecture.md)。
- **计算和资产：**[转换与成本](architecture/conversion-display.md)、[物品与配件](architecture/fixed-asset-components.md)、[游戏记录](architecture/game-record-design.md)。
- **诊断：**[日志](architecture/logging.md)。

`db.md` 留在文档根目录，因为发布一致性检查直接读取该文件。

## 部署与发布 `deployment/`

- **服务器：**[生产部署与恢复](deployment/production-deployment.md)、[Linux 测试机一键自更新](deployment/self-update-linux.md)、[1.0 升级方案](deployment/production-upgrade-1.0.md)、[自动备份执行器](deployment/backup-executor.md)。
- **桌面安装包：**[Windows 便携版](deployment/desktop-release.md)、[Windows 安装版](deployment/windows-installer.md)、[Linux 桌面版](deployment/linux-desktop-release.md)。
- **历史发布包：**[0.2.0 本地发布包](deployment/local-release-0.2.0.md)、[便携版随包说明](portable/README-便携版.txt)。

## 验收记录 `acceptance/`

- **发布和性能：**[发布准备](acceptance/release-readiness.md)、[浏览器账本性能基线](acceptance/browser-ledger-scale-benchmark.md)、[Windows 本机验收](acceptance/native-desktop-acceptance.md)。
- **部署和副本：**[生产镜像验收](acceptance/production-deployment-acceptance-2026-10-28.md)、[三节点验收清单](acceptance/three-node-acceptance.md)、[五逻辑节点跨机预验收](acceptance/five-node-acceptance-2026-10-28.md)、[节点路由与压力验收](acceptance/replica-routing-and-scale-acceptance.md)。

## 后续规划 `planning/`

[管理后台路线图](planning/admin-experience-roadmap.md)、[手机视图后续方案](planning/mobile-view-review-2026-10-17.md)。其中已完成的条目以现行手册为准。

## 旧版设计 `legacy-design/`

- **数据与记账：**[数据模型设计背景](legacy-design/data-model.md)、[账号模式实施](legacy-design/account-mode-implementation.md)、[记账初始化与账户规则](legacy-design/ledger-experience-plan.md)。
- **同步与管理：**[同步提交图](legacy-design/event-sync-design.md)、[管理后台方案](legacy-design/server-admin-plan.md)、[管理员预览方案](legacy-design/admin-ledger-preview-plan.md)、[重构实施记录](legacy-design/refactor-implementation.md)。
- **Web 与移动端：**[图表决策](legacy-design/web-chart-plan.md)、[视觉密度整改](legacy-design/web-visual-density-plan.md)、[手机适配](legacy-design/mobile-web-adaptation-plan.md)。

## 过程与版本

[工作日志](worklog.md)保留重要操作、当时的验证证据及历史路径；这些记录不代表当前状态。[发布说明](release-notes.md)记录版本变化。两者留在文档根目录，便于查找。

功能或操作步骤变化时更新对应现行文档；运行日志、测试截图、构建缓存、个人 memory、数据库快照和密钥不提交到仓库。`.github/` 是 CI 配置，`.agents/` 和 `.codex/` 保存设计工具及钩子；它们的下载运行时由 `.gitignore` 排除。
