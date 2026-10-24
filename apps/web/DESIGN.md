---
version: alpha
name: 资产生命周期
description: 温和、清晰、克制的个人多资产账本界面
colors:
  primary-terracotta: "#a0522d"
  primary-sage: "#406d54"
  primary-plum: "#8f5670"
  accent-soft-terracotta: "#f6e4d5"
  paper-terracotta: "#f0e9dc"
  surface-terracotta: "#fffcf6"
  surface-raised-terracotta: "#f6efe2"
  ink-terracotta: "#2b2620"
  ink-secondary-terracotta: "#6b6155"
  ink-tertiary-terracotta: "#706558"
  border-terracotta: "#e6dccb"
  on-accent-light: "#ffffff"
  income: "#317554"
  expense: "#a64c37"
  warning: "#855916"
  dark-paper-terracotta: "#191512"
  dark-surface-terracotta: "#221d19"
  dark-ink-terracotta: "#f2e9dd"
  dark-accent-terracotta: "#e0a072"
  on-accent-dark: "#241a12"
typography:
  display:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "26px"
    fontWeight: 700
    lineHeight: 1.15
  headline:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "20px"
    fontWeight: 700
  title:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "15px"
    fontWeight: 700
  body:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "13px"
    fontWeight: 400
  caption:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "11px"
    fontWeight: 600
  input-touch:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "16px"
    fontWeight: 400
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "20px"
  sp-6: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-terracotta}"
    textColor: "{colors.on-accent-light}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "38px"
    typography: "{typography.body}"
  button-outline:
    backgroundColor: "{colors.surface-terracotta}"
    textColor: "{colors.ink-secondary-terracotta}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "38px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary-terracotta}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "38px"
  card:
    backgroundColor: "{colors.surface-terracotta}"
    textColor: "{colors.ink-terracotta}"
    rounded: "{rounded.md}"
    padding: "20px"
  input:
    backgroundColor: "{colors.paper-terracotta}"
    textColor: "{colors.ink-terracotta}"
    rounded: "{rounded.sm}"
    padding: "9px 11px"
    typography: "{typography.body}"
  tag:
    backgroundColor: "{colors.surface-raised-terracotta}"
    textColor: "{colors.ink-secondary-terracotta}"
    rounded: "{rounded.sm}"
    padding: "3px 8px"
  tab-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink-terracotta}"
    padding: "0 12px"
    height: "38px"
    typography: "{typography.body}"
  summary-metric:
    backgroundColor: "{colors.surface-terracotta}"
    textColor: "{colors.ink-terracotta}"
    padding: "16px"
---

# Design System: 资产生命周期

## Overview

**Creative North Star: “温暖的个人分类账”**

这个界面把个人账本当作需要长期翻阅和操作的工具：底色像暖纸，记录与控件清楚分层，金额和状态可以快速扫读。整体气质是温和、清晰、克制；强调可靠的操作反馈，而不让装饰压过财务数据。

默认呈现“暖纸 · 赭石”，另有“鼠尾草 · 苔绿”和“梅子 · 紫褐”两套主题。每套主题都可独立选择浅色、深色或跟随系统。主题切换改变语义色板，不改变页面结构、字级或交互含义。

**Key Characteristics:**

- 暖色或带色相的页面底与明晰的内容表面，依靠细边框和间距分组。
- 字号紧凑、金额突出；辅助文字分为可辨认的次级和第三级。
- 常规页面保持平稳，弹窗与抽屉才明显抬升。
- 桌面、平板与手机共享组件语言，并按输入方式调整触控尺寸。

## Colors

色彩由 `src/theme.ts` 的语义变量驱动，`src/styles.css` 提供首屏默认值。上方 token 是默认赭石浅色主题及关键深色对应值；运行时由主题映射覆盖，不能把这些值硬编码进组件。三套主题的现有名称与语义角色应继续沿用。

### Primary

- **暖纸 · 赭石：** 默认主操作色，承担主要按钮、当前选择和重点链接；柔和变体用于低强度强调。
- **鼠尾草 · 苔绿：** 与赭石并列的可选主题，保持相同的交互角色。
- **梅子 · 紫褐：** 第三套可选主题，保持相同的交互角色。

### Tertiary

- **收入／正向：** 用于正金额与成功状态。
- **支出／负向：** 用于负金额、支出及危险操作。主题另设 `--danger` 语义别名；现有默认主题中它与负向色取相同色值。
- **提醒：** 用于账本日落后等需要注意但不属于错误的状态。
- 图表分类使用 `--cat-1` 至 `--cat-6` 的有序色槽和去饱和的“其他”色槽，不能把收支状态色直接借作分类色。

### Neutral

- 页面底、卡片表面、次级表面、主文字、两级辅助文字和边框各有独立角色。默认浅色主题是暖纸与深棕墨色；深色主题换成深暖底与浅色文字，而非简单反相。
- 主色填充按钮的文字由 `--on-accent` 决定：浅色主题用浅字，深色主题用深字。

**The Semantic Color Rule.** 金额方向、警告、图表分类和主要操作分别使用自己的语义色，不用同一个颜色承担相互冲突的含义。

**The Theme Pair Rule.** 每个主题同时提供浅色和深色变量；切换模式时保留主题色相，并重新选择文字、边框、状态色及阴影。

## Typography

账本主界面使用 `Manrope` 优先、中文系统字体随后、系统无衬线字体兜底的字体栈；代码没有捆绑 Manrope 字体文件，因此实际字形取决于设备可用字体。数字使用等宽数字特性，方便比较金额和日期。登录等前置页面可使用独立的系统字体和更大的标题，但仍沿用主题色板。

- **Display：** 关键汇总金额采用粗体显示级，行高紧凑；手机有专用的流动字号。
- **Headline：** 页面和弹窗标题使用明确但不夸张的粗体。
- **Title：** 区块标题与行内重点使用较小一级的粗体。
- **Body：** 密集数据和表单的基本阅读层级；不靠任意加粗制造层次。
- **Caption 与 Label：** 说明、标签、徽记和图轴使用次级字级与文字颜色。
- **Touch input：** 粗指针设备的输入字号提高到避免移动浏览器聚焦放大的尺寸。

**The Numbers First Rule.** 用字级、字重和对齐让金额与核心状态先被看见；说明文字保持可读，但不与主要数据争夺焦点。

## Layout

桌面账本采用固定宽度侧栏与弹性内容区，页面顶部是持续可见的标题和状态栏；内容区用间距、单层卡片和分隔线组织。宽视口限制主内容最大宽度，避免财务数据横向铺得过散。

小于手机断点（768px）时，侧栏让位于底部导航与“更多”抽屉；较长表格改为带字段标签的纵向记录卡。平板保留侧栏语义但压缩空间。触控目标与输入字号由 `(pointer: coarse)` 决定，覆盖横屏手机和平板，不仅依赖视口宽度。弹窗、底部导航与抽屉留出安全区。

基础间距沿用六级比例尺。卡片常用内部留白为较大的一级，紧凑卡片降低一级；区块之间留出比字段间更明确的间隔。

## Elevation & Depth

**色层与边框为主，浮层再抬升。** 常规卡片主要靠表面色、细边框与留白区分；弹窗、悬浮菜单和移动抽屉才使用阴影及遮罩。深色模式重新定义阴影和遮罩强度，确保浮层仍能从背景分离。

### Shadow Vocabulary

- **中等浮层：** `--shadow-md`，用于较轻的悬浮表面。
- **重要浮层：** `--shadow-lg`，用于弹窗和强层级面板。
- **向上浮层：** `--shadow-up` 与 `--shadow-up-strong`，用于从底部升起的移动控件与抽屉。

**The Raised Layer Rule.** 静态内容不靠普遍投影制造层级；只有离开页面流、盖在内容之上的界面才明显抬升。

## Shapes

表单控件和按钮采用柔和的小圆角，卡片和弹窗使用更宽的圆角；徽记和状态胶囊采用药丸轮廓。快速记账等独立图标操作使用真正的圆形，并在触控尺寸下保持宽高一致。边框通常细且有颜色倾向，不以厚重描边建立层次。

## Components

共同手感是**温和而可靠，操作清楚**。组件保持统一轮廓和状态反馈，数据始终比控件装饰更重要。

### Buttons

- **Primary：** 实心主题色，使用随明暗模式切换的对比文字；普通桌面控件保持紧凑，触控设备扩大点击区域。
- **Outline / Quiet / Ghost：** 分别用细边框、次级表面和透明背景表达较低优先级；悬停时通过主色改变边框与文字。
- **Danger：** 文字及边框使用危险语义色，不通过主色伪装破坏性动作。
- **Focus：** 保留明显的键盘焦点指示；禁用态降低对比且不显示可点击指针。

### Cards / Containers

- 单层有边框的内容表面承载主要分组；卡片内部的次级分组使用分隔线和间距，不再次套入同类卡片。
- 常规卡片、紧凑卡片与无内部留白的列表卡共用表面和边框语言。

### Inputs / Fields

- 输入框和下拉框使用页面底色、细边框和小圆角；聚焦时边框转为主题色。数字使用等宽数字特性。
- 字段标签位于控件上方；错误文本使用危险语义色，触控设备扩大真实命中区。

### Navigation

- 桌面侧栏承载可配置模块；移动端使用底部导航和“更多”抽屉。当前项依靠主题色、文字层级或边线表达，不仅靠位置。
- 水平标签在当前项下方使用主题色细线；内容较多时可横向滚动，不压缩字词到不可读。

### Summary Metrics

- 汇总数字使用高字级和粗体，标签放在其上方。指标之间用一像素的分隔与独立表面形成连续汇总条，而不是多个漂浮卡。

## Do's and Don'ts

### Do:

- **Do** 通过语义变量使用三套主题，并核对浅色、深色和跟随系统的首屏效果。
- **Do** 先用字级、间距、表面与边框建立信息层次；金额和状态保持可扫读。
- **Do** 在粗指针设备保留足够的命中区与较大的输入字号，验证横屏手机和平板。
- **Do** 让图表分类同时依靠文字标签与固定顺序，不只靠颜色辨别。

### Don't:

- **Don't** 把卡片再套进同样的卡片；内部层级用分隔线和留白。
- **Don't** 把支出红、收入绿或警告色当作任意分类色或装饰色。
- **Don't** 给每块静态内容加阴影，削弱真正浮层的层次。
- **Don't** 为单一页面另造字号、圆角或按钮外观，跳过既有比例尺与组件语义。
