# Playwright 测试生成双模式方案（AI + 人工）

更新时间：2026-07-24

## 1. 目标

本文档定义一套适合当前 `CmbCoworkAgent` 仓库的 Playwright 测试生成方案。

这套方案不再把功能定义成单一“录制器”，而是定义成一个统一的“测试生成系统”，同时支持两种输入模式：

- `AI 录制`：AI 通过 Playwright MCP 操作页面，并把执行过的步骤沉淀为 Playwright 脚本。
- `人工录制`：用户自己在内置浏览器里操作，系统采集真实交互并生成 Playwright 脚本。

最终目标是两条路径共用一套动作模型、步骤收敛逻辑和代码生成器，而不是维护两套彼此割裂的系统。

## 2. 为什么要做双模式

只做人工录制的问题：

- 用户必须自己逐步演示流程。
- 对复杂后台、长流程、探索式自动化不够高效。
- 很难直接从自然语言快速得到一份测试初稿。

只做 AI 录制的问题：

- 录到的是 AI 执行的路径，不一定等同于用户真实操作路径。
- 对需要“我自己点一遍、你忠实记录下来”的场景不适用。
- 当页面语义不稳定时，AI 会走捷径，未必符合用户想保留的业务步骤。

因此最合理的产品定义是：

- `AI 录制` 负责“从意图快速生成脚本初稿”。
- `人工录制` 负责“忠实记录用户实际操作”。

## 3. 当前仓库上下文

这套方案需要建立在当前代码库已经存在的浏览器能力之上：

- 内置浏览器核心在 `src/main/browser/core/browser-service.ts`
- BrowserView 容器与工具栏 UI 在 `src/renderer/src/components/browser/BrowserPanel.tsx`
- BrowserView 当前使用 `sandbox: true`、`contextIsolation: true`
- 工程已经提供 CDP 端口配置和 Playwright MCP 自动注册能力
- 当前依赖版本为 `Electron 39.8.10`、`Playwright 1.58.2`

相关文件：

- `src/main/browser/core/browser-service.ts`
- `src/renderer/src/components/browser/BrowserPanel.tsx`
- `src/main/browser/cdp/playwright-mcp-bridge.ts`
- `src/main/browser/cdp/browser-cdp.ts`

这意味着：

- `AI 录制` 可以尽量复用现有 CDP / MCP 链路。
- `人工录制` 不能依赖 Playwright 官方 Inspector，需要自己补一层交互采集。

## 4. 产品定义

建议把功能定义为：

`Playwright Test Generation`

而不是：

`Playwright Recorder`

因为真正的核心产物不是“录制过程”，而是：

- 一段可读的 Playwright 脚本
- 一组结构化步骤
- 一份可继续编辑和回放的测试草稿

在这个定义下，AI 和人工只是两种“动作来源”。

## 5. 双模式概览

### 5.1 AI 录制

AI 录制的本质是：

- AI 通过 Playwright MCP 读取页面 snapshot
- AI 调用 `browser_click`、`browser_type`、`browser_select_option`、`browser_navigate` 等工具
- 系统把这些成功执行过的 MCP 工具调用归一化成动作序列
- 再生成 Playwright 脚本

特点：

- 可以不写注入脚本
- 可以复用当前内置浏览器 session 和登录态
- 适合“自然语言 -> 自动执行 -> 生成脚本初稿”

### 5.2 人工录制

人工录制的本质是：

- 用户自己在 BrowserView 里操作
- 系统采集真实 DOM 交互和浏览器事件
- 再将这些交互转换为 Playwright 步骤

特点：

- 更贴近用户实际流程
- 更适合“我自己走一遍，你忠实记下来”
- 无法仅靠 MCP 自动替代

## 6. 总体架构

推荐做成“双入口、单内核”：

```text
Renderer
  -> BrowserPanel
  -> "开始人工录制"
  -> "让 AI 生成脚本"
  -> 统一结果面板

Main Process
  -> TestGenerationService
  -> AiRecordingProducer
  -> ManualRecordingProducer
  -> ActionCollector
  -> ScriptGenerator
  -> Export / Save

AI mode
  -> Playwright MCP tool calls
  -> normalize to actions

Manual mode
  -> injected recorder script
  -> BrowserService / session signals
  -> normalize to actions
```

共享内核只保留一套：

- `NormalizedAction`
- `RecordedSignal`
- `ActionCollector`
- `ScriptGenerator`
- `GenerationSessionState`

## 7. 为什么 AI 录制不能完全替代人工录制

AI 录制和人工录制的价值不同。

AI 录制更适合：

- 从一句自然语言快速得到脚本初稿
- 做 smoke test
- 让 AI 在陌生系统里先“摸路”

人工录制更适合：

- 忠实保留真实操作路径
- 录入需要精确还原的人类步骤
- 记录业务人员实际演示出来的流程

所以这里不应该争论“二选一”，而应该让两者汇合到同一套输出模型。

## 8. AI 录制设计

### 8.1 目标

第一阶段优先交付 AI 录制，因为它开发成本最低，且当前仓库已经具备 CDP / MCP 基础设施。

### 8.2 数据来源

AI 录制不直接监听浏览器 DOM，而是监听：

- MCP 工具调用请求
- MCP 工具调用结果

只记录“成功执行”的浏览器动作。

### 8.3 动作映射

建议将 MCP 工具统一映射到内部动作模型：

- `browser_navigate` -> `navigate`
- `browser_click` -> `click`
- `browser_type` -> `fill` 或 `press`
- `browser_select_option` -> `selectOption`
- `browser_snapshot` -> 不生成脚本动作，只作为推理上下文

如果后续 MCP 工具集有更多能力，再逐步补充映射。

### 8.4 优势

- 不需要在页面里注入 recorder 脚本
- 不需要自己处理大部分 selector 推导
- 可以复用 AI 的语义理解能力
- 可以利用当前登录 session

### 8.5 限制

- 录到的是 AI 采取的路径，不是用户真实操作
- AI 有时会走捷径，不一定符合“业务演示”的顺序
- 如果不额外保存上下文，脚本解释性会偏弱

### 8.6 结论

AI 录制适合最先上线，但它的产品定位应该是：

`测试生成助手`

而不是：

`人工交互录制器`

## 9. 人工录制设计

### 9.1 为什么仍然需要自定义采集

Playwright 官方的手工录制能力是 `codegen`，它运行在 Playwright 自己控制的浏览器和 Inspector 中。

它不会自动帮我们监听 Electron 内置 BrowserView 里的用户真实点击。

因此如果要支持人工录制，就仍然需要一层自定义交互采集。

### 9.2 推荐来源拆分

人工录制建议拆成两路数据源：

- 页面内注入脚本：采集 click、fill、press、select 这类 DOM 动作
- 主进程浏览器事件：采集 navigation、popup、download、dialog 这类信号

### 9.3 页面注入脚本只负责什么

建议页面脚本只负责：

- `click`
- `dblclick`
- `input`
- `change`
- `keydown` 中需要落脚本的按键

页面脚本不负责：

- 自己判断顶层导航
- 自己推导 popup / download / dialog
- 自己承担完整归因逻辑

### 9.4 主进程负责什么

主进程直接监听：

- `did-navigate`
- `did-navigate-in-page`
- `did-frame-finish-load`
- `setWindowOpenHandler(...)`
- `session.on("will-download")`

如果后续需要对话框，可补页面层 hook 或更高层浏览器事件桥接。

### 9.5 关键结论

人工录制依然需要注入脚本或等价机制。

这个部分无法被 Playwright MCP 直接替代。

## 10. 统一动作模型

不管动作来自 AI 还是人工，进入共享内核前都应先归一化。

建议动作模型至少带上：

```ts
export type ActionSource = "ai" | "manual";

export interface FrameContext {
  pageAlias: string;
  framePath: string[];
}

export interface BaseAction {
  source: ActionSource;
  timestamp: number;
}

export interface NavigateAction extends BaseAction {
  name: "navigate";
  url: string;
}

export interface ClickAction extends BaseAction {
  name: "click";
  frame?: FrameContext;
  selector: string;
  clickCount: number;
  button?: "left" | "middle" | "right";
  modifiers?: string[];
  textHint?: string;
}
```

建议单独建模 signal：

```ts
export type RecordedSignal =
  | { name: "navigation"; url: string; timestamp: number }
  | { name: "popup"; url?: string; timestamp: number }
  | { name: "download"; suggestedFilename?: string; timestamp: number }
  | { name: "dialog"; dialogType: string; message?: string; timestamp: number };
```

这里最重要的是：

- `source` 字段必须保留
- `framePath` 必须预留
- AI 和人工动作不能直接各自生成代码，必须先汇合到统一模型

## 11. 共享收敛层

`ActionCollector` 负责把原始动作和 signal 收敛成更稳定的步骤序列。

至少要做这些事情：

- 连续 `fill` 合并
- 连续导航去重
- 单击 / 双击归并
- 将短时间内的 `navigation`、`popup`、`download` 信号归因到最近动作
- 给 AI 动作补注释和上下文摘要

建议不要把这些逻辑分别写在 AI mode 和 manual mode 内部。

正确做法是：

- producer 负责“采集”
- collector 负责“收敛”

## 12. 共享代码生成器

生成器输出目标不是“动作日志”，而是可读的 Playwright Test 脚本。

推荐形式：

```ts
import { test, expect } from "@playwright/test";

test("generated flow", async ({ page }) => {
  await page.goto("https://example.com");
  await page.getByRole("button", { name: "Login" }).click();
  await page.getByLabel("Email").fill("user@example.com");
});
```

生成策略建议：

- 优先产出 locator 风格代码
- 其次退到 `page.locator(...)`
- 最后才退到普通 CSS 字符串

对 AI 录制：

- 如果 MCP 层已经给出了较强语义定位，应尽量保留

对人工录制：

- 注入脚本只需产出候选 selector，不必在第一版就复刻完整 Playwright selector engine

## 13. 选择器策略

### 13.1 AI 模式

AI 模式下的 selector 通常来自 MCP 工具决策过程，因此它更偏“语义定位”。

建议尽量保留：

- `getByRole`
- `getByLabel`
- `getByText`
- `locator(...)`

不要过早降级成纯 CSS。

### 13.2 人工模式

人工模式建议用候选策略：

1. `data-testid`
2. `data-test`
3. `aria-label`
4. 唯一 `id`
5. `role + accessible name`
6. text
7. fallback CSS

建议同时保留：

- `primarySelector`
- `selectorCandidates[]`

这样第一版生成器只消费主选择器，后续再慢慢优化稳定性。

## 14. iframe 与跨导航

这是人工模式必须重点解决的部分。

### 14.1 iframe

`deepEventTarget()` 只能解决 shadow DOM，不能跨 iframe 文档边界。

正确方向是：

- 每个 frame 都注入 recorder
- 记录 frame 上下文
- 生成代码时转成 `frameLocator(...)`

AI 模式下也建议为统一模型预留 `framePath`，避免后续割裂。

### 14.2 跨导航

人工模式下，页面导航会导致已注入脚本失效。

因此 `ManualRecordingProducer` 必须在这些时机重新注入：

- `did-frame-finish-load`
- `did-navigate`
- 新 frame 可用时

同时要保证：

- 注入是幂等的
- 停止录制后能清理当前页面中的 recorder 标记

## 15. UI 建议

建议在同一块结果面板上做双入口：

- `开始人工录制`
- `让 AI 生成脚本`

统一输出面板包含：

- 步骤列表
- 代码预览
- 来源标记（AI / 人工）
- 复制按钮
- 保存到工作区按钮

建议第一版不要做太重的编辑功能：

- 不急着做拖拽重排
- 不急着做双向代码编辑
- 不急着做断言录制
- 不急着做多语言输出

先把“能稳定出脚本”做好更重要。

## 16. 推荐落地顺序

### Phase 1：先做 AI 录制

目标：

- 基于现有 MCP / CDP 能力快速交付第一条可用链路

内容：

- 新增 `AiRecordingProducer`
- 记录成功的 MCP 浏览器工具调用
- 引入统一 `NormalizedAction`
- 生成第一版 Playwright 脚本

验收标准：

- 能从自然语言驱动内置浏览器生成一份脚本初稿

### Phase 2：补共享内核

目标：

- 把 AI mode 临时逻辑沉淀成可复用底座

内容：

- `ActionCollector`
- `ScriptGenerator`
- `GenerationSessionState`
- 统一结果面板

验收标准：

- AI 动作和中间步骤可以稳定展示、导出和复用

### Phase 3：补人工录制

目标：

- 在内置浏览器里支持真实用户交互录制

内容：

- `ManualRecordingProducer`
- 页面注入脚本
- 主进程 navigation / popup / download signal
- 跨导航重新注入

验收标准：

- 用户自己点一遍后，能得到合理的脚本

### Phase 4：提高可回放性

目标：

- 提升两种模式输出脚本的一致性和稳定性

内容：

- iframe 支持
- selector 候选优化
- signal 归因优化
- 结果编辑与测试能力

## 17. 测试建议

至少补这些测试：

- `AiRecordingProducer` 的工具调用归一化测试
- `ManualRecordingProducer` 的事件采集测试
- `ActionCollector` 的 fill merge、navigate dedupe、double click merge
- `ScriptGenerator` 的输出快照测试
- 最小 e2e：
  - AI 导航并生成脚本
  - 手工点击并生成脚本
  - SPA in-page navigation

## 18. 最终建议

最终建议很明确：

- 先不要把问题定义成“要不要写注入脚本”
- 先把产品定义成“我们要支持两种测试生成模式”

然后分别采取最适合的技术路线：

- `AI 录制`：尽量复用 Playwright MCP，不写手工 recorder 注入脚本
- `人工录制`：接受需要一层自定义交互采集，并尽量把它缩到最小

一句话总结：

最合适的方向不是“只做一个 recorder”，而是“做一个统一的 Playwright 测试生成系统，让 AI 和人工成为两种动作来源”。

## 19. 参考资料

- Playwright MCP Introduction: <https://playwright.dev/mcp/introduction>
- Playwright MCP Configuration: <https://playwright.dev/mcp/configuration>
- Playwright Codegen: <https://playwright.dev/docs/codegen>
