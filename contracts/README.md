# ChatX 统一机器人共享契约

本目录是 Desktop、Mock Gateway 与 Java Gateway 共用的 V1 协议基线。生产网关不得从客户端 TypeScript 源码反向猜字段；实现时直接读取 `schema/` 和 `fixtures/v1/`。

当前冻结范围：

- `DesktopGatewayWsEnvelopeV1`：Desktop 与 Java Gateway 的完整 WSS envelope、握手、
  心跳、ACK、permit、reply、sync 与错误关联；
- `RemoteImEventV1`：网关向企业主体当前单活桌面连接投递的单聊文本事件；
- `RemoteImAckV1`：Desktop 在持久化边界后发送的事件 ACK；
- `RemoteImReplyV1`：Desktop 写入本地 outbox 后提交给网关的文本分段。

实现约束：

1. WSS HTTP Upgrade 使用现有企业登录取得的标准 JWT `ystIdToken`；Java 网关必须完整
   验证签名、允许算法、issuer、audience、时间和主体 claim，不得只 decode；
2. schema 使用 JSON Schema draft 2020-12，未知字段一律拒绝；
3. `schemaVersion` 只出现在 Event/Reply payload，ACK 由 WSS envelope 统一承载版本；
4. `conversationSeq` 从 1 开始；`segment.index` 从 0 开始；
5. JSON Schema 能约束 `index <= 7` 和 `count <= 8`，实现还必须额外检查 `index < count`；
6. 每段 `message.content` 最多 2,800 个 Unicode code point，前缀和 `[i/n]` 均计入；
7. 重投可以更新尚未 acquire permit 的 `lease.id/expiresAt`，但不得改变 event 身份、正文、顺序或客户端首次固化的 target snapshot；
8. `completed` ACK 表示 Desktop 已把结果与完整回复 outbox 严格落盘，不表示平台已经送达；
9. 相同 `idempotencyKey` 的重试必须逐字段相同，不得用新 key 绕过发送结果未知。
10. 每个 `principalId` 只保留一个活动桌面连接；后连接替代先连接，旧连接收到
    `SESSION_SUPERSEDED` 后不得自动重连。连接 generation 只做 socket fencing，不进入
    Event、Reply、conversation 或授权业务字段。

TypeScript 的同构 payload 类型和额外跨字段校验位于 `src/shared/im-gateway-contract.ts`。文件名含 `.valid.json` 的 Golden fixtures 必须同时通过 Desktop 测试和 Java Gateway 的 schema validator；`.invalid-*.json` 必须得到对应的稳定拒绝。其中 `remote-reply.invalid-segment-relation.json` 是 JSON Schema 不能表达的跨字段反例，双方还必须执行 `index < count` 的业务校验。任一端需要增删字段时，必须先升级 schema/fixture 并由双方评审。

WSS 入口见 `asyncapi/desktop-gateway-ws-v1.yaml`，全部帧以
`schema/desktop-gateway-ws-v1.schema.json` 为准。招乎 webhook、单聊文本、幂等和错误码已经
内嵌在 `docs/chatx-gateway-agent-plan/01-contract-freeze.md`，身份同步契约在阶段三任务单中。
唯一仍需负责人补充的外部资料是 Token 获取和 Token 刷新两份正式文档；阶段一必须将它们归档为
Java 网关仓库内契约和 fixture，之后不再依赖外部附件。
