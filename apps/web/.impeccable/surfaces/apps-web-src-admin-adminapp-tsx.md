---
version: 1
slug: "apps-web-src-admin-adminapp-tsx"
primary_target: "apps/web/src/admin/AdminApp.tsx"
related_targets: ["apps/web/src/admin/OperationsPage.tsx","apps/web/src/admin/LogWorkspacePage.tsx","apps/web/src/admin/admin.css"]
---

# 管理后台与可观测性

Primary target: src/admin/AdminApp.tsx
Related targets: src/admin/OperationsPage.tsx, src/admin/LogWorkspacePage.tsx, src/admin/MonitorPage.tsx, src/admin/TrafficPanel.tsx, src/admin/admin.css
Mode: Operate

管理员先判断当前异常，再按请求、页面访问、运行资源、数据库、采集器与日志排查。用户指定以可观测性 v1.1 的信息组织扩展后台，视觉继承现有前端。保留账号、会话、邀请、同步、备份、安全、维护和权限。

## Direction contract

THESIS: 用明确来源和时间的运维工作区组织排障，页面访问、API 请求和登录审计各自独立；每类信息只有一个主入口，六种日志共用字段目录和工作区外壳。

OWN-WORLD: 沿用有本 DESIGN.md 的文献纸、墨色、朱色、藍色状态及全量文楷；后台共用前端三种纸张与浅深色偏好。深墨侧栏、朱色当前位置、单层纸面、连续指标带和墨线记录。

STORY: 先看告警与数据是否新鲜，再看同窗口指标，进入路由或请求 ID 明细，沿原有维护入口处理。缺失来源明确显示未采集。

FIRST VIEWPORT: 76px 顶栏持续展示账号与连接，224px 侧栏按运维、用户、数据、维护、日志和设置组织。主区显示页题、时间与刷新控制、来源和采样时间，再显示连续指标带。窄屏收起侧栏、指标变两列、日志以带字段标签的双列墨线记录展开。

FORM: 在现有工作台中扩展；用户已指定视觉系统和文档中的信息结构，按既有界面的扩展流程执行，无概念抽签。特征交互为点击规范化路由缩小请求范围，再从异常明细用 Request ID 关联系统日志。菜单仅使用已有短位移动画，减少动态偏好生效。

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
