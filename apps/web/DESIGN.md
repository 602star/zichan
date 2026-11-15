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
    fontFamily: "'Songti SC','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif"
    fontSize: "clamp(28px, 8vw, 40px)"
    fontWeight: 700
    lineHeight: 1.05
  headline:
    fontFamily: "'Songti SC','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif"
    fontSize: "20px"
    fontWeight: 700
  title:
    fontFamily: "'Songti SC','Noto Serif CJK SC','Source Han Serif SC','SimSun',serif"
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
  touch-input:
    fontFamily: "'Manrope','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif"
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

标题与重点汇总的发声来自宋／明体栈 --font-display；表单、说明、导航和密集数据使用清楚的无衬线正文栈。账本金额与日期启用等宽数字。当前字体栈依赖设备可用字体，缺字时回退到 serif 或系统无衬线。

正文 13px，说明 12px，极少数元信息 11px，区块标题 15px，页标题 20px，关键金额采用 26px 或响应式 hero 级。常规字重只有 400、600、700；先用位置、字号和墨色层级区分，不给每行辅助文字加粗。粗指针设备的输入字号提高到 16px。

## Layout

桌面是深墨侧栏与弹性纸面内容区。页首持续显示当前位置、报表币种和账本日。日常收支首先给连续摘要条，再给日期、搜索、可展开筛选和记录；不让维护操作或筛选墙挤走金额。

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
- **记录：** 搜索保持可见，较少使用的筛选可展开。已对账记录只有在真实状态为已对账时才出现小朱印；朱印不是装饰。
- **表单和弹窗：** 标签位于输入上方，焦点采用朱色边线；错误与恢复路径用明确文字说明。触屏输入保证 16px 字号与命中面积。
- **触屏日期／时间：** 字段以按钮打开文献纸面板，使用朱色选中态与统一线性图标；日期按年月日选择，时间用可滚动的时、分列（精确时间可含秒），统一确认与取消。打开时结束文本输入，返回时只聚焦字段按钮。鼠标设备保留原生键盘编辑。
- **每日／每周回顾：** 收支页以双列入口展示今日、本周支出，点击查看该期间全部流水；每日列表标题在同一行展示该日筛选后的小计，金额沿用收入藍、支出赤。

## Do's and Don'ts

移动端将总览、收支、记一笔、资产、更多固定在拇指可达的底栏，与桌面侧栏偏好分开。总览默认收支优先，可切换资产优先；资产聚合账户、持仓和物品。更多、资料、设置与账号使用墨线目录，进入独立任务页；物品详情按概况、使用、事件组织。手机 Web 与 Android 共用页面，不另建一套 Android 视觉。

长表单按内容、金额与账户、日期与周期分组，主操作固定在表单底部；手机选择使用共用纸面面板，长列表可搜索，桌面保留原生选择。转换保存前显示真实实扣、到账与手续费核对。返回先关闭当前层，未保存内容遵循草稿保护；登录、注册和找回账号各自成页。系统键盘、权限、文件操作与前后台切换另做 Android 真机验收。

- **Do** 让金额、方向和状态先于辅助说明被看见；浅色、深色、三种纸张和手机都验证真实数据长度。
- **Do** 使用语义变量，不在组件内写死朱、藍、赤的色值；纸张变体只改变纸张角色。
- **Do** 把已核对状态与数据库状态相连，并同时用文字呈现。
- **Don't** 把卡片套进同类卡片，或把每一条记录做成漂浮卡。
- **Don't** 用仿古纸纹、随意图章和通用金融霓虹把账本做成主题装饰。
- **Don't** 为一个页面另造字号、圆角、状态色或按钮样式。
