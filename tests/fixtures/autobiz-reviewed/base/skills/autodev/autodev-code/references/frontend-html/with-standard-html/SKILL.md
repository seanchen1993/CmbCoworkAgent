---
name: code-frontend-with-standard-html
description: 处理 /autodev-code 内部标准 DOM / 语义明确 HTML 的路线技能。适用于标准 DOM、style 标签、class 命名清晰、表单/按钮/label/flex 结构明显的 HTML 输入；既覆盖普通 HTML，也覆盖结构标准但视觉仍要求高保真的 HTML。
---

# 标准 HTML 路线

这是 `/autodev-code` 内部的标准 HTML 实现路线目录。

- 当前路线入口：`SKILL.md`
- 当前路线参考：`references/`
- 当前路线脚本：`scripts/`

本文中提到的 `SKILL.md` 均指 code 根技能 `../../../SKILL.md`。若本文和 code 根技能冲突，以 code 根技能的 Source/Method Bundle 优先级、HTML 分支总控契约和 code_done 收尾规则为准。

## 1. 什么时候使用

当输入满足以下特征时，使用本路线：

- 标准 DOM 结构明显
- 存在 `<style>` 或清晰 class 规则
- `form` / `input` / `button` / `label` / `textarea` / `select` / `flex` 布局明显
- 页面不是靠绝对定位碎片容器拼装主结构
- 目标是优先映射 React + AntD / 真实项目组件，同时保留需要的视觉还原度

如果 HTML 主要由坐标、绝对定位、碎片 div 或 Figma/MasterGo 导出结构驱动，不使用本路线，应回到 `../with-absolute-html/SKILL.md`。

补充硬门槛：如果命中以下任一“绝对定位 / 导出稿”信号，**即使 DOM 看起来较规整，也不能走本路线**：

- 用户明确标注“绝对定位 HTML”“Figma/MasterGo 导出 div 稿”“纯坐标还原稿”
- 存在全局 absolute 规则，如 `body { * { position: absolute; } }`
- utility class 中出现大量 `left-[...]` / `top-[...]` / `clip-path` / data-svg
- 一个页面内出现多组梯形、迷你趋势图、像素级卡片矩阵、复杂壳层布局

命中以上任一条，必须返回 `../with-absolute-html/SKILL.md`。

补充说明：

- 如果用户明确要求高保真，但 HTML 本身仍然是标准 DOM、表单结构、表格结构或正常的 flex / grid 布局，本路线仍然适用。
- “是否高保真”不是排除条件；“是否主要由绝对定位碎片结构驱动”才是本路线的核心分流条件。

## 2. 默认读取顺序 / 主流程 write_todos

进入本路线后，先把下面这组 `write_todos` 视为主流程骨架；**未完成前不得提前转交 `references/standard-html-parser.md`**。这里的 `write_todos` 是路线执行时必须显式维护的可见清单，不是项目业务 API，也不是新增脚本要求。

本路线不新增标准 HTML 前置分析脚本，不复用 `../with-absolute-html/` 下的 absolute 分析脚本，也不要求生成 `.frontend/html-analysis` 前置产物。原始 HTML 始终是视觉、内容和语义事实源。

- [ ] 写出路线判定清单（write_todos）。
  - [ ] 读取原始 HTML 来源。
  - [ ] 确认输入具备标准 DOM、语义结构、表单 / 表格 / flex / grid / class 规则等证据。
  - [ ] 检查是否命中 `../with-absolute-html/SKILL.md` 定义的绝对定位 / Figma / MasterGo / 设计导出稿强信号。
  - [ ] 若命中强信号，停止本路线并返回 `../with-absolute-html/SKILL.md`。
  - [ ] 若未命中强信号，记录交接状态：`routeType=standard-html`、`absoluteSignalsCleared=true`。
- [ ] 写出页面模块清单（write_todos）。
  - [ ] 从 HTML 来源目录和目标工程目录向上查找并读取 `AGENT.md` / `AGENTS.md`，更近的规则优先。
  - [ ] 读取项目 `architecture/`、组件说明、API 说明和相似页面。
  - [ ] 扫描真实源码证据，例如 import、导出、实际用法、路由 / 菜单 / API helper / 样式文件 / 包管理器 / 已安装依赖。
  - [ ] 按页面模块列出入口、分区、局部组件、复用逻辑、样式文件和资产。
  - [ ] 若目标页面已存在，先读取现有目标文件，对照原始 HTML 差异限定修改范围；若是新建页面，再按完整模块清单落盘。
  - [ ] 将以上证据与原始 HTML 交叉核对，再继续后续实现。
  - [ ] 记录交接状态：`moduleTodosReady=true`。
- [ ] 写出转换清单（write_todos）。
  - [ ] 按区域明确项目组件 / Ant Design / Ant Design Mobile / 原生 React + CSS 的映射策略。
  - [ ] 覆盖表单、表格、筛选、导航、反馈、弹窗、上传、分页、图表、图标、默认值、禁用态、选中态、空态、错误态、loading、hover / focus、responsive 和可识别交互。
  - [ ] 判断 `uiLibraryTarget=project|antd|antd-mobile|native`：项目自有组件体系优先记为 `project`；桌面 Ant Design 记为 `antd`；移动端 Ant Design Mobile 记为 `antd-mobile`；品牌化、文章化、营销化、异形视觉和高度自定义布局优先记为 `native`。
  - [ ] 后台产品 UI 优先项目组件或桌面 Ant Design；移动端标准 HTML 按项目证据或 code 根技能兜底使用 Ant Design Mobile；品牌化、文章化、营销化、异形视觉和高度自定义布局优先保留原生 React + CSS。
  - [ ] 遵循“语义优先，组件替换有证据”：没有源码、导出或真实用例证据时，不强行使用某个项目组件。
  - [ ] 判断 `antdMode=required|candidate|selected|notApplicable`：用户明确要求桌面 Ant Design 时为 `required`；桌面 Ant Design 可能适用但尚未决定时为 `candidate`；映射矩阵决策后实际使用桌面 Ant Design 时为 `selected`；不使用桌面 Ant Design 时为 `notApplicable`。
  - [ ] 当 `antdMode=required` 或 `antdMode=candidate` 时，读取 `references/ant-design-conversion.md` 并建立映射矩阵；`candidate` 只表示必须评估，不等于最终使用。
  - [ ] 记录交接状态：`conversionTodosReady=true`。
- [ ] 写出 Ant Design 审计清单（write_todos）。
  - [ ] 仅当 `uiLibraryTarget=antd` 且 `antdMode=required|selected` 时启用桌面 Ant Design 审计，并记录 `auditRequired=true`。
  - [ ] 当 `antdMode=candidate` 但映射矩阵最终未选择桌面 Ant Design 时，将 `antdMode` 更新为 `notApplicable`，并记录 `auditRequired=false`。
  - [ ] 当 `uiLibraryTarget=antd-mobile` 时，不套用桌面 Ant Design 映射矩阵和 `audit_antd_coverage.py`；如后续需要移动端审计，单独定义规则。
  - [ ] 当 `uiLibraryTarget=project` 且项目 wrapper 内部基于 Ant Design 时，仍按项目组件优先，不直接裸用桌面 Ant Design；是否审计只看最终源码是否直接选择桌面 Ant Design。
  - [ ] 当 `uiLibraryTarget=antd` 且 `antdMode=required|candidate` 时，编码前创建 Ant Design 映射矩阵，覆盖所有产品 UI 控件、数据面、导航模式、反馈元素、overlay 和表单控件候选。
  - [ ] 当 `auditRequired=true` 时，实现后运行 `scripts/audit_antd_coverage.py` 做源码覆盖审计。
  - [ ] 审计脚本只扫描 JSX / TSX 源码，是启发式候选扫描，不是 AST 级完整审计；退出码 `1` 表示发现待处理候选项，不表示脚本故障。
  - [ ] 对每个审计候选项执行转换，或保留原生实现并添加 `antd-audit-ignore` 注释说明原因。
- [ ] 转交 `references/standard-html-parser.md`。
  - [ ] 交接状态必须包含：`routeType=standard-html`、`absoluteSignalsCleared=true`、`moduleTodosReady=true`、`conversionTodosReady=true`、`uiLibraryTarget=<project|antd|antd-mobile|native>`、`antdMode=<required|candidate|selected|notApplicable>`、`auditRequired=<true|false>`。
  - [ ] 该参考文件已作为 `standard-html-parser` 承载标准 HTML 转 React 工程代码能力，是本路线主执行入口。
- [ ] 主线完成后返回 `/autodev-code` 主流程。
  - [ ] `standard-html-parser` 主线完成后先输出交付总结，并带回统一前端回检输入：目标源码路径、原始 HTML 路径、analysis JSON 路径（标准 HTML 路线通常为 none）、PLAN 路径、`uiLibraryTarget`、`antdMode`、`auditRequired`。
  - [ ] 随后控制权必须返回 `/autodev-code`，由 code 根技能执行项目级验证、统一前端回检和 `code_done` 推进。
  - [ ] 不发起独立回检选择，不调用或引用已移除的内部回检路线。

## 3. 交接状态

完成第 2 节的 `write_todos` 后，默认直接转交 `references/standard-html-parser.md`，并带上以下状态：

```text
routeType=standard-html
absoluteSignalsCleared=true
moduleTodosReady=true
conversionTodosReady=true
uiLibraryTarget=<project|antd|antd-mobile|native>
antdMode=<required|candidate|selected|notApplicable>
auditRequired=<true|false>
```

如果任一 ready 状态无法成立，必须先补齐对应清单；只有命中绝对定位 / 设计导出稿强信号时，才停止本路线并返回 `../with-absolute-html/SKILL.md`。

## 4. 边界

- 本路线只负责标准 DOM / 语义明确 HTML
- 不修改绝对定位高保真路线的执行结果，只在命中强信号时返回 `../with-absolute-html/SKILL.md`
- 不依赖 `../with-absolute-html/` 下的 absolute 分析脚本
- 不新增标准 HTML 分析脚本，也不依赖 `.frontend/html-analysis/*.json` 前置产物
- `scripts/audit_antd_coverage.py` 只在桌面 Ant Design 转换后做源码覆盖审计，不作为 HTML 解析前置步骤，也不用于 Ant Design Mobile
