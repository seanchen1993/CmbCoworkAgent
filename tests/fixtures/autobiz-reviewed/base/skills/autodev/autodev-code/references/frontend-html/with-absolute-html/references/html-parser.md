---
name: html-parser
description: 统一负责绝对定位高保真 HTML 路线的整页还原、结构定性、局部组件替换，并直接写入项目目标目录。组件来源优先走项目 architecture 中的公共组件说明，其次才是本地组件与项目已安装组件库；若当前工程缺少所需组件库，则按 `SKILL.md` 改用用户提供的兜底组件库继续生成。
---

# HTML 解析器

本文中的 `SKILL.md` 均指 code 根技能 `../../../../SKILL.md`。
本文件只能由 `../SKILL.md` 转交进入，是绝对定位高保真 HTML 主线里唯一负责“整页还原 + 局部组件替换 + 代码写入”的核心依赖。

## 1. 入口契约

| 项 | 规则 |
| --- | --- |
| 允许入口 | 仅允许由 `../SKILL.md` 转交进入 |
| `task-stem` | 上游通过 `--task-stem` 传入；本文里的 `<task-stem>`、`use-detail-1` 都是它的具体取值 |
| `hasManifest=true` | 已有 `.frontend/html-analysis/<task-stem>.md` 与 `<task-stem>.json`，后续步骤可读取脚本产物 |
| `hasManifest=false` | Stage 1 脚本失败或走降级路径，后续直接以原始 HTML 为唯一视觉源继续 |
| 口径 | `hasManifest=true` 不等于脚本更可信；脚本产物只是辅助理解材料 |
| 冲突规则 | 原始 HTML 与 manifest / handoff / checklist 冲突时，原始 HTML 优先 |

## 2. 可选参考

| 文件 | 命中场景 |
| --- | --- |
| `../references/page-archetypes.md` | 需要先锁定 detail / list-table / report 等页面原型时 |
| `../references/interaction-contracts.md` | 出现 `+N` 浮层、工具栏分组、紧凑表单、独立预览 HTML 等特殊交互时 |
| `../references/components-match-rules.md` | 需要把区域语义映射到项目组件时 |
| `../references/component-slot-map.md` | 需要快速核对组件槽位和高风险误替换时 |
| `../references/html-templates/pure-div-core.md` | 纯 div / Figma / 绝对定位 HTML 的默认参考 |
| `../references/html-templates/pure-div-converter.md` | 需要更重的坐标、边界、必填星号、原始层抑制规则时 |
| `../references/html-templates/llm-prompt-template.md` | 只在把单个局部分区交给外部模型转换时 |

## 3. 总原则

### 3.1 HTML 视觉契约

| 项 | 规则 |
| --- | --- |
| 视觉优先级 | 只要用户给了高保真 HTML，字体、字号、颜色、背景、边框、圆角、阴影、渐变、不透明度和对齐关系都以 HTML 为准 |
| token 作用 | 只补 HTML 没明确给出的交互态与默认组件细节 |
| 冲突处理 | HTML 赢，不要为了“更像 AntD / 更工程化 / 更整齐”主动改掉原稿视觉结果 |

### 3.2 输出约定

| HTML 类型 | 主输出 |
| --- | --- |
| 可直接映射的框架/组件 HTML | 目标项目页面/组件文件 + 样式文件 |
| 原生语义 HTML | 目标项目页面/组件文件 + 样式文件 |
| 纯 `div` / 绝对定位 / Figma 导出 | 分阶段分析结果 + 目标项目页面/组件文件 + 样式文件 |
| 局部片段 | 目标项目中的局部代码修改 + 缺失区域说明 |

| 补充约束 | 规则 |
| --- | --- |
| 文件写入 | 默认直接写项目目标目录，不再默认产出 `output/transfer/<task-stem>.tsx`、`output/transfer/<task-stem>.less` |
| 页面级抽取 | 页面级代码生成必须包含主线可维护性处理 |
| 同页多片段 | 先统一页面级分区，再落到一个主页面和同目录局部组件 |
| 主线边界 | 上述主线处理必须在 HTML 主线内完成，不再依赖后续 `/autodev-reviewer` 补齐 |

| write_todos 页面模块清单 | 规则 |
| --- | --- |
| 模块级前置检查 | 在开始写入前，先按模块列出可见清单，确认每个页面 / 模块都被纳入实现范围 |
| 页面模块拆解 | 清单必须至少包含主页面入口、各分区模块、局部组件、复用函数 / 常量 / type / hook、样式文件 |
| 漏项防护 | 每个清单项都要和原始 HTML / manifest / 现有源码证据交叉核对，避免只还原视觉却遗漏模块 |
| 同页多段 HTML | 对多片段输入，先把片段合并成页面级模块清单，再开始落文件 |
| 交付要求 | 最终交付中必须能看出哪些模块已生成、哪些模块只保留为页面壳层、哪些模块仍需要后续补齐 |
| 脚本阶段清单 | `prepare_html_analysis.py` 的参数确认、执行、产物检查、失败降级必须单独列出，不得并入页面模块清单 |

## 4. 读取输入

| 输入源 | 读取策略 |
| --- | --- |
| 用户提供的 HTML | 必读 |
| Source Bundle 列出的 specs / design / PLAN 等正式流程产物 | 按各自 Method Bundle 读取；未列入契约的上游产物不作为正式输入 |
| 当前目标文件 | 增量修改时读取 |
| 项目 `architecture/` 文档 | 与结构、技术栈、API、组件相关时读取 |
| 项目组件源码 | 只有需要证据时再读 |
| HTML URL | 如果拿不到实际内容，则停止并要求用户补 HTML |

### 4.1 Assets 资源处理

执行 `../../references/assets-processing-guide.md` 中定义的完整流程：

1. 检查并扫描 assets 目录
2. 提取 HTML 中所有 assets 引用（仅处理被引用的文件）
3. 对每个被引用的 asset 执行四级优先级判定
4. 创建 assets 使用映射表并写入 `.frontend/html-analysis/<task-stem>-assets-mapping.json`
5. 复制必要的 assets 到项目目录
6. 输出 assets 处理总结

**映射表位置：** `.frontend/html-analysis/<task-stem>-assets-mapping.json`

Assets 处理总结将作为后续"编码前简报"的输入材料。映射表中包含每个 asset 的处理决策、替代方案和理由。

### 4.2 脚本 / manifest 口径

### 4.2 脚本 / manifest 口径

| 项 | 规则 |
| --- | --- |
| 脚本角色 | 进入本路线后默认先执行脚本 |
| 脚本定位 | 分析加速器，不是最终视觉判官 |
| 主要作用 | 内容盘点、分区辅助、多片段聚合、组件候选与 replacement slots 识别 |
| 产物用途 | handoff / checklist / json 负责：盘点内容、标记候选区域、暴露图标 / 图表 / 交互 / 组件信号 |
| 使用边界 | manifest 的作用是”盘点和识别”，不是”替代原始 HTML 做最终视觉判断” |
| 错判处理 | 如果 manifest 对页面语义、左右栏边界、图标 / 图表、组件槽位的判断明显不对，就把它降级为辅助点查材料 |
| 保守模式 | 如果 `summary.componentizationMode.mode=conservative`，则脚本产物只能用于 whole-section 保留、缺项检查和局部候选提示，不能驱动大块结构重写 |

## 5. 技术栈确认

| 步骤 | 规则 |
| --- | --- |
| 1 | 优先读取项目 `architecture/` 中的技术栈说明 |
| 2 | 若契约或项目上下文中已有技术栈扫描结果，可作为辅助材料读取 |
| 3 | 若仍无结果，再扫描真实项目 |
| 扫描命令 | `rg '"(react|vue|antd|antd-mobile|element-plus|@ant-design/pro-components|@ant-design/icons|ahooks|@tanstack/react-query)"' package.json` / `rg --files -g "*.tsx" -g "*.jsx" -g "*.vue" src` |
| React 输出 | `.tsx` / `.jsx` + 项目实际样式方案 |
| Vue 输出 | `.vue` + 项目实际样式方案 |
| 兜底 | 未知时桌面端按 React + `antd`，移动端按 React + `antd-mobile`，但不要只输出预览 HTML |

## 6. 分类 HTML

| 类型 | 识别信号 | 默认处理 |
| --- | --- | --- |
| 框架/组件 HTML | AntD / Element / 组件式标签明显 | 保留结构并映射到项目组件 |
| utility class 高保真 HTML | `w-[...]`、`h-[...]`、`flex`、`gap-*`、`rounded` 等明显 | 先恢复样式，再做组件识别 |
| 原生语义 HTML | 有 `form`、`table`、`button`、`input`、`section` 等 | 直接转换为框架组件 |
| 纯 div | `div` / `span` 为主、内联样式多 | 结合纯 div 规则处理 |
| Figma / 绝对定位导出 | `position:absolute` 占比高、坐标密集、类名生成感强 | 先走分阶段恢复，再生成代码 |
| 局部片段 | 壳层不完整或只是一段组件片段 | 只转换当前区域 |

| 高保真补充规则 | 说明 |
| --- | --- |
| 用户明说高保真 | 即使脚本分类结果是 `html`，也仍按高保真处理 |
| 坐标 / clip-path / data-svg / 漏斗 / 像素拼装信号 | 直接按高保真处理 |
| 脚本产物只做辅助 | `.json` / `.md` 不得反过来覆盖原始 HTML 的视觉事实 |
| 低置信度信号 | 区域太少、图表偏少、文本异常合并时，要提升原始 HTML 权重并收紧组件替换范围 |

## 7. 检测信号

### 7.1 图标信号

| 信号类别 | 具体信号 |
| --- | --- |
| SVG / 向量 | `svg` / `path` / `use` / `symbol` |
| 图片类图标 | `img`、雪碧图、背景图里的小图标 |
| 类名类图标 | `i` 标签、`icon-*`、`iconfont`、`anticon`、`el-icon` |
| 交互类图标 | 纯图标按钮、表格操作图标、输入框前后缀图标、状态图标 |
| 语义类图标 | PRD / 文案中只有语义、没有具体图形的操作词 |

| 图标处理规则 | 说明 |
| --- | --- |
| 来源顺序 | 遵循 `SKILL.md` §图标来源顺序 |
| Stage 1 记录 | handoff 中记录关键图标映射，供 Stage 2 和最终代码生成使用 |
| 优先动作 | 先在项目图标体系或已安装图标库里找外观最接近的真实组件图标 |
| 允许保留原始 `svg` | 只有“真实 svg 资产”才允许作为 fallback |
| 禁止保留原始 `svg` | 占位几何、装饰 path、背景碎片等不能直接当最终 icon |
| 特殊判断 | `sparkline`、迷你趋势线、迷你面积图即使尺寸小，也按图表处理 |
| 交付要求 | 汇报里说明图标来源层级与关键图标映射 |

### 7.2 图表信号

| 信号类别 | 具体信号 |
| --- | --- |
| 直接图表信号 | `canvas`、图表 `svg`、坐标轴、图例、tooltip、series、数据标签、趋势线 |
| 图形结构信号 | 柱状图、条形图、折线图、面积图、饼图、环图、雷达图、漏斗图、散点图、仪表盘 |
| 页面结构信号 | 统计卡片 + 趋势区、时间维度切换、图表筛选器、图表 Tab |
| 容器命名信号 | `chart`、`graph`、`trend`、`analysis`、`echarts`、`g2`、`plot` |
| 语义信号 | PRD / 文案中只有语义、没有具体图形的分析类模块 |

| 图表处理规则 | 说明 |
| --- | --- |
| 同区域多种信号 | 先按图表信号计分，`linearGradient` 只作为辅助线索 |
| 小区域多图表 | 同一小区域内如果存在多个图表或多种图表组合，不能为了简化而只保留一个；要逐个保住其容器、语义和相对位置 |
| 折线 / 面积 / 柱条 / 饼 / 漏斗 | 识别为图表语义，不要提前降级成装饰背景或进度条 |
| 线性图表数量 | 折线图、面积图、sparkline、迷你趋势图等线性图表必须按原稿真实趋势线 / series 数量实现，不能少线、并线、偷换成单线，也不要把多线图误还原成单指标装饰趋势 |
| 多趋势对比图 | 多个趋势的对比图表必须把每条趋势都实现出来，并保留图例、颜色和相对比较关系，不能偷换成单趋势图 |
| 仅有语义无图形 | 仍按图表语义记录，由后续阶段按 `SKILL.md` §图表来源顺序 落地 |
| 交付要求 | handoff 中至少记录信号命中和图表类型映射 |

### 7.3 页面原型

| archetype | 典型页面 | 强制约束 |
| --- | --- | --- |
| `funnel-metric-dashboard` | 使用情况 | 漏斗区整体保真；KPI + sparkline 同卡关系不可拆坏 |
| `comparison-grid-with-inline-trends` | 价值情况 | 以比较矩阵为主；每列指标与其行内趋势绑定；禁止误聚成单一大图 |
| `list-table-with-kpis` | 报错统计 | 顶部 KPI + 筛选区 + 表格区 + 分页区必须完整存在 |
| `workflow-detail-with-compare-panels` | 任务详情 | 壳层、提醒条、左右对比、处理区、时间线、上传区先保真，再替换叶子控件 |

原型与组件替换冲突时，**原型优先，组件替换降级**。

## 8. 组件化策略

### 8.1 组件来源选择

| 项 | 规则 |
| --- | --- |
| 总顺序 | 遵循 `SKILL.md` §组件来源优先级（图标 / 图表同表） |
| 替换粒度 | 一次只对一个区域做组件替换，逐区评估 |
| 文档层命中 | 先按项目文档理解用途 / props / 示例，再用真实源码确认导入路径 |
| 基础组件层 | 项目自身组件体系（前 3 层）无法覆盖时才进入已安装组件库层 |
| 新依赖 | 固定 Code Workflow 不安装新依赖也不请求用户确认；复用已有组件或原生实现，并记录非阻断降级 |
| 汇报要求 | 记录复用或降级方案；新增依赖必须为“不涉及” |
| 图表场景 | 统一按 `SKILL.md` §图表来源顺序 |

### 8.2 低风险标准结构组件化口径

| 项 | 规则 |
| --- | --- |
| 总原则 | 对低风险、标准结构、视觉契约清楚的区域，不要因为缺少很强的项目私有组件证据就停在 fidelity-only |
| 基础组件层启用条件 | 项目前 3 层没有可用组件证据，但当前工程已安装并真实使用 `antd` / `antd-mobile`，且区域属于标准结构 |
| 默认可积极组件化的区域 | 按钮、输入框、文本域、下拉选择、单选、多选、开关、搜索/筛选表单、表格、分页、标签页、时间线、上传区、弹窗、抽屉 |
| 回退条件 | 只有当组件化会直接破坏主布局、区域边界、行内原子内容、关键视觉层次或明显交互时，才回退到 fidelity-only |
| 复杂页例外 | 对图表多、表格多、时间线/上传/分页并存、左右对比强的高保真页面，上述积极组件化默认降级为“先保布局，后成熟结构组件化 + 叶子组件化”，而不是长期停在 fidelity-only |

### 8.3 Stage 2 门槛

| 门槛 | 规则 |
| --- | --- |
| 组件候选 | 必须能明确候选组件 |
| 关键属性 | 能反推出关键 `props / mode / layout` |
| 样式补丁 | 明确需要补哪些样式才能贴近原稿 |
| 细节收尾 | 组件接管后必须继续补齐 padding、边框、圆角、阴影、字色、字号、字重、行高、内外边距、对齐、状态色和文本内容等明显细节，保证一比一还原 |
| 回退方案 | 若不适合组件化，要有失败回退 |
| 来源证据 | 默认要求“来源证据 + 关键 props + 样式补丁 + 回退方案”同时具备 |
| 低风险放宽 | 对低风险标准结构，来源证据可放宽为：项目自身组件 / 相似页面 / 已安装并真实使用的 `antd` / `antd-mobile` / HTML 语义和视觉契约足以稳定映射到基础组件 |

### 8.4 执行层补充规则

| 结构类型 | 默认组件倾向 |
| --- | --- |
| 表单控件 | `Form`、`Form.Item`、`Input`、`Input.TextArea`、`Select`、`Radio.Group`、`Checkbox.Group`、`Switch` |
| 列表与表格 | `Table` / 项目表格封装 + `Pagination` |
| 常规动作区 | `Button`、`Space` |
| 切换结构 | `Tabs` |
| 轨迹结构 | `Timeline` |
| 上传结构 | `Upload` |
| 浮层壳体 | `Modal`、`Drawer` |

| 执行规则 | 说明 |
| --- | --- |
| 脚本 slot 决策 | 只有在 `componentizationMode.mode != conservative` 且 `analysisConfidence.level = high` 时，才把低风险标准结构 slot 视为“积极组件化候选” |
| 保守模式下的 slot 口径 | 若 `componentizationMode.mode = conservative`，则 `table/chart/section/form/filter/tabs/page-pattern` 这类 slot 在宏观布局稳定前只作为提醒，不得直接驱动大块组件化 |
| 保守模式下的二次回看 | 一旦宏观布局、分区边界和区块顺序已稳定，必须回看 `Tabs`、`Timeline`、`Table`、`Pagination`、`Upload`、`Modal`、`Drawer` 等成熟结构，优先把它们落成真实组件 |
| 禁止随意回退 | 在普通页面里不要随意整块回退；但在保守模式里，允许优先保留 fidelity block，再只替换叶子控件 |
| 唯一允许推翻条件 | 只有当你能明确证明该组件化会破坏主布局、区域边界、原子内容或关键视觉层次时，才允许推翻脚本的积极决策 |

### 8.5 高风险组件禁错表

| 组件 / 场景 | 允许使用条件 | 禁止事项 |
| --- | --- | --- |
| `Badge` / `Tag` | 整块本身就是带背景、边框、圆角的标签块时才允许 `Tag` | 彩色小圆点 + 状态文本时不要直接替换成 `Tag` |
| `Descriptions` | `layout`、`column`、`bordered`、冒号、间距都能贴近原稿时 | 上下布局且无边框的详情块不要直接套默认 `Descriptions` |
| `Progress` | 条状进度优先 `type="line"`；只有明确圆形或仪表盘几何时才允许 `circle` / `dashboard` | 不要把线性进度误做成圆形进度 |
| 漏斗图 | 必须保留层级顺序、宽度差、标签/数值关系和分层间距 | 不要降级成普通纵向卡片堆叠 |
| `Tabs` / `Timeline` / `Upload` | 宏观布局稳定后，若边界、交互角色、朝向、节点结构与原稿一致，应优先使用真实组件，并补齐对应样式 | 若组件默认外观会改坏壳层布局、节点节奏、边框背景或左右关系，就不要直接套默认外观；必须继续补样式或调整 props |
| 表格边框与列宽 | 表格若原稿是有边框表格，就不要还原成无边框；若原稿是无边框，就不要强加边框。列宽既不要平均瞎分，也不要全部写死；应尽量保留原稿的列宽占比与阅读节奏 |
| 行内原子内容 | 必要时用 `inline-flex`、`white-space: nowrap`、基线对齐等方式保行 | 不要把数字 + 单位、金额 + 币种、数值 + `%` 等同一视觉行拆成两行 |
| 大布局容器 | 优先用 `flex` / `grid` / 百分比 / `minmax` 等活动布局 | 不要整页和大模块层层写死 `width` / `height` |
| 明显交互 | 至少补齐基础可用行为，即使没有真实接口 | 不要只画静态外观而不补状态切换 |
| `cursor:pointer` | 只要原稿明确出现 `cursor:pointer` 或等价点击 affordance，就把它视为交互契约；不能只保留手型样式，必须落成真实可触发的操作、切换、展开/收起、跳转或占位 handler |

## 9. Stage 1 / Stage 2

| 阶段 | 目标 | 主要动作 | 输出 |
| --- | --- | --- | --- |
| Stage 1 | 先恢复整页视觉与结构 | 定住主壳层、主分栏、分区顺序、内容完整性；原始 HTML 是主依据 | 稳定页面骨架 |
| Stage 2 | 再替换已证明安全的组件槽位 | 逐槽位组件化，优先处理 `Tabs`、`Timeline`、`Table`、`Pagination`、`Upload` 等成熟结构，并为高风险槽位补齐 props、样式与细节收尾；**读取并应用 assets 映射表** | 最终项目代码 |

| Stage 共通规则 | 说明 |
| --- | --- |
| Stage 1 先行 | 如果 Stage 1 结果与原稿还有明显结构偏差，禁止继续做 Stage 2 组件化 |
| 同页多片段 | 先统一页面壳层、分区边界和共享数据语义，再决定哪些区域拆成局部组件 |
| 主线抽取 | 在主线里完成局部组件、函数、常量、helper / type / hook / 图表配置抽取 |
| Assets 映射表应用 | Stage 2 开始前必须读取 `.frontend/html-analysis/<task-stem>-assets-mapping.json`，严格按照映射表中的决策处理每个图标和图片：`useAntdIcon` → 使用 Ant Design 图标组件；`useCss` → 使用 CSS 实现；`copyToProject` → 使用已复制到项目的文件并正确 import |
| Stage 2 收尾 | Stage 2 结束前必须再做一轮样式细节收尾，不得把明显的 padding、边框、圆角、阴影、字色、字号、文本内容、间距、对齐问题留到后续 `/autodev-reviewer` |
| 最终交付 | 直接写入项目目标目录 |
| write_todos 贯穿 | Stage 1 先列页面级模块清单，并单独列脚本清单；Stage 2 再按清单逐项完成模块落盘，防止实现遗漏 |

### 9.1 同页多段 HTML 拆分策略

| 步骤 | 规则 |
| --- | --- |
| 1 | 先确定唯一的主页面入口文件 |
| 2 | 先合并成页面级分区草图，例如筛选区、统计区、图表区、表格区、弹窗区、详情区 |
| 3 | 先写出 `write_todos` 可见清单（页面模块清单 + 脚本清单），按页面模块逐项列出入口、分区、局部组件、复用逻辑和样式文件 |
| 4 | 主页面保留页面壳层、路由入口、状态编排、数据获取和分区装配 |
| 5 | 清晰分区拆成同目录局部组件，而不是拆成多个伪页面目录 |
| 6 | 同页复用的函数、常量、状态映射、列定义、图表配置、局部 helper / type 就近抽取 |

### 9.1.1 Assets 映射表应用规则

**执行时机：** Stage 2 代码生成阶段开始前，必须先读取并理解 assets 映射表。

**映射表位置：** `.frontend/html-analysis/<task-stem>-assets-mapping.json`

**应用规则：**

| 决策类型 | 处理方式 | 代码示例 |
| --- | --- | --- |
| `useAntdIcon` | 使用映射表中的 `replacement` 字段，引入对应的 Ant Design 图标组件 | `import { RightOutlined } from '@ant-design/icons';`<br/>`<RightOutlined className="text-[#5C69FF]" />` |
| `useCss` | 使用映射表中的 `replacement` 字段，用 CSS 实现 | `<div className="w-full h-px bg-gray-300" />` |
| `copyToProject` | 使用映射表中的 `importStatement` 字段，正确引入已复制到项目的文件 | `import AIIcon from '@/assets/icons/AI.svg';`<br/>`<img src={AIIcon} alt="AI" className="w-6 h-6" />` |

**强制约束：**

1. **必须读取映射表**：Stage 2 开始前，必须读取映射表并理解每个 asset 的处理决策
2. **严格遵循决策**：不得擅自改变映射表中的决策（例如把 `useAntdIcon` 改成直接使用原始 SVG 文件）
3. **验证文件存在**：对于 `copyToProject` 类型，生成代码前应验证映射表中的 `targetPath` 文件确实存在
4. **保持颜色和尺寸**：使用 Ant Design 图标替代时，必须通过 `className` 或 `style` 保持原稿的颜色和尺寸
5. **完整覆盖**：映射表中的每个 asset 都必须在最终代码中被正确处理，不得遗漏

**检查清单：**

- [ ] 已读取 `.frontend/html-analysis/<task-stem>-assets-mapping.json`
- [ ] 映射表中标记为 `copyToProject` 的文件都已存在于项目目录
- [ ] 代码中所有图标和图片引用都来自映射表的决策
- [ ] Ant Design 图标的颜色和尺寸与原稿一致
- [ ] CSS 实现的几何图形与原稿视觉一致
- [ ] 项目 assets 的 import 路径与映射表中的 `importStatement` 一致

### 9.2 低置信度执行模式

| 触发条件 | 规则 |
| --- | --- |
| `analysisConfidence.level != high` | 进入低置信度模式 |
| 区域过少 | 原稿明显有多个大块，但只识别出极少区域 |
| 缺失明显区块 | 图表 / 分页 / 时间线 / 上传等明显区域没有被识别出来 |
| 文本异常 | 文本区域出现大面积异常合并 |
| `componentizationMode.mode = conservative` | 即使脚本可用，也默认按复杂页保守模式执行 |

| 低置信度模式动作 | 规则 |
| --- | --- |
| 主依据 | 原始 HTML 是主依据，manifest 只做辅助点查 |
| 组件化范围 | 禁止大块组件化，只允许叶子控件替换或已经稳定的小槽位替换 |
| 成熟结构例外 | 当 `Tabs`、`Timeline`、`Table`、`Pagination`、`Upload` 等结构的边界、朝向、节点与交互角色已经稳定时，仍应优先落成真实组件 |
| 顺序 | 先补整页分区和宏观布局，再考虑 Stage 2 |
| 回退 | 某块无法证明组件替换安全时，直接保留 fidelity structure |
| 表格/图表 | 先保住区块边界、表头/列关系、图表与筛选/图例/说明文字的相对位置；不要让脚本 slot 直接决定最终组件实现 |

## 10. Happy Path 示例

下面保留一个紧凑示例，只用于对齐流程，不再承担通用规则说明。

### 10.1 输入

```html
<div class="w-[780px] h-[160px] p-4 bg-white rounded border border-gray-300 flex flex-col gap-4">
  <div class="text-base text-gray-800">活跃用户指标</div>
  <div class="w-[748px] h-[88px] flex gap-4">
    <div class="w-[228px] h-[88px] ...">
      <span>日均DAU</span>
      <span class="text-[28px] font-bold text-gray-800 opacity-80">2,256</span>
      <span>人</span>
      <span class="text-xs text-gray-400">较同期</span>
      <svg ...></svg>
      <span class="text-xs text-green-500">1.56%</span>
      <svg ...></svg>
    </div>
  </div>
</div>
```

### 10.2 流程示例

| 阶段 | 结果示例 |
| --- | --- |
| Stage 0 | HTML 类型：utility class / Tailwind 高保真；视觉契约锁定：4px 圆角、28px KPI 字号、趋势色保留 |
| Stage 1 | Panel / MetricCard / Tooltip / TrendDelta / Sparkline 槽位被识别出来 |
| Stage 2 | `Card`、`Tooltip`、图标、图表等在不破坏视觉契约的前提下落成真实组件 |
| Stage 3 | 按 §11 的通用校验与汇报模板执行 |

## 11. 项目说明、写入、校验、汇报

### 11.1 项目说明优先级

| 项 | 规则 |
| --- | --- |
| 优先级 | 遵循 `SKILL.md` §项目说明优先级 |
| 默认读取 | 应用结构、API、技术栈、路由/菜单/权限、状态管理、样式体系都先看项目 `architecture/` |
| 缺失时 | 回退到源码扫描 |

### 11.2 写入文件

| 项 | 规则 |
| --- | --- |
| 写入位置 | 默认直接写项目文件 |
| 命名与样式 | 必须跟随项目真实命名与样式约定 |

### 11.3 通用校验清单

| 检查项 | 要求 |
| --- | --- |
| import | 路径可解析 |
| 样式 | style class 存在 |
| 模板残留 | 没有残留模板内容 |
| JSX 注释 | JSX 中没有 HTML 注释 |
| 分区数量 | 与原稿一致或可解释 |
| 字段/按钮 | 必填字段和按钮文案没有丢失 |
| 图标 | 图标导入与引用可解析；纯图标按钮补 `Tooltip` 和 `aria-label`；**所有图标处理都严格遵循 assets 映射表的决策** |
| Assets 映射表应用 | 已读取映射表；映射表中的每个 asset 都在代码中被正确处理；`useAntdIcon` 使用了图标组件；`useCss` 使用了 CSS 实现；`copyToProject` 使用了正确的 import 语句 |
| 图表 | 图表容器、数据结构、类型映射自洽；不退回假图表；sparkline 也是真图表；线性图表的趋势线 / series 数量与高保真一致 |
| 多图表完整度 | 同一局部区域内的多图表 / 复合图表都已保留，没有漏掉小图表、辅助图、对比图或其中某条趋势 |
| 高风险组件 | 没有发生模式误判，例如 dot status -> Tag、line progress -> circle progress、vertical plain detail -> default Descriptions |
| 关键组件 | `props / mode / layout` 与源稿视觉一致 |
| 组件化说明 | 能说明替换了哪个源区块、为何适合该组件、补了哪些 props 和样式 |
| 样式细节 | padding、边框、圆角、阴影、字色、字号、字重、行高、内外边距、对齐、状态色、文本内容等用户一眼可见的细节已补齐 |
| 成熟结构组件化 | `Tabs`、`Timeline`、`Table`、`Pagination`、`Upload`、`Modal`、`Drawer` 等标准成熟结构已优先落成真实组件；若未落成，已能明确说明原因 |
| 表格还原 | 表格边框形态、列宽占比、列头节奏和内容密度与原稿一致或可解释 |
| 交互契约 | `cursor:pointer`、展开/收起、Tab 切换、分页切换、上传入口、操作按钮等显性交互都已落成真实可触发行为，而不只是视觉占位 |
| 原子内容 | 数字 + 单位、金额 + 币种、数值 + `%` 等没有被误拆成两行 |
| 大布局 | 没有无意义地层层写死宽高；父子尺寸关系主要通过继承、flex、grid、百分比表达 |
| 组件证据 | 复用组件都有真实项目证据；若用了项目文档中的组件，也确认过源码和导出方式 |
| 同页多段 HTML | 已统一成一个页面级实现，并完成主线抽取 |

### 11.4 汇报格式

```text
【HTML 转换结果】
HTML 类型：<type>
来源：<file/url>
页面名称：<page name>
页面位置：<main page file path>
写入文件：<paths>
组件来源：publicComponents / shared-components / local components / installed library / user fallback library / fidelity-only
图标来源：project icon rules / local icons / installed icon library / React + AntD fallback
图表来源：project chart rules / local charts / installed chart library / user-specified chart library / default ECharts solution
图表类型映射：<区域 / 语义 -> 最终图表类型>
是否触发 ECharts：是 / 否
新增依赖：不涉及（固定 Code Workflow 禁止新增依赖与用户确认）
统一前端回检输入：target=<生成/修改的源码文件或目录>; sourceHtml=<原始 HTML 路径>; analysis=<.frontend/html-analysis/*.json 或 none>; plan=<PLAN.md 或 none>; uiLibraryTarget=<project|antd|antd-mobile|native>; antdMode=<required|selected|notApplicable>; auditRequired=<true|false>
验证：通过 / 待修正
```

### 11.5 汇报后的强制动作

| 动作 | 规则 |
| --- | --- |
| 1 | 输出完 `【HTML 转换结果】` 后，返回 `/autodev-code` 主流程执行项目级验证、统一前端回检，并按 code 节点收尾规则推进到 `code_done` |
| 2 | 不发起额外回检选择，不询问是否进入独立回检流程 |
| 3 | 禁止引用已移除的内部回检路线或其参考文件 |
