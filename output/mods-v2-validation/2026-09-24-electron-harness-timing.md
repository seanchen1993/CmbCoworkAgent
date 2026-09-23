# Electron 脚本时序修正 — 2026-09-24

基线 `88ced672`，生产代码不在本提交范围。

- native-read 完整 Electron 首次 132 检查后 ToolBatch 提交超时，截图中提示仍停留 composer；旧脚本独立 ToolBatch 随后 6 检查通过。不能据此断言生产工具链故障或已证明唯一根因。脚本改为填入后点击实际表单 submit 按钮，让 Playwright 等待按钮可用；仍执行同样的原生工具/回执/模型/取消/撤权断言，没有重试提交。
- focus 完整 Electron 第一轮 27 检查后立即读取代码 token 颜色失败；失败截图显示随后高亮已呈现。修改为在既有 30 秒直到条件成立的边界内，等待实际 computed colors 多于一种；不删除断言、不改生产高亮、不增加固定 sleep。
- 第二次完整回归最终 exit 0，172 项检查通过，包括 Code、ToolBatch，普通 out 已恢复；日志/产物 2026-09-24-focus-full-electron-2.log 及同名前缀 artifacts/。包含未提交的焦点能力差异，不是干净基线单独验证，报告明确保留该边界。
- 新 helper scoped ESLint 零错误/警告。属于测试时序修复，不是业务验收证明。
