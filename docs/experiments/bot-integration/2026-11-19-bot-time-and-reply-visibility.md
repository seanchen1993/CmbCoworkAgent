# 招乎群的当日日期与 Bot 汇报中的过程文字

2026 年 11 月 19 日，在集成分支 `codex/merge-uat-into-bot-beta` 的 `8044ad96c` 上核对。使用 macOS、Node.js 25.5.0 和 Vitest 3.2.4。本轮做确定性回放，模型与内网服务均未参与，未改产品代码。

## 输入与观察

使用模拟群请求「请检查今天的日志」，固定 `TZ=Asia/Shanghai`，宿主采样时间为 `2026-11-19T09:16:00Z`。用人工构造的助手文字分别覆盖首次确认、交办前的跟进和主 Bot 汇报。

| 核对点 | 结果 |
| --- | --- |
| 本轮时间 | `isBotCommunicationTurn` 识别为群主对话。`buildBotTurnContext` 返回 UTC 时间和 `Asia/Shanghai`，对应本地 11 月 19 日 17 时 16 分。 |
| 群聊首次确认 | 给 `currentBotReplyState` 一条同时包含中文确认和英文计划的助手消息，两段文字都留在首回复里。IM 首回复的入队入口会保留这段正文。 |
| 交办时补发 | 再给同一轮放入两条带工具调用的计划文字，两条都按顺序进入 `followup`，中间用空行分隔。 |
| 最终汇报 | 在相同中文结论前放一段无标记的英文计划，`normalWorkResultSummary` 将其原样保留。将同一计划包在开头的 `<think>…</think>` 内，结果只保留结论。两例中，结论自带的 `NoSuchKey` 都得到保留。 |

回放直接通过 `env TZ=Asia/Shanghai TSX_DISABLE_CACHE=1 node --require tsx/cjs` 调用对应源码函数。已有回归执行如下，4 个文件、55 条断言用例全部通过。首次使用 Vitest 的 runner 配置加载器时，仓库配置中的 `__dirname` 无法解析，随后按默认加载方式执行成功。

```sh
node_modules/.bin/vitest run --no-cache --maxWorkers=1 \
  src/main/bots/prompt.test.ts src/main/agent/bot-turn-context.test.ts \
  src/main/agent/bot-dispatch-feedback.test.ts src/renderer/src/lib/bot-inline-reasoning.test.ts
```

## 边界

回放确认了日期的来源、交办跟进的拼接，以及汇报正文会保留无标记的过程文字。内网运行的模型原始响应和工具回执未随截图提供，无法据此还原当时的取时指令来源、Shell 调用次数，或判断英文最早出现于模型正文还是响应转换阶段。
