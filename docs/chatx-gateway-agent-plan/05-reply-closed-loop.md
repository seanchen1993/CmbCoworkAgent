# 阶段五：回复闭环

> 本阶段打通“Desktop 结果 -> Gateway durable outbox -> 招乎单聊文本”。本阶段完成后可以
> 进入内网联调，但尚未通过生产故障演练。
>
> 这是可独立交给代码 Agent 的任务单。招乎文本 API 已完整写在本文中；Token 获取/刷新契约
> 使用阶段一归档到仓库的版本。交付时只给 Java 网关仓库和本文件，不再重复附接口资料。

## 1. 前置材料

- 阶段四已评审通过；
- 阶段一归档的 `contracts/http/zhaohu-token-api.md`、Token fixture 和 WireMock 已在仓库中；
- 阶段一生成的 `RemoteImReplyV1`、`REPLY_ACCEPTED`、`REPLY_RESULT` Schema 和 fixture 已在
  仓库中；
- approved CryptoPort/SecretPort 可以装配，并有可用的招乎测试机器人。

## 2. 本阶段接口

### Desktop WSS

- Client -> Gateway：`REMOTE_REPLY`；
- Gateway -> Client：`REPLY_ACCEPTED`、`REPLY_RESULT`。

### Gateway -> 招乎

- Token acquire；
- Token refresh；
- 单聊文本发送。

Token URI、Header 和 DTO 必须逐字使用阶段一归档的仓库内契约。文本发送契约固定如下：

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

- `fromId` 从统一机器人安全配置取得；
- `toId` 从 conversation 保存的加密用户 OpenID 解密取得，Desktop 不能提交或覆盖；
- 原接口允许 `content/base64Content` 二选一，首版只发送 `content`；
- 文本最多 3,000 个字符；
- `ROBOT-MESSAGE-ID` 使用 outbox 创建时生成的 `platform_request_id`；一次创建后永不更换；
- 平台对同一 ID 的防重窗口是 10 分钟，Gateway 自动重试安全窗固定为首次 attempt 后 8 分钟。

成功响应：

```json
{ "code": 0, "msg": "1591668393690" }
```

`msg` 是平台消息 ID，必须保存。HTTP 200 但 `code != 0` 不是成功。

| HTTP / code | 分类       | 固定处理                                                 |
| ----------- | ---------- | -------------------------------------------------------- |
| `200 / 0`   | 成功       | 标记 SENT，保存平台 `msg`                                |
| `200 / 120` | 业务失败   | 接收方 OpenID 非法，标记永久失败                         |
| `400`       | 参数错误   | 永久失败                                                 |
| `401`       | Token 无效 | 强制刷新一次并用同一消息 ID 重试；第二次失败则停止       |
| `403`       | 无接口权限 | 永久失败并告警                                           |
| `404`       | 路径错误   | 永久失败并告警                                           |
| `429`       | 限流       | 8 分钟安全窗内退避重试并复用原 ID                        |
| `5xx`       | 临时失败   | 8 分钟安全窗内退避重试并复用原 ID                        |
| timeout     | 结果不确定 | 安全窗内可复用原 ID；超出安全窗进入 UNKNOWN，不生成新 ID |

## 3. 允许修改范围

- reply outbox 和 platform token Repository/Mapper；
- `ReplyAcceptanceService`；
- `PlatformTokenProvider`、`PlatformMessageClient` 及招乎 Adapter；
- `ReplyOutboxWorker`、`SendingRecoveryWorker`；
- REMOTE_REPLY/REPLY_ACCEPTED/REPLY_RESULT WSS 处理；
- 阶段四已持久 system notice 的发送；
- WireMock、Testcontainers 和端到端测试。

禁止改变 event 投递、permit、单活 session 或 Desktop 工作区语义。

## 4. 任务顺序

### RP-01：接受 REMOTE_REPLY

一个短事务内：

1. 验证当前 WSS session 和 conversation principal；
2. 验证 Unicode code point 长度、0-based segment、`index < count`和最多 8 段；
3. eventId 存在时验证其属于同 conversation；
4. 对 canonical business payload 计算 SHA-256；
5. 同 idempotencyKey + 同 hash 返回历史结果，不同 hash 返回
   `REPLY_IDEMPOTENCY_CONFLICT`；
6. 验证同 delivery 的 source、target、event 和 segmentCount 一致；
7. 为每段生成一个固定 `platform_request_id`，写 PENDING outbox；
8. commit 后返回 `REPLY_ACCEPTED`。

`eventId` 对 Desktop 主动消息或 scheduler 回复可空。这不代表允许 Desktop 伪造 conversation；
conversation 仍必须属于已验证 principal。

### RP-02：Token Provider

- client secret 只从 approved SecretPort/Vault 取得；
- access/refresh token 用 approved codec 加密存入 `chatx_gw_platform_token`；
- 用 provider/state/version/owner/expiry CAS 租约实现多节点单飞；
- 获得刷新租约后先 commit，事务外调 Token HTTP，再带 owner/version 写回；
- 到期前提前刷新；401 最多强制刷新并重试一次；
- 用户 JWT 与机器人 Token 的配置、Bean 和日志完全分离。

`chatx_gw_platform_token` 是本 Gateway 官方机器人的最小 Token 缓存，不是通用凭据管理器，不存
client secret。

### RP-03：outbox worker

- 候选查询必须有上限；仅选 PENDING、已到重试时间、段已收齐的 delivery；
- 后一段只在前一段 SENT 后发送；
- 用 state/version CAS 改为 SENDING，写 `send_attempt_id/owner/started_at`后 commit；
- 事务外解密正文和目标、取 Token、调招乎；
- 结果写回带 outbox/state/attempt/version fencing；
- HTTP 200 且业务 `code == 0` 才是 SENT；
- 可安全重试时复用原 `platform_request_id`，结果不确定则 UNKNOWN，不生成新 ID。

### RP-04：系统提示

- 未映射身份：`system:identity:<platformMessageId>`，direct encrypted OpenID target；
- 无在线桌面：`system:offline:<conversationKey>:<waitGeneration>`，conversation target；
- `conversation_key` 和 `direct_to_id_ciphertext` 恰好一个非空；
- direct target 只允许 `SYSTEM_NOTICE`；
- 重放 webhook 不得产生第二条系统提示。

## 5. 必须测试

- 同 reply key/同 payload 幂等，同 key/异 payload 冲突；
- 0、2,800 code points、3,000 平台边界、8 段、缺段、重段和不一致 count；
- 双 worker 只有一个 CAS 成功，后段不超越前段；
- Token 首次获取、提前刷新、并发单飞、refresh 轮换、401 只刷新一次；
- 招乎 HTTP 200/code 0、200/code 非 0、400、401、403、404、429、5xx、timeout 分类；
- 重试始终复用原 `ROBOT-MESSAGE-ID`，超出安全窗口只进 UNKNOWN；
- worker crash 后安全恢复，SENT 不重发；
- Token、OpenID、principalId、正文和完整 HTTP body 不进日志；
- 招乎测试机器人端到端回复成功；
- `./mvnw verify` 在 JDK 1.8 通过。

## 6. 退出条件

用户从招乎发送单聊文本，消息只在获得 permit 后执行，结果通过持久 outbox 返回
同一用户；重复 webhook、WSS reply 重放和 worker 重启都不产生可见重复。完成此条件后可进入
内网联调，不得跳过阶段六直接上生产。
