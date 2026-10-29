# Workbuddy Design：结合当前实现的增量借鉴分析

分析日期：2026-10-28。

对照对象：`/Users/liuxuyang/Downloads/workbuddy-design/skills/`、该目录已有的 `design-skills-analysis.md`，以及当前项目的 Design 执行、模板、设计系统与校验代码。

Workbuddy 侧材料是技能与流程规范，不包含 Ardot/Miora 后端实现。因此本文区分“规范要求了什么”和“当前项目代码已经实现了什么”，不据此推断竞品真实生成速度或成品质量。

**建议优先补三项：统一任务契约与规则优先级、增加成品视觉验收、保存项目设计基线。** 现有 HTML、局部补丁和 Tweaks 可以继续作为执行基础。

## 1. 已经有的能力，不应重复建设

| 能力 | 当前依据 | 本次判断 |
| --- | --- | --- |
| 渐进生成、稳定区块、草稿恢复 | `generation-prompt.ts`、`draft-preview.ts`、`docs/design-progressive-generation.md` | 已覆盖“分段出现”的主要体验，不必为此迁移为画布节点 DSL。 |
| 局部 AI 修改、节点身份、事务、撤销重做 | `patch-executor.ts`、`patch-applier.ts`、`run-manager.ts`、`docs/design-local-patch.md` | 已有实际执行与校验机制，不能再把 Workbuddy 的批量更新当作全新能力。 |
| 声明式参数与用户 overrides | `design-tweaks.ts`、`generation-prompt.ts` | 已有可用的微调基础。下一步是参数语义和跨页面一致性。 |
| 设计系统选择与上下文注入 | `design:list-systems`、`buildSelectedDesignSystemContext` | 已有 DESIGN.md 资源库和视觉方向锁定。下一步是结构化解析和实际使用检查。 |
| 模板与本地静态资源包 | `template-packages.ts`、`docs/design-template-packages.md` | 已有导入、预览、依赖保存和导出。下一步是让场景规则稳定进入执行与验收。 |
| 编号版式、质量等级 | `design-templates/replit-deck/references/layouts.md`、`references/checklist.md` | 已有 L01 等版式及 P0/P1/P2 清单；差距是其他模板覆盖不均、宿主未统一执行。 |
| 后台运行和会话状态 | `run-manager.ts`、`session-store.ts` | 已有运行与持久化机制。无需仅因 Workbuddy 有阶段流程再建一套任务系统。 |

## 2. P0：统一任务契约，收敛通用规则与场景规则

### Workbuddy 值得学的部分

`design-router` 先按交付物形态分类；`ardot-design-core` 负责工具和步骤，领域技能负责产物规范。宿主已经确定的文件动作、图片模式通过指令直接注入，减少模型重复决策。

对应原文：

- `/Users/liuxuyang/Downloads/workbuddy-design/skills/design-router/SKILL.md`
- `/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/SKILL.md`，Step 2–5。
- `/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-ui-design/SKILL.md`，场景规则选择。

### 当前的具体问题

1. `src/main/ipc/design.ts:202` 的通用提示词要求卡片内边距至少 24px、页面大留白；`design-templates/dashboard/SKILL.md` 要求紧凑排版，归藏演示稿也要求高信息密度。通用默认值容易压过场景需求。
2. 总提示词说默认只出单方案，但 iteration 分支又要求宽泛探索出两版。`src/shared/managed-design-session.ts:175` 还会在没有设计系统时注入 A/B 双方案，`forceVariations` 参数未参与当前决策。宿主显式指令可以覆盖默认值，但这些策略分散在多个入口，后续修改容易产生不一致。
3. 模板已有 `od.mode/platform/scenario` 元数据，`listDesignTemplates()` 也在读取。它们适合进一步驱动规则选择，而不只是用于列表展示。

### 适合你的落地方式

由宿主生成并持久化一份轻量 `DesignBrief`，模型只补充尚未确定的部分，例如：

```ts
interface DesignBrief {
  deliverable: "html-prototype" | "html-deck" | "html-poster"
  scenario: "dashboard" | "landing" | "mobile" | "deck" | "poster" | "custom"
  operation: "create" | "local-edit" | "restyle"
  variationCount: 1 | 2
  density: "compact" | "balanced" | "airy"
  designSystemId?: string
  referenceIntent?: "clone" | "style" | "content"
}
```

这是一份建议协议，不代表上述字段已经存在。

- 将文件、渐进生成、Tweaks 和保护约束放入执行层。
- 按场景加载结构、密度、排版、响应式规则。
- 将用户本轮明确要求置于视觉默认值之前；宿主明确技术能力边界。
- 方案数量只计算一次，所有入口共享同一结果。
- 局部修改复用当前补丁通道，不重新进行风格探索。

**完成标准：** 同一输入从新建、图片参考、模板或继续修改入口进入时，得到一致的方案数量和场景规则；看板不再被通用“大留白”规则牵引。

## 3. P0：补齐视觉验收，复用现有浏览器校验

### Workbuddy 值得学的部分

`design-rules.md` 的 T1–T5 分级区分结构、内容、样式、区块和整页；要求截图必须实际读图；限制修复次数，并明确区分可接受的细节和阻塞交付的问题。

原文：`/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/rules/design-rules.md:383`。

### 当前已经验证什么

- `validateDesignArtifactInHiddenBrowser()` 检查运行错误、文档/变体结构、Tweaks 初始化等。
- `artifact-validator.ts` 和局部补丁验证检查样式是否生效、前后布局变化、目标外样式变化。
- 局部布局修改已检查当前宽度和 390px 移动宽度，不能把这部分再当作缺失功能。

### 尚值得补什么

在本次查看的宿主校验链路中，未见统一的成品截图读图与场景视觉报告。当前运行校验通过，并不能单独证明标题层级、长中文排版、留白和信息密度合适。

建议分两层：

| 层次 | 检查内容 | 实现建议 |
| --- | --- | --- |
| 确定性检查 | 缺图、内容裁切、非法横向溢出、字号是否满足当前场景约束、所需模块是否存在 | 复用隐藏浏览器，基于实际 DOM、计算样式和场景契约判断。 |
| 视觉审阅 | 主次层级、阅读路径、密度是否合理、参考风格是否偏离、图文是否抢占同一视觉中心 | 定稿时生成截图，交给具备视觉能力的模型；报告绑定产物版本。 |

- 完整生成完成后检查目标视口；响应式 Web 页面再检查移动视口。固定比例演示稿走自己的缩放规则。
- 超长页面按区块截图，避免缩成一张无法读字的长图。
- 局部颜色修改保留现有轻量样式验证；仅结构、排版或参考还原任务增加相应视觉检查。
- 不把逐区块截图机械加入渐进生成路径，避免破坏首屏和总耗时。
- 一次汇总问题，最多两轮修复；核心内容缺失或文字不可读时，保留草稿并明确未完成。
- 视觉模型不可用时标记“视觉审阅未执行”，仍可展示已有确定性检查结果。

**完成标准：** 用户能看到针对实际产物版本的检查结果；运行通过、视觉通过、未执行分别记录。

## 4. P1：从 DESIGN.md 注入升级为项目设计基线

### Workbuddy 值得学的部分

- Ardot 将颜色、间距、字体等绑定为变量，并支持 Light/Dark、密度模式。
- Miora 的跨轮次风格锚点同时保存“被接受的产物”和“当时的风格描述”，后续显式声明保留项和修改项。

对应原文：

- `skills/ardot-design-core/func-rule/design-variables/SKILL.md`
- `skills/miora-creative-core/references/output-contract.md:26`

### 当前差距

你已经有 DESIGN.md、CSS 变量和用户 Tweaks。`DesignSystemInfo.tokens` 目前只包含六个预览颜色；`extractDesignSystemTokens()` 通过正则读取它们。完整设计系统主要以文本进入模型，尚未形成统一、可校验的语义 token 合约。

`DesignArtifactMetadata` 保存设计系统 ID、提示词、模板、变体和 Tweaks，但还没有明确的“已接受视觉基线 + 版本 + 不变量”结构。

### 适合你的落地方式

- 保留 DESIGN.md 作为人可读入口，增加结构化 token 数据和版本号。
- 使用语义名称，例如 `surface.canvas`、`text.primary`、`action.primary`、`space.controlGap`，再映射到 CSS 变量。
- 字体栈、字号、行高、圆角、间距、组件状态都纳入基线；主题和密度使用模式表达。
- 用户接受一个页面后保存其产物引用、token 快照、组件约定及风格摘要。
- “再做一个详情页”复用同一基线；“按钮亮一点”作为局部覆盖；明确换风格时建立新版本。
- 区分项目共享 token 和单页 Tweaks，避免修改一个页面的按钮文案影响其他页面。

**完成标准：** 连续生成列表、详情、编辑三页时，字体、按钮、表格和间距保持一致；刷新、重开和导出后仍使用同一有效基线。

## 5. P1：把版式建议升级为生成计划和可检查的版式契约

### Workbuddy 值得学的部分

Slides 先保存逐页大纲，每页注明角色、核心信息和 Layout hint。Poster 在动手前声明版式、色彩角色、字号表、主视觉和阅读顺序，完成后逐项审计。

对应原文：

- `skills/ardot-slides/workflows/slides-workflow.md`，Phase 0–2。
- `skills/ardot-poster/references/guidelines-poster.md:42`。

### 当前差距与已有基础

`replit-deck` 已有编号版式、主题约束和分级清单；其他模板如 dashboard 的布局文件主要是自然语言组合建议。渐进生成已有稳定 section，但计划尚未统一描述每个 section 的任务、必要内容和验收规则。

### 适合你的落地方式

在现有生成运行内先保存一份小型 `design-plan.json`，无需额外启动一次长问答：

- 页面/区块 ID、承担的任务、核心信息、主要操作。
- 版式 ID，例如 `dashboard.master-detail`、`deck.key-metric`。
- 必须出现的内容、可用素材、目标视口和需要验证的状态。
- 引用的设计基线与验证 profile。

例如：运营看板应以异常处理或分析任务为中心；营销页突出价值与 CTA；演示稿每页一个结论；海报突出一条信息和一条阅读路径。

计划随后用于骨架生成、进度、缺失模块检查和修复反馈，避免成为无人读取的附属文件。只在页数、目标或交付形态存在实质歧义时请求确认。

**完成标准：** 骨架、生成进度和最终验收引用同一组区块 ID；缺少必要模块时可指出具体项。

## 6. P1：区分参考素材角色，防止“参考一下”变成整页克隆

### Workbuddy 值得学的部分

Miora 输入契约要求明确每份素材是主体、风格还是构图参考；产物按“主视觉”“细节特写”等语义角色记账，不凭返回顺序分配用途。跨轮次延续必须携带有效锚点。

对应原文：

- `skills/miora-creative-core/references/input-contract.md:28`
- `skills/miora-creative-core/references/output-contract.md:9`

### 当前接入点

`IMAGE_DESIGN_SYSTEM_PROMPT` 明确要求严格克隆截图；当前图片路径适合截图还原。若用户只想参考配色、沿用 Logo 或使用产品照片，就应与克隆任务区分。`DesignRunRequest` 的图片输入目前主要是 `imageData/mimeType`，未统一表达这些用途。

### 适合你的落地方式

给参考资源增加 `role`、有效路径、来源和保留要求，例如：

- `layout-reference`：参考布局，可重新组织内容。
- `style-reference`：参考色彩和视觉语言，不照搬内容。
- `brand-logo`：保留原素材，作为独立资源排版。
- `product-photo`：保留产品外观，可调整展示位置。
- `content-source`：只提取文本或业务资料。

UI 优先由用户已有入口、操作和上下文推断；确实影响结果且无法确定时再问。生成图片资产时按语义角色登记真实结果，页面在资源完成后替换对应占位区。

**完成标准：** 同一截图用于“还原”和“借鉴配色”会走不同约束；Logo、产品照片不会因整页重画而被替换成近似素材。

## 7. P2：把设计系统目录变成按任务检索的风格库

### Workbuddy 值得学的部分

`search_style_guide` 按风格、颜色、字体、布局、场景和构图检索候选，再由 `build_style_guide` 组装。规范要求依据 `summary/bestFor` 判断适配，而非只看分数；已有明确风格时跳过搜索。

原文：`skills/ardot-design-core/SKILL.md:94`。

### 当前基础与建议

你已有品牌设计系统目录、分类、说明和方向卡。可以先增强元数据，无需立刻建立向量数据库：

- `bestFor/avoidFor`、信息密度、明暗主题、主要版式、动效程度。
- 字体可用性、中文 fallback、对比度风险。
- 从任务和场景给出三个有理由的候选；已有品牌或参考则直接使用。
- 增加“由导入页面提取设计基线”：提取 CSS/字体/组件特征，结合实际截图，保存为可再次选择的 DESIGN.md 与 tokens。

当前 `design:import-url` 主要处理远端 HTML 导入，和提取可复用设计系统是不同的产物。后者可复用导入能力，但需要样式分析和验证。

**完成标准：** 用户按“高密度审批后台”“中文咨询演示稿”等任务描述找到风格，而不必先知道品牌名。

## 8. P2：优先借鉴组件组合语义，再考虑完整实例系统

Workbuddy 组件规范值得借鉴的不只是复制和换属性，还包括：组合前检查内置导航、返回按钮、状态栏；避免重复入口；组件语义与任务匹配；共享变化优先修改组件本体。

原文：`skills/ardot-design-core/func-rule/component-instance/SKILL.md`，Composition Contract。

建议先为常用模块定义轻量 HTML/CSS 约定：按钮、筛选栏、表格、详情抽屉、导航，以及按场景需要的 loading/empty/error/success 状态。配合模板包和设计基线复用。

不需要立即仿造 COMPONENT_SET、嵌套实例路径和整套节点 schema。当前 React/Vue 模板还需尊重组件重绘边界，已有“框架模板走完整源码改稿”的策略应继续保留。

**完成标准：** 模块组合不会出现两个返回入口或两套导航；关键操作有反馈，状态可以在原型中实际触发和查看。

## 9. P2：工程交付前锁定技术契约

如果后续重点是“导出为 React/Vue 应用”，可借鉴 Workbuddy 出码流程对技术栈、视口、等比缩放/响应式、素材映射的明确约束。

当前已经支持 HTML 和资源 ZIP 导出，`design-protocol.ts` 也有 framework/artifactKind 类型。因此下一步应明确区分“保存当前原型”和“生成可维护工程”两项能力，先支持一个目标栈并完成构建、预览验证。

Workbuddy 的出码规范明确要求不运行生成代码，这部分不适合照搬到你的工程交付链路。

## 10. 不建议照搬的规则

1. **每次强制多轮澄清和大纲确认。** 可以保留计划文件；已给出的答案、已有品牌和当前页面状态直接复用。小任务继续直接执行。
2. **统一审美禁令。** 不宜全局禁止某种字体、居中布局、渐变，也不宜全局强制卡片大内边距。优先服从品牌、场景和中文可读性。
3. **把海报的 28px 地板套到所有页面。** 其目的是可读性；实际阈值应由画布尺寸、展示方式和场景共同决定。
4. **把每条规则都交给模型记住。** 文件动作、方案数量、状态迁移、资源身份和版本校验由宿主确定，提示词只承担视觉和内容决策。
5. **全面迁移 Ardot 节点模型。** 当前 HTML 路径已经具备编辑、交互、验证与导出基础，应先通过实际需求证明完整画布引擎的必要性。
6. **把全部规范一次塞进上下文。** 分离公共执行规则、场景规则和具体能力参考，按任务装配。
7. **把新增能力等同于新增规则数量。** Workbuddy 原文也存在局部优先级张力，例如 core 的搜索一次约束与 slides 的重新搜索建议。需要统一决策来源，复制更多文案不能解决冲突。

## 11. 推荐实施顺序与接入位置

| 顺序 | 改进 | 主要接入位置 | 最先解决的问题 |
| --- | --- | --- | --- |
| 1 | DesignBrief、场景分流、规则与方案数量统一 | `managed-design-session.ts`、`generation-prompt.ts`、`ipc/design.ts` | 不同入口与不同提示词之间的决策冲突。 |
| 2 | 视觉验收与分级报告 | `artifact-validator.ts`、`ipc/design.ts`、会话事件 | 运行正常但排版不合格的产物仍被视为完成。 |
| 3 | 设计计划与版式契约 | 模板元数据、`draft-preview.ts`、生成上下文 | 生成偏题、缺模块、模板质量不均。 |
| 4 | 项目设计基线与语义 tokens | `DesignArtifactMetadata`、设计系统加载、Tweaks | 多页和多轮迭代的视觉漂移。 |
| 5 | 参考资源角色 | `DesignRunRequest`、图片入口、资源目录 | 克隆、风格借鉴和素材保真混用。 |
| 6 | 风格检索、组件约定、工程交付 | 设计资源库、模板和导出流程 | 后续规模化复用和交付。 |

建议先用三类样例验收：高密度中文看板、16:9 演示稿、截图参考的新页面。记录首个有效区块可见时间、总耗时、修复次数、人工视觉通过率与跨页一致性；沿用现有 generationMetrics 和 patchMetrics，不在缺少真实采样时承诺固定加速倍数。

本次为静态材料和代码对照，只新增分析文档，未修改产品代码或运行测试。
