# UAT 搜索、Team 通知与 Bot 回执合并验证

2026-11-19，Asia/Shanghai。集成分支以 `7417088d9` 为起点，合入 `uat-without-mods` 的 `a06a80b75`。本轮检验同一条回复从运行时写入历史、再从界面或搜索打开时，内容、身份和可见范围是否一致。

## 条件

macOS arm64，Node.js 25.5，真实 Electron、React、SQLite 和搜索 Worker。测试使用空配置、合成会话和可控的流式模型，招乎通道使用本机 WebSocket 测试网关。

## 用例和结果

| 用例 | 验收与观察 |
| --- | --- |
| Team 子任务回报 | 在子任务回报前观察主 Agent 草稿，等待回复完成，再冷启动打开历史。正常完成和触发完成核验两条路径均只显示一份回复。 |
| 跨会话搜索 | 从另一条会话搜索 Team 的回报正文，实际点击结果，已打开目标会话，活动高亮命中原句。普通会话列表可搜索独立任务，Bot 私聊和群主对话的内部记录保持隔离。 |
| Workflow 历史回放 | 初次合并在新通知到达后重放了旧回复。修正通知类型的消息边界后，历史持久化回归通过，Bot 任务内补充的执行语义也通过回归。 |
| 交办确认 | 通过桌面 App 和模拟招乎网关交办。接受后只确认一次，预算续办没有多一次模型确认，执行失败和任务的新结果仍然可见。 |
| 任务预览 | 搜索引擎升级后，预览改为读取投影的正文字段，标题和预览文本的回归通过。 |

搜索长会话后，首轮桌面回归通过了 33 项检查，随后在「继续读取中间消息」时停在新页末尾。仅重试滚动未能消除问题。翻页替换的是整页消息，最终改为同时更新虚拟列表的窗口版本，让新页使用自己的行高和定位信息。修正后，工具消息尾部、隐藏提示尾部、跨分页 Goal 以及超过驻留上限后的双向翻页均通过 Electron 回归。

两端 TypeScript 检查和隔离构建通过。25 个 Vitest 文件共 810 项通过，运行队列 44 项、队列接线 52 项及会话分支处理器回归通过。首轮定向套件为 167 项通过、4 项未通过，保留首轮结果用于区分修复前后。

完整导航套件在原始 UAT 和最终合并版均通过前 43 项，同一项超时。会话持续流式增长时，从全局搜索跳回该会话里先前保存的消息，结果列表命中，但屏幕上的高亮没有出现。两次均为 `Timeout: visible LAYOUT_STREAM_EXACT_TARGET in layoutStream-44`，界面结果计数为 `1/1 · 已截断`，测试退出码为 1。此项没有计为通过。

## 主要复现入口

- `node --import tsx tests/message-queue-runtime.spec.ts` 和 `node --import tsx tests/message-queue-plumbing.spec.ts`
- `node --import tsx tests/team-notification-transcript-e2e.spec.ts`，完成核验场景追加 `--gate`
- `node --import tsx scripts/run-bot-integration-e2e.mjs --build-only --handoff`，将隔离构建目录传给 `BOT_TEST_APP_OUT` 并设置 `BOT_FEEDBACK_ONLY=1` 运行 `tests/bots-private-group-app.spec.ts`
- `npm run test:chat-navigation:e2e` 覆盖搜索、可见范围和虚拟列表翻页

此次验证覆盖本地客户端和协议回执。真实内网账号、生产网关和打包后的 Windows 客户端未参与本次验证。
