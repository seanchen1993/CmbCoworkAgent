# ChatX 统一机器人 Java 网关实施规格

> 状态：可按分阶段实施包交给内网代码 Agent；生产 Adapter 开发前必须完成阶段一。
>
> 技术基线：JDK 1.8 + 内部增强版 Spring Boot 2.7.2 + Maven + MySQL 5.7 + MyBatis。
>
> 架构前提：内网每个用户只有一台桌面，网关对每个企业主体只保留一个活动 WSS 连接。
>
> Agent 分阶段交付入口：`docs/chatx-gateway-agent-plan/README.md`。

## 0. 交付给代码 Agent 的材料

本文只供负责人和 reviewer 查阅，不交给代码 Agent。实际交付方式只有两种：

- 阶段一：Java 网关仓库 + 阶段一任务单 + Token 获取接口文档 + Token 刷新接口文档；
- 阶段二至六：Java 网关仓库 + 当前一个阶段任务单。

招乎 webhook、单聊文本、错误码和幂等规则已经内嵌在阶段任务单中。阶段一负责把两份 Token
文档转换成仓库内固定契约，后续阶段不再索要任何接口附件。每份阶段任务单都包含允许修改范围和
验证要求，不需要负责人再拼接 README、母规格或原始机器人 API 大文档。

### 0.1 真相来源

发生冲突时按以下优先级处理：

| 优先级 | 来源                                                 | 决定内容                      |
| ------ | ---------------------------------------------------- | ----------------------------- |
| P0     | `contracts/schema/*.json`、`contracts/fixtures/v1/*` | WSS 字段、必填、类型、上下限  |
| P1     | `src/shared/im-gateway-contract.ts`                  | Event、ACK、Reply、reasonCode |
| P2     | `src/main/services/im/gateway-ws-client.ts`          | 关联、超时、断线和重连行为    |
| P3     | 当前阶段文档                                         | 当前允许范围、任务顺序和验收  |
| P4     | 本文                                                 | 跨阶段状态机、事务和数据语义  |
| P5     | 阶段一收到的 Token 获取、刷新正式文档                | 仅决定机器人 Token HTTP 契约  |

如果 P0～P5 冲突，代码 Agent 必须停止相关实现并输出 `BLOCKED`，不得增加兼容字段或放宽校验。

### 0.2 部署配置

以下值必须用强类型配置表达，生产 profile 不允许默认值：

```text
${INTERNAL_BOOT_PARENT_GROUP_ID}
${INTERNAL_BOOT_PARENT_ARTIFACT_ID}
${INTERNAL_BOOT_PARENT_VERSION}
${YST_JWK_SET_URI}
${YST_JWT_ISSUER}
${YST_JWT_AUDIENCE}
${YST_PRINCIPAL_CLAIM}
${YST_ALLOWED_JWS_ALGORITHM}
${ZHAOHU_TOKEN_ACQUIRE_URL}
${ZHAOHU_TOKEN_REFRESH_URL}
${ZHAOHU_CLIENT_ID_SECRET_REF}
${ZHAOHU_CLIENT_SECRET_REF}
${APPROVED_CRYPTO_ADAPTER}
${APPROVED_SECRET_ADAPTER}
${ZHAOHU_BASE_URL}
${ZHAOHU_ROBOT_OPEN_ID_SECRET_REF}
```

### 0.3 标识符入库前置

当前 WSS JSON Schema 对部分标识符只限定非空，而 DDL 必须有有限列长。阶段一必须与 Desktop、
企业身份和招乎平台负责人冻结以下规则：

- 网关生成的 binding/session/conversation/event/lease/outbox/platform request ID 是标准小写
  UUID，固定 36 个 ASCII 字符；
- `principalId`、`nodeId`、`commandId` 最长 128 个 ASCII 字符；
- `deliveryId`、`idempotencyKey`、平台 `msgId` 最长 256 个 ASCII 字符；
- 如正式平台契约允许 Unicode 或更长 ID，必须先同步修改 JSON Schema、DDL、Mapper 参数校验和
  golden fixtures，不得依赖 MySQL 截断、字符集转换或 `INSERT IGNORE`。

未冻结前可以实现表和 Repository，但不得宣称生产输入校验已完成。

## 1. 方案结论

方案可行，首版使用模块化单体：

- 一个官方招乎机器人服务所有用户；
- webhook 接收用户单聊文本；
- 权威身份映射把招乎用户 OpenID 关联到企业 `principalId`；
- Desktop 使用现有企业登录取得的标准 JWT `ystIdToken` 建立 WSS；
- 一个 `principalId` 同时只有一个活动桌面连接，后连接替代先连接；
- conversation、授权、事件和回复不绑定某台机器，也不因普通重连失效；
- 每个 conversation 严格顺序投递；
- Agent 执行前必须取得 event permit，执行期间续租；
- reply 先持久化，再调用招乎文本接口；
- 结果未知时不自动重跑，也不生成新的平台幂等键绕过不确定性。

WSS 协议固定使用 schemaVersion `1`。本次交付不实现多桌面设备选择、会话接管或其
兼容层。

## 2. 明确删除的复杂度

Java 网关不得实现下列能力：

- 用户选择桌面、设置首选桌面或查看桌面清单；
- conversation 固定到某台机器；
- 用户发起连接接管、强制接管或路由版本 CAS；
- 因桌面变化撤销本地 Thread、Feature grant 或 reply outbox；
- 把连接 generation 写进业务授权、conversation 或 reply 幂等语义；
- 旧连接与新连接之间自动来回重连竞争。

需要保留的是：企业主体、单活 WSS session、连接 generation、事件 lease/permit、严格顺序、
去重和 durable outbox。连接 generation 只用于阻止旧 socket，不是业务版本。

招乎 webhook 里可能存在名为 `deviceId` 的平台字段。它只表示用户发送消息时的平台终端，
Adapter 解析后忽略，绝不能用于桌面连接选择、授权或事件投递。

## 3. 身份与凭据边界

### 3.1 三种身份不要混用

| 名称             | 来源                        | 用途               | 是否落日志                        |
| ---------------- | --------------------------- | ------------------ | --------------------------------- |
| `ystIdToken`     | Desktop 已有企业登录链路    | WSS Upgrade 认证   | 否                                |
| `principalId`    | 已验证 JWT 的冻结 claim     | 网关内部企业主体   | 否；指标也禁作 label              |
| 招乎用户 OpenID  | webhook `fromId` / 权威映射 | 平台回复目标       | 仅加密值和 keyed fingerprint 落库 |
| 招乎机器人 Token | 招乎 Token 服务             | 调用机器人下行 API | 否                                |

用户 `ystIdToken` 不能作为招乎机器人 Token；招乎机器人 Token 也不能下发到 Desktop。

### 3.2 `ystIdToken` 验证

`ystIdToken` 是标准 JWT。网关必须使用 Spring Security Resource Server 或内部等价增强组件
完成密码学验签，并校验：

- JWS 算法在 allowlist 中，禁止 `none`；
- `iss` 精确匹配；
- `aud` 包含网关 audience；
- `exp`、`nbf`、`iat` 和允许时钟偏差；
- 主体 claim 非空且长度合法；
- JWKS 轮换和未知 `kid` 的安全失败。

`principalId` 只能从 Spring Security 已验证的 Authentication/Principal 取得。HELLO、URL、
Header 自定义字段和 JSON body 都不能覆盖它。若现有 `ystIdToken` 的 audience 不包含网关，必须
在阶段一冻结正式 Token Exchange，不能关闭 audience 校验。

### 3.3 OpenID 映射

网关维护权威映射：

```text
principalId <-> user OpenID fingerprint + encrypted OpenID
```

要求：

- active 映射的两侧都唯一；
- 冲突时拒绝覆盖并告警；
- webhook 的 `fromId` 只用于查映射，不从请求体接受 `principalId`；
- 未映射消息不投递 Desktop，只产生一次稳定幂等的用户提示；
- 映射撤销后，旧 conversation 不得改发到另一个 OpenID。

## 4. 技术基线与 Java 8 约束

建议依赖：

- 内部增强版 `spring-boot-starter-web`；
- `spring-boot-starter-websocket`；
- `spring-boot-starter-validation`；
- `spring-boot-starter-security`；
- `spring-boot-starter-oauth2-resource-server`；
- 内部 BOM 允许的 `mybatis-spring-boot-starter` 2.x；
- `spring-boot-starter-actuator`；
- `micrometer-registry-prometheus`；
- `flyway-core`；
- 内部 BOM 允许的 MySQL Connector/J；
- 内部 BOM 固定的 JUnit 5、Testcontainers MySQL 1.x、WireMock 2.x。

硬约束：

- 只使用 Java 8 语法和 `javax.*`；
- 禁止 `record`、`var`、sealed class、switch expression、文本块；
- 禁止 `List.of`、`Map.of`、`Stream.toList`、Java 11 `HttpClient`；
- 禁止 Spring 6 `RestClient`、Boot 3 和 `jakarta.*`；
- 协议 DTO 使用普通 JavaBean，显式构造器/getter/`equals`/`hashCode`；
- 数据访问只使用 MyBatis Mapper 接口 + XML 显式 SQL，不引入 JPA、MyBatis-Plus 或通用 CRUD 生成器；
- Mapper XML 参数只使用 `#{}`，禁止将外部输入放入 `${}`；
- 状态转移使用 `UPDATE ... WHERE id = #{id} AND state = #{expectedState} AND version = #{version}`，
  并严格校验影响行数为 1；
- schema 只由 Flyway 迁移；
- MySQL 服务器、JDBC session 和应用 Clock 统一使用 UTC；领域层使用 `Instant`，数据库使用
  `DATETIME(3)`，持久化边界统一转换；
- 事务隔离级别使用 `READ_COMMITTED`；MySQL 5.7 不使用 `SKIP LOCKED`，worker 使用候选查询 +
  `state/version` CAS 短事务抢占；
- MySQL 5.7 不强制执行 `CHECK` 约束，状态枚举、分段边界和时间先后关系必须在 domain
  校验，不得因 DDL 里没有 `CHECK` 而省略；
- 外部网络调用绝不能发生在数据库事务中；
- worker 使用有界线程池，禁止无界队列和内存注解重试；
- CI 必须在真实 JDK 1.8 执行 `./mvnw verify`，产物 class major version 为 52。

## 5. 推荐工程结构

```text
src/main/java/com/cmb/chatx/gateway/
  GatewayApplication.java
  config/
    GatewayProperties.java
    SecurityConfig.java
    WebSocketConfig.java
    ExecutorConfig.java
    ProductionAdapterGuard.java
  contract/ws/
    WsEnvelope.java
    WsMessageType.java
    WsContractValidator.java
    dto/
      HelloPayload.java
      HeartbeatPayload.java
      EventAckPayload.java
      PermitRequestPayload.java
      RemoteReplyPayload.java
      WelcomePayload.java
      RemoteEventPayload.java
      PermitResultPayload.java
      LeaseRevokedPayload.java
      ReplyResultPayload.java
      SyncStatePayload.java
      ErrorPayload.java
  domain/model/
    PlatformInbox.java
    IdentityBinding.java
    DesktopSession.java
    Conversation.java
    InboundEvent.java
    EventLease.java
    ClientCommand.java
    ReplyOutbox.java
  domain/state/
    SessionState.java
    InboundEventState.java
    LeaseState.java
    ReplyState.java
    InboundEventTransitions.java
  application/port/
    CallbackAuthenticator.java
    CryptoPort.java
    SecretPort.java
    PlatformTokenProvider.java
    PlatformMessageClient.java
    DesktopSessionSender.java
  application/service/
    IdentityBindingService.java
    PlatformIngressService.java
    DesktopSessionService.java
    EventDispatchService.java
    EventAckService.java
    ExecutionPermitService.java
    ReplyAcceptanceService.java
    RecoveryService.java
  adapter/in/platform/webhook/
    ZhaohuWebhookController.java
    ZhaohuCallbackRequest.java
  adapter/in/desktop/websocket/
    DesktopWebSocketHandler.java
    DesktopHandshakeInterceptor.java
    DesktopSessionRegistry.java
  adapter/in/admin/identity/
    IdentitySyncController.java
  adapter/out/persistence/
    entity/
      *Po.java
    mapper/
      *Mapper.java
    repository/
      *MybatisRepository.java
  adapter/out/platform/
    ZhaohuPlatformMessageClient.java
    ZhaohuPlatformTokenProvider.java
  worker/
    EventDispatcherWorker.java
    ReplyOutboxWorker.java
    SessionExpiryWorker.java
    LeaseExpiryWorker.java
    WaitingSessionExpiryWorker.java
    SendingRecoveryWorker.java
    RetentionWorker.java
```

依赖方向必须是：

```text
adapter/in -> application/service -> domain + application/port <- adapter/out
worker ----^
```

`src/main/resources/mapper/` 下按聚合拆分 Mapper XML。domain 不 import Spring/MyBatis/JDBC/
WebSocket；application service 不接收原始 JSON 或 `WebSocketSession`；Repository 不自行
决定状态转移。Mapper 只负责 SQL，事务边界放在 application service 的 Spring
`@Transactional` 方法，禁止 Mapper 手动 `commit`。

## 6. 数据模型

表名可以按内网规范加数据库名前缀，但字段语义和唯一约束不得改变。可直接执行的
MySQL 5.7 DDL 见 `docs/sql/chatx-unified-bot-gateway-mysql57.sql`，交付到 Java 仓库时复制为
`src/main/resources/db/migration/V1__chatx_gateway_baseline.sql`。

存储约定：

- 网关生成的 UUID 以小写字符串存入 `CHAR(36) CHARACTER SET ascii COLLATE ascii_bin`；
- 用作幂等、去重和 fingerprint 的字符串一律大小写敏感；
- 所有时间列使用 `DATETIME(3)` 并按 UTC 读写，不使用数据库自动时区转换；
- 不使用 MySQL `ENUM`，状态以 ASCII `VARCHAR` 存储，domain 对非法枚举 fail closed；
- MySQL 5.7 没有 partial unique index，DDL 用 STORED generated column + unique index 实现
  “仅 ACTIVE/ONLINE 行唯一”，业务代码不得手工写生成列。

### 6.1 `chatx_gw_identity_binding`

| 字段                               | 说明                  |
| ---------------------------------- | --------------------- |
| `binding_id char(36) PK`           | 服务端 UUID           |
| `principal_id varchar(128)`        | 企业主体              |
| `open_id_fingerprint varchar(128)` | keyed fingerprint     |
| `open_id_ciphertext longtext`      | approved codec 加密值 |
| `status varchar(16)`               | `ACTIVE/REVOKED`      |
| `version bigint`                   | CAS                   |
| `created_at/updated_at/revoked_at` | UTC 时间              |

ACTIVE 状态下 `principal_id` 唯一、`open_id_fingerprint` 唯一。DDL 中的
`active_principal_id` 和 `active_open_id_fingerprint` 是生成列，只用于实现该约束。

### 6.2 `chatx_gw_desktop_session`

| 字段                                             | 说明                                |
| ------------------------------------------------ | ----------------------------------- |
| `session_id char(36) PK`                         | 每次成功 HELLO 创建                 |
| `principal_id varchar(128)`                      | 来自已验证 JWT                      |
| `node_id varchar(128)`                           | 持有真实 socket 的节点              |
| `connection_generation bigint`                   | principal 维度单调递增              |
| `state varchar(16)`                              | `ONLINE/OFFLINE/SUPERSEDED/EXPIRED` |
| `connected_at/last_heartbeat_at/disconnected_at` | 时间                                |
| `jwt_expires_at datetime(3)`                     | 到期前主动断开                      |
| `version bigint`                                 | CAS                                 |

同一 `principal_id` 最多一个 `ONLINE` session。新连接事务化地把旧 ONLINE 标为
`SUPERSEDED`，再创建更高 generation。`online_principal_id` 生成列保证单活。旧
socket 的 heartbeat、命令和 close 不能覆盖新状态。

### 6.3 `chatx_gw_conversation`

| 字段                                     | 说明                               |
| ---------------------------------------- | ---------------------------------- |
| `conversation_key char(36) PK`           | 对 Desktop 暴露的 opaque key       |
| `principal_id varchar(128)`              | 固定企业主体                       |
| `peer_open_id_fingerprint varchar(128)`  | 用户 OpenID fingerprint            |
| `peer_open_id_ciphertext longtext`       | 不可变回复目标                     |
| `robot_open_id_fingerprint varchar(128)` | 官方机器人身份                     |
| `next_sequence bigint`                   | 分配入站顺序                       |
| `delivery_cursor_sequence bigint`        | 已 durable received/终结的连续游标 |
| `session_wait_active tinyint(1)`         | 是否处于无在线桌面等待窗口         |
| `session_wait_generation bigint`         | 等待提示幂等 generation            |
| `state varchar(16)`                      | `ACTIVE/SUSPENDED/REVOKED`         |
| `version bigint`                         | CAS                                |

没有桌面路由表。conversation 只属于 principal；任何时刻由该 principal 当前唯一 ONLINE
session 消费。

### 6.4 `chatx_gw_platform_inbox`

| 字段                                  | 说明                                           |
| ------------------------------------- | ---------------------------------------------- |
| `platform_message_id varchar(256) PK` | webhook 去重键                                 |
| `payload_hash varchar(128)`           | 同 ID 不同内容冲突检测                         |
| `message_type varchar(32)`            | 平台类型                                       |
| `state varchar(32)`                   | `RECEIVED/NORMALIZED/IGNORED/IDENTITY_UNKNOWN` |
| `event_id char(36) null`              | 归一化事件                                     |
| `received_at/updated_at`              | 时间                                           |

不要保存完整原始请求；如合规要求必须保存，需独立加密、限制访问与保留期。

### 6.5 `chatx_gw_inbound_event`

| 字段                                                     | 说明                     |
| -------------------------------------------------------- | ------------------------ |
| `event_id char(36) PK`                                   | 网关稳定 UUID            |
| `platform_message_id varchar(256) UNIQUE`                | 平台去重                 |
| `conversation_key char(36)`                              | conversation             |
| `conversation_sequence bigint`                           | 严格递增，联合唯一       |
| `principal_id varchar(128)`                              | 冻结 owner               |
| `message_text_ciphertext longtext`                       | 可选加密正文；按合规保留 |
| `occurred_at datetime(3)`                                | 平台时间                 |
| `state varchar(32)`                                      | 见 §7                    |
| `first_delivered_at/received_at/accepted_at/finished_at` | 时间                     |
| `terminal_reason varchar(64)`                            | 终态原因                 |
| `version bigint`                                         | CAS                      |
| `created_at/updated_at`                                  | 时间                     |

事件不保存桌面标识或连接 generation。session 归属只存在当前 lease 中。

### 6.6 `chatx_gw_event_lease`

| 字段                                   | 说明                     |
| -------------------------------------- | ------------------------ |
| `lease_id char(36) PK`                 | 每次投递许可             |
| `event_id char(36)`                    | 事件                     |
| `principal_id varchar(128)`            | owner                    |
| `session_id char(36)`                  | 发 lease 时的 session    |
| `connection_generation bigint`         | stale socket fencing     |
| `state varchar(16)`                    | `ACTIVE/REVOKED/EXPIRED` |
| `issued_at/expires_at`                 | 时间                     |
| `permit_acquired_at/permit_expires_at` | 执行许可                 |
| `revoke_reason varchar(64)`            | 原因                     |
| `version bigint`                       | CAS                      |

一个 event 同时最多一个 ACTIVE lease，由 `active_event_id` 生成列唯一索引保证。

### 6.7 `chatx_gw_client_command`

| 字段                               | 说明                          |
| ---------------------------------- | ----------------------------- |
| `session_id char(36)`              | 当前认证 session              |
| `command_id varchar(128)`          | 客户端 commandId              |
| `principal_id varchar(128)`        | owner                         |
| `command_type varchar(64)`         | 类型                          |
| `payload_hash varchar(128)`        | 防止同 key 换 payload         |
| `state varchar(16)`                | `PROCESSING/COMPLETED/FAILED` |
| `result_type varchar(64)`          | 可空；返回消息类型            |
| `result_payload_json longtext`     | 可空；可重放结果，不含敏感值  |
| `created_at/updated_at/expires_at` | 时间                          |

主键 `(session_id, command_id)`。相同 key、相同 payload 返回历史结果；payload 不同返回
`COMMAND_ID_REUSE`。业务回复跨 session 幂等由 reply 的 `idempotencyKey` 负责。

### 6.8 `chatx_gw_reply_outbox`

| 字段                                                             | 说明                                  |
| ---------------------------------------------------------------- | ------------------------------------- |
| `outbox_id char(36) PK`                                          | 内部 UUID                             |
| `source varchar(32)`                                             | `CLIENT_REPLY/SYSTEM_NOTICE`          |
| `delivery_id varchar(256)`                                       | 一次逻辑回复                          |
| `event_id char(36) null`                                         | 主动消息可空                          |
| `conversation_key char(36) null`                                 | 正常回复/离线提示的会话目标           |
| `direct_to_id_ciphertext longtext null`                          | 仅未映射身份系统提示使用              |
| `idempotency_key varchar(256) UNIQUE`                            | Desktop 稳定 key                      |
| `payload_hash varchar(128)`                                      | 同 key 不同 payload 冲突检测          |
| `segment_index int`                                              | 0-based                               |
| `segment_count int`                                              | 1～8                                  |
| `content_ciphertext longtext`                                    | 待发文本                              |
| `platform_request_id char(36)`                                   | `ROBOT-MESSAGE-ID`，首次生成后不变    |
| `state varchar(16)`                                              | `PENDING/SENDING/SENT/UNKNOWN/FAILED` |
| `platform_message_id varchar(256) null`                          | 成功结果                              |
| `attempt_count/first_attempt_at/next_attempt_at/last_error_code` | 重试和平台幂等窗口                    |
| `send_attempt_id/send_owner_node_id/sending_started_at`          | 本次发送抢占与 fencing                |
| `version bigint`                                                 | worker CAS                            |
| `created_at/updated_at`                                          | 时间                                  |

唯一约束 `(delivery_id, segment_index)`。同一 delivery 的 source、target、event 和 segmentCount
必须一致。`conversation_key` 与 `direct_to_id_ciphertext` 必须恰好一个非空；direct target
只允许 `SYSTEM_NOTICE`。这些是 domain 强校验，不依赖 MySQL 5.7 的 `CHECK`。回复不绑定
session，普通断线重连后继续发送。

### 6.9 `chatx_gw_platform_token`

该表是网关内部官方机器人 Token 缓存和多节点刷新租约，不是通用凭据管理器，不存储
client secret。

| 字段                                                                | 说明                           |
| ------------------------------------------------------------------- | ------------------------------ |
| `provider_key varchar(64) PK`                                       | 固定机器人凭据槽位             |
| `access_token_ciphertext/refresh_token_ciphertext longtext`         | approved codec 加密 Token      |
| `access_token_fingerprint varchar(128)`                             | 401 后防重复刷新的 fingerprint |
| `access_token_expires_at/refresh_token_expires_at`                  | UTC 到期时间                   |
| `state varchar(16)`                                                 | `EMPTY/VALID/REFRESHING/ERROR` |
| `refresh_owner_node_id/refresh_started_at/refresh_lease_expires_at` | 多节点单飞刷新                 |
| `last_error_code varchar(64)`                                       | 脱敏错误码                     |
| `version bigint`                                                    | CAS                            |
| `created_at/updated_at`                                             | UTC 时间                       |

刷新 worker 先用 `state/version` CAS 取得有限时租约，提交事务后才调用 Token API，再用
`provider_key + refresh_owner_node_id + version` 完成写回。进程崩溃后只允许超过租约的节点抢占。

### 6.10 `chatx_gw_audit_log`

该表是 append-only 安全审计，用于身份映射变更、session 替代、lease 撤销、Token 刷新异常和
UNKNOWN 人工处置。

| 字段                                   | 说明                                             |
| -------------------------------------- | ------------------------------------------------ |
| `audit_id char(36) PK`                 | 审计 UUID                                        |
| `action/outcome`                       | 动作和结果枚举                                   |
| `actor_type/actor_fingerprint`         | 操作者类型和 keyed fingerprint，不存 principalId |
| `subject_type/subject_id`              | 业务对象类型和网关 opaque ID，不存 OpenID        |
| `previous_state/new_state/reason_code` | 状态变化与原因                                   |
| `trace_id`                             | 脱敏调用链路 ID                                  |
| `created_at`                           | UTC 时间                                         |

审计表不提供通用 JSON details 列，避免 Agent 把 Token、OpenID、principalId 或正文整包写入。

### 6.11 必要索引

- event：`(conversation_key, state, conversation_sequence)`；
- event：`(state, updated_at)`；
- event：`(principal_id, state, created_at)`；
- lease：`(event_id, state)`；
- session：`(principal_id, state, connection_generation)`；
- outbox：`(state, next_attempt_at, created_at)`；
- platform inbox：`(state, received_at)`；
- audit：`(subject_type, subject_id, created_at)` 和 `(action, created_at)`。

## 7. 状态机

### 7.1 Event 状态

```text
RECEIVED
  -> WAITING_SESSION       principal 没有 ONLINE session
  -> QUEUED                有 ONLINE session

WAITING_SESSION -> QUEUED  session 上线且未过 TTL
WAITING_SESSION -> EXPIRED TTL 到期，绝不补执行

QUEUED -> LEASED           dispatcher 原子 claim 并创建 lease
LEASED -> ACCEPTED         durable received/accepted ACK
ACCEPTED -> WAITING_DESKTOP
ACCEPTED -> COMPLETED | CANCELLED | FAILED | OUTCOME_UNKNOWN
WAITING_DESKTOP -> COMPLETED | CANCELLED | FAILED | OUTCOME_UNKNOWN
```

规则：

- 同一 conversation 只有 `delivery_cursor_sequence + 1` 可以首次投递；
- `received` ACK 才推进首次投递游标；
- `busy` 不推进游标；
- EXPIRED/CANCELLED 也要在 conversation 行锁内连续推进游标，不能留下 seq 空洞；
- 终态不可回退；
- permit 尚未取得时连接丢失，事件可以用同一 eventId/seq 和新 lease 投递当前新 session；
- permit 已取得后连接/lease 丢失，事件进入 `OUTCOME_UNKNOWN`，禁止自动执行第二次。

### 7.2 Reply 状态

```text
PENDING -> SENDING -> SENT
                  -> PENDING   仅在平台幂等安全窗口内重试
                  -> UNKNOWN   请求可能成功但无法确认
                  -> FAILED    明确永久失败
```

UNKNOWN 不自动重发。只有正式结果查询或受审计人工操作可以关闭。

## 8. WSS 契约

### 8.1 Envelope

所有消息：

```json
{
  "schemaVersion": 1,
  "type": "HELLO",
  "commandId": "client-command-id",
  "sentAt": "2026-07-30T08:00:00.000Z",
  "payload": {}
}
```

- Client 命令和直接响应使用 `commandId`；
- Server 主动推送使用 `messageId`；
- 未知字段、重复 JSON key、trailing token、未知 enum、错误 schemaVersion 必须拒绝；
- WSS strict `ObjectMapper` 与平台 callback mapper 分开；
- 单帧最大 64 KiB；
- 除本机测试外只允许 WSS。

### 8.2 Client -> Gateway

字段必须与 `contracts/schema/desktop-gateway-ws-v1.schema.json` 完全一致：

| type                       | payload                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `HELLO`                    | `appVersion`, `capabilities[]`, optional `protocolExtensions[]`       |
| `HEARTBEAT`                | `sessionId`                                                           |
| `EVENT_ACK`                | ACK union：`type/eventId/leaseId`；failed 另含 `retryable/reasonCode` |
| `EXECUTION_PERMIT_ACQUIRE` | `eventId`, `lastLeaseId`                                              |
| `EXECUTION_PERMIT_RENEW`   | `eventId`, `lastLeaseId`                                              |
| `REMOTE_REPLY`             | `RemoteImReplyV1`                                                     |
| `SYNC_REQUEST`             | 空对象                                                                |

HELLO 不携带 `principalId`。主体来自已验证 Upgrade。

### 8.3 Gateway -> Client

| type                              | payload                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `WELCOME`                         | `sessionId/principalId/serverTime/heartbeatIntervalSeconds`                      |
| `REMOTE_EVENT`                    | `{event: RemoteImEventV1}`                                                       |
| `PERMIT_RESULT`                   | GRANTED: `eventId/status/leaseId/expiresAt`; DENIED: `eventId/status/reasonCode` |
| `LEASE_REVOKED`                   | `eventId/reasonCode`                                                             |
| `REPLY_ACCEPTED` / `REPLY_RESULT` | `deliveryId/idempotencyKey/segmentIndex/state/platformReplyId?`                  |
| `SYNC_STATE`                      | `routes[]` 及可选 `defaultConversationKey`；路由项仅 `principalId/conversationKey/state` |
| `ERROR`                           | `reasonCode/message?/eventId?/idempotencyKey?/conversationKey?`                  |

`SYNC_STATE.routes` 是 conversation 状态同步；当存在多条历史路由时，网关通过可选的
`defaultConversationKey` 明确本次连接的权威默认路由。每项 `principalId` 必须与
WELCOME 一致。
只有 `HELLO.protocolExtensions` 包含 `sync-default-route-v1` 时才返回该可选字段，以保证
新旧 Desktop 和网关可以独立灰度。

### 8.4 Remote event

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

### 8.5 Remote reply

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

`eventId` 对定时提醒或桌面主动推送可空；`segment.index` 从 0 开始；最多 8 段；Desktop
单段最多 2,800 Unicode code points，平台最终文本仍不得超过 3,000 字符。

### 8.6 reasonCode

网关对外只使用冻结枚举：

```text
AUTH_REQUIRED
PRINCIPAL_MISMATCH
SCHEMA_VERSION_UNSUPPORTED
INVALID_PAYLOAD
COMMAND_ID_REUSE
IDENTITY_NOT_FOUND
IDENTITY_CONFLICT
PLATFORM_MESSAGE_UNSUPPORTED
DESKTOP_OFFLINE
SESSION_SUPERSEDED
ROUTE_NOT_FOUND
EVENT_NOT_FOUND
EVENT_ORDER_BLOCKED
EVENT_TERMINAL
EVENT_OUTCOME_UNKNOWN
INVALID_EVENT_TRANSITION
LEASE_NOT_FOUND
LEASE_EXPIRED
LEASE_REVOKED
PERMIT_DENIED
REPLY_IDEMPOTENCY_CONFLICT
SEGMENT_INVALID
OUTBOX_INCOMPLETE
PLATFORM_RETRYABLE_FAILURE
PLATFORM_PERMANENT_FAILURE
PLATFORM_RESULT_UNKNOWN
```

`ROUTE_NOT_FOUND` 表示 conversation 不存在或不可用，不表示机器路由。

## 9. 单活桌面连接算法

### 9.1 Upgrade 与 HELLO

Desktop WSS 的固定 Upgrade 路径是 `GET /ws/desktop`。当前内网 TLS 入口为
`wss://devclaw-im-gateway.paasst.cmbchina.cn/ws/desktop`，不得为不同节点或用户生成不同路径。

1. TLS 和 Spring Security 验证 `Authorization: Bearer <ystIdToken>`；Token 缺失、无效或过期时在
   Upgrade 阶段返回 HTTP `401`，身份有效但无网关权限时返回 `403`；
2. 把已验证 `principalId`、权限和 JWT 到期时间放入 handshake attributes；
3. 不保存原始 JWT；
4. socket 建立后要求在 10 秒内收到 HELLO；
5. 校验 appVersion/capabilities；
6. 调用 `DesktopSessionService.activate(principalId, nodeId, jwtExpiresAt)`；
7. 返回 WELCOME；
8. 唤醒该 principal 的 `WAITING_SESSION` conversation。

Desktop 对 `401` 只会调用现有企业登录刷新接口一次，并携带刷新后的 `ystIdToken` 重新 Upgrade；
第二次 `401` 会停止自动重试。因此网关不得用 `401` 表示可重试的网络故障，也不得把 `403` 当成
Token 过期。

### 9.2 `activate` 事务

伪代码：

```text
tx:
  SELECT active identity_binding WHERE principal_id = ? FOR UPDATE
  require binding exists; this row serializes first and later connections for the principal
  SELECT latest desktop_session for principal ordered by generation desc LIMIT 1
  generation = latest generation + 1, or 1 when no session exists
  SELECT current ONLINE session for principal FOR UPDATE
  old = current ONLINE session, if any
  if old exists:
    UPDATE old -> SUPERSEDED WHERE state=ONLINE AND version=expected
  insert new ONLINE session(sessionId, principalId, nodeId, generation, jwtExpiresAt)
commit

register local socket only if generation is newest
if old belongs to this node:
  send ERROR(reasonCode=SESSION_SUPERSEDED) to old socket
  close old socket with code 4001
else:
  publish a best-effort node notification so old node performs the same action
```

MySQL 5.7 下不能依赖“latest session 不存在时的行锁”；必须先锁定已存在的 ACTIVE
identity binding 行。`online_principal_id` 唯一索引是最后一道并发保护；如果命中唯一键冲突，
整个 activate 事务回滚并使用有界重试，不能删除唯一约束。
数据库中的 SUPERSEDED 状态是权威 fencing；节点通知只用于加速断开。每个网关节点必须至少按
心跳周期轮询自己持有的 session，发现不再 ONLINE 就发送 `SESSION_SUPERSEDED` 并关闭本地
socket。因此节点通知丢失不影响正确性，也不需要额外的路由表。

Desktop 收到 `SESSION_SUPERSEDED` 后不会自动重连，只有用户手动点击重连才再次连接。否则两个
进程会互相替代形成重连风暴。

### 9.3 心跳与 close fencing

HEARTBEAT 更新必须满足：

```text
session_id + principal_id + node_id + connection_generation + state=ONLINE 全部匹配
```

socket close 也只 CAS 自己那条 session。旧连接晚到的 close 不能把新 session 标为 OFFLINE。
后台每 15 秒心跳，45 秒未更新标为 EXPIRED。已建立 WSS 的 JWT 到期时，网关先发送不带
`commandId` 的 `ERROR { reasonCode: "AUTH_REQUIRED" }`，再关闭该 socket；此时已经完成 Upgrade，
不能再返回 HTTP `401`。Desktop 刷新成功后会建立一个新 session，旧 session 的 fencing 规则不变。

### 9.4 多实例 socket 发送

- WebSocket 对象只存在 owning node 的 `DesktopSessionRegistry`；
- DB 保存 `node_id/session_id/generation`；
- dispatcher 只 claim 当前节点 ONLINE session 的 event；
- Servlet WebSocket 并发发送使用 `ConcurrentWebSocketSessionDecorator` 或单写者有界队列；
- DB 事务提交后再执行 socket send；
- send 失败时重新进入持久恢复流程，不能在内存里假装成功。

## 10. webhook 入站与 conversation

### 10.1 平台字段

Adapter 至少解析：

| 字段                  | 处理                                 |
| --------------------- | ------------------------------------ |
| `msgId`               | 平台去重键                           |
| `msgType`             | 仅精确 `text` 进入业务               |
| `timestamp`           | 接受 10 位秒或 13 位毫秒并转 Instant |
| `fromId`              | 用户 OpenID，查权威映射              |
| `toId`                | 官方机器人 OpenID                    |
| `groupId/groupOpenId` | 任一非空则忽略                       |
| `msgContent`          | 文本正文                             |
| `deviceId/clientType` | 平台终端信息，忽略                   |

生产 callback 路径可定义为：

```http
POST /api/v1/platform/zhaohu/callback
Content-Type: application/json
```

它是网关自定义路径，不是平台固定 URI。已提供的招乎原文没有签名 Header 或验签算法，因此首版
不发明 HMAC 协议：只开放内网 HTTPS，在可信入口限制官方给出的
`12.6.72.0/21`、`12.6.112.0/21`，应用只信任直连 peer IP 或明确配置的可信代理属性，不直接
信任任意 `X-Forwarded-For`。后续平台如正式增加签名，再作为向后兼容的认证层升级。

### 10.2 原子入站事务

```text
tx:
  insert platform_inbox by msgId; duplicate returns previous result
  reject same msgId with different payload hash
  if unsupported/group: mark IGNORED and return
  lookup active identity binding by fromId fingerprint
  if missing: mark IDENTITY_UNKNOWN and enqueue one stable system notice
  lock/create conversation(principalId, peer OpenID, robot OpenID)
  allocate conversation_sequence = next_sequence; increment next_sequence
  event state = principal has ONLINE session ? QUEUED : WAITING_SESSION
  insert event with stable eventId
  if first event in a new wait window:
    session_wait_generation += 1
    session_wait_active = true
    enqueue system notice with stable key
commit
return HTTP 200 {"code":0,"msg":"success"}
```

系统提示的幂等键固定为：

- 未映射身份：`system:identity:<platformMessageId>`，使用 callback `fromId` 的加密值作为 direct
  target，不创建 conversation；
- 无在线桌面：`system:offline:<conversationKey>:<sessionWaitGeneration>`，使用
  conversation target。

平台 HTTP ACK 必须在数据库 commit 后返回。校验失败返回 400，来源认证失败返回 403，持久化
失败返回 5xx；网络调用不放进事务。

### 10.3 无在线桌面

- event 进入 `WAITING_SESSION`；
- 同一个 wait generation 只提示一次“消息已暂存，请打开 ChatX”；
- 默认等待 TTL 24 小时，生产配置化；
- session 上线后唤醒未过期 event；
- TTL 到期进入 EXPIRED 并推进连续 cursor，未来不得补执行。

## 11. Dispatcher、ACK 与 permit

### 11.1 首次投递

MySQL 5.7 使用“候选查询 + 短事务 CAS”，不使用 `SKIP LOCKED`：

1. 非锁定查询最多 N 个 QUEUED 候选 `event_id/conversation_key/version`，只选取可能等于
   `delivery_cursor_sequence + 1` 的事件；
2. 对每个候选开启独立短事务，先 `SELECT conversation ... FOR UPDATE`，再读 event 和当前
   ONLINE session；
3. 在锁内重新验证 seq、event state/version、principal 和 session generation；
4. 创建 ACTIVE lease，绑定 sessionId + connectionGeneration；`active_event_id` 唯一索引
   防止同一 event 并发生成两个 ACTIVE lease；
5. 执行 event CAS，影响行数不是 1 则回滚并跳过：

   ```sql
   UPDATE chatx_gw_inbound_event
   SET state = 'LEASED', version = version + 1, updated_at = #{now}
   WHERE event_id = #{eventId}
     AND state = 'QUEUED'
     AND version = #{expectedVersion}
   ```

6. commit 后才通过 owning node socket 发送 REMOTE_EVENT。

候选页必须有上限，单个 CAS 失败不是系统错误。所有事件路径按 conversation -> event -> session ->
lease 的固定顺序加锁，死锁时只在原事务之外有界重试当前短事务，并记录低基数指标。

socket send 失败且 permit 尚未取得时，可以撤销旧 lease 后回 QUEUED；不得改变 eventId/seq。

### 11.2 ACK

每个 ACK 必须验证：

- socket 是当前 principal 的 ONLINE session；
- event principal 一致；
- leaseId 匹配当前 ACTIVE lease；
- 状态转移合法。

重复 ACK 若 payload 相同返回历史成功；非法回退返回 `INVALID_EVENT_TRANSITION`。`received`
推进 conversation 首次投递游标；`accepted` 表示 Desktop 已 durable 入队，不等于 Agent 已执行。

### 11.3 permit acquire

```text
tx:
  lock conversation, then event, then current session, then latest lease
  require session ONLINE and generation current
  require event non-terminal and principal match
  require request.lastLeaseId == active lease
  if lease expired and permit not acquired:
    revoke old lease
    create replacement lease for same event and same authenticated current session
  if permit already acquired by same lease:
    return same GRANTED result
  set permit_acquired_at and permit_expires_at
commit
return PERMIT_RESULT(GRANTED)
```

permit 默认 90 秒，Desktop 每 30 秒 renew。renew 必须匹配当前 session、generation、event 和
lease。permit 后连接失效或续租失败时，事件最终进入 OUTCOME_UNKNOWN；网关不把它自动交给
新连接执行。

### 11.4 连接替代时的事件规则

新 session 的 activate 事务必须先单独提交，再按 conversation -> event -> session -> lease 顺序
用独立短事务处理旧 lease：

- 未 acquire permit 的旧 lease：撤销；同一 event 可用新 lease 重投新 session；
- 已 acquire permit 的旧 lease：撤销并使 event 进入 OUTCOME_UNKNOWN；
- conversation、grant、业务目标和 reply outbox 不变；
- 不生成“接管结果”业务消息；只对旧 socket 发送 `SESSION_SUPERSEDED`。

## 12. Reply 接收与招乎文本下行

### 12.1 接收 `REMOTE_REPLY`

事务内：

1. 验证当前 WSS session 已认证且 principal 拥有 conversation；
2. 校验 schema、Unicode 长度、0-based segment 和最多 8 段；
3. 若有 eventId，校验 event 属于同 conversation；
4. 对规范化业务 payload 计算 SHA-256，按 idempotencyKey 查询：相同 `payload_hash` 返回历史
   结果，不同 hash 报 `REPLY_IDEMPOTENCY_CONFLICT`；
5. 校验同 delivery 的不可变字段和 segmentCount；
6. 写 reply outbox；
7. commit 后返回 `REPLY_ACCEPTED`。

Reply 一旦持久化，不因原 WSS 断线而删除。平台 worker 只依赖 conversation 中加密的权威
OpenID 目标。

### 12.2 招乎单聊文本接口

已知正式路径：

```http
POST /robot-service/single-message/text
Authorization: Bearer <robot-token>
ROBOT-MESSAGE-ID: <stable-platform-request-uuid>
Content-Type: application/json

{
  "fromId": "<robot-open-id>",
  "toId": "<user-open-id>",
  "content": "<text <= 3000 chars>"
}
```

常规成功响应：

```json
{ "code": 0, "msg": "<platform-message-id>" }
```

HTTP 200 但 `code != 0` 不是成功。平台幂等头通常保留 10 分钟；网关重试必须复用同一个
`platform_request_id`，建议只在 8 分钟安全窗口内自动重试。超时且无法确认结果进入 UNKNOWN。

### 12.3 Outbox worker 抢占

MySQL 5.7 下每个 worker 循环执行：

1. 非锁定查询一个有界候选页：`state='PENDING'` 且 `next_attempt_at` 为空或已到期；同一
   delivery 必须已收齐 `0..segment_count-1` 且没有重号，当前段之前的所有段均为 SENT；
2. 为候选生成 `sendAttemptId`，在短事务中执行 CAS：

   ```sql
   UPDATE chatx_gw_reply_outbox
   SET state = 'SENDING',
       send_attempt_id = #{sendAttemptId},
       send_owner_node_id = #{nodeId},
       sending_started_at = #{now},
       first_attempt_at = COALESCE(first_attempt_at, #{now}),
       attempt_count = attempt_count + 1,
       version = version + 1,
       updated_at = #{now}
   WHERE outbox_id = #{outboxId}
     AND state = 'PENDING'
     AND version = #{expectedVersion}
     AND (next_attempt_at IS NULL OR next_attempt_at <= #{now})
   ```

3. 只有影响行数为 1 的 worker 获得发送权；commit 后才解密正文和目标、取 Token 并调用
   平台。CLIENT_REPLY 及离线提示从 conversation 取权威 OpenID，未映射身份提示使用已加密的
   direct target；
4. 结果写回必须带 `outbox_id + state='SENDING' + send_attempt_id + version`，旧 worker 晚到的
   HTTP 结果不得覆盖新 attempt；
5. 恢复 worker 只处理超过“最长 HTTP 时间 + 安全余量”的 SENDING。仍在平台幂等窗口内可用
   原 `platform_request_id` 回到 PENDING；窗口外进入 UNKNOWN，不自动换 ID 重发。

### 12.4 招乎机器人 Token

Token 获取和刷新接口确实存在，但机器人 API 原文没有完整 DTO。负责人只需在阶段一提供 Token
获取和刷新两份正式文档；阶段一必须把它们归档为仓库内 `contracts/http/zhaohu-token-api.md`
及 fixture，阶段五只读取该仓库内契约。冻结内容包括：

- acquire URI、认证方式、client 标识/密钥字段；
- access token 字段和 `expires_in` 单位；
- refresh token 是否存在、是否轮换；
- refresh URI、请求与响应 DTO；
- 多实例并发刷新语义；
- HTTP 与业务错误码；
- 401 后是否允许重新 acquire；
- Token 提前刷新窗口。

先定义 Port，不猜 HTTP：

```java
public interface PlatformTokenProvider {
    String getValidAccessToken();
    String forceRefreshAfterUnauthorized(String rejectedTokenFingerprint);
}
```

实现要求：

- client secret 只从 approved SecretPort/Vault 读取；
- token 使用 approved codec 加密存入 `chatx_gw_platform_token`，禁止日志；
- 多实例使用 §6.9 的有限时刷新租约单飞；获租约事务和 Token HTTP 调用必须分开；
- 到期前提前刷新；
- 平台 401 最多强制刷新并重试一次；
- 刷新失败保留 PENDING outbox，不把消息标 SENT；
- 用户 JWT 和机器人 Token 两套配置、Bean、日志字段完全隔离。

## 13. 安全、日志与配置

### 13.1 配置建议

```yaml
spring:
  datasource:
    url: ${MYSQL_JDBC_URL} # 必须明确 serverTimezone=UTC
    username: ${MYSQL_USERNAME}
    password: ${MYSQL_PASSWORD}
    hikari:
      transaction-isolation: TRANSACTION_READ_COMMITTED
      connection-init-sql: "SET time_zone = '+00:00'"

mybatis:
  mapper-locations: classpath*:/mapper/**/*.xml
  configuration:
    map-underscore-to-camel-case: false
    local-cache-scope: STATEMENT
    default-executor-type: SIMPLE

gateway:
  security:
    jwt:
      issuer: ${YST_JWT_ISSUER}
      jwk-set-uri: ${YST_JWK_SET_URI}
      audience: ${YST_JWT_AUDIENCE}
      principal-claim: ${YST_PRINCIPAL_CLAIM}
      allowed-algorithm: ${YST_ALLOWED_JWS_ALGORITHM}
      clock-skew-seconds: 60
      max-session-seconds: 28800
  websocket:
    path: /ws/desktop
    hello-timeout-seconds: 10
    heartbeat-seconds: 15
    offline-seconds: 45
    max-frame-bytes: 65536
  event:
    lease-seconds: 90
    permit-renew-seconds: 30
    received-ack-timeout-seconds: 15
    waiting-session-hours: 24
  reply:
    max-segments: 8
    desktop-max-code-points: 2800
    platform-max-characters: 3000
    platform-idempotency-safe-minutes: 8
  zhaohu:
    base-url: ${ZHAOHU_BASE_URL}
    robot-open-id-secret-ref: ${ZHAOHU_ROBOT_OPEN_ID_SECRET_REF}
    client-id-secret-ref: ${ZHAOHU_CLIENT_ID_SECRET_REF}
    client-secret-ref: ${ZHAOHU_CLIENT_SECRET_REF}
```

### 13.2 日志红线

禁止记录：

- Authorization、JWT、机器人 Token、client secret；
- OpenID 明文、`principalId`、消息正文；
- 完整 WSS envelope 或 webhook body；
- 解密后的 outbox content。

允许记录：traceId、eventId 后缀、conversationKey 后缀、sessionId 后缀、reasonCode、状态、耗时。
指标 label 禁止任何高基数业务 ID。

### 13.3 prod 启动门禁

生产必须验证正式 `CallbackAuthenticator`、`CryptoPort`、`SecretPort`、
`PlatformTokenProvider`、`IdentitySync` 已装配；local/test 的静态 Token、明文 codec 和 mock
identity Bean 在 prod profile 不得存在。

## 14. 恢复、保留与监控

启动/周期恢复：

- stale ONLINE session -> EXPIRED；
- 未 permit 的过期 lease -> REVOKED，event 可回 QUEUED 或 WAITING_SESSION；
- 已 permit 的过期 lease -> event OUTCOME_UNKNOWN；
- stale SENDING reply 在幂等安全窗口内 -> PENDING，复用原 platform_request_id；
- 超出窗口且无法查询 -> UNKNOWN；
- WAITING_SESSION TTL 到期 -> EXPIRED，并推进连续 cursor；
- SENT 和终态 event 不重发、不重跑；
- retention 不删除非终态 event、ACTIVE lease、PENDING/SENDING/UNKNOWN outbox。

至少暴露：

```text
chatx_gateway_platform_ingress_total{result,type}
chatx_gateway_platform_duplicate_total
chatx_gateway_identity_unknown_total
chatx_gateway_ws_connections{state}
chatx_gateway_session_replaced_total
chatx_gateway_event_backlog{state}
chatx_gateway_event_oldest_age_seconds{state}
chatx_gateway_event_ack_latency_seconds
chatx_gateway_lease_total{result}
chatx_gateway_reply_total{state,platform_code}
chatx_gateway_reply_oldest_age_seconds{state}
chatx_gateway_worker_errors_total{worker}
```

liveness 只看进程；readiness 检查数据库和正式安全 Adapter 初始化。单次招乎 API 失败不应永久
摘流，但必须有 dependency 指标和告警。

## 15. 分阶段开发计划

实施按 `docs/chatx-gateway-agent-plan/README.md` 中的六个阶段进行。每个阶段独立 PR，前一阶段
`./mvnw verify` 和人工 review 未通过，不进入下一阶段。

| 阶段               | 实施文档                                                        | 退出结果                                             |
| ------------------ | --------------------------------------------------------------- | ---------------------------------------------------- |
| 契约冻结与 Mock    | [阶段一](./chatx-gateway-agent-plan/01-contract-freeze.md)      | 外部契约可测，未知项只停在 Port/Mock                 |
| 工程与数据库       | [阶段二](./chatx-gateway-agent-plan/02-foundation-database.md)  | Java 8 工程、MySQL DDL 和基础 Repository 通过        |
| 身份与桌面连接     | [阶段三](./chatx-gateway-agent-plan/03-identity-websocket.md)   | 身份可映射，Desktop 单活 WSS 可连接和 SYNC           |
| 入站事件与执行许可 | [阶段四](./chatx-gateway-agent-plan/04-inbound-execution.md)    | 招乎消息可持久、顺序投递，结果不确定时不自动重跑     |
| 回复闭环           | [阶段五](./chatx-gateway-agent-plan/05-reply-closed-loop.md)    | Desktop 结果通过 durable outbox 返回招乎，可内网联调 |
| 生产加固与联调     | [阶段六](./chatx-gateway-agent-plan/06-production-hardening.md) | 多实例、恢复、审计、监控和故障演练通过               |

每个阶段文档就是一张完整任务单。负责人一次只交付一个阶段，Agent 按文档中的 C/DB/IW/IN/RP/PH
小节顺序完成，不提前实现下一阶段。

## 16. 低推理 Agent 固定提示词

```text
你是 ChatX 统一机器人 Java Gateway 的实现 Agent。

当前阶段文档：<CURRENT_PHASE_DOCUMENT>
基线 commit：<BASE_COMMIT>
冻结契约 commit：<FROZEN_CONTRACT_COMMIT>
验证命令：<TEST_COMMAND，默认 ./mvnw verify>

第一步只检查，不写代码：
1. 确认 HEAD 和 git status；存在任务外改动时停止。
2. 完整阅读当前阶段文档；只实现其中列出的允许范围。
3. 阅读仓库内由前序阶段生成的 Schema、fixture 和契约。
4. 若当前阶段文档、仓库内契约和现有代码冲突，输出 BLOCKED，不自行选择。
5. 输出不超过 8 步的计划，然后直接实施。

规则：
- 只能使用 JDK 1.8 和内部增强版 Spring Boot 2.7.2。
- 数据库只能使用 MySQL 5.7，持久层只能使用 MyBatis Mapper + XML。
- 必须使用本文配套 DDL；不使用 `SKIP LOCKED`、`CHECK` 或 MySQL 8 语法。
- Mapper XML 禁止将外部输入放入 `${}`；状态写入必须校验 CAS 影响行数。
- 只用 Java 8 与 javax.*；禁止 Boot 3/Jakarta/Java 9+ API。
- 不实现本任务之外的后续能力。
- 不自行修改 schema、状态、reasonCode、字段名、唯一约束。
- 不实现桌面选择、conversation 到机器的绑定或用户接管流程。
- principalId 只取已验证 JWT claim，禁止信任 HELLO/body。
- Token 获取/刷新只使用阶段一归档的契约，禁止猜 URI/DTO。
- 网络调用不进入数据库事务。
- 幂等、状态转移和 worker 必须有 Testcontainers/WireMock 测试。
- 不记录 Token、OpenID、principalId、正文或完整 payload。
- 不用内存 Map 代替数据库；node-local WebSocket 对象除外。
- 不用 Thread.sleep 测并发；使用 latch/barrier 和可注入 Clock。
- 最终报告改动文件、迁移、测试命令/结果、阻塞项和未实现后续任务。
```

实施范围只以当前阶段文档为准。

## 17. 验收矩阵

### 17.1 必须通过的安全测试

- JWT 坏签名、错误算法、issuer、audience、过期、尚未生效全部拒绝；
- HELLO 无法伪造 principal；
- WSS 帧未知字段、额外字段、重复 key 和错误 schemaVersion 拒绝；
- webhook 非官方允许来源不能进入 domain，伪造 `X-Forwarded-For` 不能绕过；
- identity 冲突不覆盖；
- Token/OpenID/principalId/正文不出现在日志；
- prod 不装配 mock/static/plaintext Adapter。

### 17.2 必须通过的一致性测试

- 同一平台 msgId 并发只生成一个 event；
- 同 conversation seq 连续，首次投递严格有序；
- 两 worker 不双投 event、不双发 reply；
- 后建立的 WSS 成为唯一 ONLINE session；
- 旧 session heartbeat、命令和 close 全部被 fencing；
- 普通重连不改变 conversation、授权和 outbox；
- pre-permit 连接丢失可用新 lease 重投同一 event；
- post-permit 连接丢失进入 OUTCOME_UNKNOWN，不自动重跑；
- received/accepted/completed 重投幂等；
- EXPIRED/CANCELLED 不造成 seq 空洞；
- 同 reply key 同 payload 幂等，不同 payload 冲突；
- 平台超时重试复用原 `ROBOT-MESSAGE-ID`；
- UNKNOWN 不自动重发；
- crash/restart 不丢非终态 event/outbox，不重发 SENT。

### 17.3 必须通过的平台测试

- 单聊 text webhook 正确读取 `msgContent/fromId/toId`；
- 群聊和非文本在去重后忽略；
- 回复使用权威映射的动态 `toId`；
- HTTP 200 + code 非 0 不当成功；
- 429/5xx/timeout 分类正确；
- Token acquire、提前刷新、并发单飞、401 刷新一次；
- refresh 失败时 outbox 保留；
- 2,800/3,000/8 段边界通过。

## 18. 最终交付物

- JDK 1.8 可复现构建的内部 Boot 2.7.2 仓库和 Maven Wrapper；
- Flyway migration、索引、容量、备份与恢复说明；
- OpenAPI、JSON Schema、AsyncAPI、golden fixtures；
- JWT、identity、callback、crypto、secret、Token 和平台 Adapter；
- 部署清单、TLS、健康检查、资源基线；
- dashboard、告警、runbook、保留和 UNKNOWN reconciliation 工具；
- 单元、Testcontainers、WireMock、并发、恢复和故障注入报告；
- 与 ChatX Desktop 及招乎测试机器人的联调演练报告。

只有业务代码、没有契约、迁移、测试、监控和演练，不算交付完成。
