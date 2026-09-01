# 阶段一：契约冻结与 Mock

> 这是可独立交给代码 Agent 的任务单。除 Java 网关仓库和本文件外，只需再附上两份正式资料：
> **招乎 Token 获取接口文档**、**招乎 Token 刷新接口文档**。不要再附原始机器人 API 大文档。

## 1. 本阶段目标

把 Desktop WSS、招乎 webhook、招乎单聊文本、Token 获取/刷新和身份边界转换为仓库内可执行的
Schema、fixture、强类型配置和 WireMock。此阶段不实现数据库和真实业务闭环。

固定技术基线：JDK 1.8、内部增强版 Spring Boot 2.7.2、Maven、MySQL 5.7、MyBatis XML。

## 2. 本阶段唯一外部输入

负责人会提供：

1. Token 获取接口正式文档；
2. Token 刷新接口正式文档。

Agent 必须把它们归档成仓库内的 `contracts/http/zhaohu-token-api.md` 和对应 fixture。后续阶段只读
这个仓库内契约，不再要求负责人重复提供原文。

JWT 的 issuer、JWKS URI、audience、主体 claim、允许算法等是部署配置，不是另一份接口附件。
本阶段建立强类型配置项且生产环境无默认值；测试使用明确的本地 issuer/JWKS fixture。

## 3. Desktop WSS 固定契约

所有消息使用同一个 envelope：

```json
{
  "schemaVersion": 1,
  "type": "HELLO",
  "commandId": "client-command-id",
  "sentAt": "2026-07-30T08:00:00.000Z",
  "payload": {}
}
```

- Client 命令和直接响应必须带非空 `commandId`；
- Server 主动推送 `REMOTE_EVENT`、`LEASE_REVOKED` 使用非空 `messageId`；
- 时间为 ISO-8601 UTC；单帧上限 64 KiB；
- 拒绝未知字段、重复 JSON key、trailing token、未知 enum 和非 1 的 `schemaVersion`；
- `HELLO` 不携带 `principalId`，主体只来自已验证 JWT。

### Client -> Gateway

| type                       | payload                                                    |
| -------------------------- | ---------------------------------------------------------- |
| `HELLO`                    | `appVersion:string`、唯一数组 `capabilities[]`、可选唯一数组 `protocolExtensions[]` |
| `HEARTBEAT`                | `sessionId:string`                                         |
| `EVENT_ACK`                | `type/eventId/leaseId`；failed 另带 `retryable/reasonCode` |
| `EXECUTION_PERMIT_ACQUIRE` | `eventId:string`、`lastLeaseId:string`                     |
| `EXECUTION_PERMIT_RENEW`   | `eventId:string`、`lastLeaseId:string`                     |
| `REMOTE_REPLY`             | 本节下方 `RemoteImReplyV1`                                 |
| `SYNC_REQUEST`             | 严格空对象 `{}`                                            |

`capabilities` 只允许 `inbox`、`feature`、`scheduler`、`hitl`。

### Gateway -> Client

| type                              | payload                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `WELCOME`                         | `sessionId/principalId/serverTime/heartbeatIntervalSeconds`                      |
| `REMOTE_EVENT`                    | `{event: RemoteImEventV1}`                                                       |
| `PERMIT_RESULT`                   | GRANTED: `eventId/status/leaseId/expiresAt`；DENIED: `eventId/status/reasonCode` |
| `LEASE_REVOKED`                   | `eventId/reasonCode`                                                             |
| `REPLY_ACCEPTED` / `REPLY_RESULT` | `deliveryId/idempotencyKey/segmentIndex/state/platformReplyId?`                  |
| `SYNC_STATE`                      | `routes[]` 及可选 `defaultConversationKey`；路由项仅 `principalId/conversationKey/state` |
| `ERROR`                           | `reasonCode/message?/eventId?/idempotencyKey?/conversationKey?`                  |

`SYNC_STATE.routes[].state` 只允许 `active`、`suspended`、`revoked`。
`SYNC_STATE.defaultConversationKey` 如存在，必须指向同一响应中的一条 `active` 路由；客户端
将其作为网关根据本次认证身份和当前机器人配置选出的权威默认单聊路由。
客户端只有在 `HELLO.protocolExtensions` 声明 `sync-default-route-v1` 后才允许网关返回该字段；
旧网关忽略扩展声明，旧客户端不会收到新增字段。
`heartbeatIntervalSeconds` 范围为 5～300。

### RemoteImEventV1

```json
{
  "schemaVersion": 1,
  "eventId": "stable-event-id",
  "platformMessageId": "platform-msg-id",
  "principalId": "opaque-principal",
  "conversationKey": "opaque-conversation",
  "conversationSeq": 1,
  "message": { "type": "text", "text": "hello" },
  "occurredAt": "2026-07-30T08:00:00.000Z",
  "lease": { "id": "lease-id", "expiresAt": "2026-07-30T08:01:30.000Z" },
  "redelivered": false
}
```

### RemoteImReplyV1

```json
{
  "schemaVersion": 1,
  "deliveryId": "delivery-id",
  "eventId": "event-id",
  "conversationKey": "opaque-conversation",
  "idempotencyKey": "delivery-id:reply:0",
  "segment": { "index": 0, "count": 1 },
  "message": { "type": "text", "content": "done" }
}
```

- `eventId` 对 scheduler 或 Desktop 主动消息可缺省；
- `segment.index` 从 0 开始，`count` 为 1～8，且 `index < count`；
- Desktop 单段最多 2,800 Unicode code points；平台发送上限仍是 3,000 个字符。

## 4. 招乎上行 webhook 契约（已内嵌）

招乎后台把 webhook 配置为 Gateway 自己定义的固定地址：

```http
POST /api/v1/platform/zhaohu/callback
Content-Type: application/json
```

首版只处理“单聊文本”。官方请求字段如下：

| 字段            | 类型   | 必填 | 首版处理                                                   |
| --------------- | ------ | ---- | ---------------------------------------------------------- |
| `msgId`         | string | 是   | 平台消息唯一 ID，作为永久去重键                            |
| `msgType`       | string | 是   | 只有精确值 `text` 进入 Desktop                             |
| `timestamp`     | long   | 是   | 接受 10 位秒或 13 位毫秒，统一转 UTC `Instant`             |
| `fromId`        | string | 是   | 用户招乎 OpenID，只用于权威身份映射                        |
| `toId`          | string | 否   | 机器人招乎 OpenID                                          |
| `groupId`       | long   | 否   | 非空且非 0 表示群消息，首版记为 `IGNORED`                  |
| `groupOpenId`   | string | 否   | 非空表示群消息，首版记为 `IGNORED`                         |
| `groupName`     | string | 否   | 首版不使用                                                 |
| `msgContent`    | string | 条件 | `msgType=text` 时必填，是用户文本正文                      |
| `netWorkStatus` | int    | 是   | 0 未知、1 办公网、2 互联网、3 业务网；首版不参与身份和路由 |
| `deviceId`      | string | 否   | 招乎终端信息，明确忽略，不作为 ChatX 设备                  |
| `clientType`    | string | 否   | `pc/ios/android/pad`，明确忽略                             |
| `skillCode`     | string | 否   | 首版不使用                                                 |

示例：

```json
{
  "msgId": "1591668393690",
  "msgType": "text",
  "timestamp": 1785398400000,
  "fromId": "USER_OPEN_ID",
  "toId": "ROBOT_OPEN_ID",
  "groupId": null,
  "groupOpenId": null,
  "msgContent": "帮我总结今天的工作",
  "netWorkStatus": 1,
  "deviceId": "pc-device-value",
  "clientType": "pc"
}
```

处理约定：

- callback JSON 允许平台未来增加未知字段，但只把上表白名单字段映射到 domain；
- 不保存完整原始 body；对规范化白名单字段计算 SHA-256 payload hash；
- 相同 `msgId`、相同 hash 返回既有结果；相同 `msgId`、不同 hash 记录冲突并拒绝；
- 数据库事务成功提交后返回 `HTTP 200` 和 `{"code":0,"msg":"success"}`；
- 校验失败返回 400，来源认证失败返回 403，持久化失败返回 5xx，绝不能先回成功再落库；
- 官方原文没有承诺超时、重投次数或顺序；实现必须依靠 `msgId` 去重，不能依赖固定重试次数。

### webhook 安全

已提供的官方原文**没有签名 Header 或验签算法**，因此禁止 Agent 发明 HMAC 字段。首版使用：

1. 内网 HTTPS；
2. 在可信入口限制招乎生产出口网段 `12.6.72.0/21`、`12.6.112.0/21`；
3. 应用只信任直连 peer IP，或由明确配置的可信反向代理传入的已验证来源属性；不得直接信任任意
   `X-Forwarded-For`；
4. 来源认证必须在 JSON 进入 domain 前完成。

## 5. 招乎单聊文本下行契约（已内嵌）

```http
POST {ZHAOHU_BASE_URL}/robot-service/single-message/text
Authorization: Bearer <robot-access-token>
ROBOT-MESSAGE-ID: <stable-lowercase-uuid>
Content-Type: application/json

{
  "fromId": "<robot-open-id>",
  "toId": "<user-open-id>",
  "content": "<text, max 3000 chars>"
}
```

字段规则：

- `fromId` 是统一机器人的招乎 OpenID；
- `toId` 是当前 conversation 保存的用户招乎 OpenID；
- `content` 与 `base64Content` 原接口允许二选一，首版只发送 `content`；
- 文本不得超过 3,000 个字符；
- `ROBOT-MESSAGE-ID` 原接口标为可选，但 Gateway 必须发送；不同业务消息使用不同 UUID，同一
  业务重试始终复用原 UUID；
- 平台只保证同一 `ROBOT-MESSAGE-ID` 在 10 分钟内防重，Gateway 自动重试安全窗取 8 分钟。

成功响应：

```json
{
  "code": 0,
  "msg": "1591668393690"
}
```

`msg` 是平台消息 ID，必须持久化。HTTP 200 但 `code != 0` 不是成功。

| HTTP / code | 分类         | 固定处理                                           |
| ----------- | ------------ | -------------------------------------------------- |
| `200 / 0`   | 成功         | 标记 SENT，保存 `msg`                              |
| `200 / 120` | 业务失败     | 接收方 OpenID 非法，永久失败                       |
| `400`       | 参数错误     | 永久失败                                           |
| `401`       | Token 无效   | 强制刷新一次并用同一消息 ID 重试；第二次失败则停止 |
| `403`       | 无接口权限   | 永久失败并告警                                     |
| `404`       | 路径错误     | 永久失败并告警                                     |
| `429`       | 限流         | 在 8 分钟安全窗内退避重试，复用原消息 ID           |
| `5xx`       | 平台临时失败 | 在 8 分钟安全窗内退避重试，复用原消息 ID           |
| timeout     | 结果不确定   | 安全窗内可复用原 ID 重试；超出安全窗进入 UNKNOWN   |

## 6. Token 两份文档的归档要求

Agent 从负责人提供的两份正式文档中逐项抄录并测试，禁止猜测：

- acquire/refresh URI 和 HTTP method；
- Authorization/Header、client 标识和 secret 字段；
- 请求 DTO、Content-Type 和字符编码；
- access token、refresh token、token type 字段；
- `expires_in` 单位和 refresh token 是否轮换；
- HTTP/业务成功码及全部错误码；
- 401 后允许 refresh 还是重新 acquire；
- 平台建议的提前刷新窗口和并发要求。

必须生成：

- `contracts/http/zhaohu-token-api.md`：完整归一化契约；
- acquire/refresh 成功、轮换、401、429、5xx、timeout fixture；
- WireMock stub；
- 敏感字段日志脱敏测试。

如果两份正式文档互相矛盾，只把 Token Adapter 标记为 `BLOCKED` 并列出具体字段；不得阻塞 WSS、
webhook 和文本 API fixture。

## 7. 身份与安全固定规则

- `principalId` 只从已验证 `ystIdToken` 的可配置主体 claim 取得；
- 必须验证 JWS 签名、算法 allowlist、issuer、audience、`exp/nbf/iat` 和 clock skew；
- HELLO、URL、普通 Header 和 JSON body 都不能覆盖 `principalId`；
- Gateway 自己提供幂等的 OpenID 绑定/撤销管理能力，契约由阶段三任务单直接规定，不需要另一份
  外部 API 文档；
- OpenID、正文、access/refresh token 必须通过批准的 Crypto/Secret Adapter；
- prod 缺正式安全 Adapter 或必填配置时启动失败；
- 日志和指标禁止 Authorization、JWT、Token、OpenID、`principalId`、正文和完整 payload。

## 8. 实施任务

### C-01：WSS Schema 与 fixture

- 按第 3 节生成 Schema 和全部 15 种消息的 valid/invalid fixture；
- 对 commandId/messageId、字段白名单、枚举、时间和边界做 contract test。

### C-02：招乎 HTTP fixture

- 按第 4、5 节生成 webhook 与文本发送 DTO、fixture 和 WireMock；
- callback mapper 与 WSS strict mapper 分开；
- 覆盖重复 msgId、hash 冲突、群聊、非文本和错误码。

### C-03：Token fixture

- 按第 6 节归档负责人提供的两份 Token 文档；
- 生成强类型配置、fixture 和 WireMock，不实现生产 Token Provider。

### C-04：安全与启动检查

- 建立 JWT、CallbackAuthenticator、CryptoPort、SecretPort 的 Port 和 local/test mock；
- mock 不得在 prod profile 装配；
- prod 缺配置或正式 Adapter 时 fail closed。

## 9. 验收与退出

- WSS、webhook、文本发送和 Token valid fixture 全通过，invalid fixture 精确失败；
- 招乎 API 测试不依赖原始大文档；
- 代码和配置中不存在猜测的 Token URI/字段；
- 敏感信息扫描通过；
- `./mvnw verify` 在真实 JDK 1.8 通过；
- Agent 提交改动文件、测试结果、未实现项和最终 commit。
