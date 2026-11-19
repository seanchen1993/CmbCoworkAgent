# 私聊 Bot 记忆的编辑入口

2026-11-19 14:35（Asia/Shanghai）。macOS arm64，分支 `codex/merge-uat-into-bot-beta`，基线 `35aa5a4db7`，叠加本地长期记忆开关和本轮界面改动。使用隔离 Electron 构建、临时 Bot 和本地模拟模型。

| 用例 | 观察结果 |
| --- | --- |
| 私聊管理页新增一条仅私聊记忆 | 条目显示使用范围，列表顶部已移除群内记忆提示。 |
| 点击标题编辑后取消，再从「… → 编辑记忆」修改周报偏好并保存 | 新内容显示在列表中，通过 IPC 重新读取确认只有一条同名记录，范围仍为私聊。分享与删除入口仍可打开并取消。 |
| 应用全局记忆关闭、Bot 长期记忆开启，在同一会话要求模型更新偏好 | 运行时提供五个 Bot 记忆工具。模拟模型依次调用 `bot_memory_list`、`bot_memory_get`、`bot_remember`，原记录 ID 保持不变，版本更新。请求日志记录 0 个错误。 |

复现使用 `npm run test:bot-integration:e2e -- --build-only` 生成构建，设置 `BOT_TEST_APP_OUT` 后分别运行 `node --import tsx tests/bots-details-cards-app.spec.ts` 和 `node --import tsx tests/bots-memory-app.spec.ts`。两项均通过。记忆工具和编辑表单的 18 项 Vitest 回归、Web 类型检查均通过。本轮验证界面、持久化和工具链路，模型选择工具的自然语言效果未纳入测试。

## 14:42 私聊记忆范围说明复测

按新的界面要求，将原先只解释群聊的提示改为三行使用范围说明。沿用上述基线与隔离 Electron 环境，重新构建后运行 `tests/bots-details-cards-app.spec.ts`。私聊「全部记忆」显示仅私聊、Bot 共享、群内三行及对应的任务范围。进入编辑后仅显示当前条目的范围说明，群聊管理页沿用本群说明。菜单编辑保存和群聊切换通过，退出码为 0。核对了构建产物中的 `artifacts/bot-details-memory.png`，Web 类型检查通过。本轮覆盖界面文案与展示位置。

## 14:46 单句范围说明复测

按最新反馈将三行说明合并为一句，每个类型名称使用「」并保持完整换行。使用同一隔离 Electron 流程重新构建并运行 `tests/bots-details-cards-app.spec.ts`，退出码为 0。私聊侧栏的文本与预期一致，群聊和编辑态的显示断言通过。检查了本轮生成的 `artifacts/bot-details-memory.png`，窄侧栏内段落自然折行。
