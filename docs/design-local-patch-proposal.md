# Design 局部微调与补丁执行方案

日期：2026-10-23。状态：已实施；本文保留原方案设计。

实施记录：[Design 局部补丁实现](./design-local-patch.md)。下文保留方案设计与验收要求，实际行为及边界以实施记录为准。

## 1. 结论与参考边界

增加一条局部改稿链路：**定位目标 → 提取局部上下文与依赖 → 模型提交结构化补丁 → 宿主生成完整候选 → 校验 → 提交新版本并刷新目标区域**。

整页源码和合并职责保留在宿主。模型默认只看到目标 HTML、相关 CSS、布局约束和有效 Tweaks 值；最终保存、导出仍是完整 HTML。初始生成和整体重构继续走现有完整生成链路。

### 1.1 WorkBuddy：从节点操作与事务借鉴

根据用户提供的本地资料，研究的是其中 Ardot 工作流，不把它等同于所有 WorkBuddy 功能的内部实现。

- [Ardot Core](/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/SKILL.md)：先读取当前状态和选择，再按目标查节点；区分新建/重新设计与增补式修改。
- [修改流程](/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/workflows/ardot-workflow.md)：`batch_read` 定位目标，`capture_layout` 检查父级，`batch_edit` 修改，再检查布局。
- [batch_edit](/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/tool-usage/batch-edit.md)：按节点 ID 执行插入、更新、移动、删除等操作；单批最多 25 个操作；批内失败整体回滚。Update 不需要重发子节点树。
- [分级校验](/Users/liuxuyang/Downloads/workbuddy-design/skills/ardot-design-core/rules/design-rules.md)：按结构、内容、视觉、完整区块选择校验，避免每次小修改都截图和全量验证。

在本项目中的对应设计：稳定节点 ID、局部读取、结构化操作、原子提交、按改动选择校验。Ardot 是结构化画布，本项目是可执行 HTML，需要另外处理 CSS 级联、源码映射和脚本生命周期。

### 1.2 Claude Design：从交互分工借鉴

[Anthropic 发布说明](https://www.anthropic.com/news/claude-design-anthropic-labs) 描述了对话、行内批注、直接编辑与调整控件等迭代入口。[官方使用指南](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) 将组件级修改交给批注，将结构或大范围修改交给聊天，将快速视觉调整交给画布直接编辑。

这些资料能支持入口和操作粒度的设计，没有披露内部 HTML 裁剪算法、补丁格式或实际 token 开销。本文的补丁协议、上下文提取和版本控制是结合当前代码提出的方案。

## 2. 当前代码与接入点

| 当前能力 | 代码位置 | 本方案如何复用 |
|---|---|---|
| 当前页面/当前变体完整 HTML | `DesignView.tsx` 的 `getCurrentDesignHtml`、`startGeneration` | 完整改稿保留；局部改稿改传目标和版本，宿主取源码 |
| 注释/绘制的 selector、文本、角色与相对坐标 | `DesignView.tsx` 的 `getPointAnchor`、`resolveAnchorElement`；`types.ts` 的 `DesignElementAnchor` | 扩充为稳定 nodeId、sectionId 和版本化锚点 |
| `data-design-section` 与完整性检查 | `src/shared/design-progressive.ts` | 作为区块边界，扩充源码与依赖索引 |
| 区块差量预览、ACK、完整快照恢复 | `design-progressive-preview.ts`、`DesignPreviewFrame.tsx` | 复用消息身份和恢复机制；增加局部编辑预览模式 |
| 参数 overrides、撤销和版本 | `src/shared/design-tweaks.ts` | 与补丁共同校验、保留及提交 |
| 后台运行、取消、事件和 SQLite 会话 | `run-manager.ts`、`session-store.ts` | 局部改稿也成为受管理的运行 |
| 结构检查与隐藏浏览器验证 | `src/main/ipc/design.ts` | 抽取为可复用验证服务，增加局部变更断言 |

当前迭代会携带 `currentHtml`，主进程创建整页 `.source-*.html` 快照，提供路径让 Agent 读取，并要求输出完整新文件。因此仅修改提示词或仅复用 iframe 的区块刷新，无法实现模型侧的局部输入输出。

## 3. 入口路由

| 请求 | 路径 | 模型输入/输出 |
|---|---|---|
| 已有颜色、圆角、文案等参数控件 | 继续本地 Tweaks | 不调用模型 |
| 元素属性面板的明确样式设置 | 继续本地直接编辑，统一版本记录 | 不调用模型 |
| 点击元素批注、单区块绘制标记 | 默认 local-patch | 局部上下文 → 补丁 |
| 聊天中有明确目标，如“把页头搜索框加宽” | 先匹配区块目录，再 local-patch | 区块目录摘要 + 局部上下文 → 补丁 |
| 全站主题、多个页面重排、添加复杂交互 | 现有完整 Agent | 按实际需要提供全局上下文 |

路由先用显式目标与确定性规则。无法确定时，给同一补丁执行器一个精简区块目录，由它选择候选并请求上下文，避免所有修改都增加独立分类模型调用。

明确指向局部的请求定位失败时，优先重新匹配或展示候选让用户选中；不能按第一个同名按钮猜，也不能把“未找到”当成空白页重新生成。正常局部修改不新增人工审批步骤。

## 4. 定位目标：建立可写回源码的索引

### 4.1 三层身份

- `artifactId + variationId`：限定修改哪份产物及哪个方案。
- `data-design-section`：逻辑区块，例如 `header`、`hero`、`pricing`。
- `data-design-node`：宿主维护的稳定可编辑节点 ID，例如 `n_cta_01`。

新节点 ID 由宿主分配，模型只能引用上下文里的现有 ID；新 fragment 内可使用临时 ref，由宿主校验并分配永久 ID。复制内容时重新分配 ID。保留原有业务 `id`、class 和数据属性，不用包装 div 改写现有布局。

新页面在首次定稿/建立编辑基线时补齐编辑 ID。旧 HTML 按可编辑元素建立索引；安全归一化时只增数据属性，不自动拆 DOM 或迁移业务脚本。没有清晰区块时用现有 `header/main/section/aside/footer` 或稳定容器作为候选；无法唯一映射的动态 DOM 不强行写回。

### 4.2 版本与源码定位

用已有 `parse5` 的 `sourceCodeLocationInfo` 建立：

```ts
interface DesignDocumentIndex {
  artifactId: string
  variationId: string | null
  artifactRevision: number
  sourceHash: string
  sections: Record<string, SectionIndex>
  nodes: Record<string, NodeIndex> // 父级、区块、源码范围、节点 hash
  cssRules: Record<string, CssRuleIndex> // 源文件/内联块、范围、顺序、条件
  dependencies: DependencyGraph
}
```

parse5 会修复部分不规范 HTML，隐式创建的节点不一定有源码位置；它们不能直接成为源码补丁目标，应上移到有真实源码范围的容器或扩大处理范围。不能以“解析成功”代替结构有效性验证。相关能力见 [parse5 官方说明](https://parse5.js.org/interfaces/parse5.ParserOptions.html)。

源码为可持久化的事实来源。预览 DOM 只补充位置、布局、实际样式和截图；不把脚本运行后的整页 outerHTML 当作新源码，避免把弹窗状态、临时节点和宿主运行代码写回。

### 4.3 定位优先级

1. 同一产物、方案和版本中的稳定 nodeId。
2. 区块内唯一的业务 ID/已有 anchor。
3. 区块内 selector + tag + 文本签名 + role 联合匹配。
4. 坐标命中用于提示候选；必须再确认其源码身份。

锚点带 `artifactRevision`、`nodeHash` 和 `previewInstanceId`。来自旧 iframe 的消息不直接写入。selector 匹配多个、文本重复或源码不存在时返回歧义原因。

绘制区域跨区块时按采样点/区域覆盖得到多个目标，分别保留各自 note。合并重复目标，对重叠子树提升到共同父级或拆成互不重叠的事务；不把某一区域说明扩散到全部区域。

## 5. 提取上下文：HTML + 样式依赖 + 布局契约

### 5.1 模型看到的内容

```ts
interface DesignPatchContext {
  contextId: string
  base: { artifactId: string; variationId: string | null;
    artifactRevision: number; sourceHash: string; tweakRevision: number }
  instruction: string
  targets: Array<{ nodeId: string; sectionId: string; hash: string; html: string }>
  layout: ParentAndSiblingSummary[]
  styles: ReferencedCssRule[]
  tokens: ReferencedToken[]
  tweaks: RelevantTweakContract[]
  assets: ReferencedAsset[]
  protectedRefs: ProtectedReference[]
  editable: EditableScope
  omitted: OmittedResourceSummary[]
}
```

默认发送目标子树。布局变化再附父级布局和相邻节点的摘要、尺寸及顺序，不附所有兄弟节点的完整代码。边界不足时上移至最近的合理编辑容器。

例如“只把主按钮变红”发送按钮 HTML、对应样式、实际生效的背景色来源和相关参数绑定；“把按钮与输入框左右排列”发送二者共同父容器的 HTML、flex/grid 规则及尺寸约束。

### 5.2 CSS 不能只按 class 名过滤

用 CSS AST 建立规则和依赖图，建议增加显式依赖 `css-tree`，覆盖规则解析、遍历、声明解析与生成；其能力以 [官方仓库](https://github.com/csstree/csstree) 为依据，具体版本实施时锁定并验证。

提取范围包括：

- 目标及后代命中的规则，保留源码顺序、选择器、优先级与 `!important`。
- 影响继承和父级布局的相关祖先规则，如字体、行高、grid 列宽、flex 分配。
- `@media`、`@supports`、`@container`、`@layer` 的条件路径；不能只提取当前桌面宽度的命中结果。
- `:hover`、`:focus-visible`、`:disabled`、`::before/after` 等相关状态规则。
- `var()` 递归引用、fallback、局部覆盖、`@property`；相关字体与动画定义。
- 目标使用的资源路径和尺寸等元信息；不发送无关图片二进制或整个资源目录。

宿主通过 Chromium CSSOM/计算样式补充当前布局和关键属性的实际值。CSS AST 负责规则和条件结构，浏览器负责真实选择器/级联行为；不能用一个 class 正则推导全部 CSS 语义。浏览器样式表访问能力参考 [CSSStyleSheet.cssRules](https://developer.mozilla.org/en-US/docs/Web/API/CSSStyleSheet/cssRules)。

外部/跨源样式无法读取、运行时生成样式、复杂 selector 无法可靠归属时，标记 `unresolvedDependencies`。可以提供计算值和局部覆盖方案；涉及不明确的结构或交互依赖时扩大范围。不能把“无法读取”伪装成“没有依赖”。

### 5.3 共享规则的读写边界

`.btn`、`:root` 和全局字体等可以作为只读参考，默认不可改写。

局部样式通过 nodeId 定位，宿主生成受限规则或修改该元素已有 inline 声明。响应式/状态样式使用受控 condition/state；新规则必须只命中已授权目标。禁止模型随意提交选择器后简单字符串拼前缀，也不批量添加 `!important`。

浏览器检查实际级联是否满足期望；若原规则、inline 或 `!important` 阻止生效，依据来源选择局部写法或扩大编辑范围。需要修改共享 token 或共享组件时，路由为显式全局操作，校验所有受影响消费者。

节点外的样式依然可能通过继承、自定义属性、`:has()`、兄弟选择器、计数器或布局受到影响。校验同时检查反向依赖与边界外关键样式；源码未变不等于视觉绝对不变。目标高度变化造成后续内容自然下移可以允许，但不得掩盖溢出或意外样式变化。

### 5.4 上下文预算与补读

初始可配置预算建议：常见局部修改上下文约 6k–12k tokens；操作数最多 25；输出和补读设置独立上限。这些是工程起点，不是已测性能保证。

超预算时缩小目标、按不重叠区块拆分或扩大为明确的完整改稿任务。不得直接从半截 HTML/CSS 中截断。`omitted` 列明未提供的依赖及其 ID，模型最多进行两次有界补读；宿主决定是否允许。

## 6. 模型执行：专用补丁执行器

新增 `kind: "patch"`，仍由会话 RunManager 管理生命周期。采用精简的模型工具循环，复用模型选择、取消、重试、流式状态和用量采集。

不要直接复用当前完整 Agent 的 checkpoint。它保留了历史工具读写和可能的整页 HTML，即使本轮只附局部内容，模型输入仍可能很大。补丁执行器每次只装载：短系统约束、当前明确指令、已审核上下文、必要的语义摘要，以及本轮补读/校验反馈。

不要仅向 `createAgentRuntime` 追加工具：现有 `additionalTools` 并不会移除通用文件工具。局部执行器只暴露：

- `get_design_context({ contextId, resourceIds })`：通过宿主已有索引补读可访问依赖，不接受任意文件路径。
- `submit_design_patch({ contextId, operations })`：提交候选操作，不直接修改源文件。
- `request_design_scope({ contextId, reason, requestedTargets })`：报告信息不足或操作越过局部能力；宿主核定范围和后续路径。

工具调用由模型输出完整参数后才解析、校验和应用。模型逐 token 输出的未完成 JSON 只作为生成状态展示，不能边解析边写正式页面。

不支持工具调用的模型可走严格 JSON 响应 + 同一协议校验；能力不足或多次格式失败时返回清晰错误，不能通过提取任意代码块执行来兜底。

## 7. 补丁协议

首期支持明确、可验证的操作，避免通用字符串替换：

| 操作 | 适用场景 | 约束 |
|---|---|---|
| `set_text` | 修改叶子文案 | 定位到叶子文本；保留按钮图标等其他节点；转义文本 |
| `set_style` | 颜色、间距、尺寸与有限状态样式 | 目标 ID、声明 map、受控条件；宿主生成作用域 |
| `set_attribute` | 图片 alt、有限链接/无障碍属性等 | 属性白名单、值与资源引用校验；不可改业务 ID 和事件属性 |
| `replace_fragment` | 目标容器内部结构调整 | 必须保留目标根身份与必要契约；不接受整页 HTML、script 或任意 style |
| `set_tweak` | 明确要求修改已有绑定参数 | 验证 schema；只改本轮明确涉及的 key |

`replace_fragment` 的嵌套位置、namespace 和解析上下文由宿主提供，正确处理 table/SVG 等情况。宿主保留根节点必要属性，模型只提交被授权的内容。涉及事件监听、表单身份或 JS 查询的 protected ref 必须保留。

V1 不包含任意 JS、任意文件写入、任意全局 CSS、跨区块 move/delete。新增交互或无法证明兼容的结构修改，转父区块/完整链路。后续可扩充有明确挂载与卸载协议的组件行为操作。

响应示例：

```json
{
  "protocol": "design-patch/1",
  "contextId": "ctx_104",
  "baseArtifactRevision": 42,
  "operations": [
    {
      "op": "set_style",
      "targetId": "n_cta_01",
      "expectedHash": "sha256:...",
      "declarations": { "background-color": "#e5484d" }
    },
    {
      "op": "set_text",
      "targetId": "n_cta_label_01",
      "expectedHash": "sha256:...",
      "text": "立即开始"
    }
  ],
  "summary": "修改主按钮颜色和文案"
}
```

`contextId` 绑定宿主保存的产物/方案、版本、有效期、可写目标及读写集合。模型回传的身份不能扩大权限；正式 `patchId` 由宿主分配，重复提交同一候选只应用一次。

如颜色由 Tweaks 控制，应返回对应 `set_tweak`，或返回上下文不足；不要另加 CSS 与参数持续互相覆盖。改一个实例时若参数同时绑定了其他实例，不能直接改这个共享参数，需采用局部变更或扩展绑定方案。

## 8. 宿主合并、校验与事务

### 8.1 合并流程

1. 提交前 flush 参数/直接编辑，建立当前源码基线和相关 Tweaks 快照。
2. 校验 context、run、目标、expectedHash、操作 schema 与范围。
3. 在内存候选中统一计算所有源码编辑；重叠范围先归并或拒绝，按源码位置从后往前替换。
4. HTML 使用 AST 定位的源码范围，CSS 使用 AST 验证和受控生成；未涉及的源码字节保持原样。
5. 生成完整候选 HTML，合成需要的 Tweaks 运行代码后进行分级验证。
6. 验证成功，在串行提交队列内再次核对基线，再提交新 revision、补丁记录和预览事件；任何失败不改当前正式版本。

源码范围替换前验证旧片段 hash，不能通过 `String.replace(oldText, newText)` 选择碰巧相同的字符串。parse5 自动补出的节点或重叠范围不直接使用失真的 offset。

### 8.2 分级验证

| 层级 | 总是/何时执行 | 内容 |
|---|---|---|
| L0 协议与范围 | 每个补丁 | schema、版本、唯一 ID、大小、目标存在性、操作许可、幂等性 |
| L1 完整文档与契约 | 每个候选 | HTML/CSS 解析、结构错误、ID/section 保留、资源、Tweaks、脚本与保护节点 hash、范围外源码差异 |
| L2 布局与视觉属性 | 样式/文本造成尺寸变化或结构变化 | 在完整页面环境检查目标、父级、相邻区块，比较 overflow、关键计算样式和响应式表现；按改动合并检查 |
| L3 交互与运行 | 结构替换、protected refs、含交互的区域、全局样式影响 | 完整候选的 console/runtime、表单、焦点、已有点击行为与 Tweaks 校验；复用隐藏浏览器 |

字体、动画和时间等可能引起差异，应固定视口、字体就绪状态和采样时点，区分原有问题与新回归。截图作为视觉证据或模型修复输入时必须实际查看，不能把“生成截图路径”算作视觉校验。

文本/单属性修改不为每条操作重新创建隐藏浏览器；按事务合并检查，必要时复用验证窗口。涉及响应式布局至少覆盖当前视口和移动视口。完整交互检查的成本与上下文缩减分别统计。

最多两轮有界修复，只回传失败项及相关局部依赖。仍失败则丢弃候选，保留原页，说明问题或扩大处理范围。校验通过不能保证审美符合意图，保留一键撤销和修改范围提示。

### 8.3 保存与崩溃恢复

一个逻辑事务包含源码、Tweaks 变化、索引版本、补丁 journal 与会话事件。`patch_applied` 只在提交成功后发出。

SQLite 事务与文件 rename 不构成同一原子事务。建议先写并校验不可变候选文件，再通过 SQLite CAS 事务提交 revision/源内容或版本文件指针、Tweaks 和 outbox。稳定路径的 `artifact.html`/metadata 作为可重建投影原子更新；失败时恢复任务按已提交 revision 重放投影。下一轮编辑以已提交源版本为准。

取消/失败遗留候选可以清理，不能覆盖正式产物。恢复时依据 journal 区分未提交候选和已提交但投影未完成的版本。

## 9. 并发、Tweaks 与撤销

- `artifactRevision` 仅随源码变更递增；不使用会因缩放、消息、进度变化而递增的会话 `seq` 代替。
- `tweakRevision` 单独管理。模型上下文记录目标相关参数的有效值与绑定关系，hash 针对明确的源码基线计算，不把临时渲染 DOM 当基线。
- 最小版本先用严格 CAS：源码版本变化则拒绝提交并重建上下文。参数变化检查相关 read/write set；冲突则重试，不覆盖用户新值。
- 后续允许对互不重叠的源码/样式依赖和 Tweaks 做可证明的 rebase。共享 CSS、父子目标、公共 token 或布局依赖发生变化时视为冲突。
- 用户继续调整无关参数时，候选提交后重新应用最新 overrides。模型只明确修改本轮需要改动的 key，保留其余用户设置与 orphan 值。
- `set_tweak`、声明/绑定调整与 HTML 补丁必须同事务。V1 结构替换不允许无声明地删除 Tweaks 目标。
- 补丁 journal 保存被修改片段/声明和参数前后状态。一次用户请求对应一次撤销；撤销也校验当前版本，不能用整页旧快照覆盖后来的无关调整。
- 应用期间切换方案或会话不会改变补丁所属产物；迟到结果不写入新会话或当前另一个方案。

## 10. 局部刷新与保留交互

保留现有 ACK、previewInstanceId、baseRevision 和快照恢复机制，但区分两类更新：

- 参数、文本、样式补丁：由受控运行代码更新已知节点/声明，不重建整个 iframe，保留滚动、输入值、焦点和其他节点身份。
- 结构补丁：先展示经过 L0/L1 的候选区域，标记“校验中”；通过完整验证后提交。不能把当前草稿运行代码原样用于正式交互页面，因为它会移除/阻止业务脚本。

现有预览差量主要按顶层区块计算；目标子区块修改还需扩展 keyed morph，优先使用稳定 nodeId。恢复完整快照属于预览传输恢复，不触发模型重新生成。

直接替换 innerHTML 会丢失直接绑定的事件监听器。纯样式/文本路径尽量保留原节点；结构变化只有在组件具备受控 mount/unmount 或已验证 keyed morph 能保留必要行为时热更新。不能证明交互仍有效时，定稿后加载一次完整新版本并恢复可恢复的滚动/焦点，不能承诺所有结构补丁都完全无刷新。

UI 显示“定位目标 → 生成修改 → 校验 → 已应用”，并突出实际修改区域。多条互不依赖的批注可分别成为有边界的事务依次刷新；单个原子事务不向正式页面发布半完成操作。

## 11. 文件与接口改造清单

| 文件 | 改造内容 |
|---|---|
| 新增 `src/shared/design-patch.ts` | 协议、操作 schema、上下文身份、范围/幂等约束 |
| 新增 `src/main/services/design/document-index.ts` | parse5 源码映射、稳定节点/区块索引、hash |
| 新增 `src/main/services/design/patch-context.ts` | 目标解析、CSS AST/依赖与上下文预算 |
| 新增 `src/main/services/design/patch-executor.ts` | 精简模型循环、受控补读、结构化补丁提交 |
| 新增 `src/main/services/design/patch-applier.ts` | 源码范围编辑、样式作用域、候选生成、版本冲突 |
| 新增/抽取 `src/main/services/design/artifact-validator.ts` | 现有完整性/浏览器验证与分级检查 |
| `src/shared/managed-design-session.ts` | `kind: patch`、版本化 target payload、运行事件 |
| `src/main/services/design/run-manager.ts`、`session-store.ts` | 调度、CAS、patch journal/outbox、撤销恢复 |
| `src/main/ipc/design.ts`、`src/preload/index.ts` | 入口路由与 payload；复用已有主进程边界 |
| `DesignView.tsx`、`types.ts` | Comment/Draw/聊天传目标身份，拆出 target resolver |
| `DesignPreviewFrame.tsx`、`design-progressive-preview.ts` | 局部正式编辑运行代码、节点补丁、ACK/恢复 |
| `src/shared/design-tweaks.ts` | 参数 read/write set、补丁事务中的有效值协调 |

渲染进程只提交用户目标、指令、视口及观测摘要。主进程从当前已提交产物取源码、核实目标和边界，不信任渲染进程传来的任意源码范围、文件路径或“可编辑范围”。

## 12. 实施顺序与验收

### P1：首个可用闭环

先接入单目标 Comment，支持 `set_text`、`set_style`、`set_tweak`，完成稳定 ID、精简执行器、L0/L1、必要布局检查、严格 CAS、提交/撤销和 ACK。此阶段即可验证局部输入/输出是否实际减少，避免先做复杂结构替换。

验收：修改一个按钮，另一个使用相同 class 的按钮不被误改；请求不包含整页源码或历史整页工具消息；参数、撤销、导出和重新打开一致；缺失/重复目标不误写。

### P2：区块级能力

加入 `replace_fragment`、依赖提取、结构与交互校验、响应式样式、多条 Comment/Draw 去重分组，接入现有后台会话和失败恢复。

验收：布局调整保留根 ID、Tweaks 与业务引用；结构修改后表单和点击行为有效；未授权区块源码保持一致；有自然布局联动时能区分与真实溢出。

### P3：覆盖率与性能

加入聊天区块目录定位、旧 HTML 兼容、有界补读/扩大范围、缓存、可证明的非重叠 rebase；通过特性开关逐步启用并保留完整链路。

### 必须覆盖的测试

- 定位：重复按钮、selector 漂移、旧版本锚点、多方案同名节点、无源码的动态元素、跨区块绘制。
- CSS：共享 class、inline/important、继承变量、多层 var、媒体与容器查询、伪类/伪元素、字体/动画、反向 selector 依赖、不可读外部 CSS。
- 合并：相同文本多处出现、重叠操作、表格/SVG 片段、未闭合 HTML、重复 ID、越界全局样式、保护脚本/绑定保留。
- 生命周期：连续提交、迟到响应、切换方案、取消、保存失败、崩溃重开、投影重放、ACK 丢失及幂等恢复。
- 交互：输入值/焦点/滚动保留、事件监听保留或受控重载、Tweaks 同时修改、撤销与导出一致。
- 模型请求审计：断言只加载本轮受限上下文；计算 system/history/tool result/repair 在内的完整输入与输出，防止旧 checkpoint 把全文带回。

用同一页面与同一指令，对比原完整链路和局部链路：改按钮色、改一段文字、改卡片间距、调整区块布局、改全局主题五类场景。记录模型输入/输出 tokens、补读/修复次数、首个有效修改可见耗时、总耗时 P50/P95、校验耗时、成功率、冲突率与完整链路回退率。

局部样式/文字修改应以明显降低输入输出量并保持结果正确为首轮目标。上线收益必须用真实模型测量；不将源码字符缩减比例直接当作端到端加速比例。
