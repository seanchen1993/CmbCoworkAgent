# Locator 生成器技术方案

更新时间：2026-07-30

本文总结当前内置浏览器录制流程里 `locator` 生成器的缺陷，以及后续改造成“Playwright 风格、可维护、可扩展”生成器的技术方案。

## 1. 背景

当前 AI 录制脚本由 `src/main/browser/recording/ai-recording-service.ts` 直接把动作翻译成 Playwright 代码。

现状问题是：

- 生成器只靠 `target` 文本猜 locator。
- 候选策略太少，基本只有 `getByRole` 和 `getByText`。
- 没有唯一性校验，也没有候选打分。
- 没有 `label`、`placeholder`、`testId`、`iframe` 等更稳的定位路径。

因此脚本能跑，但可读性、稳定性和可维护性都不够。

## 2. 目标

目标不是“完全复刻 Playwright codegen”，而是借它的规则做我们自己的生成器：

- 优先生成语义化 locator。
- 尽量保证唯一。
- 失败时有清晰 fallback。
- 保留在当前内置浏览器和线程模型下可运行。

## 3. 当前实现缺陷

### 3.1 信息源太薄

当前只读取：

- `element`
- `target`
- `label`
- `name`

这会导致生成器只能猜页面元素语义，拿不到真正能提升稳定性的元数据。

### 3.2 生成策略过于简单

当前规则大致是：

- 识别后缀，判断是 `button` / `textbox` / `select` 等。
- 否则退回 `getByText(exact: true)`。

问题是：

- 没有 `getByLabel`
- 没有 `getByPlaceholder`
- 没有 `getByTestId`
- 没有 iframe 路径
- 没有 CSS fallback

### 3.3 没有唯一性验证

Playwright 录制器会继续收敛 locator，直到它更唯一、更稳定。

我们现在只是拼出一个字符串，不会验证这个 locator 是否只命中一个元素。

### 3.4 没有候选评分

当前没有“哪个 locator 更稳”的排序逻辑，最终结果完全依赖字符串匹配规则。

### 3.5 fallback 不够可执行

`TODO_SELECTOR` 只是占位符，不是可运行的兜底方案。

## 4. 设计原则

1. 先语义化，再兜底。
2. 先唯一，再简短。
3. 先结构信息，再文本信息。
4. 生成结果必须可执行，不能只给占位符。
5. 录制壳层和 locator 生成器解耦。

## 5. 推荐架构

### 5.1 模块拆分

建议把当前逻辑拆成独立模块，例如：

- `locator-generator.ts`
- `locator-candidate.ts`
- `locator-scoring.ts`
- `locator-formatter.ts`

### 5.2 输入模型

建议扩充成统一输入：

```ts
interface LocatorSource {
  target?: string
  role?: string
  label?: string
  placeholder?: string
  testId?: string
  accessibleName?: string
  tagName?: string
  inputType?: string
  framePath?: string[]
  textContent?: string
}
```

### 5.3 输出模型

生成器不要只返回字符串，建议返回：

```ts
interface LocatorCandidate {
  kind: "role" | "label" | "placeholder" | "testId" | "text" | "css"
  locator: string
  score: number
  unique: boolean
  reason: string
}

interface LocatorResult {
  best: LocatorCandidate
  alternatives: LocatorCandidate[]
}
```

## 6. 候选策略

建议顺序：

1. `getByRole`
2. `getByLabel`
3. `getByPlaceholder`
4. `getByTestId`
5. `getByText`
6. `locator(css fallback)`

### 6.1 评分规则

可按以下维度加分：

- 唯一命中 + 高分
- 语义明确 + 高分
- 路径短 + 中分
- 完全依赖文本 + 低分
- 依赖 CSS class / nth-child + 更低分

### 6.2 选择规则

最终选择满足以下条件的最高分候选：

- `unique === true`
- 如果没有唯一候选，再选最高分的可执行候选
- 如果仍不可用，返回显式 fallback，并标记需要人工复核

## 7. frame 处理

复杂页面里，很多元素不在顶层文档。

建议新增：

- 父 frame path
- `frameLocator()` 生成
- 递归父链定位

不要只依赖单个 CSS selector。

## 8. 上游需要补的数据

后续录制链路最好把这些字段也带上：

- `role`
- `placeholder`
- `testId`
- `ariaLabel`
- `accessibleName`
- `tagName`
- `inputType`
- `framePath`
- `textContent`

如果上游拿不到，生成器只能继续猜。

## 9. 落地路径

### Phase 1

- 抽出独立 locator 生成器模块。
- 保留现有 Playwright 输出格式。
- 先把候选集扩到 `role / label / placeholder / testId / text / css`。

### Phase 2

- 增加唯一性检查。
- 增加候选评分。
- 增加 iframe 支持。

### Phase 3

- 上游补充更多 DOM 语义元数据。
- 对歧义元素、同名元素、嵌套 frame 做完整回归测试。

## 10. 测试重点

- 同名按钮是否会选到稳定候选。
- 输入框是否优先 `label` / `placeholder`。
- `testId` 是否能作为强兜底。
- `iframe` 是否能正确生成 `frameLocator`。
- 没有 target 时是否还能产出可执行脚本。
- 敏感输入是否继续脱敏。

## 11. 现有代码参考点

- `src/main/browser/recording/ai-recording-service.ts`
- `src/main/browser/recording/ai-recording-service.test.ts`
- `src/renderer/src/components/browser/BrowserAiRecordingControls.tsx`
- `docs/in-app-browser/playwright-codegen-borrowing-notes.md`

## 12. 一句话结论

当前 locator 生成器的问题不是“不会生成代码”，而是“信息不足、候选太少、没有验证”，下一步应按 Playwright 的思路改成“候选集 + 打分 + 唯一性校验”的结构。

