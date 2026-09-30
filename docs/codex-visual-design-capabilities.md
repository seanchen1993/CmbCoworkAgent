# Codex 视觉设计能力引入建议

## 结论

当前 `design` 模块里最值得引入 Codex 相关能力的，不是完整的 HTML 设计生成器，而是“视觉反馈转结构化上下文”的交互层。

建议目标形态是：在 Codex 的浏览器预览、appshot、截图、设计稿或运行中的 UI 上，提供 comment、draw、note、element edit 等视觉反馈入口；然后把这些反馈转换成 Codex 可执行的上下文，让 Codex 修改真实源码、跑验证、展示代码 diff 和视觉 before/after。

一句话概括：

> 保留 Design 模块的视觉标注入口，引入 Codex 的执行、验证和 review 闭环。

## Codex 能力基线

根据 2026-07-04 重新拉取的 Codex manual，Codex 相关设计能力可以依托以下现有产品机制：

- Prompt loop：Codex 接收用户请求后，会循环执行模型调用、读文件、编辑文件、调用工具，直到任务完成或用户取消。
- Context：Codex prompt 可以包含相关文件、图片，IDE 扩展还会自动带上打开文件和选中文本范围。
- Review pane：Codex app 的 review 面板支持查看 Git diff，并可对具体 diff 行添加 inline comments，这些评论会作为下一轮上下文。
- Appshots：Codex app 可捕获 macOS 前台窗口，包含可见窗口图片和可用文本；适合分享设计、预览窗口、图片编辑器、错误状态或设置面板。
- Verification：manual 明确建议让 Codex 运行测试、lint、格式化、类型检查、行为确认和 diff review，而不是只生成代码。

这说明 Codex 本身已经具备“输入上下文 -> 修改源码 -> 验证 -> review”的骨架，但在 UI/产品设计任务上缺少更精确的视觉反馈入口。

## 本地 Design 模块已有能力

### 1. Comment 标注

相关文件：

- [`src/renderer/src/components/design/types.ts`](../src/renderer/src/components/design/types.ts)
- [`src/renderer/src/components/design/DesignComments.tsx`](../src/renderer/src/components/design/DesignComments.tsx)
- [`src/renderer/src/components/design/DesignView.tsx`](../src/renderer/src/components/design/DesignView.tsx)

现有能力：

- 用户可点击 iframe 里的设计预览，在页面坐标上创建 comment。
- comment 记录 `pageX`、`pageY`、`elementDesc`、`anchor`、`text`。
- comment pin 可在预览层保持位置，并支持编辑、发送。
- `buildCommentPrompt` 会把多个 comment 汇总成模型可执行的中文修改指令。

可迁移价值：

- 这是 Codex “视觉 inline comment”的基础。
- Codex 已经有 diff 行级 inline comments；Design comment 可以补上 DOM/截图区域级 inline comments。

### 2. Draw + Note 标注层

相关文件：

- [`src/renderer/src/components/design/DesignDraw.tsx`](../src/renderer/src/components/design/DesignDraw.tsx)
- [`src/renderer/src/components/design/drawUtils.ts`](../src/renderer/src/components/design/drawUtils.ts)
- [`src/renderer/src/components/design/DesignView.tsx`](../src/renderer/src/components/design/DesignView.tsx)

现有能力：

- 用户可以在预览上自由画线、圈区域。
- 支持 note 模式，可在任意位置放置明确文本指令。
- stroke 会被抽样匹配附近 DOM 元素。
- stroke 和 note 都支持 anchor 解析，页面滚动或布局变化后可尝试重新定位。
- `buildDrawPrompt` 会把画线范围、附近元素、note 文本、锚点信息整理成可执行 prompt。

可迁移价值：

- 很多视觉问题无法用精确文字描述，draw 是低成本表达方式。
- 适合接入 Codex appshot、浏览器预览、截图附件。
- 对“这里太挤”“这块层级不对”“这个区域视觉太重”这类问题非常有效。

### 3. DOM-aware Anchor

相关类型：

- `DesignElementAnchor`
- `CommentItem`
- `DrawStroke`
- `DrawNote`

现有 anchor 字段：

```ts
interface DesignElementAnchor {
  selector: string
  tagName: string
  label?: string
  role?: string
  text?: string
  screenLabel?: string
  offsetXRatio: number
  offsetYRatio: number
}
```

可迁移价值：

- 比纯截图坐标更稳定。
- 比纯 DOM selector 更符合用户视觉意图。
- 可以作为 Codex 从“视觉反馈”追踪到“源码修改”的中间层。

建议增强为：

```ts
interface VisualAnchor {
  selector?: string
  domPath?: string
  role?: string
  text?: string
  tagName?: string
  bbox?: { x: number; y: number; width: number; height: number }
  offsetRatio?: { x: number; y: number }
  screenshotCropHash?: string
  sourceFileHint?: string
  componentNameHint?: string
}
```

### 4. Element Props Panel

相关文件：

- [`src/renderer/src/components/design/ElementPropsPanel.tsx`](../src/renderer/src/components/design/ElementPropsPanel.tsx)
- [`src/renderer/src/components/design/DesignView.tsx`](../src/renderer/src/components/design/DesignView.tsx)

现有能力：

- 用户可选中 iframe 中的 DOM 元素。
- 面板展示 computed style。
- 支持实时修改字体、字号、颜色、行高、间距、透明度、宽高、padding、margin、border 等属性。
- 修改通过 `postMessage` 写回 iframe 中选中的元素。

可迁移价值：

- 这是 Codex 视觉设计能力里最接近“直接操控 UI”的部分。
- 不建议只保留运行时 style patch，而应把用户操作记录成结构化修改意图，然后交给 Codex 写回真实源码。

示例：

```ts
interface VisualStyleEdit {
  anchor: VisualAnchor
  property: "fontSize" | "paddingTop" | "color" | "borderRadius"
  before: string | number
  after: string | number
  userIntent?: string
}
```

### 5. Prompt Builder

相关函数：

- `buildCommentPrompt`
- `buildDrawPrompt`

现有能力：

- 将视觉标注转成自然语言 prompt。
- 包含元素描述、坐标、锚点、附近元素、note 内容。

可迁移价值：

- 可以先作为 Codex follow-up message 的生成器。
- 后续应从“纯文本 prompt builder”升级成“结构化 context builder”。

建议输出不只是 prompt，而是：

```ts
interface VisualFeedbackContext {
  summary: string
  annotations: VisualAnnotation[]
  screenshot?: string
  domSnapshot?: unknown
  selectedFiles?: string[]
  verificationHints?: string[]
}
```

## 建议引入的 Codex 设计能力

### 能力一：Visual Feedback Mode

目标：

在 Codex 的 UI 预览、浏览器、appshot、截图或设计稿上叠加一个视觉反馈层，支持 comment、draw、note。

用户体验：

1. 用户打开本地预览或 appshot。
2. 点击“标注”进入 Visual Feedback Mode。
3. 在页面上点选、圈选、写 note。
4. 点击“交给 Codex 修改”。
5. Codex 根据标注修改源码。

需要复用：

- `DrawLayer`
- `DrawActionBar`
- `CommentPin`
- `CommentDraftInput`
- anchor 解析工具
- prompt/context builder

### 能力二：视觉标注变成 Codex review guidance

Codex 已有 diff inline comments，Design 模块可以扩展出 visual inline comments。

建议映射：

| Codex review | Visual design |
| --- | --- |
| diff file | preview/appshot/screenshot |
| diff line | DOM element / bbox / crop |
| inline comment | visual comment / note |
| address comments | apply visual feedback |
| code diff | code diff + visual diff |

关键点：

- 每条标注都有独立 ID。
- 每条标注有状态：`pending`、`applying`、`resolved`、`unresolved`、`stale`。
- Codex 完成后可逐条说明哪些已经处理，哪些无法确认。

### 能力三：直接编辑属性并落到源码

Element Props Panel 可以变成 Codex 的“视觉参数编辑器”。

当前 Design 模块是在 iframe DOM 上直接改 style；Codex 场景下应改为：

1. 用户在预览中选元素。
2. 用户在属性面板里调整值。
3. 系统记录结构化 style edit。
4. Codex 定位相关组件和样式文件。
5. Codex 修改源码。
6. 刷新预览并验证视觉结果。

这样可以避免“预览改了但源码没改”的断层。

### 能力四：Before/After Visual Review

Codex 的 review pane 解决了代码 diff，但设计任务还需要视觉 diff。

建议在一次视觉修改后展示：

- before screenshot
- after screenshot
- 代码 diff
- 标注处理状态
- Codex 自检摘要

Codex 自检可回答：

- 是否每条标注都被处理？
- 哪些标注存在歧义？
- 是否出现新的溢出、遮挡、布局错位？
- 是否有未预期的大范围变化？

### 能力五：Screenshot/Appshot + Anchor 混合上下文

Appshot 本身只能提供图片和可用文本；Design 模块可以补上：

- 用户画线范围
- 用户 comment 文本
- DOM selector
- 可见文本
- 元素 bbox
- 截图 crop
- 当前 URL / route
- 相关源码文件 hint

这会让 Codex 处理 UI 问题时更接近“看得到，也找得到代码”。

## 推荐数据模型

### VisualAnnotation

```ts
type VisualAnnotationKind = "comment" | "draw" | "note" | "style-edit"
type VisualAnnotationStatus = "pending" | "applying" | "resolved" | "unresolved" | "stale"

interface VisualAnnotation {
  id: string
  kind: VisualAnnotationKind
  text?: string
  anchor?: VisualAnchor
  pagePoint?: { x: number; y: number }
  bbox?: { x: number; y: number; width: number; height: number }
  stroke?: { points: Array<{ x: number; y: number }>; color: string; width: number }
  styleEdit?: VisualStyleEdit
  nearbyElements?: string[]
  createdAt: number
  status: VisualAnnotationStatus
}
```

### VisualFeedbackRun

```ts
interface VisualFeedbackRun {
  id: string
  threadId: string
  source: "browser-preview" | "appshot" | "screenshot" | "design-artifact"
  annotations: VisualAnnotation[]
  beforeScreenshot?: string
  afterScreenshot?: string
  promptSummary: string
  changedFiles?: string[]
  verification?: {
    checksRun: string[]
    resolvedAnnotationIds: string[]
    unresolvedAnnotationIds: string[]
    notes: string[]
  }
}
```

## 推荐执行流程

```text
用户打开预览
  ↓
开启 Visual Feedback Mode
  ↓
添加 comment / draw / note / style edit
  ↓
构建 VisualFeedbackContext
  ↓
Codex 读取相关文件和 DOM/截图上下文
  ↓
Codex 修改源码
  ↓
运行检查：typecheck / lint / test / browser screenshot
  ↓
展示代码 diff + before/after + 标注处理状态
  ↓
用户继续在视觉层或 diff 层追加反馈
```

## 实施路线

### P0：抽离视觉反馈组件

目标：

- 从 `design` 模块中抽出通用的 visual feedback 层。
- 不绑定 HTML artifact 生成器。

建议新目录：

```text
src/renderer/src/components/visual-feedback/
  VisualFeedbackLayer.tsx
  VisualCommentPin.tsx
  VisualDrawLayer.tsx
  VisualActionBar.tsx
  VisualPropsPanel.tsx
  visualTypes.ts
  visualAnchors.ts
  visualContextBuilder.ts
```

### P1：接入 Codex 浏览器预览

目标：

- 在本地 dev server / browser preview 上支持标注。
- 将标注生成 follow-up prompt。
- 第一版可以先不做源码定位，只把 screenshot + annotation summary 交给 Codex。

验收标准：

- 用户能圈出预览区域并提交给 Codex。
- Codex 能根据标注修改源码。
- 修改后 review pane 能看到代码 diff。

### P2：加入 DOM anchor 和源码 hint

目标：

- 对可访问 DOM 的预览页面，采集 selector、role、text、bbox。
- 结合 source map、React component stack 或启发式搜索，给出源码文件 hint。

验收标准：

- Codex 能更稳定定位到对应组件。
- 用户标注“这个按钮”时，Codex 不需要大范围猜测。

### P3：加入视觉验证

目标：

- 修改前后自动截图。
- 展示 before/after。
- 对每条标注给出 resolved/unresolved 状态。

验收标准：

- 用户不用只看代码 diff，也能看视觉结果。
- Codex 能说明哪些标注已处理。

### P4：增强 appshot 场景

目标：

- 支持用户对 appshot 添加视觉标注。
- 对不可访问 DOM 的窗口，退化为 screenshot crop + OCR/text + 坐标。

验收标准：

- 即使不是本地网页，也能把视觉问题准确传给 Codex。

## 不建议直接引入的部分

### 不建议复制完整 HTML 生成器

`src/main/ipc/design.ts` 里的 Design system prompt 和 HTML artifact 生成能力，更适合独立设计生成器，不适合直接塞进 Codex 主工作流。

原因：

- Codex 的强项是修改真实 repo，而不是生成孤立 HTML。
- Codex review、diff、测试、浏览器验证都围绕真实文件工作。
- 直接复制 HTML 生成器会让能力边界混乱。

更合适的做法：

- 抽视觉反馈层。
- 抽 prompt/context builder。
- 保留 Codex 的 repo 修改与 review 机制。

### 不建议只做运行时样式 patch

Element Props Panel 当前会直接改 iframe 内 DOM style。这对设计探索很快，但对 Codex 不够。

Codex 场景下必须落到源码：

- CSS module / Tailwind class / styled-components / inline style / component props
- 修改后可 review
- 修改后可 commit
- 修改后可复现

## 风险与注意点

### Anchor 失效

布局变化后 selector 或坐标可能失效。

缓解：

- selector、DOM path、text、role、bbox、crop hash 多信号定位。
- 标记 `stale` 状态，而不是静默错误应用。

### 用户意图歧义

画线只表达区域，不一定表达具体修改。

缓解：

- draw 默认要求用户补充一句话；无补充时只作为关注区域。
- note 优先级高于 stroke。
- Codex 在不确定时回问或给出假设。

### 大范围误改

视觉 prompt 容易导致模型顺手重构页面。

缓解：

- prompt/context 中明确“只处理标注区域，未标注区域尽量保持不变”。
- review 阶段展示 changed files 和 visual diff。
- 对大批量标注拆成多轮。

### 源码定位难

DOM 元素不一定能直接映射到 React/Vue/Svelte 源码。

缓解：

- 优先支持 dev 模式下的 component stack/source map。
- 无法定位时退化到全文搜索可见文本、class、aria-label。
- 让 Codex 先说明定位依据，再修改。

## 最小可行版本

第一版不要做太大，建议只做这条主链路：

```text
Browser preview
  → draw/comment/note
  → 生成视觉反馈上下文
  → Codex follow-up prompt
  → 修改源码
  → 展示代码 diff
```

暂缓：

- 完整视觉 diff
- 自动 resolved 判定
- appshot 标注
- source map 精确定位
- 属性面板源码回写

这样能最快验证一个关键假设：

> 用户用视觉标注描述 UI 问题，是否能显著提升 Codex 修改前端界面的准确性。

