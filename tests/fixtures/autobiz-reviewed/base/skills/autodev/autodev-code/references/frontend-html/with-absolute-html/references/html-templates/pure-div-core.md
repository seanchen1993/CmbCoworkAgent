# 纯 div 核心规则

本文中提到的 `SKILL.md` 均指 code 根技能 `../../../../../SKILL.md`。

当处理纯 div 或绝对定位 HTML 时，把这份文件作为默认的小模型参考。

只有当这份核心文件不足以解决当前失败模式时，才继续读取更重的 `pure-div-converter.md`。

## 核心目标

把纯 div 或 Figma 风格 HTML 转成与项目技术栈匹配的框架代码，同时保留布局，并避免自由发挥。

## 默认流程

1. 运行 `prepare_html_analysis.py`（必填参数 `--project-root` / `--task-stem` / `--html-file`，完整命令以 `SKILL.md §4` 为准）：
   - `autodev-code` 技能根目录：
     ```
     python -X utf8 references/frontend-html/with-absolute-html/scripts/prepare_html_analysis.py \
       --project-root . \
       --task-stem <task-stem> \
       --html-file <HTML_PATH>
     ```
   - `references/frontend-html/with-absolute-html/` 目录：
     ```
     python -X utf8 scripts/prepare_html_analysis.py \
       --project-root <CODE_WORKSPACE> \
       --task-stem <task-stem> \
       --html-file <HTML_PATH>
     ```
   - 脚本阶段要单独写成 `write_todos`，不要并入页面模块清单。
2. 先读 `.frontend/html-analysis/<task-stem>-checklist.md`，再按需读 `.frontend/html-analysis/<task-stem>.md`。
3. 以原始 HTML 加紧凑 handoff 作为视觉契约。
4. 产出组件槽位计划：
   - 用户组件
   - 项目组件
   - 相似页面模式
   - UI 库原语
   - fidelity-only
5. 一次只转换一个区域。
6. 优先输出框架代码。

只有在以下情况才生成调试 HTML 或参考 HTML：

- 用户明确要求独立视觉回放 HTML
- 本地视觉调试确实需要它

## 不可妥协项

- 当 manifest 已存在时，不要把整份原始 HTML 直接传给弱模型。
- 不要发明 section、字段、按钮或辅助区块。
- 不要超出 HTML 或 PRD 明确给出的范围去改字段名。
- 不要把整页重建成 Card/Grid/Tabs，除非用户明确要求组件优先重构。
- 不要把 AntD / Element 组件默认 props 当成视觉事实。
- 不要把原稿同一行的数字、单位、百分号、币种或短尾缀误拆成两行。
- 不要把 `cursor:pointer` 只还原成手型样式而不补真实交互。
- 不要漏掉同一小区域中的多个图表或多条趋势线。
- 不要在大页面和大模块里层层写死 `width` / `height`。
- 父容器已经是 `flex` 且子项明显等分时，不要在每个子项上继续写死宽度。
- 明显上下排列的区域，不要误写成默认横向 `flex`；需要 `flex` 时显式写 `flex-direction: column`。
- 对非组件区域，保持视觉忠实。
- 对组件接管区域，抑制其中的原始层内容。

## 组件优先级

来源顺序遵循 `SKILL.md` §组件来源优先级。补充约束：只有当组件类型、关键 props / mode / layout 和补充样式都能从 HTML 反推出来时，才允许进入第 4 层（已安装 UI 库）。

布局约束（参见 `SKILL.md` §高保真 HTML 全局约束）：

- 父级已定义尺寸时子级优先继承 / 拉伸 / 比例，不重复写死整套宽高
- 大容器优先 `flex` / `grid` / 百分比 / `minmax`；固定尺寸只留给局部稳定视觉盒子
- 源 HTML 已有的 `display` / `flex-direction` / `justify-content` / `align-items` / `gap` / `overflow` 必须保留
- 等分布局优先抽象成 `flex: 1` 或 grid 等分轨道，而不是保留一排重复的固定宽度
- 明显纵向堆叠的结构优先保留块流或 `flex-direction: column`

## 标准控件映射

- label + 边框盒子 + placeholder -> `Input` / `TextArea`
- 选项文字或下拉箭头 -> `Select`
- radio/checkbox 标记 -> `Radio.Group` / `Checkbox.Group`
- 重复的 chip/tab 行 -> `Tabs` 或本地 tabs
- 重复规则行/表格行 -> 结构化列表或 `Table`
- 类对话框浮层 -> `Modal` / `Drawer`
- 操作盒子 -> `Button`

## 区域策略

- 把 shell、tabs/chips、form、规则列表和 footer 分成独立区域处理。
- 对每个区域，只传相关 manifest 行和最少的原始片段。
- 如果某区域由组件接管，就抑制该区域中的原始文本和假控件。

## 仅在需要时升级到完整参考

在以下情况读取 `pure-div-converter.md`：

- 需要坐标映射检查点
- 需要更细的 Tab 边界规则
- 需要处理必填标记转换边界情况
- 需要处理背景归属边界情况
- 需要严格的失败案例

## 混合保真异常处理

只有在转换大型绝对定位 HTML 时，且出现重叠、文本溢出、原始文本重复，或组件与原始层冲突时才使用这一节。

核心规则：

1. 当某个区域由组件接管时，该区域的原始层必须被抑制（文本节点、placeholder、假控件、计数小盒等）。
2. 装饰性背景块和大区域面板只有在组件后方确实需要时才保留。
3. 部分替换时只抑制被接管的槽位，保留周围视觉盒子。
4. 组件替换后原始层文本若溢出到目标区域边界外，视为错误，执行抑制或重映射。

常见区域：

- Chip / Tab 行：水平重复标签且有一项激活 → 使用 `Tabs` 或项目本地 tab 组件，挂载后抑制原始 chip 文本与对应小盒子。
- card 风格、分段式、带边框卡片感的 tab 行，只要本质仍是切换内容面板，也按 `Tabs` 处理。
- 概要 / 信息卡：重复面板含标题 + 内容或标题 + 输入对 → 使用小型 card / list 结构，渲染后抑制内部原始段落与 placeholder。
- 规则列表 / 评分面板：序号 + 标题 + 分数 + 正文 + “添加规则”动作 → 作为结构化列表组件，抑制原始规则文本与小分数盒子。

弱模型分步流程：先决定区域归属（fidelity-only 还是组件接管）→ 只转换该归属区域 → 抑制该区域原始层 → 验证边界外无残留原始文本。



