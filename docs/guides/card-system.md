# 卡片与信息分组

Web 和管理后台沿用“大福帳 · 墨与朱”的纸、墨、朱色。卡片只承载独立任务或信息组；表格行、定义行和内层指标不再各自增加边框。设计依据见 [DESIGN.md](../../apps/web/DESIGN.md)。

## 容器和内容

| 用途 | API／CSS | 约定 |
| --- | --- | --- |
| 独立信息面板 | `Card`／`.zc-card` | surface、1px 边线、8px 圆角、20px 内边距 |
| 紧凑面板 | `variant="tight"`／`.is-tight` | 16px 内边距 |
| 表格／列表外壳 | `variant="flush"`／`.is-flush` | 内容贴边；直接标题和页脚仍有统一留白 |
| 内层分组 | `CardGroup`／`.zc-card-group` | 相邻组用一条分隔线和间距，无外框 |
| 指标 | `CardMetric`／`.zc-card-metric` | 标签、主数值、说明；数值使用既有财务格式化函数 |
| 定义行 | `CardFact`／`.zc-card-fact` | 标签和值，相邻行分隔，长值允许换行 |
| 连续摘要 | `.zc-card-band` | 指标之间 1px 分隔；卡内加 `.is-inset` 去掉外框 |
| 告警 | `CardAlert`／`.zc-alert` | 语义底色与 1px 墨色短线，可放在面板内部 |
| 空状态 | `CardEmpty` | 一句话说明当前范围无内容；有恢复动作时保留实际入口 |

```tsx
<Card title="资产配置" note="按当前折算价值" footer={<button>查看明细</button>}>
  <CardGroup>资产分类与占比</CardGroup>
  <CardGroup>
    <CardMetric label="累计净投入" value={money(net)} note="累计支出与累计回款的差额" />
    <CardFact label="账本日" value={asOf} />
  </CardGroup>
</Card>
```

`Card` 的 `as` 保留 `article`、`details`、`button` 等原生语义。折叠面板仍由原生 `summary` 控制；按钮型选择项保留按钮、禁用态与键盘操作，内容使用适合按钮的元素。标题默认 h2，可通过 `heading` 调整层级；自动生成的标题 ID 与容器关联，也可指定 `titleId` 或显式 `aria-labelledby`。

`CardHeader` 作为兼容入口转发到 `CardHead`，不创建另一张 Card。旧 `.zc-section` 分组类仍可使用；新增和迁移内容使用 `.zc-card-group`。旧 `.zc-card-header*` 类已移除。

## 迁移边界

- 卡片内边距由基础类和变体决定，不在 JSX 中覆盖 padding。表格单元格、操作按钮及页面布局仍可有自己的间距。
- 卡内需要二级层次时使用分组、定义行或无外框的指标带。不能仅把 `.zc-card` 改名为另一种带完整边框的内层盒子。
- Dashboard 和物品摘要在桌面连续排列，在窄屏换为两列，奇数末项可横跨整行；断点不能给指标带重新加大间隙。
- Convert 保留资产展开、步骤详情、编辑和作废操作；换算步骤及收付明细使用分组。预算月份和分类仍是可点击按钮，外观改为有分隔线的条目。
- 告警保留明确恢复路径；一般提示使用 `status`，需要立即播报的读取错误显式使用 `alert`。后台用户状态仍通过徽章文字区分禁用、正常、接近配额及超额。

## 验证

`apps/web/test/design-scale.test.ts` 检查 JSX 卡片 padding、直接嵌套与同步折叠面板中的嵌套，以及告警／用户卡粗边。`card.test.ts` 检查标题关联、原生元素和播报语义。浏览器检查补足跨组件组合后的 DOM，并保留实际详情与操作流程。

```sh
npm run typecheck
npm test -w @zichan/web
npm run build:web
npm run test --prefix tools/e2e -- tests/card-system.spec.mjs
npm run test --prefix tools/e2e -- --config account.config.mjs card-system-admin.spec.mjs
```

浏览器矩阵覆盖三种纸张、浅色／深色、1280px／390px，以及总览、物品、转换、收支、报表、历史、管理、账号、游戏和设置。截图与运行证据保存在忽略的 `tools/e2e/test-results/`，不提交私人账本或测试数据库。

后台继续使用自身既有的青灰纸主题，额外检查浅色／深色、1280px／390px 的用户卡，确认禁用状态文字、选择操作、1px 边线和无投影。
