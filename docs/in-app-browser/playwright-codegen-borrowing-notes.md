# Playwright 录制与 Selector Generator 可借鉴点

更新时间：2026-07-30

本文只总结 Playwright 公开文档和开源源码里，适合被我们借鉴的部分。目标不是把 Playwright 整套搬进来，而是借它的 locator 规则、动作采集模型和脚本生成思路，做成我们自己的内置浏览器录制能力。

## 结论先行

最值得借鉴的是三层：

1. `locator` 选择策略
2. `recording` 事件模型
3. `selector generator` 的独立生成器

最不值得直接依赖的是：

1. Playwright Inspector / VS Code 的 UI 形态
2. Playwright 内部 selector 格式
3. 假设“每个测试都有全新 browser context”的运行方式

## 1. Playwright 公开提供了什么

Playwright 的 `codegen` 文档明确说明了几件事：

- 录制测试时，Playwright 会根据页面内容挑选最佳 locator。
- 优先顺序是 `role`、`text`、`test id`。
- 如果匹配到多个元素，生成器会继续收敛 locator，让它更稳定、更唯一。
- 支持 `Record new`、`Record at cursor`、`Pick locator`、以及录制断言。

参考：

- [codegen 文档](https://github.com/microsoft/playwright/blob/main/docs/src/codegen.md#L239-L257)
- [codegen 录制与 Pick locator](https://github.com/microsoft/playwright/blob/main/docs/src/codegen.md#L264-L285)

## 2. 值得借鉴的源码结构

### 2.1 `contextRecorder.ts` 的分层

Playwright 的 recorder 不是“直接把浏览器事件写成代码”，而是先把事件归一化，再交给输出层。

它做了几件关键的事：

- 通过 `exposeBinding()` 暴露录制绑定
- 把“会导致导航的动作”和“普通动作”分开
- 监听 page / frame / download / dialog / popup 等结构性事件
- 通过 `setOutput()` 切换输出语言
- 通过 `clearScript()` 重置录制

参考源码：

- [安装 recorder hook](https://github.com/microsoft/playwright/blob/v1.49.0/packages/playwright-core/src/server/recorder/contextRecorder.ts#L1099-L1113)
- [page / frame / download / dialog / popup 事件](https://github.com/microsoft/playwright/blob/v1.49.0/packages/playwright-core/src/server/recorder/contextRecorder.ts#L1141-L1290)
- [测试 ID 配置回退](https://github.com/microsoft/playwright/blob/v1.49.0/packages/playwright-core/src/server/recorder/contextRecorder.ts#L1246-L1249)
- [frame selector 回退逻辑](https://github.com/microsoft/playwright/blob/v1.49.0/packages/playwright-core/src/server/recorder/contextRecorder.ts#L1322-L1385)

### 2.2 selector generator 是独立的一层

Playwright 的 selector generator 不是绑死在 Inspector UI 里的。Issue #13900 里，维护者明确建议：

- 可以从 `injected/` 目录复制相关代码
- 实例化 `InjectedScript`
- 调用 `generateSelector()`

这说明可复用的核心其实是“页面内的 selector 生成器”，不是 UI。

参考：

- [Issue #13900: SelectorGenerator as standalone package](https://github.com/microsoft/playwright/issues/13900)

### 2.3 `playwright-main/packages` 里最值得借鉴的文件

如果只看一个文件，`packages/injected/src/selectorGenerator.ts` 确实是核心；但它只是“selector 怎么选”的主入口，不是完整方案。更现实的做法是按三层一起借：

#### 第一层：selector 选择规则

这些文件直接决定 locator 稳不稳定、能不能唯一命中，优先级最高。

| 文件 | 作用 | 我们最该借什么 |
| --- | --- | --- |
| `packages/injected/src/selectorGenerator.ts` | selector 生成主逻辑 | 候选打分、唯一性收敛、父链回溯、`nth`/CSS 兜底、交互元素 retarget |
| `packages/injected/src/roleUtils.ts` | ARIA role 和 accessible name 计算 | `getByRole()` 的基础语义规则，避免 role/name 推断错误 |
| `packages/injected/src/selectorUtils.ts` | 文本提取、label 提取、文本匹配 | `getByText()` / `getByLabel()` 候选生成的底层规则 |
| `packages/injected/src/domUtils.ts` | DOM 可见性、shadow DOM、父链与 scope 工具 | 可见性判断、跨 shadow 祖先查找、scope 限定 |
| `packages/injected/src/injectedScript.ts` | 页面内运行时入口 | 理解 selector generator 如何注入页面并执行 |

#### 第二层：locator 和代码输出

这些文件决定“内部 selector”怎么变成最终可读、可维护的 Playwright 代码，适合我们保留业务壳，只借生成规则。

| 文件 | 作用 | 我们最该借什么 |
| --- | --- | --- |
| `packages/isomorphic/locatorUtils.ts` | 定义 `getByRole/getByText/getByTestId` 等内部 selector 片段 | 统一 locator 表达层 |
| `packages/isomorphic/locatorGenerators.ts` | 把内部 selector 翻译成公开 locator 代码 | `page.getByRole(...).click()` 这类可读输出规则 |
| `packages/isomorphic/locatorParser.ts` | 解析 locator 并归一化 | 未来若支持 locator 编辑/回显，可直接借思路 |
| `packages/isomorphic/stringUtils.ts` | 转义、引号、文本序列化 | 避免手写字符串转义导致脚本错误 |
| `packages/isomorphic/codegen/javascript.ts` | 生成 JavaScript / Playwright Test 代码 | action 到脚本语句的映射方式 |
| `packages/isomorphic/codegen/language.ts` | 多语言 codegen 的公共格式化逻辑 | click options、快捷键、signal 等通用处理 |
| `packages/isomorphic/codegen/types.ts` | codegen 输入输出模型 | 我们自己的录制 action schema 可以向它对齐 |

#### 第三层：录制器架构与 frame 处理

这些文件更适合参考“系统怎么拆”，不一定要直接移植实现。

| 文件 | 作用 | 我们最该借什么 |
| --- | --- | --- |
| `packages/injected/src/recorder/recorder.ts` | 页面内录制器，监听 click/input/hover/pick | 录制时机、元素高亮、pick locator 体验 |
| `packages/playwright-core/src/server/recorder/recorderUtils.ts` | 服务端录制辅助工具 | frame selector 递归生成与回退规则 |
| `packages/playwright-core/src/server/recorder/recorderRunner.ts` | 录制动作执行辅助 | 可执行动作与执行参数的拆分方式 |
| `packages/recorder/src/recorder.tsx` | Playwright 自己的录制器 UI | 只参考交互，不建议直接照搬 UI 架构 |

#### 直接阅读顺序建议

如果要快速建立整体认识，建议按这个顺序读：

1. `packages/injected/src/selectorGenerator.ts`
2. `packages/injected/src/roleUtils.ts`
3. `packages/injected/src/selectorUtils.ts`
4. `packages/isomorphic/locatorGenerators.ts`
5. `packages/isomorphic/codegen/javascript.ts`
6. `packages/playwright-core/src/server/recorder/recorderUtils.ts`

读完这 6 个文件，基本就能回答三个关键问题：

1. 元素为什么被翻译成这个 locator。
2. locator 为什么会继续收敛或回退。
3. 最终代码为什么长成 `page.getByRole(...).click()` 这种形式。

#### 许可与使用方式

这些文件头部都带 Apache 2.0 许可声明。适合借鉴的是：

- 候选优先级和打分思路
- 可见性 / role / label / text 的判定规则
- selector 到公开 locator 的翻译方式
- action 到脚本代码的格式化方式

不建议把内部 `internal:` selector 直接当成我们自己的稳定协议，也不建议把 Playwright Inspector UI 当成必须复用的核心依赖。

## 3. 可直接借鉴的规则

| 规则 | Playwright 做法 | 我们怎么用 |
| --- | --- | --- |
| Locator 优先级 | `role -> text -> test id` | 先做语义化 locator，再退回文本/CSS |
| 唯一性收敛 | 如果多个元素匹配，就继续细化 locator | 给 locator 打分，优先唯一且稳定的候选 |
| Frame 处理 | 递归生成父 frame selector，再回退到 `iframe[name]` / `iframe[src]` | 生成可回放的 frame path，而不是只记单个 CSS |
| Test ID 配置 | `testIdAttributeName` 可配置，默认 `data-testid` | 支持项目级 test id 约定 |
| 动作采集 | 区分“可执行动作”和“结构性事件” | 把 click/fill/select/press 和 navigation/popup/download 分开 |
| 断言生成 | 支持录制 visibility/text/value 断言 | 后续可补“录完自动补断言” |
| 录制位置 | 支持 `Record at cursor` | 后续可做“从当前步骤继续录制” |

## 4. 不能直接照搬的地方

### 4.1 不要依赖内部 selector 字符串

Playwright recorder 内部会出现一些内部格式，例如 `internal:`、`aria-ref` 之类的临时表示法。它们适合 recorder 内部使用，不适合作为我们最终输出的脚本格式。

我们最终应该输出公开 API 风格的 locator，例如：

- `page.getByRole(...)`
- `page.getByLabel(...)`
- `page.getByPlaceholder(...)`
- `page.getByTestId(...)`

### 4.2 不要把 Inspector UI 当成核心依赖

Playwright 的 Inspector / VS Code 体验是它自己的产品形态。我们这里更需要的是：

- 录制壳层
- 会话管理
- 线程锁
- 脱敏
- 保存 / 复制 / 导出

UI 可以参考，但不建议强绑定。

### 4.3 不要假设“每次都是全新 context”

Playwright 默认测试强调 browser context 隔离；但我们这个项目的内置浏览器是共享目标，线程之间还要复用会话和登录态。

参考：

- [Playwright Test Isolation](https://github.com/microsoft/playwright/blob/main/docs/src/browser-contexts.md)

## 5. 对我们项目的落地建议

当前仓库里，`src/main/browser/recording/ai-recording-service.ts` 已经在做“动作 -> Playwright 脚本”的第一版转换，`src/renderer/src/components/browser/BrowserAiRecordingControls.tsx` 负责录制壳层。

下一步建议按这个方向演进：

1. 把 locator 生成器拆成独立模块。
2. locator 候选至少补齐 `role / label / placeholder / text / test id / CSS fallback`。
3. 给候选 locator 加唯一性检查和稳定性评分。
4. frame 处理改成父链路径生成，不只靠当前元素。
5. recorder 继续保留线程归属、脱敏、去重和保存逻辑。

## 6. 一句话总结

Playwright 真正值得借鉴的是“怎么把真实交互变成稳定、可读、可维护的测试代码”的规则，而不是它的录制 UI 本身。
