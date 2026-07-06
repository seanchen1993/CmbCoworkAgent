# CMBDevClaw 视觉标注改 UI 实现方案

## 目标

把 `design` 模块里已经验证过的 comment、draw、DOM anchor 能力，整合进 CMBDevClaw 当前工作流，让用户可以在 Claw 的预览界面上直接标注 UI 问题，并由 Claw Agent 修改当前 workspace 里的真实源码。

这不是把功能做到 OpenAI Codex 里，也不是复制 Codex 产品 UI；Codex 只作为工作模式参考。最终能力属于 CMBDevClaw：

```text
预览标注 -> 生成结构化视觉上下文 -> 提交当前 Claw 会话 -> Agent 修改源码 -> Git diff/review -> 处理摘要
```

## 核心原则

- 视觉输入来自现有 `design` 模块能力。
- 执行、文件修改、检查、Git diff 继续走 Claw 现有 Agent 工作流。
- 不复制 `design` 的完整 HTML 生成器。
- 不新建一套 Agent 通道。
- 第一版先保证闭环，不追求自动视觉判断完全准确。
- 标注提交后不立即清空，要保留状态，便于后续 review。

## Codex 借鉴点

这些不是要接入 Codex，而是借鉴 Codex 的产品机制：

1. **Inline feedback**

   Codex 可以对 diff 行留言。Claw 这里扩展为对预览区域、DOM 元素、截图坐标留言。

2. **Thread context**

   用户反馈进入同一个 thread，成为下一轮 Agent 工作上下文。

3. **Review loop**

   Agent 修改后不是结束，要看 Git diff、继续反馈或确认。

4. **Verification**

   Agent 不只改代码，还要尽量运行检查，并说明验证结果。

5. **Screenshot context**

   视觉问题需要截图、坐标、crop、DOM 信息共同描述。

6. **Task status**

   每条标注是可追踪任务，不是一句临时 prompt。

## 现有可复用代码

### Design 标注能力

- [`src/renderer/src/components/design/DesignDraw.tsx`](../src/renderer/src/components/design/DesignDraw.tsx)
- [`src/renderer/src/components/design/DesignComments.tsx`](../src/renderer/src/components/design/DesignComments.tsx)
- [`src/renderer/src/components/design/drawUtils.ts`](../src/renderer/src/components/design/drawUtils.ts)
- [`src/renderer/src/components/design/types.ts`](../src/renderer/src/components/design/types.ts)
- [`src/renderer/src/components/design/DesignView.tsx`](../src/renderer/src/components/design/DesignView.tsx)

### Claw 会话与提交能力

- [`src/renderer/src/components/chat/ChatContainer.tsx`](../src/renderer/src/components/chat/ChatContainer.tsx)
- [`src/renderer/src/lib/thread-context.tsx`](../src/renderer/src/lib/thread-context.tsx)
- [`src/renderer/src/lib/electron-transport.ts`](../src/renderer/src/lib/electron-transport.ts)

### Claw 预览能力

- [`src/renderer/src/components/tabs/FileViewer.tsx`](../src/renderer/src/components/tabs/FileViewer.tsx)
- [`src/renderer/src/components/chat/previews/HtmlPreview.tsx`](../src/renderer/src/components/chat/previews/HtmlPreview.tsx)

### Claw Git review 能力

- [`src/renderer/src/components/chat/AgentGitCommitDialog.tsx`](../src/renderer/src/components/chat/AgentGitCommitDialog.tsx)
- 当前 Chat 输入区已有“检测到文件变更，可打开 Git 面板查看”的提示。

## MVP 范围

MVP 只做最短可用闭环：

1. 在 Claw 的 HTML/网页预览里显示“标注修改”入口。
2. 支持 comment 点选和 draw 圈画两种标注。
3. 采集基础 DOM anchor 和坐标信息。
4. 将标注转换成增强 prompt。
5. 复用当前 `ChatContainer` 提交流提交到当前 thread。
6. Agent 修改当前 workspace 真实源码。
7. 修改后沿用现有 Git 变更提示和 diff 面板。
8. Agent 最终按标注 ID 汇报处理结果。

MVP 暂不做：

- Element Props Panel 源码回写。
- 自动 before/after 像素 diff。
- 自动解析 Agent 回复更新标注状态。
- appshot 标注。
- source map 精确源码定位。
- React component stack 精确映射。
- 多人协作标注。

## MVP 用户流程

```text
用户打开 HTML/网页预览
  ↓
点击“标注修改”
  ↓
Claw 进入视觉标注模式
  ↓
用户添加 comment / draw，并补充修改说明
  ↓
点击“交给 Claw 修改”
  ↓
Claw 生成增强 prompt 并提交当前 thread
  ↓
Agent 读取源码并修改
  ↓
Claw 显示 Git 变更提示
  ↓
用户打开 Git 面板查看 diff
  ↓
Agent 最终按标注 ID 总结处理结果
```

## MVP 工程结构

新增目录：

```text
src/renderer/src/components/visual-edit/
  visual-edit-types.ts
  VisualEditLayer.tsx
  VisualDrawLayer.tsx
  VisualCommentPin.tsx
  VisualEditToolbar.tsx
  visual-anchor.ts
  visual-context-builder.ts
  visual-edit-store.ts
  useVisualEditSubmit.ts
```

复用提交锁：

```text
src/renderer/src/lib/submit-in-flight-lock.ts
```

`ChatContainer` 与视觉标注提交共享同一个 thread 级 submit-in-flight lock，避免对话输入和视觉标注同时打出两路 run。

## MVP 数据模型

### ClawVisualAnchor

```ts
export interface ClawVisualAnchor {
  selector?: string
  tagName?: string
  role?: string
  text?: string
  className?: string
  screenLabel?: string
  bbox?: {
    x: number
    y: number
    width: number
    height: number
  }
  offsetRatio?: {
    x: number
    y: number
  }
  targetPath?: string
  targetUrl?: string
}
```

### ClawVisualAnnotation

```ts
export type ClawVisualAnnotationKind = "comment" | "draw"

export type ClawVisualAnnotationStatus =
  | "draft"
  | "pending"
  | "submitted"
  | "resolved"
  | "unresolved"
  | "stale"

export interface ClawVisualAnnotation {
  id: string
  kind: ClawVisualAnnotationKind
  text?: string
  pageX?: number
  pageY?: number
  bbox?: {
    x: number
    y: number
    width: number
    height: number
  }
  anchor?: ClawVisualAnchor
  stroke?: {
    points: Array<{ x: number; y: number }>
    color: string
    width: number
  }
  nearbyElements?: string[]
  status: ClawVisualAnnotationStatus
  createdAt: number
}
```

### ClawVisualFeedbackContext

```ts
export interface ClawVisualFeedbackContext {
  threadId: string
  targetKind: "html-preview" | "file-preview" | "browser-preview"
  targetPath?: string
  targetUrl?: string
  annotations: ClawVisualAnnotation[]
  beforeScreenshot?: string
  submittedAt: number
}
```

## MVP 组件职责

### VisualEditLayer

职责：

- 覆盖在预览容器上方。
- 管理当前工具模式。
- 接收并更新外部标注列表。
- 采集 DOM anchor、坐标、画线和用户说明。
- 对外回调结构化视觉反馈上下文。

主要 props：

```ts
interface VisualEditLayerProps {
  threadId: string
  targetKind: "html-preview" | "file-preview" | "browser-preview"
  targetPath?: string
  targetUrl?: string
  active: boolean
  zoom?: number
  scrollX?: number
  scrollY?: number
  onClose: () => void
  onSubmit: (context: ClawVisualFeedbackContext) => void
}
```

### VisualDrawLayer

职责：

- 支持画线。
- draw 完成后要求补充修改说明。
- 将 stroke 和说明转成 annotation。

复用来源：

- 从 `DesignDraw.tsx` 抽核心 pointer 逻辑。

### VisualCommentPin

职责：

- 展示 comment pin。
- 支持输入、编辑、删除。

复用来源：

- 从 `DesignComments.tsx` 抽 pin + popover。

### VisualEditToolbar

职责：

- 切换工具。
- 撤销。
- 清空。
- 提交给 Claw。
- 退出标注模式。

建议按钮：

```text
批注 | 画线 | 撤销 | 清空 | 交给 Claw 修改 | 退出
```

### visual-anchor.ts

职责：

- 从 DOM 元素和点位生成 anchor。
- 生成可读元素标签。
- 采集附近元素。

建议函数：

```ts
getElementAnchor(element: Element, point: { x: number; y: number }): ClawVisualAnchor
getElementLabel(element: Element | null): string
getSelector(element: Element): string
getElementBBox(element: Element): ClawVisualAnchor["bbox"]
collectNearbyElements(doc: Document, points: Array<{ x: number; y: number }>): string[]
```

### visual-context-builder.ts

职责：

- 把标注转换成 Agent prompt。
- 输出用户可读摘要。

建议函数：

```ts
buildVisualEditPrompt(context: ClawVisualFeedbackContext): string
buildVisualAnnotationSummary(annotation: ClawVisualAnnotation, index: number): string
```

## MVP Prompt 模板

```text
用户在当前 Claw 预览界面上做了视觉标注。请根据这些标注修改当前 workspace 中的真实源码。

要求：
- 只修改标注涉及的区域。
- 未标注区域尽量保持不变。
- 优先根据 DOM anchor、元素文本、附近元素和坐标定位相关源码。
- 修改后运行必要检查，例如 typecheck、lint、test 或项目中合适的验证命令。
- 最终回复必须按标注 ID 总结处理结果。

预览目标：
- 类型：{targetKind}
- 文件：{targetPath}
- URL：{targetUrl}

标注列表：
{annotationLines}

最终回复格式：
标注处理结果：
- A1: resolved/unresolved/stale，说明...
- A2: resolved/unresolved/stale，说明...

修改文件：
- ...

验证：
- ...
```

annotation line 示例：

```text
[A1] comment: 元素 button.primary "提交"；坐标 x:320, y:188；用户意见：按钮太高，改紧凑一点。
[A2] draw: 区域 x:120-360, y:400-520；附近元素：card.stats, h2 "趋势"；用户意见：视觉层级太重，降低压迫感。
```

## MVP 接入点

### 1. 接入 HtmlPreview

在 `HtmlPreview` 外层加一个相对定位容器：

```tsx
<div className="relative h-full">
  <HtmlPreview ... />
  {visualEditActive && (
    <VisualEditLayer
      threadId={threadId}
      targetKind="html-preview"
      targetPath={filePath}
      active={visualEditActive}
      onClose={() => setVisualEditActive(false)}
      onSubmit={handleSubmitVisualFeedback}
    />
  )}
</div>
```

入口按钮放在预览右上角：

```text
标注修改
```

### 2. 复用 ThreadProvider 提交

不要新建 Agent IPC，也不要依赖文件 tab 下已卸载的 `ChatContainer`。当前实现由 `FileViewer` 接入 `useVisualEditSubmit(threadId)`，直接复用 `ThreadProvider` 中保持的同一个 thread stream：

```ts
const { submitVisualFeedback, canSubmitVisualFeedback, submitDisabledReason } =
  useVisualEditSubmit(threadId)
```

`HtmlPreview` 通过可选 `visualEdit` prop 接收：

```ts
visualEdit={{
  threadId,
  targetKind: "html-preview",
  targetPath: displayPath,
  submitDisabled: !canSubmitVisualFeedback,
  submitDisabledReason,
  annotations,
  onAnnotationsChange,
  onSubmit: submitVisualFeedback
}}
```

`useVisualEditSubmit` 负责：

- 与 `ChatContainer` 共享 submit-in-flight lock。
- 对齐 history loading、scheduled task、模型可用性、workspace、pending approval 等前置校验。
- pending approval 场景下，视觉提交选择阻止并提示用户先处理审批卡片；主聊天的新消息路径会自动 reject 部分 pending approval，这是刻意保留的产品差异。
- 聊天气泡只显示摘要，例如 `提交了 3 条视觉标注（index.html）`。
- 完整结构化 prompt 只通过 `stream.submit` 发给 Agent。
- 写入 message timing，并在首条消息时生成标题。
- 提交后切回 agent tab。

### 3. 标注状态

标注列表由 `visual-edit-store.ts` 按 `threadId + targetKind + targetPath/targetUrl` 保存，避免文件 tab 切回 agent 后丢失标注状态。Store 是运行期内存 Map：空列表会删除 key，并保留最近 100 个目标，长期持久化和跨重启恢复放到扩展阶段。

MVP 前端只维护这几个状态：

```text
draft -> pending -> submitted
```

再次提交时只提交 `pending` 标注，已经 `submitted` 的历史标注保留在预览里但不会重复进入 prompt。

Agent 完成后的：

```text
resolved / unresolved / stale
```

第一版可以只显示在 Agent 最终回复里，不强制前端解析。

## MVP 具体任务拆分

### 任务 1：抽类型

新增 `visual-edit-types.ts`，定义：

- `ClawVisualAnchor`
- `ClawVisualAnnotation`
- `ClawVisualFeedbackContext`

验收：

- TypeScript 编译通过。
- 不影响现有 `design` 模块。

### 任务 2：抽 DrawLayer

新增 `VisualDrawLayer.tsx`。

保留：

- pointer down/move/up
- stroke path
- draw 说明 draft
- wheel scroll 透传

验收：

- 能在普通 div 上画线。
- 能输出 stroke annotation。

### 任务 3：抽 CommentPin

新增 `VisualCommentPin.tsx`。

保留：

- pin 展示
- popover 输入
- 编辑
- 删除

验收：

- 能展示多个 pin。
- pin 不被父容器边界挤出不可见区域。

### 任务 4：实现 VisualEditToolbar

新增 `VisualEditToolbar.tsx`。

验收：

- 能切换 comment/draw。
- 能撤销、清空、提交、退出。

### 任务 5：实现 VisualEditLayer

新增 `VisualEditLayer.tsx`。

验收：

- 能叠加到预览容器。
- 能添加 comment/draw 两种标注。
- 能维护外部 annotation list。

### 任务 6：实现 anchor 采集

新增 `visual-anchor.ts`。

验收：

- 点击 DOM 元素后可得到 selector、tagName、text、bbox。
- iframe 场景可正常工作。

### 任务 7：实现 prompt builder

新增 `visual-context-builder.ts`。

验收：

- 给定 annotations 能生成稳定中文 prompt。
- prompt 包含标注 ID、元素信息、坐标、用户意见。

### 任务 8：接入 HtmlPreview/FileViewer

在预览 UI 上加“标注修改”入口。

验收：

- HTML 预览可进入标注模式。
- 不影响普通文件预览。

### 任务 9：接入 ThreadProvider 提交

新增 `useVisualEditSubmit.ts`，由 `FileViewer` 传给 `HtmlPreview` 的 `visualEdit.onSubmit` 调用。

验收：

- 点击“交给 Claw 修改”后，当前 thread 里出现用户消息。
- Agent 正常开始处理。
- 与 `ChatContainer` 共享 submit lock。
- history loading、scheduled task、模型可用性、workspace、pending approval 等前置校验正常。

### 任务 10：验证 Git 变更提示

Agent 修改源码后，复用现有 Git 变更提示。

验收：

- 修改完成后可打开 Git 面板看 diff。

## MVP 验收标准

必须满足：

1. HTML/网页预览里能打开“标注修改”。
2. 能添加 comment、draw。
3. 每条标注有稳定 ID。
4. 能生成视觉标注 prompt。
5. 能提交到当前 Claw thread。
6. Agent 能修改 workspace 源码。
7. Claw 能显示 Git 变更。
8. Agent 最终按标注 ID 总结处理结果。

不要求：

- 自动判断每条标注是否真的解决。
- 完整 before/after 图片对比。
- 精确源码组件映射。
- 属性面板直接回写源码。

## 后续扩展

### 扩展 1：Before/After 截图

目标：

- 提交标注前保存 before screenshot。
- Agent 完成后刷新预览并保存 after screenshot。
- 在标注面板展示两张图。

实现建议：

- 优先截预览容器，不截全屏。
- 如果 iframe 跨域或截图受限，退化为保存 HTML/path + 标注坐标。

验收：

- 用户能对比修改前后视觉结果。

### 扩展 2：自动解析处理摘要

目标：

- Agent 回复后自动识别：
  - `A1: resolved`
  - `A2: unresolved`
  - `A3: stale`
- 更新前端 annotation 状态。

实现建议：

- 先用严格文本格式。
- 后续让 Agent 输出 JSON block。

验收：

- 标注列表能自动显示处理状态。

### 扩展 3：Element Props Panel 源码回写

目标：

- 引入 `ElementPropsPanel` 的视觉调参能力。
- 用户调整字号、间距、颜色、圆角等属性。
- Claw 不直接 patch DOM，而是生成 style edit，让 Agent 写回源码。

数据结构：

```ts
interface ClawVisualStyleEdit {
  anchor: ClawVisualAnchor
  property: string
  before: string | number
  after: string | number
}
```

验收：

- 用户调一个按钮的 padding，Agent 能修改真实 CSS/组件源码。

### 扩展 4：源码定位增强

目标：

- 让 Agent 更快定位对应组件和文件。

可提供 hint：

- targetPath
- targetUrl
- route
- selector
- className
- visible text
- aria-label
- component name hint
- source map hint

验收：

- Agent 修改 UI 时搜索范围更小。
- 错改无关文件概率降低。

### 扩展 5：Browser Preview 支持

目标：

- 不只支持 HTML 文件预览，也支持本地 dev server / browser preview。

实现建议：

- 复用同一套 `VisualEditLayer`。
- iframe 可访问时采集 DOM anchor。
- 不可访问时退化为截图坐标。

验收：

- React/Vue/业务项目运行页面可直接标注修改。

### 扩展 6：视觉验证

目标：

- Agent 修改后自动检查视觉问题。

检查项：

- 文本溢出。
- 元素重叠。
- 标注区域是否发生变化。
- 未标注区域是否大范围变化。
- 移动端视口是否破版。

验收：

- Agent 最终回复中包含视觉验证结果。
- 明显布局问题能被自动发现。

### 扩展 7：视觉 diff

目标：

- 对 before/after 做局部对比。

实现建议：

- 先做标注区域 crop 对比。
- 再做整页 screenshot diff。
- 对未标注区域大变化给 warning。

验收：

- 用户能看到标注区域改动。
- 非目标区域大变化会被提醒。

### 扩展 8：Appshot/截图标注

目标：

- 用户可以对截图或 appshot 做标注。

限制：

- 没有 DOM anchor。
- 只能用坐标、crop、OCR、用户说明。

验收：

- 非网页预览也能通过视觉标注给 Claw 提供上下文。

### 扩展 9：标注历史

目标：

- 标注作为 thread history 的一部分保存。
- 切回 thread 后能看到过去的视觉反馈。

实现建议：

- 存到 thread metadata 或独立本地 store。
- 和 before/after screenshot 路径关联。

验收：

- 重启应用后标注记录仍可查看。

### 扩展 10：设计偏好沉淀

目标：

- 对重复出现的视觉反馈沉淀成用户偏好或项目规范。

例子：

- “按钮不要太圆”
- “后台系统不要大面积渐变”
- “卡片间距保持紧凑”

实现建议：

- 从 resolved 标注中提取偏好候选。
- 用户确认后写入项目 `AGENTS.md`、Claw memory 或设计规范文件。

验收：

- 后续同项目 UI 修改能自动遵守这些偏好。

## 风险与规避

### 风险 1：标注位置漂移

原因：

- 页面滚动。
- zoom。
- DOM 重排。

规避：

- 坐标 + DOM anchor 双通道。
- anchor 找不到时标记 `stale`。

### 风险 2：Agent 大范围误改

原因：

- 视觉 prompt 太宽泛。

规避：

- prompt 明确“只处理标注区域”。
- 多条复杂标注建议拆分提交。
- review 阶段必须看 diff。

### 风险 3：DOM 到源码定位不准

原因：

- class hash。
- 组件嵌套。
- 构建产物和源码不一致。

规避：

- 第一版让 Agent 结合全文搜索定位。
- 后续加 source map、component stack、route hint。

### 风险 4：截图能力受限

原因：

- iframe 跨域。
- Electron 安全限制。

规避：

- MVP 不强依赖 screenshot。
- 先用坐标、DOM anchor、HTML path。

## 推荐实施顺序

```text
1. 抽 visual-edit 类型
2. 抽 draw/comment UI
3. 做 VisualEditLayer
4. 做 prompt builder
5. 接 HtmlPreview/FileViewer
6. 接 ChatContainer 提交
7. 验证 Agent 修改源码 + Git diff
8. 再做 before/after
9. 再做状态解析
10. 再接 Element Props Panel
```

## 最终形态

长期目标不是一个单独的设计工具，而是 Claw 的 UI 修改增强入口：

```text
用户用视觉方式表达问题
Claw 用 Agent 能力修改真实代码
Git diff 提供可审查结果
视觉 before/after 提供直观确认
标注状态提供任务闭环
```
