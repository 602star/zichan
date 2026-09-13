# 手机 Web 端适配方案

> **状态：已全部实施（2026-09-12）。** 批次 1–4 全部落地；审计脚本从 269 条问题降到 **0 条**；
> 新增 `tools/e2e/account-tests/mobile-layout.spec.mjs`（7 视口 × 10 页面，真实数据）与升级版
> `apps/web/test/responsive-contract.test.ts` 作为回归护栏。改动清单与验证数据见
> [`worklog.md`](worklog.md) 的「2026-09-12 — 手机 Web 端完全适配」条目。
>
> 范围：`apps/web`（浏览器 Web + 复用同一套 UI 的 Tauri 移动壳）
> 方法：真实 Chrome + 真实 `@zichan/sync-server` + `apps/web/dist` 构建产物，走真实登录/建账/记流水流程，
> 逐屏程序化测量（横向溢出、触控目标尺寸、字体尺寸、遮挡、滚动模型）。
> 审计脚本与原始数据：`.runtime/mobile-audit/`（`*.mjs` + `findings*.json` + `shots*/`，均在 gitignore 内）。

---

## 1. 结论先说

**这个项目的手机壳已经做对了大部分事**：三档断点、底部导航 + “更多”抽屉、安全区 inset、`100dvh`、
`viewport-fit=cover`、`interactive-widget=resizes-content`、弹窗全屏 + 头尾吸附、分类双栏滚动。

**剩下的问题不在“有没有做响应式”，而集中在两个结构性的地方：**

1. **断点边界漏了**：16px 输入字号和 44px 触控目标只写在 `@media (max-width: 767px)` 里。
   一旦宽度 ≥ 768px（**平板竖屏、手机横屏**），整套手机规则失效，回落到桌面尺寸 → iOS 聚焦自动放大、
   触控目标变小。这是目前最容易在真机上被吐槽的问题。
2. **手机规则靠 `!important` 压制内联样式**：`styles.css` 里手机段有大量
   `grid-template-columns: ... !important` 去覆盖 TSX 里的内联 `gridTemplateColumns`。
   凡是**没有 class 的内联网格**（对账弹窗、资产转换“已作废”行、导入预览行等）就天然漏掉，
   而且不会报错 —— 因为被 `html, body { overflow-x: hidden }` 静默裁掉了。

---

## 2. 已复现的问题清单（按优先级）

### P0-1 平板 / 手机横屏：输入框 13px → iOS 聚焦自动放大

| 视口 | 低于 16px 的表单字段数 |
|---|---|
| 768×1024（iPad 竖屏） | 16 |
| 1024×768（iPad 横屏） | 16 |
| 844×390（手机横屏） | 13 |
| 390×844 / 360×800 / 320×568（手机竖屏） | 0 ✅ |

- 证据：`findings.json` / `findings3.json` 的 `input-zoom-risk` 与 `ZOOM` 行。
- 原因：`apps/web/src/styles.css:677` 的 `font-size: 16px !important` 只在 `max-width: 767px` 生效；
  `.zc-input/.zc-select` 基础值是 `padding: 9px 11px; font-size: 13px`（`styles.css:278-289`）。
- 影响：iPad 和横屏手机上每点一个输入框，Safari 自动放大整页，表单错位、需要手动缩小。

### P0-2 总览「净资产」大数字会把「截至 日期」挤出屏幕并裁掉

- 证据（`.runtime/mobile-audit/shots3/dashboard-hero-360x800.png` + `findings3.json`）：
  金额 `¥1,280,246.79` 时，值的宽度 323px，卡片右边界 348px，
  而「截至 2026-09-12」元素 `right = 483`（视口只有 360）→ **完全不可见**。
- 原因：`apps/web/src/screens/Dashboard.tsx:93-103` —— 字号写死 `46px`，日期块 `whiteSpace: 'nowrap'`，
  没有换行也没有响应式缩放。
- 影响：只要金额位数变多（7 位数起），基准日直接消失，且用户不知道自己丢了信息。

### P0-3 触控目标小于 44px

竖屏手机每屏 7–37 个，平板 59 个。具体到控件：

| 控件 | 实测尺寸 | 位置 |
|---|---|---|
| 流水/历史筛选 `select` | 294×38 / 324×38 | `Transactions.tsx:1902`、`History.tsx:389` |
| 设置/同步里的 `<summary>` 折叠开关 | 324×31 | `Settings.tsx`、`Sync.tsx` |
| 设置/同步里的按钮 | 119×37 / 145×37 / 106×37 / 132×37 | `LedgerProtectionPanel`、`AccountSecurityPanel` 等 |
| 撤销 toast 的「撤销」按钮 | 53×36 | `ui/UndoToast.tsx:91`（`minHeight: 36`） |
| 「应用锁 / 同步通知」开关 | 命中区 **134×19** | `ui/DeviceSecurityPanel.tsx:176-179` |
| 对账弹窗行选择 checkbox | **27×13** | `screens/ReconciliationModal.tsx:205` |
| 同步服务商表格 checkbox | **13×13**（无 label 包裹） | `screens/Sync.tsx:1636` |
| 平板图标轨上的「快速记账」 | **24×24** | `styles.css:594-601`（`width/height: 24px !important`） |
| 分类选择 / 手动记支出分类按钮 | 316×38 | `ui/QuickExpenseModal.tsx` |

- 原因：基础控件尺寸按桌面密度定（`styles.css:278-289`），44px 兜底只在手机断点里；
  行内 checkbox 完全没被 44px 规则覆盖。

### P1-1 `overflow-x: hidden` 把 `<body>` 变成了滚动容器，并静默吞掉溢出

- 证据（`findings4.json`）：`documentElement.scrollHeight = 844`（= 视口），
  `body.scrollHeight = 6084`，`window.scrollTo(0, 4000)` 之后 `window.scrollY` 仍是 **0**，
  只有 `document.body.scrollTop` 会动。
- 原因：`apps/web/src/styles.css:5-10` 的 `html, body { height: 100%; overflow-x: hidden }`。
- 影响：
  1. `window.scrollTo / scrollY / scroll` 事件全部失效 —— 任何“回到顶部”、滚动位置恢复、
     地址栏收起联动都不可用；
  2. 真正的溢出不再可见、不再可滚，而是被裁掉（P0-2 就是这样被藏起来的），
     以后新增布局问题也不会被现有测试发现。

### P1-2 密集表格在手机上退化为横向滚动

实测宽度：历史表 **696px**、报表月度预算表 **389px**、报表页签（含「物品资产」）滚到 448px。
能滚（`overscroll-behavior-inline: contain`），但「摘要 / 字段 / 偏差」这些关键列要横向滑才看得到。
手机上的表格最好是卡片化，而不是横向滚动。

### P1-3 部分弹窗 / 内联网格完全没有手机版

这些网格没有 class，手机媒体查询无法覆盖，只能靠 `overflow-x: hidden` 掩盖：

| 位置 | 网格 | 最小宽度估算 |
|---|---|---|
| `screens/ReconciliationModal.tsx:174` | `1.2fr 1fr 1fr 1fr` | 4×~110px |
| `screens/ReconciliationModal.tsx:204` | `28px 100px minmax(0,1fr) 130px 90px` | ≈388px + 弹窗 padding 48 |
| `screens/ReconciliationModal.tsx:186` | `repeat(4, minmax(0,1fr))` | 4 列挤压 |
| `screens/Convert.tsx:105` | `120px 100px minmax(0,1fr) 90px` | ≈382px |
| `screens/Transactions.tsx:1084` | `130px 90px minmax(0,1fr) 130px 72px` | ≈462px |
| `screens/Settings.tsx:944`、`ui/EntityFormModal.tsx:677` | `minmax(0,1fr) <fixed>` | 尚可 |

### P1-4 架构性：手机适配靠 `!important` 叠内联样式

`styles.css` 手机段里有 60+ 处 `!important`，绝大部分是为了压住 TSX 里的内联 `gridTemplateColumns`。
新增任何一个内联网格，都会静默漏掉手机版。这是“改一处、坏一处”的根源，也是现有
`responsive-contract.test.ts` 只能做字符串断言（“CSS 里存在某个媒体查询”）而无法防回归的原因。

### P2 体验细节

- 撤销 toast 固定在 `bottom: 24px`，会**压在 66px 高的底部导航上**（`ui/UndoToast.tsx:57`）。
- 平板 768–1199px 只有 84px **纯图标**轨（文字被隐藏），首次使用难以识别。
- 「更多」抽屉只列**已启用**模块，没有“未启用模块一次性启用”的入口，常用 5–6 个模块时每次多点两下。
- 全站没有 `prefers-reduced-motion` 处理。

---

## 3. 实施计划

### 批次 1 — 断点与触控基础（P0，约 1 天）

1. **把手机兜底规则从断点里拿出来**（`styles.css`）：
   - 16px 输入字号：改为 `@media (pointer: coarse)`（或提到基础层 + 桌面用 `(pointer: fine)` 覆盖回去）。
   - 44px 触控目标：`button, select, .zc-input, .zc-select, summary, [role="button"] { min-height: 44px }`
     同样绑 `(pointer: coarse)`，避免影响桌面鼠标密度。
2. **行内 checkbox 统一包装**：新增 `.zc-check-row { min-height: 44px; display: flex; align-items: center; gap: 10px }`，
   替换 `DeviceSecurityPanel`、`ReconciliationModal` 行、`Transactions` 选择列、`Sync` 服务商表格里的裸 checkbox。
3. 平板图标轨的「快速记账」24px → 44px（`styles.css:594-601`）。
4. 首页 hero 修掉 P0-2：`flexWrap: 'wrap'` + `fontSize: 'clamp(28px, 8vw, 46px)'`，
   数字容器加 `minWidth: 0`，日期块去掉 `nowrap`。

**验收**：脚本断言——在 320/360/390/414/768/844 六种宽度下，
① 表单字段字号 ≥ 16px（coarse pointer）；② 所有可交互元素命中区 ≥ 44×44。

### 批次 2 — 溢出与滚动模型（P0/P1，约 1 天）

1. `html, body { overflow-x: hidden }` → 只保留 `html { overflow-x: clip }`，
   让 `documentElement` 重新成为滚动容器；顺带确认 `position: sticky` 头部仍然生效
   （当前已实测生效）。
2. 给 P1-3 表格里的每一处内联网格**加 class**，并在手机媒体查询里重排为 1 列 / 2 列。
3. 加一条“禁止裸内联网格”的 lint/约定：所有 `gridTemplateColumns` 必须伴随 class。

**验收**：360 / 320 下 `document.documentElement.scrollWidth <= innerWidth`，
且**在去掉 `overflow-x: hidden` 之后**仍成立（这是真正的回归护栏）。

### 批次 3 — 把横向滚动改成手机原生布局（P1，约 2 天）

1. 历史表、报表月度预算表 → 手机上卡片化：第一行「时间 + 类型 + 金额」，第二行摘要，详情折叠。
2. 报表页签 / 日期范围条 → 保留横向滚动，但加边缘渐隐 + `scroll-snap`。
3. 同步结果网格（8 列 `110px 1fr 140px ...`）→ 手机上改为两行 key-value 卡片。

### 批次 4 — 导航与一致性（P2，约 1 天）

1. 「更多」抽屉增加“全部模块”区块（含未启用模块 + 一键启用）。
2. 平板窄轨：768–1023px 用 64px 图标 + 文字，1024–1199px 保持图标轨。
3. Toast 上移避开底部导航：`bottom: calc(78px + env(safe-area-inset-bottom))`（手机断点内）。
4. 补 `prefers-reduced-motion`。

---

## 4. 验证方案（关键：先补测试，再改代码）

**现有覆盖不足**：`tools/e2e/account-tests/mobile.spec.mjs` 只测了登录、快记、设置、同步 4 个页面，
且只断言“不横向溢出”。而**空账本时 10 个页面全部 0 溢出** —— 我这次先跑空账本、后跑 6 笔流水，
总览才暴露出溢出。所以：

1. **把这次的审计脚本固化**成交付物：`tools/e2e/account-tests/mobile-audit.spec.mjs`
   （可直接复用 `.runtime/mobile-audit/audit.mjs` + `probe2-5.mjs` 的探针函数）。
   → 已落地为 `account-tests/mobile-layout.spec.mjs`（布局契约）+ `account-tests/mobile-form-sweep.spec.mjs`（表单流程）。
   两者分开：布局是几何，表单是行为，混在一起失败时定位不清。
2. **必须带真实数据**：6 笔流水 + 1 次转换 + 1 件物品资产 + 1 条游戏记录 + 1 次对账，
   否则空状态会掩盖问题。
3. **设备矩阵**：320×568、360×800、390×844、414×896（手机竖屏）、844×390（手机横屏）、
   768×1024、1024×768（平板）。
4. **每屏断言**：无横向溢出、可交互元素 ≥ 44×44、表单字号 ≥ 16px、无文本被裁、
   内容不被底部导航遮挡（滚动到底后测量）。

   **另加表单行为层**（`mobile-form-sweep.spec.mjs`）：手机端也要求
   “打开每个新增表单 → 空提交 → 每个被拦字段都能定位”。手机与桌面的三个差异必须单独断言：

   - 弹窗面板自身是滚动容器（`max-height: 90vh`），字段是否在视口内要拿**面板矩形**当框，不能用窗口；
   - 跳转后字段不能被**底部导航**遮住；
   - 错误汇总里的字段标签（恢复入口本身）必须 ≥ 44px 触控高度。

   注意实现现状：保存被拦后会 `queueFocus(第一个错误字段)`，面板会滚到该字段，
   底部的错误汇总因而可能移出视口。**这是有意行为**（字段旁边就有自己的错误文案），
   所以断言应写成“汇总条可见 **或** 字段自身的错误文案可见”，而不是“汇总条必须可见”。
5. **视觉回归**：每屏整页截图 + Playwright `toHaveScreenshot` 基线。
6. 升级 `apps/web/test/responsive-contract.test.ts`：从“CSS 里存在某字符串”改为
   “每个手机专用 class 都有对应 `@media` 规则”，作为快速防回归。

---

## 5. 风险与取舍

| 风险 | 处理 |
|---|---|
| 全局 16px 影响桌面信息密度 | 只在 `(pointer: coarse)` 生效，桌面不受影响 |
| `overflow-x: clip` 需要 Safari 16+ | 提供 `overflow-x: hidden` 回退 + 一次性 `min-width: 0` 修根因 |
| 卡片化会改掉现有 e2e 依赖的 `.zc-history-entry` 等选择器 | 保留 class 名，只改内部结构；同步更新 spec |
| 批次 2 去掉 `overflow-x: hidden` 后可能**暴露**一批一直存在的溢出 | 这正是目的：一次性修完，而不是继续掩盖 |

---

## 6. 如果只想先修最显眼的三件事

1. **P0-2 总览大金额把日期顶出屏幕** —— 用户直接看到信息丢失，改动最小（1 个组件）。
2. **P0-1 平板/横屏输入框 13px** —— 真机上每次输入都被放大，体感最差，改动集中在 CSS。
3. **P0-3 里最差的几个触控目标** —— 对账/流水 checkbox（27×13、13×13）、
   设置里 19px 高的开关、平板 24px 的快记按钮。

合计约半天，覆盖用户最容易抱怨的问题；批次 1–4 才是“完全适配”。
