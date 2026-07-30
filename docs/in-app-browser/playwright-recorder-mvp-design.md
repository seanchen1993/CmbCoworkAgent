# Playwright 测试生成双模式技术方案（AI + 人工）

更新时间：2026-07-30

## 1. 文档目标

本文档把 Playwright 几份最相关的公开文档合并为一份面向当前仓库的实现方案，目标是指导我们在内置浏览器里做一套统一的测试生成系统，同时支持：

- `AI 录制`：AI 通过 MCP / Playwright 工具操作页面，系统把成功执行过的动作沉淀成 Playwright 脚本。
- `人工录制`：用户在内置浏览器里手动操作，系统采集真实交互并生成 Playwright 脚本。

最终产物不是单一“录制器”，而是一套统一的：

- 动作模型
- signal 模型
- locator 生成器
- 代码生成器
- 调试与导出能力

## 2. 合并了哪些 Playwright 文档

本文综合了以下本地文档：

- `playwright-main/docs/src/codegen.md`
- `playwright-main/docs/src/locators.md`
- `playwright-main/docs/src/api/class-framelocator.md`
- `playwright-main/docs/src/test-assertions-js.md`
- `playwright-main/docs/src/browser-contexts.md`
- `playwright-main/docs/src/trace-viewer.md`

合并后的结论如下：

1. `codegen` 说明了录制产品形态：`Record new`、`Record at cursor`、`Pick locator`、录制断言。
2. `locators` 说明了公开 API 层最推荐的定位方式：优先使用用户可感知、语义化的 locator。
3. `FrameLocator` 说明了 iframe 不是边角问题，而是 locator 设计里的一级能力。
4. `assertions` 说明了生成脚本时，断言不应只是字符串比对，而要尽量落到 Playwright 的 auto-retrying `expect(...)`。
5. `browser-contexts` 说明了 Playwright 默认假设“每个测试一个全新 context”，这和我们的共享内置浏览器模型不同。
6. `trace-viewer` 说明了“录完如何调试”应该是方案的一部分，而不是事后再补。

## 3. 从 Playwright 文档提炼出来的产品要求

### 3.1 我们真正要做的不是“录制器”

更准确的产品定义是：

`Playwright Test Generation`

因为用户最终要的是：

- 一段可读的 Playwright 测试代码
- 一组可编辑、可回放、可继续追加的步骤
- 一份能调试、能导出、能分享的测试草稿

录制只是输入方式，不是最终目标。

### 3.2 必须支持双模式

只做 `AI 录制` 不够，因为：

- 它记录的是 AI 选择的路径，不一定是用户真实操作路径。
- AI 可能会跳步骤、走捷径、换 locator。
- 对“我自己走一遍，你帮我忠实记下来”的场景不合适。

只做 `人工录制` 也不够，因为：

- 起步慢，不适合从自然语言直接出初稿。
- 对长流程、探索式页面、复杂后台不够高效。
- 很难让 Agent 帮忙先“摸路”再产出脚本。

所以我们的定位应该是：

- `AI 录制`：负责“从意图快速生成脚本初稿”
- `人工录制`：负责“忠实保留真实操作路径”

两条路径汇合到同一套共享内核。

## 4. Playwright 的核心启发

### 4.1 录制不是直接写代码，而是先归一化动作

Playwright 的录制链路不是“浏览器事件 -> 直接拼代码”，而是：

1. 先收集动作和结构性信号
2. 再做去重、归并、归因
3. 最后交给 language generator 产出代码

这意味着我们也应该坚持：

- `Producer` 只负责采集
- `Collector` 负责收敛
- `Codegen` 负责输出

### 4.2 公开文档讲的是原则，源码里实现更细

`codegen.md` 里对外说的是“优先 role、text、test id”，但源码里实际规则更细，候选还包含：

- `testId`
- `role + accessible name`
- `placeholder`
- `label`
- `alt`
- `text`
- `title`
- `css fallback`
- `nth`

对我们来说，正确理解应该是：

- 文档给的是产品原则
- `packages/injected/src/selectorGenerator.ts` 给的是工程实现细节

### 4.3 iframe 和断言必须一开始就预留

`FrameLocator` 文档和 `test-assertions-js.md` 都说明了两件事：

- 不处理 iframe，录制结果很快会在真实页面失效。
- 不把断言做成一等公民，录制出来的脚本只能是“操作回放”，不是完整测试。

所以我们的共享模型必须预留：

- `framePath`
- `assertVisible / assertText / assertValue`

## 5. 当前仓库上下文

这套方案需要落在当前仓库已经存在的浏览器和 MCP 基础上：

- `src/main/browser/core/browser-service.ts`
- `src/main/browser/cdp/playwright-mcp-bridge.ts`
- `src/main/browser/recording/ai-recording-service.ts`
- `src/main/browser/recording/locator-generator.ts`
- `src/renderer/src/components/browser/BrowserAiRecordingControls.tsx`

当前事实：

1. 内置浏览器是共享的 BrowserView / WebContents，不是 Playwright 自己新开的受控浏览器。
2. AI 录制已经可以通过 MCP 成功记录一部分动作。
3. locator 生成器已经完成了第一版 Playwright 风格改造，但还不是完整 selector engine。
4. 人工录制还没有真正落地，仍缺页面内事件采集与主进程 signal 归因。

## 6. 总体架构

推荐继续走“双入口、单内核”：

```text
Renderer
  -> BrowserPanel
  -> AI Recording Controls
  -> Manual Recording Controls
  -> Shared Recording Result Panel

Main Process
  -> TestGenerationService
  -> AiRecordingProducer
  -> ManualRecordingProducer
  -> ActionCollector
  -> LocatorResolver
  -> PlaywrightCodeGenerator
  -> Trace / Export / Save

AI mode
  -> MCP browser_* tool calls
  -> normalize to actions

Manual mode
  -> injected recorder bridge
  -> browser events + page events
  -> normalize to actions
```

共享内核只保留一套：

- `NormalizedAction`
- `RecordedSignal`
- `LocatorMetadata`
- `ActionCollector`
- `ScriptGenerator`
- `GenerationSessionState`

## 7. 统一动作模型

建议继续向 Playwright 的 `ActionInContext` / `SignalInContext` 对齐，但保留我们自己的业务字段。

建议模型：

```ts
export type RecordingSource = "ai" | "manual";

export interface FrameContext {
  pageAlias?: string;
  framePath?: string[];
}

export interface LocatorMetadata {
  target?: string;
  role?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  accessibleName?: string;
  textContent?: string;
  selector?: string;
  tagName?: string;
  inputType?: string;
  framePath?: string[];
}

export type NormalizedAction =
  | { source: RecordingSource; kind: "navigate"; timestamp: string; url: string }
  | { source: RecordingSource; kind: "click"; timestamp: string; locator?: LocatorMetadata; clickCount: number; button?: "left" | "middle" | "right" }
  | { source: RecordingSource; kind: "fill"; timestamp: string; locator?: LocatorMetadata; value: string; sensitive: boolean }
  | { source: RecordingSource; kind: "selectOption"; timestamp: string; locator?: LocatorMetadata; values: string[] }
  | { source: RecordingSource; kind: "press"; timestamp: string; locator?: LocatorMetadata; key: string }
  | { source: RecordingSource; kind: "assertVisible"; timestamp: string; locator?: LocatorMetadata }
  | { source: RecordingSource; kind: "assertText"; timestamp: string; locator?: LocatorMetadata; text: string; substring?: boolean }
  | { source: RecordingSource; kind: "assertValue"; timestamp: string; locator?: LocatorMetadata; value: string };

export type RecordedSignal =
  | { pageId: string; name: "navigation"; timestamp: string; url: string }
  | { pageId: string; name: "popup"; timestamp: string; popupPageId?: string }
  | { pageId: string; name: "download"; timestamp: string; filenameHint?: string }
  | { pageId: string; name: "dialog"; timestamp: string; message?: string }
  | { pageId: string; name: "expect"; timestamp: string; locator?: LocatorMetadata };
```

关键点：

1. `source` 必须保留，方便回放、统计和 UI 标注。
2. `locator` 和 `framePath` 必须在动作层存在，不能晚到只剩脚本文本时再猜。
3. `signal` 要单独建模，不能硬塞进 action。

## 8. AI 录制技术方案

### 8.1 数据来源

AI 录制继续复用现有 MCP 链路：

- `src/main/browser/cdp/playwright-mcp-bridge.ts`
- `src/main/browser/recording/ai-recording-service.ts`

原则：

- 只记录成功执行过的 `browser_*` 工具调用
- `browser_snapshot` 只作为推理上下文，不直接生成脚本动作
- 从工具参数里尽量提取结构化 locator 元数据

### 8.2 建议映射

建议统一映射：

- `browser_navigate` -> `navigate`
- `browser_click` -> `click`
- `browser_fill` / `browser_type` -> `fill`
- `browser_fill_form` -> 多个 `fill`
- `browser_select_option` -> `selectOption`
- `browser_press_key` / `browser_key` -> `press`

### 8.3 AI 录制需要继续增强的点

1. 保留 `threadId`，方便区分不同任务的录制来源。
2. 尽量记录 `role / label / placeholder / testId / framePath / selector`。
3. 在 `ActionCollector` 中继续做批量去重和 supersede 归并。
4. 后续支持“录制断言”时，可让 AI 显式调用 assertion 工具或结构化意图。

### 8.4 当前实现与下一步

当前仓库已经有：

- AI 录制会话管理
- 动作归一化
- 基础去重
- 第一版 locator 元数据驱动代码生成

下一步主要是：

- 增强唯一性校验
- 增强 frame 场景
- 补 signal 归因
- 补断言生成

## 9. 人工录制技术方案

### 9.1 为什么不能直接复用 Playwright Inspector

Playwright 官方 `codegen` 录的是“它自己控制的浏览器 + 自己的 Inspector”。

我们这里录的是：

- Electron 里的内置 BrowserView
- 已有登录态和共享会话
- 我们自己的右侧浏览器面板

因此不能直接嵌 Playwright Inspector，而要借它的内部结构和规则。

### 9.2 推荐采集链路

人工录制拆成两路：

1. 页面内注入层
2. 主进程浏览器 signal 层

页面内注入层负责采集：

- `click`
- `dblclick`
- `input`
- `change`
- `keydown` 中需要落脚本的按键
- pick locator
- assert pick

主进程 signal 层负责采集：

- 顶层导航
- 页面打开 / popup
- download
- dialog
- frame 导航与 frame path 更新

### 9.3 推荐实现方式

考虑当前 BrowserView 使用了 `sandbox` 和 `contextIsolation`，建议走“隔离世界注入 + 主进程桥接”的方式，而不是让页面脚本直接污染业务页面全局对象。

推荐模块：

- `src/main/browser/recording/manual-recording-service.ts`
- `src/main/browser/recording/manual-recorder-bridge.ts`
- `src/main/browser/recording/manual-action-collector.ts`
- `src/renderer/src/components/browser/BrowserManualRecordingControls.tsx`

### 9.4 页面内桥接职责

页面内桥接只做两件事：

1. 从事件里抽出最小动作事实
2. 上报足够的 locator 元数据

它不负责：

- 拼 Playwright 代码
- 处理导航去重
- 处理 popup / download / dialog 归因
- 维护最终脚本

### 9.5 主进程职责

主进程负责：

1. 为每个页面和 frame 维护 recording session。
2. 把页面动作和浏览器 signal 汇总到 `ActionCollector`。
3. 在 frame 变动时生成可回放的 `framePath`。
4. 统一做去重、归并、归因与脚本生成。

## 10. locator 生成策略

### 10.1 公开文档与源码的统一理解

Playwright 文档对外强调的是“优先用户可理解的 locator”，源码里则给了完整的候选评分逻辑。

对我们来说，应该综合成以下策略：

1. `testId`
2. `role + accessible name`
3. `placeholder`
4. `label`
5. `alt / title`
6. `text`
7. `explicit selector`
8. `css fallback`
9. `nth` 兜底

### 10.2 我们要借鉴的不是内部 selector 协议

不要把 Playwright 内部的 `internal:*` selector 直接当成我们对外的稳定协议。

最终输出仍然应该是公开 API 风格，例如：

- `page.getByRole(...)`
- `page.getByLabel(...)`
- `page.getByPlaceholder(...)`
- `page.getByTestId(...)`
- `page.frameLocator(...).getByRole(...)`

### 10.3 frame 策略

根据 `FrameLocator` 文档与源码行为，建议：

1. `framePath` 作为动作元数据直接保存。
2. 代码生成时优先拼 `page.frameLocator(...).getBy...`。
3. 如果某级 iframe 不唯一，预留 `first()` / `nth()` 兜底策略。

## 11. ActionCollector 收敛规则

参考 Playwright `RecorderSignalProcessor`，我们至少要做：

1. 连续 `fill` 对同一目标只保留最后一次值。
2. 单击后紧跟双击时合并成双击。
3. 连续导航对同一页面只保留最后有效目标。
4. 短时间内出现的 `navigation / popup / download / dialog` 归因到最近动作。
5. 对立即重复的批量输入做 trailing-batch 去重。

这层逻辑必须是共享层，不应分散在 AI 和人工两条 producer 里。

## 12. 代码生成策略

### 12.1 输出目标

默认输出：

```ts
import { test, expect } from "@playwright/test";

test("recorded flow", async ({ page }) => {
  await page.goto("https://example.com");
  await page.getByLabel("邮箱").fill("test@example.com");
  await page.getByRole("button", { name: "登录" }).click();
});
```

### 12.2 需要支持的录制体验

根据 `codegen.md`，我们后续产品能力至少应覆盖：

1. `Record new`
2. `Record at cursor`
3. `Pick locator`
4. 录制断言
5. 清空并重新录制

落到我们这里可以变成：

1. 新建录制会话
2. 从某一步继续追加录制
3. 在内置浏览器里单独拾取 locator
4. 录入可回放断言
5. 清空当前草稿

### 12.3 断言策略

第一阶段建议只生成三类断言：

- `await expect(locator).toBeVisible()`
- `await expect(locator).toContainText(...)` / `toHaveText(...)`
- `await expect(locator).toHaveValue(...)`

理由：

1. 这正是 Playwright codegen 公开强调的基础断言集。
2. 它们天然带 auto-retry，更适合录制产物。
3. UI 和用户心智都更简单。

## 13. 会话隔离与状态策略

`browser-contexts.md` 的结论不能直接照搬到我们产品里。

Playwright 默认是：

- 每个测试新建 context
- 强隔离
- 可复现性优先

我们现在的产品现实是：

- 内置浏览器共享会话
- 登录态和 Cookie 会被复用
- 录制过程不一定发生在干净环境里

因此建议区分：

1. `录制时状态`
2. `导出时状态`

录制时：

- 允许复用当前内置浏览器登录态

导出时：

- 默认生成“普通脚本”
- 以后再支持导出 `storageState` 或“录制前状态说明”

不要在第一版里假设已经实现了 Playwright Test 那种完整隔离模型。

## 14. trace 与调试方案

`trace-viewer.md` 给我们的启发是：测试生成不能只有脚本，还需要“录后调试入口”。

建议分阶段支持：

### Phase A

- 保存结构化步骤
- 保存生成脚本
- 提供可复制、可导出、可继续编辑

### Phase B

- 对“回放验证”补 trace 采集
- 失败时附带 trace.zip 或本地 trace 路径
- UI 里显示“打开 trace 调试”

### Phase C

- 把 trace 里的网络/API 请求转成辅助代码片段
- 让录制结果不仅能回放 UI，还能辅助补接口断言

## 15. 分阶段实施建议

### Phase 1：补强 AI 录制

- 完善 `ai-recording-service.ts`
- 完善 `locator-generator.ts`
- 增加 signal 归因
- 增加更稳的 locator 评分与唯一性验证
- 完善文档与测试

### Phase 2：落地人工录制 MVP

- 新建 `manual-recording-service.ts`
- 建立页面内桥接
- 采集 click / fill / press / select / navigation
- 共用现有 `locator-generator.ts`
- 复用共享脚本输出面板

### Phase 3：补录制断言与 Record at Cursor

- 支持 assert pick
- 支持在草稿中插入后续步骤
- 支持从某一步继续录制

### Phase 4：补 trace 与导出增强

- 支持回放校验
- 支持 trace 打包
- 支持更完整的导出选项

## 16. `playwright-main/packages` 可参考源码清单

下面这份清单只列“和我们当前目标直接相关”的文件路径。

### 16.1 selector / locator 核心

| 文件路径 | 主要职责 | 我们怎么借 |
| --- | --- | --- |
| `playwright-main/packages/injected/src/selectorGenerator.ts` | selector 候选生成、打分、唯一性收敛、父链回溯 | locator 评分体系的核心参考 |
| `playwright-main/packages/injected/src/roleUtils.ts` | ARIA role、accessible name、隐式 role 计算 | `getByRole()` 与 accessible name 推断 |
| `playwright-main/packages/injected/src/selectorUtils.ts` | 文本提取、label 提取、文本匹配 | `getByLabel()` / `getByText()` 的候选来源 |
| `playwright-main/packages/injected/src/domUtils.ts` | 可见性、shadow DOM、父链与 scope 判断 | 提升 locator 稳定性，减少误选 |
| `playwright-main/packages/injected/src/injectedScript.ts` | 页面内注入脚本入口，暴露 selector 生成能力 | 理解生成器在页面里的运行方式 |
| `playwright-main/packages/isomorphic/locatorUtils.ts` | 内部 locator 片段表达 | 建立统一 locator 中间表达层 |
| `playwright-main/packages/isomorphic/locatorGenerators.ts` | 内部 selector -> 公开 locator 代码 | 输出 `page.getByRole(...)` 等可读代码 |
| `playwright-main/packages/isomorphic/locatorParser.ts` | locator 解析与归一化 | 后续做 locator 编辑/回显时参考 |
| `playwright-main/packages/isomorphic/stringUtils.ts` | 转义、引号、文本序列化 | 避免脚本转义错误 |

### 16.2 录制运行时与 signal 处理

| 文件路径 | 主要职责 | 我们怎么借 |
| --- | --- | --- |
| `playwright-main/packages/playwright-core/src/server/recorder.ts` | 新版录制核心入口，绑定页面、收集动作、管理模式与状态 | 对照设计我们的主进程 `ManualRecordingService` |
| `playwright-main/packages/playwright-core/src/server/recorder/recorderSignalProcessor.ts` | action buffering、supersede、signal 归因 | 直接借去重与归因思路 |
| `playwright-main/packages/playwright-core/src/server/recorder/recorderRunner.ts` | 可执行动作参数转换 | 手工录制回放或校验时参考 |
| `playwright-main/packages/playwright-core/src/server/recorder/recorderUtils.ts` | frame selector 拼接、call log 构造 | framePath 生成与 call log 设计参考 |
| `playwright-main/packages/injected/src/recorder/recorder.ts` | 页面内录制器，监听 click/input/keydown/assert/pick locator | 人工录制页面桥接最重要的参考文件 |
| `playwright-main/packages/injected/src/recorder/pollingRecorder.ts` | 页面端通过 polling / bindings 和宿主同步 UIState | 适合参考我们 BrowserView 的录制桥接方式 |

### 16.3 codegen 与动作模型

| 文件路径 | 主要职责 | 我们怎么借 |
| --- | --- | --- |
| `playwright-main/packages/isomorphic/codegen/actions.d.ts` | Action / Signal / ActionInContext 类型定义 | 我们共享动作模型的最佳参考 |
| `playwright-main/packages/isomorphic/codegen/language.ts` | 生成 header/footer、signal 映射、键盘/点击参数格式化 | 共用代码生成规则 |
| `playwright-main/packages/isomorphic/codegen/javascript.ts` | JavaScript / Playwright Test 输出实现 | 我们当前主要输出语言的直接参考 |
| `playwright-main/packages/isomorphic/codegen/types.ts` | codegen 输入输出接口 | 约束我们自己的 generator API |
| `playwright-main/packages/isomorphic/codegen/languages.ts` | 多语言 generator 注册 | 如果以后支持多语言导出可直接参考 |

### 16.4 录制 UI 与交互

| 文件路径 | 主要职责 | 我们怎么借 |
| --- | --- | --- |
| `playwright-main/packages/recorder/src/recorder.tsx` | Playwright 录制器 UI 主界面 | 参考模式切换、pick locator、assert 按钮组织方式 |
| `playwright-main/packages/recorder/src/callLog.tsx` | 调用日志 UI，展示 locator、状态和耗时 | 参考我们录制过程的步骤面板 / call log 面板 |
| `playwright-main/packages/recorder/src/recorderTypes.d.ts` | 录制 UIState、Mode、Source、CallLog 类型 | 参考我们 Renderer <-> Main 的状态协议 |

### 16.5 trace 与录后调试

| 文件路径 | 主要职责 | 我们怎么借 |
| --- | --- | --- |
| `playwright-main/packages/playwright-core/src/server/trace/recorder/tracing.ts` | trace 录制生命周期与资源打包 | 录后回放校验和 trace 导出的主要参考 |
| `playwright-main/packages/playwright-core/src/server/trace/recorder/snapshotter.ts` | DOM snapshot 采集 | 后续若做录后调试快照可参考 |
| `playwright-main/packages/playwright-core/src/server/trace/recorder/snapshotterInjected.ts` | 页面内 snapshot 注入逻辑 | trace 侧页面注入参考 |
| `playwright-main/packages/trace-viewer/src/ui/codegen.ts` | 根据 trace / HAR 生成 Playwright request 代码 | 录后 API 片段补全与调试参考 |

## 17. 不建议直接照搬的部分

1. 不建议把 Playwright Inspector UI 直接搬进我们的产品。
2. 不建议把 `internal:*` selector 当成外部长期协议。
3. 不建议在第一版就追求完全复刻 Playwright 的 selector engine。
4. 不建议假设录制时一定处于全新 browser context。

## 18. 许可说明

`playwright-main/packages` 下上述文件都带 Apache 2.0 许可头。

适合借鉴的是：

- 规则
- 结构
- 类型模型
- 评分思路
- 输出格式化思路

如果后续要直接移植较大段实现，应保留 attribution 并按 Apache 2.0 要求处理。

## 19. 一句话结论

这件事最现实的做法不是“嵌一个现成的 Playwright Recorder”，而是：

保留我们自己的内置浏览器业务壳，借 Playwright 的动作模型、locator 规则、signal 收敛和代码生成结构，做一套统一支持 `AI 录制 + 人工录制` 的测试生成系统。
