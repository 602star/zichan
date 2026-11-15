---
version: alpha
name: 资产生命周期 · 大福帳
description: 以墨、朱和文献纸组织个人多资产账本
colors:
  action-vermilion: "#b63226"
  action-vermilion-dark: "#ee7868"
  income-indigo: "#2b6079"
  income-indigo-dark: "#8ec5dc"
  expense-red: "#a72f24"
  expense-red-dark: "#f18c78"
  warning-ochre: "#76531c"
  paper: "#ebe8df"
  surface: "#faf9f5"
  surface-secondary: "#f1efe8"
  ink: "#211d18"
  ink-secondary: "#56514b"
  ink-tertiary: "#625d56"
  rule: "#d3cec2"
  sidebar: "#24221f"
  sidebar-ink: "#e8e3d9"
  dark-paper: "#1b1b1a"
  dark-surface: "#262521"
  dark-ink: "#f1eee6"
  on-action-light: "#ffffff"
  on-action-dark: "#211b18"
typography:
  display:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "clamp(28px, 8vw, 40px)"
    fontWeight: 700
    lineHeight: 1.05
  headline:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "24px"
    fontWeight: 700
  title:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "18px"
    fontWeight: 700
  body:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "16px"
    fontWeight: 400
  caption:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "14px"
    fontWeight: 400
  touch-input:
    fontFamily: "'LXGW WenKai Screen','PingFang SC','Microsoft YaHei',system-ui,sans-serif"
    fontSize: "16px"
    fontWeight: 400
rounded:
  seal: "2px"
  sm: "4px"
  md: "8px"
  lg: "12px"
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
    backgroundColor: "{colors.action-vermilion}"
    textColor: "{colors.on-action-light}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "38px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "20px"
  summary-metric:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    padding: "16px"
  status-stamp:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.action-vermilion}"
    rounded: "{rounded.seal}"
    padding: "2px 5px"
---

# Design System: 资产生命周期 · 大福帳

## Overview

**Creative North Star：大福帳，墨与朱。** 这是一份需要长期翻阅、记入和核对的个人总账。页面用偏冷的文献纸承托数据，以暖墨建立阅读秩序，以朱色标记主操作、当前位置和确实完成的核对状态。表面像可靠的当代账本，不模拟破旧纸纹或把每项数据装进独立卡片。

现有的 terracotta、sage、plum 存储标识保持兼容，界面改称文献纸、青灰纸、紫灰纸。它们只改变纸张底色与边线，不改变朱色操作墨、收入藍、支出赤和页面结构。每种纸张有浅色、深色和跟随系统模式。

## Colors

- 页面底、内容表面、次级表面与细规则线分别使用 --bg、--surface、--surface-2、--border；默认浅色值见上方 token。静态内容以墨线和留白分层。
- 主操作、焦点、当前导航与朱印使用 --accent。浅色下是深朱 #b63226，深色下重新选为 #ee7868；按钮文字由 --on-accent 配对。
- 收入和正向金额使用 --positive 藍色；支出与负向金额使用 --negative 赤色；提醒使用 --warning 黄土色。危险操作单独通过 --danger 命名，即使当前与支出色相近，也不可在代码中互换语义。
- 深色使用重新选择的纸、墨、边线与状态色，不通过反相计算。暗色首屏默认值与运行时主题必须一致。
- 图表分类使用 --cat-1 至 --cat-6 以及 --cat-other 的有序色槽；分类既有颜色也有文字和固定顺序。不得把收入、支出或提醒颜色当作任意分类标记。

## Typography

标题、表单、说明与导航使用随应用打包的霞鹜文楷屏幕阅读版 v1.530，--font-display 与 --font-body 共用该字体，保留纸面账簿的书写感。按用户要求保持全量字库，仅转换为单个 WOFF2，不分包、不裁剪字符；随离线壳缓存，不依赖外部 CDN 或用户安装。--font-numeric 在金额与数量位置使用系统无衬线和等宽数字，中文单位仍回退到共用文楷。授权见 public/licenses/lxgw-wenkai-screen.txt，来源、版本与 SHA-256 固定在 scripts/fonts/build-wenkai.py；脚本对比转换前后完整字符映射和字形顺序。

正文 16px，说明 14px，徽章与图表轴等元信息 13px，区块标题 18px，页标题 24px，关键金额采用 30px 或响应式 hero 级；基础行高 1.6。字重语义保留 400、600、700，但屏幕文楷只提供常规字形，全局 `font-synthesis: none` 禁止浏览器补造粗体与斜体，汉字使用字体原本已加强的笔画；标题和导航通过字号、留白、墨色与当前状态区分。金额的系统数字字体可使用其真正的字重。输入字号至少 16px，大屏字号递增，不能在更宽断点反而缩小。

## Layout

“账单与还款”是独立日常任务，不以添加资金账户为前提。首页提供通用新增入口，账户还款日期作为额外来源；单次、持续及固定期数计划共用现有日期控件。只做提醒时默认不自动入账；“仅标记已处理”与“登记流水”明确区分，前者不得改变金额汇总或账户余额。高级生成时间、时区与补齐规则逐步展开，避免首次登记计划时要求理解账户或自动记账配置。

工作台先用一张概况 Sheet 组织净资产与期间收支，随后并排显示“账单与还款”和“最近流水”两张 Sheet，内部用墨线分行，禁止恢复无边框的最近流水外壳。投资与使用指标置于单独 Sheet 的连续信息带，避免资产快照重复。手机收支优先时先看最近流水、提醒默认两项并可展开；信用卡仅提供日期提醒，不从余额推断应还或逾期。资产配置含负余额时仅展示净额，不画比例。

桌面是深墨侧栏与弹性纸面内容区。页首持续显示当前位置、报表币种和账本日。日常收支首先给连续摘要条，再给日期、搜索、可展开筛选和记录；不让维护操作或筛选墙挤走金额。

电脑端以通栏记录为主，不使用常驻右侧详情区。点流水在行下展开，以墨线、定义行和明确编辑动作组织；流水新增、编辑和退款在居中纸面弹窗完成，保存并继续与草稿保护共用；账户和转换等复杂任务仍进入主区。侧栏按日常、资产与分析、账本工具分组，宽度 212px 并可收起。资料、设置与账号使用窄幅局部目录；物品以比较清单为入口，详情复用概况／使用／事件；宽屏报表并排组织走势与构成。具体操作见[电脑端账本工作台](../../docs/guides/desktop-ledger.md)。

768px 以下使用底部导航和“更多”抽屉。手机上的收支汇总排成两列，搜索与首条记录在底栏上方可见；记录以紧凑条目显示，桌面记录保留清楚的列关系。平板保留侧栏语义并压缩宽度。触控目标与输入字号按粗指针适配，弹窗、底栏和抽屉留出安全区。区块与字段间距沿用 sp-1 至 sp-6。

手机流水按天以墨线分组，日期账头显示每日支出合计和币种，缺价时明确标记未完整折算。点按先查看只读详情；长按或左右滑动打开纸面操作面板，行尾更多按钮提供同一入口。滑动只打开选择，编辑、退款等变更仍需明确点选。面板使用宋体标题、原币金额、墨线定义行与朱色操作图标；内部不再套卡。纵向滚动取消手势，两侧保留系统返回区域。细则与 Android 真机清单见 [手机流水与操作](../../docs/guides/mobile-ledger.md)。

## Elevation & Depth

常规卡片、摘要带和记录列表以单层表面、细边线与留白组织；弹窗、菜单和移动抽屉才使用 --shadow-md、--shadow-lg 或向上阴影。深色模式分别定义阴影和遮罩。背景不加仿古纹理，静态内容不靠普遍投影抬升。

## Shapes

朱印使用近方形的小圆角和细边框；普通控件用 4px、内容表面用 8px、较大浮层用 12px。药丸只用于简短状态或真正圆形的快速记账按钮。列表和表格更依赖墨线，不以圆角盒子逐条隔开。

## Components

- **导航：** 深墨侧栏以朱色章点标识当前项，顶部“资”字为朱印。手机保留底部导航与居中的快速记账入口。
- **按钮：** 主按钮实心朱色，次级按钮细边框，低优先级操作用透明或次级表面。危险动作使用 --danger。每种状态保留键盘焦点和禁用反馈。
- **汇总：** 标签在金额上方，单元以一像素分隔组成连续信息带。收入藍、支出赤与结余的文字含义同时可读。
- **卡片：** 一张卡承载一个真正独立的任务或信息组。Sheet 使用 surface、1px 边线、8px 圆角与 20px 内边距；tight 使用 16px，flush 仅让表格／列表内容贴边，标题与页脚保留内边距。Card 提供统一标题、说明、操作和页脚，CardHeader 保留兼容导出并共用 CardHead。
- **卡内层级：** CardGroup／`.zc-card-group` 用间距和相邻组间的单条墨线分隔；CardMetric 表达标签、主数值和说明，CardFact 表达定义行，CardEmpty 表达一句空状态。多个指标用 `.zc-card-band` 连成信息带；卡内使用 `is-inset` 去掉外框。换行后仍保持 1px 分隔，不恢复浮动小卡。
- **告警：** 缺价与读取失败使用 `--warn-surface`／`--danger-surface` 和左侧 1px 墨色短线，正文说明问题与恢复路径。CardAlert 使用 `.zc-alert`，允许放在 Sheet 内而不构成嵌套卡片；`.zc-card.is-alert` 兼容独立告警面板。后台用户状态同时使用文字徽章与 1px 顶部墨线，不使用彩色粗边或静态投影。
- **记录：** 搜索保持可见，较少使用的筛选可展开。分类列按全目录完整路径实测预留 12.5 倍正文字号加 16px 留白（16px 正文时共 216px），不截断分类；内置分类在桌面保持单行，更长的自定义分类与手机窄列允许完整换行。768–1023px 将时间和账户移至摘要下方，保留分类与摘要空间。账户列可单行省略、详情显示完整内容。退款金额与原支出及净支出集中在金额列，不与摘要混排，不把退款当作作废划掉原消费。已对账记录只有在真实状态为已对账时才出现小朱印；朱印不是装饰。
- **表单和弹窗：** 标签位于输入上方，焦点采用朱色边线；错误与恢复路径用明确文字说明。触屏输入保证 16px 字号与命中面积。
- **触屏日期／时间：** 字段以按钮打开文献纸面板，使用朱色选中态与统一线性图标；日期按年月日选择，时间用可滚动的时、分列（精确时间可含秒），统一确认与取消。打开时结束文本输入，返回时只聚焦字段按钮。鼠标设备保留原生键盘编辑。
- **每日／每周回顾：** 收支页以双列入口展示今日、本周支出，点击查看该期间全部流水；每日列表标题在同一行展示该日筛选后的小计，金额沿用收入藍、支出赤。

## Do's and Don'ts

账户工作区采用默认收支设置、可比较的资金账户清单和通栏详情；不另设右侧详情栏。清单保留零余额及原币余额，用文字标识默认方向与停用状态；点击后定位到对应账户。账户流水、对账记录、账户资料分为页签，日期与日常收支查询独立。桌面账户编辑进入主区，手机共用纸面选择和表单。系统预建默认账户的类型为“其他”，与自行添加账户共用清单、资料、流水、余额和操作；默认支出／收入仅表示用途，不另设归集面板。仅系统预建的两个账户取消新建对账；自建账户不因类型为“其他”或被设为默认用途而失去对账。旧对账可查看与撤销。

账户编辑、对账、历史归属整理及余额起点核对互斥。对账在桌面独占主区，按真实余额、账单流水、差额逐步组织；首次余额不默认填零。指标明确区分余额基准、勾选净额、自动转换、本次核对余额及差额，并说明未勾选记录仍留在账本。差额调整作为展开后的显式选择，金额或范围变化后需重新确认；未保存退出保护输入与勾选。

移动端将总览、收支、记一笔、资产、更多固定在拇指可达的底栏，与桌面侧栏偏好分开。总览默认收支优先，可切换资产优先；资产聚合账户、持仓和物品。更多、资料、设置与账号使用墨线目录，进入独立任务页；物品详情按概况、使用、事件组织。手机 Web 与 Android 共用页面，不另建一套 Android 视觉。

长表单按内容、金额与账户、日期与周期分组，主操作固定在表单底部；手机选择使用共用纸面面板，长列表可搜索，桌面保留原生选择。转换保存前显示真实实扣、到账与手续费核对。返回先关闭当前层，未保存内容遵循草稿保护；登录、注册和找回账号各自成页。系统键盘、权限、文件操作与前后台切换另做 Android 真机验收。

- **Do** 让金额、方向和状态先于辅助说明被看见；浅色、深色、三种纸张和手机都验证真实数据长度。
- **Do** 使用语义变量，不在组件内写死朱、藍、赤的色值；纸张变体只改变纸张角色。
- **Do** 把已核对状态与数据库状态相连，并同时用文字呈现。
- **Don't** 把卡片套进同类卡片，或把每一条记录做成漂浮卡。
- **Don't** 用仿古纸纹、随意图章和通用金融霓虹把账本做成主题装饰。
- **Don't** 为一个页面另造字号、圆角、状态色或按钮样式。
