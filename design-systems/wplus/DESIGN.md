---
version: beta
name: Market W+ System Design
description: A PC-first enterprise design system for the Market W+ platform. It uses a restrained blue action color, white content surfaces, a light gray page canvas, compact Chinese UI typography, and predictable Ant Design-style states for dense operational workflows.

colors:
  primary: "#1774FF"
  primary-hover: "#3D8BFF"
  primary-active: "#0F5FD7"
  primary-disabled: "#D6E4FF"
  on-primary: "#FFFFFF"
  success: "#52C41A"
  warning: "#FAAD14"
  error: "#F5222D"
  info: "#1774FF"
  text-primary: "#262626"
  text-secondary: "#595959"
  text-tertiary: "#8C8C8C"
  text-disabled: "#BFBFBF"
  border: "#D9D9D9"
  divider: "#F0F0F0"
  canvas: "#F5F5F5"
  surface: "#FFFFFF"
  surface-subtle: "#FAFAFA"
  surface-hover: "#F5F9FF"
  surface-selected: "#E6F4FF"
  surface-disabled: "#F5F5F5"
  dark-surface: "#123567"
  dark-border: "#416A9F"
  focus-ring: "rgba(23, 116, 255, 0.20)"

typography:
  display-lg:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  display-md:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: 0
  title-md:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: 0
  body-md:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.57
    letterSpacing: 0
  body-sm:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  label:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.5
    letterSpacing: 0
  caption:
    fontFamily: "PingFang SC, Microsoft YaHei, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0
  code:
    fontFamily: "SFMono-Regular, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: 0

rounded:
  xs: 2px
  sm: 4px
  md: 4px
  lg: 6px
  pill: 9999px
  full: 50%

spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  xxl: 40px
  section: 48px

components:
  app-header:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    height: 64px
    padding: 0 24px
    borderBottom: "1px {colors.divider}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 16px
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
    textColor: "{colors.on-primary}"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
  button-primary-disabled:
    backgroundColor: "{colors.primary-disabled}"
    textColor: "{colors.surface}"
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.border}"
    rounded: "{rounded.sm}"
    height: 32px
    padding: 0 16px
  button-dashed:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px dashed {colors.border}"
    rounded: "{rounded.sm}"
    height: 32px
  button-link:
    backgroundColor: transparent
    textColor: "{colors.primary}"
    height: 32px
    padding: 0 4px
  button-text:
    backgroundColor: transparent
    textColor: "{colors.text-secondary}"
    height: 32px
    padding: 0 4px
  button-ghost:
    backgroundColor: transparent
    textColor: "{colors.on-primary}"
    border: "1px {colors.dark-border}"
    rounded: "{rounded.xs}"
    height: 32px
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body-md}"
    border: "1px {colors.border}"
    rounded: "{rounded.xs}"
    height: 32px
    padding: 0 12px
  input-focused:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.primary}"
    focusRing: "{colors.focus-ring}"
  input-error:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.error}"
  input-disabled:
    backgroundColor: "{colors.surface-disabled}"
    textColor: "{colors.text-disabled}"
    border: "1px {colors.border}"
  select:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.border}"
    rounded: "{rounded.xs}"
    height: 32px
  table:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    headerBackgroundColor: "{colors.surface-subtle}"
    rowHeight: 40px
    border: "1px {colors.divider}"
    rowHoverBackgroundColor: "{colors.surface-hover}"
  table-selected-row:
    backgroundColor: "{colors.surface-selected}"
  scroll:
    trackColor: transparent
    thumbColor: "rgba(191, 191, 191, 0.40)"
    thumbHoverColor: "rgba(191, 191, 191, 0.60)"
    largeWidth: 10px
    smallWidth: 6px
  modal:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: 24px
  drawer:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    padding: 24px
  popover:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.divider}"
    rounded: "{rounded.xs}"
  message:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.divider}"
    rounded: "{rounded.xs}"
  alert:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.divider}"
    rounded: "{rounded.xs}"
  tag:
    backgroundColor: "{colors.surface-subtle}"
    textColor: "{colors.text-secondary}"
    border: "1px {colors.border}"
    rounded: "{rounded.xs}"
    padding: 0 8px
  badge:
    backgroundColor: "{colors.error}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.pill}"
    minSize: 16px
  avatar:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    largeSize: 36px
    smallSize: 28px
    rounded: "{rounded.full}"
  empty:
    backgroundColor: transparent
    textColor: "{colors.text-tertiary}"
    illustrationRequired: true
  descriptions:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    labelBackgroundColor: "{colors.surface-subtle}"
    rowHeight: 40px
    border: "1px {colors.divider}"
  upload:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-secondary}"
    border: "1px dashed {colors.border}"
    rounded: "{rounded.xs}"
  date-picker:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-primary}"
    border: "1px {colors.border}"
    rounded: "{rounded.xs}"
    height: 32px
  tooltip:
    backgroundColor: "{colors.text-primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.xs}"
  back-top:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    size: 40px
    rounded: "{rounded.full}"

---

## Overview

市场 W+ 是面向企业运营后台的 PC-first 设计系统。压缩包中的页面以“市场 W+”品牌蓝为唯一主要动作色，页面底色为浅灰，内容区域使用白色容器，信息层级依靠字号、间距、边框和状态色建立，而不是依靠装饰性渐变或大面积投影。

设计目标是让密集的业务数据可快速扫描、可靠编辑并保持稳定的操作反馈：

- 蓝色用于主要动作、链接、选中态和信息态；成功、警告、错误只表达语义，不作为装饰色。
- 默认页面底色为 `{colors.canvas}`，卡片、表格和表单容器为 `{colors.surface}`。
- 组件采用轻边框、低阴影和小圆角，保持企业后台的紧凑与可预测性。
- 规范以桌面端为基准，同时为窄屏提供横向滚动、列收缩和抽屉化策略。

## Colors

### Brand & Semantic

- **Primary** (`{colors.primary}`): 主要按钮、链接、选中项、分页和焦点边框。
- **Success** (`{colors.success}`): 成功提示、已完成状态和可用状态。
- **Warning** (`{colors.warning}`): 风险提示、待处理和需要注意的状态。
- **Error** (`{colors.error}`): 校验错误、失败提示和破坏性操作反馈。
- **Info** (`{colors.info}`): 普通信息提示，与品牌蓝保持一致。

### Neutral

- **Text primary** (`{colors.text-primary}`): 标题、表头和主要内容。
- **Text secondary** (`{colors.text-secondary}`): 普通正文、表单标签和次要操作。
- **Text tertiary** (`{colors.text-tertiary}`): 占位符、说明和辅助信息。
- **Text disabled** (`{colors.text-disabled}`): 禁用文本与不可用图标。
- **Border** (`{colors.border}`): 输入框、表格和卡片外框。
- **Divider** (`{colors.divider}`): 分组、表头和内容之间的弱分隔线。
- **Canvas** (`{colors.canvas}`): 页面底色，避免使用纯白作为整页背景。
- **Surface** (`{colors.surface}`): 内容容器、弹窗、抽屉和表格主体。

### Usage Rules

不要使用紫蓝渐变、发光背景、网格纹理、泛化的 AI 闪烁图标或大面积彩色投影。原始规范中的 AI 视觉装饰建议与截图中的市场 W+ 组件体系不一致，已移除。悬浮态只改变组件本身的颜色或边框，不使用扩散阴影制造“发光”效果。

## Typography

### Font Family

优先使用 `PingFang SC`，Windows 使用 `Microsoft YaHei`，再回退到 `Arial, sans-serif`。这是中文企业后台的屏幕阅读优先方案；不要为标题引入装饰性衬线字体。

### Hierarchy

| Token                     | Size | Weight | Line Height | Use                    |
| ------------------------- | ---: | -----: | ----------: | ---------------------- |
| `{typography.display-lg}` | 28px |    600 |         1.4 | 页面标题               |
| `{typography.display-md}` | 20px |    600 |         1.4 | 主要分区标题           |
| `{typography.title-md}`   | 16px |    600 |         1.5 | 卡片标题、表格分组标题 |
| `{typography.body-md}`    | 14px |    400 |        1.57 | 默认正文、表单文本     |
| `{typography.label}`      | 14px |    500 |         1.5 | 按钮、字段标签、导航   |
| `{typography.body-sm}`    | 12px |    400 |         1.5 | 辅助说明、状态描述     |
| `{typography.code}`       | 12px |    400 |         1.5 | 编号、代码和结构化值   |

字体层级应优先通过大小、颜色和间距区分，不使用全大写或过重字重。表格和表单默认使用 14px，说明文字使用 12px；不要为了压缩信息而低于 12px。

## Layout

### Spacing System

- 基础单位为 4px。
- 常用间距为 4 / 8 / 12 / 16 / 24 / 32 / 40 / 48px。
- 表单控件之间默认 8px，字段组之间 16px，区块之间 24px，页面主要分区之间 40-48px。
- 控件默认高度 32px；需要强调或大尺寸操作时使用 40px，不随意拉伸普通表单控件。

### Grid & Container

- 桌面内容区使用 1200px 左右的最大宽度，居中并保留 24px 外边距。
- 表格、描述列表和筛选区优先使用 12 列或等分网格，列宽由内容和最小可读宽度共同决定。
- 组件展示页采用“标题/使用场景/类型/样式/状态/应用示例”的纵向节奏。
- 数据表格允许固定左列、固定右侧操作列和横向滚动；不要强制压缩到不可读的列宽。

### Whitespace

留白用于分组而不是装饰。浅灰页面底色与白色容器形成一级层级，容器内部使用 16-24px 内边距；相邻白色容器之间必须通过间距或分割线明确边界。

## Elevation & Depth

| Level       | Treatment             | Use                        |
| ----------- | --------------------- | -------------------------- |
| Flat        | 页面底色，无阴影      | 页面背景、普通分区         |
| Surface     | 白色背景 + 1px 分隔线 | 表格、表单、描述列表       |
| Overlay     | 白色背景 + 轻微阴影   | Popover、Tooltip、下拉面板 |
| Dark action | 深蓝背景 + 浅色边框   | 暗色背景上的 Ghost 按钮    |

阴影只用于浮层和悬浮面板，建议使用低透明度的 `0 2px 8px rgba(0, 0, 0, 0.12)`。普通卡片不使用明显阴影，不使用渐变投影。

## Shapes

### Border Radius

| Token            |  Value | Use                      |
| ---------------- | -----: | ------------------------ |
| `{rounded.xs}`   |    2px | 表格内小控件、紧凑输入框 |
| `{rounded.sm}`   |    4px | 按钮、输入框、弹窗       |
| `{rounded.lg}`   |    6px | 需要更强分组的卡片       |
| `{rounded.pill}` | 9999px | 徽标、状态标签           |
| `{rounded.full}` |    50% | 头像、回到顶部           |

整体保持近方形。不要将后台按钮、输入框或表格卡片设计成大圆角胶囊。

## Components

### Header & Navigation

`app-header` 高 64px，白色背景，左侧为蓝色圆形 W 标识与“市场”字标，右侧显示系统名称、用户信息或全局操作。顶部区域使用浅分隔线，不使用渐变导航背景。

### Buttons

按钮包括 Primary、Default、Dashed、Link、Text 和 Ghost 六类。常规按钮高度 32px，水平内边距 16px，圆角 4px。Primary 只用于当前区域的主要动作；Default 用于次要动作；Link/Text 用于低强调操作；Ghost 只在深蓝背景上使用。每类按钮必须具备 Normal、Hover、Active、Disabled 状态，Disabled 降低对比度但仍保持可读。

### Inputs & Forms

输入框支持前后缀图标、前后缀文本、标签组合、搜索、密码、金额、数字、格式化输入和组合输入。金额右对齐并显示千分位；字符计数位于输入框右下角。Focus 使用品牌蓝边框与 `{colors.focus-ring}`，Error 使用红色边框并在下方显示错误文字，Disabled 使用浅灰背景。表单标签左对齐，单行字段间距为 8px。

### Table

表格表头使用 `{colors.surface-subtle}`，默认行高 40px，边框使用 `{colors.divider}`。支持复选选择、排序、筛选、分页、行展开、固定列、操作列、批量操作和横向滚动。行悬浮使用 `{colors.surface-hover}`，选中行使用 `{colors.surface-selected}`；固定列应保留明确的分隔阴影或边线。

### Scroll

大滚动条宽 10px，小滚动条宽 6px，轨道透明。滑块默认使用 40% 透明度的 `#BFBFBF`，悬浮提升至 60%，按下提升至 80%。滚动条不抢占主要内容空间；表格横向滚动时必须提供可见的滚动提示。

### Select & TreeSelect

Select 支持单选、多选、Tags、搜索和清空；多选内容过长时折叠为计数。TreeSelect 用缩进、展开图标和连接线表达层级，保留父子选中关系。下拉面板使用白色浮层和轻阴影，选项悬浮使用浅蓝背景。

### Avatar, Badge & Tag

头像支持图标、图片和字符三类，常用尺寸为 36x36px 和 28x28px，字符头像使用蓝色或预定义的五色背景。Badge 用于数字和状态计数，保持 16px 以上的最小点击/阅读面积；Tag 用于分类和筛选，使用浅灰背景、细边框和 2px-4px 圆角。

### Empty, Result & Descriptions

Empty 必须包含插画、标题、说明和可选引导按钮；无数据与无搜索结果要使用不同文案。Result 用于成功、失败和异常结果页。Descriptions 支持水平、表格型和垂直布局，默认行高 40px，标签列使用浅灰背景，值列保持白色。

### Feedback & Overlays

Alert 用于页面内持续提示，Message 用于短暂全局反馈，Tooltip 用于解释图标或截断文本，Popover 用于相关操作和补充信息。Modal 用于需要明确确认的任务，Drawer 用于从侧边编辑或查看上下文；破坏性或不可逆操作必须使用 Modal 或 Popconfirm，按钮文案必须明确写出动作。

### Upload, Date/Time & Data Entry

Upload 支持点击、拖拽、批量导入、文件列表、进度和失败重试。DatePicker 与 TimePicker 使用统一的 32px 输入高度，日期范围必须明确起止含义。InputNumber、Slider、Switch、Checkbox、Radio 和 Cascader 共享同一套焦点、禁用和错误状态，不要为单个组件引入独立色板。

## Interaction & Feedback

1. 对超过 500ms 的异步操作显示 Loading；批量导入显示阶段、进度、成功数和失败数。
2. Hover 只在 100ms 内改变背景、边框或文字颜色；Active 状态必须可区分，不能只依赖颜色。
3. 破坏性、不可逆或影响范围较大的操作使用 Modal/Popconfirm 二次确认。
4. 错误反馈同时包含红色边框和可读的错误文案，不以颜色作为唯一提示。
5. 键盘焦点使用品牌蓝外框；下拉面板、弹窗和抽屉打开后，焦点应保持在当前任务上下文中。

## Responsive Behavior

规范以 PC 端为主：

| Name            |       Width | Key Changes                                               |
| --------------- | ----------: | --------------------------------------------------------- |
| Compact desktop | 1024-1279px | 收紧页面外边距，表格启用横向滚动，操作列保持固定          |
| Desktop         | 1280-1439px | 使用完整导航、筛选区和多列表格布局                        |
| Wide desktop    |   >= 1440px | 内容宽度封顶约 1200px，增加两侧留白                       |
| Tablet fallback |    < 1024px | 多列表单改为单列或双列，侧栏改为 Drawer，表格保留横向滚动 |

不要将桌面密集表格强行变成卡片列表，除非业务已定义移动端阅读顺序。触控设备上按钮和输入框至少保持 40px 有效触达区域；32px 高度仅用于桌面密集型控件。

## Do's and Don'ts

### Do

- 使用品牌蓝表达动作和状态，把颜色用于信息层级而不是装饰。
- 保持页面底色浅灰、内容容器白色，使用细边框建立边界。
- 为表格、输入框和弹层提供完整的 Normal、Hover、Focus、Active、Disabled、Error 状态。
- 让固定列、批量操作、筛选、分页和横向滚动在数据量上升时仍然可用。
- 为空状态、错误状态和导入失败提供明确文案和下一步动作。

### Don't

- 不使用紫蓝渐变、网格纹理、发光投影或泛化的 Sparkle 图标作为 AI 装饰。
- 不把所有操作都做成 Primary，也不在普通页面大量使用纯蓝背景。
- 不使用大圆角卡片、过重阴影或低于 12px 的正文文字。
- 不隐藏表格的关键操作、分页和横向滚动提示。
- 不只用颜色表达成功、警告、错误或选中状态。

## Iteration Guide

1. 先确认页面使用的基础 tokens：颜色、字体、间距、控件高度和圆角。
2. 按“结构布局 -> 默认态 -> 交互态 -> 异常态 -> 窄屏策略”的顺序实现单个组件。
3. 组件变体使用独立 token（例如 `button-primary-disabled`、`input-error`），不要在页面中散落新的颜色值。
4. 表格、表单和弹层完成后，用真实中文、长标题、长数字和空数据做一次可读性检查。
5. 新增组件前先复用现有组件的状态和间距，只有在交互契约不同且已有组件无法表达时才扩展。

## Revision Notes

本次修订相对原提取稿做了以下调整：

- 修复全部中文乱码，并将文档统一为可读的 Markdown + YAML token 格式。
- 将 `#1774FF`、`#52C41A`、`#FAAD14`、`#F5222D` 与中性灰色列为可复用令牌，避免在组件中重复写色值。
- 删除截图中没有证据支持的 AI 渐变、微光背景、网格纹理和 Sparkle 专属图标要求。
- 将按钮从“AI 渐变按钮”改为 Primary、Default、Dashed、Link、Text、Ghost 六种真实变体，并补齐状态。
- 将原来只覆盖 8 个组件的章节扩展为压缩包中出现的表格、输入、选择、树选择、上传、弹窗、抽屉、反馈、时间选择等业务组件。
- 增加字体、控件高度、表格行高、焦点环、错误态、无障碍对比和 PC/窄屏响应策略。

## Known Gaps

- 压缩包以静态 PNG 展示为主，未提供完整的设计 token 源文件，因此 hover/active 颜色、阴影透明度和部分断点是工程化建议值。
- 未提取具体图标库、动效时长、键盘快捷键和组件 API；实现时应优先沿用项目已有的图标和 Ant Design 组件能力。
- 视觉稿主要覆盖 PC 后台，移动端需要结合真实业务流程验证，而不是仅按比例缩放桌面布局。

# End of Specification Document v13
