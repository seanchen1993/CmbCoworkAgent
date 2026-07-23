# ChatX 统一机器人共享契约

本目录是 Desktop、Mock Gateway 与 Java Gateway 共用的 V1 协议基线。生产网关不得从客户端 TypeScript 源码反向猜字段；实现时直接读取 `schema/` 和 `fixtures/v1/`。

当前冻结范围：

- `DesktopGatewayWsEnvelopeV1`：Desktop 与 Java Gateway 的完整 WSS envelope、握手、
  心跳、ACK、permit、reply、takeover、sync 与错误关联；
- `RemoteImEventV1`：网关向固定设备投递的单聊文本事件；
- `RemoteImAckV1`：Desktop 在持久化边界后发送的事件 ACK；
- `RemoteImReplyV1`：Desktop 写入本地 outbox 后提交给网关的文本分段。

实现约束：

1. schema 使用 JSON Schema draft 2020-12，未知字段一律拒绝；
2. `schemaVersion` 只出现在 Event/Reply payload，ACK 由 WSS envelope 统一承载版本；
3. `conversationSeq`、`deviceEpoch` 从 1 开始；`segment.index` 从 0 开始；
4. JSON Schema 能约束 `index <= 7` 和 `count <= 8`，实现还必须额外检查 `index < count`；
5. 每段 `message.content` 最多 2,800 个 Unicode code point，前缀和 `[i/n]` 均计入；
6. 重投可以更新尚未 acquire permit 的 `lease.id/expiresAt`，但不得改变 event 身份、正文、顺序或客户端首次固化的 target snapshot；
7. `completed` ACK 表示 Desktop 已把结果与完整回复 outbox 严格落盘，不表示平台已经送达；
8. 相同 `idempotencyKey` 的重试必须逐字段相同，不得用新 key 绕过发送结果未知。

TypeScript 的同构 payload 类型和额外跨字段校验位于 `src/shared/im-gateway-contract.ts`。文件名含 `.valid.json` 的 Golden fixtures 必须同时通过 Desktop 测试和 Java Gateway 的 schema validator；`.invalid-*.json` 必须得到对应的稳定拒绝。其中 `remote-reply.invalid-segment-relation.json` 是 JSON Schema 不能表达的跨字段反例，双方还必须执行 `index < count` 的业务校验。任一端需要增删字段时，必须先升级 schema/fixture 并由双方评审。

WSS 入口见 `asyncapi/desktop-gateway-ws-v1.yaml`，全部帧以
`schema/desktop-gateway-ws-v1.schema.json` 为准。平台 webhook、身份同步和平台下行 HTTP
仍需由 `docs/chatx-unified-bot-gateway-java-development-plan.md` 的 GW-00 交付线冻结；WSS
契约完成不代表生产外部依赖已经关闭。
