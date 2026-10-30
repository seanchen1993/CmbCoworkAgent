# 回归修复登记与验证约定

## 必须遵守的流程

每次完成新的问题修复后，必须阅读本文件中的全部历史修复记录，并执行或补充相应的回归测试，确认此前修复的问题没有被破坏。只有相关历史测试和本次新增测试通过后，才可以把修复视为完成。

新增问题修复时，必须在下方追加一条记录，至少写明：问题表现、根因、修复方式、回归测试及相关文件。已有记录不得删除；如果验证方式发生变化，应更新对应记录。

## 历史修复记录

### 2026-10-19：录制脚本点击 Ant Design 单选按钮时发生 strict mode 冲突

- 问题表现：录制脚本使用全页面 `getByText(..., { exact: true })` 点击单选项；当 iframe 内表格也出现相同文字时，一个 locator 命中多个元素，回放报 `strict mode violation`。
- 根因：录制器选中了单选按钮 label 内的文字 span，只保存了文字 selector，没有利用同一 label 内 radio/checkbox input 的稳定属性。
- 修复方式：点击 radio/checkbox 的 label 内容时，如果 input 的 `type`、`name`、`value` 组合可以唯一定位 label，则录制为 `label:has(input[...])`，避免与页面其他同名文本冲突。
- 回归测试：`npx tsx tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`；`npx vitest run tests/browser/record/script-record/recorded-text-selector.test.ts tests/browser/record/script-record/script-recording-service.test.ts`。
- 相关文件：`src/main/browser/record/script-record/script-recorder-playwright-adapter.ts`、`tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`。

### 2026-10-20：录制脚本点击重复同名按钮时发生 strict mode 冲突

- 问题表现：页面同时存在多个同名按钮时，录制脚本保存全页面 `getByRole(...)`；例如两个“发送”按钮分别位于“计划发送”和“缺少主题”区域，回放时报 `strict mode violation`。
- 根因：Playwright action 上报的 selector 可能同时命中多个元素，录制适配器只在 selector 含瞬态样式时才使用鼠标实际悬停目标生成的稳定 selector，没有在普通重复匹配场景保留实际点击元素的作用域。
- 修复方式：点击、选中或取消选中动作的 selector 命中多个元素时，确认鼠标实际悬停元素属于该匹配集合，并改用悬停目标的 Playwright 生成 selector；因此可录制为 `getByLabel("缺少主题").getByRole("button", { name: "发送" })` 等带作用域的 locator。
- 回归测试：`node node_modules/vite-node/vite-node.mjs --script tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`；`npx vitest run tests/browser/record/script-record/recorded-text-selector.test.ts tests/browser/record/script-record/script-recording-service.test.ts`。
- 相关文件：`src/main/browser/record/script-record/script-recorder-playwright-adapter.ts`、`tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`。

### 2026-10-22：Element UI 动态浮层 ID 导致回放无法点击菜单项

- 问题表现：录制浮层中的“Merge（推荐）”后，脚本保存了 `locator('#el-popover-3396').getByText('Merge（推荐）')`；再次打开浮层时 ID 变为 `el-popover-7965`，回放等待旧 ID 直至超时。
- 根因：组件库会为 popover、tooltip、dropdown、popper 生成“任意组件前缀 + 浮层类型 + 递增数字”的瞬态 ID（如 `el-popover-3396`、`custom-menu-popover-9001`），Playwright codegen 将该 ID 作为祖先作用域写入 selector，跨渲染后不再有效。
- 修复方式：新录制的 click/check/uncheck 在确认文本唯一对应鼠标实际目标后，不再保存末尾为 `popover/tooltip/dropdown/popper-数字` 的动态浮层 ID；回放已有脚本时，将具体数字 ID 转换为同类可见浮层的稳定 ID 前缀 selector，既兼容存量脚本，也保留浮层作用域。普通 selector、重复同名元素和既有作用域 locator 继续沿用原逻辑。
- 回归测试：`node node_modules/vite-node/vite-node.mjs --script tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`；`npx vitest run tests/browser/record/script-record/recorded-text-selector.test.ts tests/browser/record/script-record/script-recording-service.test.ts tests/browser/shared/browser-script-recording-utils.test.ts`。
- 相关文件：`src/main/browser/record/script-record/script-recorder-playwright-adapter.ts`、`src/shared/browser-script-recording.ts`、`tests/browser/record/script-record/recorded-text-selector.test.ts`、`tests/browser/record/script-record/recorded-text-selector.browser.spec.ts`、`tests/browser/shared/browser-script-recording-utils.test.ts`。
