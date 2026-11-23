# 招乎作答卡片的题目编号

2026-11-23 19:30（Asia/Shanghai）。在 `codex/merge-uat-into-bot-beta@04a5f67a1864` 上验证工作区改动。使用 macOS arm64、Node.js 25.5.0、Vitest 3.2.4 和本地模拟网关。用例直接构造待回答请求，未调用模型。[上一轮卡片排版验证](2026-11-20-group-question-text-mode.md)

此前题目和选项都以阿拉伯数字开头。验收要求是把题目标题和对应表单标签统一成「问题一：格式」这样的中文序号，题干下的选项仍按数字逐条列出。提交时继续使用原有字段和选项值。

| 场景 | 观察结果 |
| --- | --- |
| Bot 群卡片含十道单选或多选题 | 正文标题从「问题一」到「问题十」，每道与表单及「其他」输入框对应。选项编号仍加粗且独立成行，反馈键和下拉选项值与原用例一致。 |
| 普通机器人询问导出格式 | 模拟网关收到「问题一：格式」和分行的三个数字选项。回答第一个选项后记录了对应的 CSV 答案，已回答卡片沿用中文序号。 |
| 群内切换文字模式 | 切换后收到短码。先回答单选，再用新短码提交多选，原任务取得两道题的答案。 |

```sh
node_modules/.bin/vitest run src/main/services/im/remote-user-input-service.test.ts src/main/services/im/bot-group-question-mode.test.ts src/main/services/im/bot-interaction-command.test.ts
node --import tsx tests/im-remote-user-input.spec.ts
node --import tsx tests/im-card-interaction.spec.ts
npm run typecheck:node
```

四条命令均退出 0。Vitest 共 3 个文件、17 项通过，耗时 7.67 秒。远程输入脚本 15 项、卡片交互脚本 25 项通过。日志只有 SQLite 和 LangSmith 的实验功能提示。验证覆盖发出的卡片数据和作答流程，实际招乎客户端视觉效果尚未复测。
