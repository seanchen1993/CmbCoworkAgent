# 阶段四：入站事件与执行许可

> 本阶段打通“招乎文本 -> Gateway -> Desktop 安全执行”。平台回复尚未开通，测试使用
> Mock reply sink 或直接检查 Desktop 执行结果。
>
> 这是可独立交给代码 Agent 的任务单。招乎 webhook 契约已经完整写在本文中；交付时只给 Java
> 网关仓库和本文件，不需要任何招乎接口附件。

## 1. 前置材料

- 阶段三已评审通过；
- 阶段一生成的 `RemoteImEventV1`、ACK、permit、SYNC Schema 和 fixture 已在仓库中；
- 阶段二的 MySQL migration 已执行；
- 阶段三的 JWT、身份绑定和 WSS session 已通过测试。

## 2. 本阶段接口

### HTTP

Gateway 在招乎机器人后台配置以下自有路径：

```http
POST /api/v1/platform/zhaohu/callback
Content-Type: application/json
```

招乎官方文档定义的请求字段和首版处理方式如下：

| 字段            | 类型   | 必填 | 首版处理                                               |
| --------------- | ------ | ---- | ------------------------------------------------------ |
| `msgId`         | string | 是   | 平台消息唯一 ID，永久去重主键                          |
| `msgType`       | string | 是   | 只有精确值 `text` 进入 Desktop                         |
| `timestamp`     | long   | 是   | 接受 10 位秒或 13 位毫秒，转为 UTC `Instant`           |
| `fromId`        | string | 是   | 用户招乎 OpenID，用于查 ACTIVE identity binding        |
| `toId`          | string | 否   | 统一机器人招乎 OpenID                                  |
| `groupId`       | long   | 否   | 非空且非 0 表示群聊，去重后标记 `IGNORED`              |
| `groupOpenId`   | string | 否   | 非空表示群聊，去重后标记 `IGNORED`                     |
| `groupName`     | string | 否   | 不使用                                                 |
| `msgContent`    | string | 条件 | `msgType=text` 时必填，是实际正文                      |
| `netWorkStatus` | int    | 是   | 0 未知、1 办公网、2 互联网、3 业务网；不参与身份或路由 |
| `deviceId`      | string | 否   | 招乎终端信息，忽略；绝不能当作 ChatX 设备              |
| `clientType`    | string | 否   | `pc/ios/android/pad`，忽略                             |
| `skillCode`     | string | 否   | 首版忽略                                               |

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
  "deviceId": "platform-device-value",
  "clientType": "pc"
}
```

官方原文没有给出签名 Header 或算法，所以不要伪造“验签”协议。固定安全措施为：

- 只开放内网 HTTPS；
- 可信入口只允许招乎生产出口网段 `12.6.72.0/21`、`12.6.112.0/21`；
- 应用只信任直连 peer IP，或由明确配置的可信反向代理提供的已验证来源属性；不得直接信任任意
  `X-Forwarded-For`；
- 来源检查失败在 JSON 进入 domain 前返回 403；
- callback mapper 可忽略平台新增字段，但只把上表字段白名单映射到 domain，且不保存完整 body。

成功 ACK 由 Gateway 固定为：

```http
HTTP/1.1 200 OK
Content-Type: application/json

{"code":0,"msg":"success"}
```

只有入站数据库事务 commit 后才能返回成功。请求校验失败返回 400，来源认证失败返回 403，数据库
失败返回 5xx。官方原文没有规定超时、重投次数和顺序，因此正确性只能依赖 `msgId` 持久去重，
不能依赖“平台只投一次”。

### Desktop WSS

新增：

- Client -> Gateway：`EVENT_ACK`、`EXECUTION_PERMIT_ACQUIRE`、`EXECUTION_PERMIT_RENEW`；
- Gateway -> Client：`REMOTE_EVENT`、`PERMIT_RESULT`、`LEASE_REVOKED`。

阶段三的 HELLO/heartbeat/SYNC 行为不得改变。

## 3. 允许修改范围

- `adapter/in/platform/webhook/**`；
- platform inbox、conversation、event、lease、client command Repository/Mapper；
- reply outbox 的最小 `SYSTEM_NOTICE` 插入 Repository，不实现发送 worker；
- `PlatformIngressService`、`EventDispatchService`、`EventAckService`、
  `ExecutionPermitService`；
- `EventDispatcherWorker`、`LeaseExpiryWorker`、`WaitingSessionExpiryWorker`；
- 对应 WSS DTO/handler 分支；
- 本阶段测试。

禁止实现 REMOTE_REPLY、Token Provider、招乎文本发送或 reply outbox worker。

## 4. 任务顺序

### IN-01：webhook 验真与去重

- 先按本文的可信入口/来源网段规则认证，后解析 domain；不要实现文档中不存在的签名 Header；
- 只有单聊 `text` 进入业务，群聊和非文本去重后标记 IGNORED；
- `platform_message_id` 是主去重键；同 ID 不同 canonical payload hash 是冲突；
- canonical hash 只覆盖规范化后的白名单业务字段，不覆盖未知扩展字段；
- 不保存完整原始 callback body。

### IN-02：原子入站

一个短事务内：

1. 插入/读取 platform inbox；
2. 用 `fromId` fingerprint 查 ACTIVE identity；
3. 未映射时标记 `IDENTITY_UNKNOWN`，按稳定 key 写 direct system notice，不创建 conversation；
4. 已映射时 lock/create conversation，在行锁内分配连续 sequence；
5. 有 ONLINE session 则 event 进入 QUEUED，否则进入 WAITING_SESSION；
6. 需要时以 `system:offline:<conversation>:<generation>` 写一次离线提示；
7. commit 后返回平台 ACK。

### IN-03：顺序 dispatcher

- 非锁定查询有界候选页；
- 每个候选用独立短事务，按 conversation -> event -> session -> lease 顺序加锁；
- 只有 `delivery_cursor_sequence + 1` 可首次投递；
- 创建 ACTIVE lease 并 CAS event `QUEUED -> LEASED`；
- commit 后才发 `REMOTE_EVENT`；
- socket send 失败且未取得 permit 时，撤销 lease 并用同 eventId/seq 重投。

### IN-04：ACK 与 cursor

- ACK 必须匹配当前 session/principal/event/ACTIVE lease；
- `received` 才推进首次投递 cursor；
- `busy` 不推进；
- 重复 ACK 幂等，非法回退返固定 reasonCode；
- EXPIRED/CANCELLED 仅在连续时推进 cursor，不留 seq 空洞。

### IN-05：permit

- Agent Runtime 产生副作用前必须 acquire permit；
- acquire/renew 必须匹配当前 session generation、event 和 lease；
- permit 默认 90 秒，Desktop 默认每 30 秒 renew；
- pre-permit 断线可以新 lease 重投同 event；
- post-permit 失去连接/续租最终进入 `OUTCOME_UNKNOWN`，不自动二次执行。

## 5. 必须测试

- 非允许来源拒绝；伪造 `X-Forwarded-For` 不能绕过；重复/并发 msgId 只有一个
  inbox/event/notice；
- 单聊 text 正确读取 `msgContent/fromId/toId`；群聊、非文本和平台新增字段按本文处理；
- 同 ID 不同 payload 冲突；事务失败不返回平台成功 ACK；
- 同 conversation 50 并发 seq 连续无重复/空洞；
- 无 session -> WAITING_SESSION，上线唤醒，TTL 到期不补执行；
- 双 worker 不双投；同会话严格顺序，不同会话可并行；
- ACK 合法边、重复边和非法回退全覆盖；
- permit acquire/renew、旧 lease、旧 session、终态事件全覆盖；
- pre-permit 可重投，post-permit 只进 UNKNOWN；
- `./mvnw verify` 在 JDK 1.8 通过。

## 6. 退出条件

招乎测试文本能以稳定 eventId/seq 到达正确 Desktop，Desktop 取得 permit 后才执行；如结果
不确定，Gateway 不会自动二次执行。
本阶段不保证用户能在招乎收到 Agent 回复。
