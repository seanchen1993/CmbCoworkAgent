# 组件槽位映射

本文中提到的 `SKILL.md` 均指 code 根技能 `../../../../SKILL.md`。

当高保真 HTML 需要转成项目代码并使用常见 UI 组件时，读取这份参考。

替换顺序遵循 `SKILL.md` §组件来源优先级。补充约束：如果项目已经有组件库，就不要再额外引入新的 UI 库。

## 三个门槛

每个组件槽位在替换前都要同时满足：

| 门槛 | 通过条件 |
| --- | --- |
| 内容 | 源文本、值、状态、占位符、禁用态、计数、分页都还在 |
| 布局 | 仍在原 section / bbox 内，不改主布局、不改左右关系、不改 rail/timeline 位置 |
| 属性 | 能反推出关键 props / mode / layout，不靠组件默认值碰运气 |
| 证据 | 项目组件、import、相似页面，或者组件语义很明确 |

如果任何门槛不过，就拆小槽位或者保留原始结构。

低风险放宽规则：

- 对按钮、输入框、选择器、单选、多选、开关、表格、分页、Tabs、Timeline、Upload、Modal、Drawer 这类标准成熟结构，若当前工程已安装并真实使用 `antd` / `antd-mobile`，且布局与内容门槛已通过，则“证据”不必要求更强的项目私有组件命中。
- 这类区域允许先落到标准基础组件，再通过 props 和样式补丁贴回原稿。

## 还原优先

- 组件替换后如果按钮文字换行、label-value 节奏变化、边框背景变化或整体观感偏离原稿，必须继续做样式修正
- 组件替换后的样式细节收尾是主线必做项，不要把背景色、边框、圆角、阴影、字号、字重、行高、间距、对齐和状态色等明显差异留到后续 `/autodev-reviewer`
- 数字 + 单位、金额 + 币种、数值 + `%`、主值 + 短尾缀如果在原稿同一行，组件化后也必须保持同一行
- 如果修正成本很高且仍难接近原稿，直接回退成高保真结构，不要强行组件化
- 但对低风险标准结构，不要因为“不是项目私有组件”就直接放弃组件化；能稳定映射到 AntD / Element 基础组件时，应先组件化再补样式
- 对 `Tabs`、`Timeline`、`Table`、`Pagination`、`Upload`、`Modal`、`Drawer` 这类成熟结构，宏观布局稳定后应优先落成真实组件，不要长期保留成手写 div 模拟结构
- card 类型、带边框卡片感、分段胶囊感的 tabs 组合，只要本质仍是“切换不同内容面板”，也优先按 `Tabs` 识别，不要误判成普通卡片列表或独立标签块
- 页面整体可以是录入页，但某个局部如果更像 `Descriptions` / `label + 内容`，就不要只因为全局语境而替换成输入控件
- 无法安全使用组件库但存在重复内容或重复布局时，优先抽成局部函数、局部渲染器或遍历生成
- 表格、列表、详情块在组件化后，字段/列/操作/状态不能少于源稿表达；如果覆盖不全，不能标记为组件化完成
- 表格组件化后必须额外回查：原稿是否有边框、列宽占比是否明显不均、列头与列值是否有密度差；这些都要尽量贴回原稿
- 同一小区域内如果存在多个图表或复合图表，不要只保留一个主图表；每个图表和每条趋势都要保住
- 只要原稿出现 `cursor:pointer` 或等价点击 affordance，就不能只保留视觉样式；必须落成真实交互或显式的占位 handler
- 如果组件默认值会改变方向、边框、状态形态、信息位置或几何外观，必须显式配置 props 和额外样式
- 大页面和大模块优先使用 flex / grid / 百分比 / 拉伸布局，不要把每一层子节点都写死宽高

## 常见槽位

| 源信号 | 语义 | React / antd | Vue / element |
| --- | --- | --- | --- |
| 普通按钮 | Button | Button | ElButton |
| 图标按钮 | IconButton | Button + icon | ElButton + icon |
| 输入框 | Input | Input | ElInput |
| 长文本 | TextArea | Input.TextArea | ElInput textarea |
| 下拉选择 | Select | Select | ElSelect |
| 级联选择 | Cascader | Cascader | ElCascader |
| 日期 / 时间 | Date / Time | DatePicker / TimePicker / RangePicker | ElDatePicker / ElTimePicker |
| 单选 | Radio | Radio.Group | ElRadioGroup |
| 多选 | Checkbox | Checkbox.Group | ElCheckboxGroup |
| 开关 | Switch | Switch | ElSwitch |
| 上传 | Upload | Upload | ElUpload |
| 搜索 / 筛选区 | Form | Form / Space | ElForm |
| 表格 | Table | Table / ProTable | ElTable |
| 分页 | Pagination | Pagination | ElPagination |
| 标签页 | Tabs | Tabs | ElTabs |
| 标签 / 状态 | Tag / Badge | Tag / Badge | ElTag / ElBadge |
| 提示 | Alert | Alert | ElAlert |
| 时间线 | Timeline | Timeline | ElTimeline |
| 抽屉 | Drawer | Drawer | ElDrawer |
| 弹窗 | Modal | Modal | ElDialog |

## 高风险替换

- `Descriptions` 只适合说明表语义
- `Card` 只适合真的有卡片边界
- `Table` 只适合稳定表头和重复行
- `Tabs` 只适合切换内容面板
- `Timeline` 只适合明确的纵向节点流、时间轴或处理轨迹
- `Upload` 只适合明确的上传入口、文件列表或附件状态区
- `Input` / `Form` 只适合存在明确控件证据的区域，不适合拿来覆盖说明型字段展示
- 自定义表格组件只有在字段、列、操作和分页覆盖不丢失时才允许替换原表格结构

额外禁错：

- 彩色小圆点 + 状态文本，若没有完整 pill 背景和边框，不要直接替换成 `Tag`
- 上下布局且无边框的说明块，若 `Descriptions` 的 `layout` / `column` / `bordered` 无法贴近原稿，不要强行用 `Descriptions`
- 条状百分比进度，不要替换成 `Progress` 的 circle / dashboard 模式
- 同一视觉行中的数字 + 单位、金额 + 币种、数值 + `%`，不要因为块级节点或默认排版被拆成两行
- 父元素已经给出宽高时，子元素不要重复写死同一套尺寸；优先继承父级尺寸或使用 `flex: 1` / `width: 100%` / `height: 100%`

## raw layer

组件接管某个槽位后，只隐藏同一区域里的 raw 节点，不要顺手删别的 section。



