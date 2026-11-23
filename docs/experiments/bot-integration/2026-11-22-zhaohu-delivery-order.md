# 招乎出站消息顺序与延迟复现

2026-11-22（Asia/Shanghai）。本轮检查从 App 消息入队到网关调用招乎发送接口的阶段，验证同一会话中的后发消息能否越过前一条，以及慢请求是否会影响其他群。

## 环境和方法

- App 对照版本为 `uat-without-mods@89b4ed0eb` 和 `codex/merge-uat-into-bot-beta@d26a05a77`。两个版本的 Bot 发送队列和发送服务一致。探针以 Node 25.5.0 运行真实的 `BotMockChannelStore`，选择生产使用的 `im` 分支及 `NativeSqliteAdapter`，数据库在内存中。
- 网关使用 `913b5e9` 的 `ReplyOutboxWorker`、`ReplyOutboxStateService` 和生产 MyBatis 映射，在 JDK 17、H2 和现有 `BotChannelTestFixture` 下运行。发送接口使用可控替身，记录其成功接受的顺序。所有会话和正文均为合成数据。
- 网关顺序实验将同一条群回复拆成 A、B，分段索引分别为 0、1，入队时间相差 1 毫秒，避开同一时间戳的排序歧义。每个场景使用新的数据库。按 A、B 交付为顺序基准。未调用模型和真实招乎接口。

## 结果

| 场景 | 注入条件 | 实际结果 |
| --- | --- | --- |
| 网关单实例对照 | A、B 均首次发送成功 | 招乎接口替身依次接受 A、B |
| 网关单实例重试 | A 首次返回明确未送达的可重试结果 | 本批只发出 B。数据库为 A 设定 30 秒重试等待，到期后顺序为 B、A |
| 网关双实例 | 实例一发 A 时暂停，实例二开始处理同一队列 | 实例二发出 B，再放行 A，顺序为 B、A。两个分段都成功，无重试 |
| App 同群同任务首回复与最终回复 | A 为首回复，B 为最终回复。把 A 的首次提交标记为临时失败 | B 先被取出提交，A 的首次重试等待为 5000 毫秒。到期后 A 才被取出 |
| 网关单实例、两个独立群 | 两群各一条消息。为先处理的 A 注入 1000 毫秒发送耗时，两条都成功 | B 的接口调用比 A 晚开始 1026 毫秒。该数值是单次本地实测 |

重试测试读取实际排定的时间，再推进 App 测试时钟或将网关记录设为已到期。5 秒和 30 秒均为调度值。跨群慢请求测试使用真实经过时间。三个探针均以退出码 0 结束，App 探针另输出 Node SQLite 的实验特性提示。

脱敏后的关键输出如下。

```text
EVIDENCE control delivered=[A, B]
EVIDENCE retry first batch=[B]
EVIDENCE retry due seconds=30
EVIDENCE retry delivered=[B, A]
EVIDENCE two-workers delivered=[B, A]
EVIDENCE app first accepted=B retry due ms=5000
EVIDENCE app delivered=B,A
EVIDENCE unrelated groups, injected A latency=1000ms, B call starts 1026ms after A call starts
```

## 定位与适用范围

App 的 `bot-channel-service.ts` 按分段顺序等待网关受理。网关 `ReplyAcceptanceService` 将待发送记录持久化后即可返回受理。`ReplyOutboxMapper.findCandidates` 只筛选已到可发送时间的记录，按创建时间排序。`ReplyOutboxStateService.claim` 只认领单条记录。前一段正在发送或等待重试时，下一段仍可被其他实例或下一次发送选中。App 的 `beginDelivery` 也允许取出已经到期的后续回复，`delivered` 给临时失败的回复单独设置退避时间。

空闲时 App 每秒检查待发送消息。网关默认在上一批结束 1 秒后再轮询，每批最多 10 条，同一实例逐条等待招乎返回。实验中两个群的正常消息发生了互相等待。文件与文本另有独立的 App 发送通道，本轮未测正文与附件的实际到达顺序。

本地没有本次内网异常对应的投递记录。若要归因到具体消息，可用网关 `deliveryId` 串起受理、开始发送、安排重试和平台成功回执；用 `segmentIndex` 区分分段，`attemptCount` 区分尝试，`queuedMs` 是入网关队列至当前尝试的累计时长。若平台回执顺序与客户端显示顺序不同，需再对照 `platformMessageId` 和招乎侧时间。内网部署版本、实例数、平台耗时及本次乱序的实际触发条件仍待现场记录确认。
