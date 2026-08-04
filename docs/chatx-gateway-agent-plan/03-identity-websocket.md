# 阶段三：身份与桌面连接

> 本阶段只实现身份映射和 Desktop 长连接。完成后 Desktop 应稳定显示已连接，但还不接收
> 招乎业务消息。
>
> 这是可独立交给代码 Agent 的任务单。交付时只给 Java 网关仓库和本文件，不需要任何招乎
> 接口附件。

## 1. 前置材料

- 阶段二已评审通过；
- 阶段一已在仓库中生成 WSS Schema、fixture 和安全 Port；
- JWT issuer/JWKS/audience/主体 claim/允许算法由生产环境变量提供，代码中不得写默认生产值；
- approved CryptoPort、SecretPort 和内部服务认证组件可从内部框架装配。

## 2. 本阶段接口

### 身份同步

这是 Gateway 自己提供的内部管理接口，不需要负责人再提供外部接口文档：

```http
PUT /internal/v1/identity-bindings
Content-Type: application/json
Idempotency-Key: <uuid>

{"principalId":"<enterprise-principal>","openId":"<zhaohu-user-open-id>"}
```

```http
POST /internal/v1/identity-bindings/revoke
Content-Type: application/json
Idempotency-Key: <uuid>

{"principalId":"<enterprise-principal>"}
```

- 使用公司内部标准服务间认证与权限校验，不自行设计用户名密码；
- `principalId` 是企业主体，`openId` 是招乎用户 OpenID；二者只出现在受保护 body，不放 URL，
  避免被 access log 记录；
- PUT 相同映射幂等成功；principal 或 OpenID 已绑定另一侧时返回 HTTP 409；
- DELETE 幂等撤销，保留历史记录；
- OpenID 只能存 approved codec 密文和 keyed fingerprint；
- 接口响应只返回 `bindingId/status/updatedAt`，不得回显 OpenID；
- 若部署方已有统一身份同步服务，可由该服务调用此接口，Gateway 的领域语义不变。

### Desktop WSS

固定 Upgrade 接口：

```http
GET /ws/desktop
Connection: Upgrade
Upgrade: websocket
Authorization: Bearer <ystIdToken>
```

本阶段实现：

- Client -> Gateway：`HELLO`、`HEARTBEAT`、`SYNC_REQUEST`；
- Gateway -> Client：`WELCOME`、`SYNC_STATE`、`ERROR`。

Desktop 在收到 `WELCOME` 后会立即发送 `SYNC_REQUEST`，因此本阶段必须返回合法
`SYNC_STATE`。如尚无 conversation，`routes` 是空数组，不是临时错误。

## 3. 允许修改范围

- `config/SecurityConfig.java`、`WebSocketConfig.java`；
- `contract/ws/**`；
- `adapter/in/admin/identity/**`；
- `adapter/in/desktop/websocket/**`；
- identity/session/audit Repository；
- conversation state 的最小只读 Mapper，仅供 `SYNC_STATE`；
- `IdentityBindingService`、`DesktopSessionService`；
- 本阶段测试。

禁止实现 webhook、event dispatcher、ACK/permit、REMOTE_REPLY、Token 或平台发送。

## 4. 任务顺序

### IW-01：JWT WSS Upgrade

- TLS 与 Spring Security 在 Upgrade 时验证 Bearer `ystIdToken`；
- 校验 JWS 算法 allowlist、issuer、audience、`exp/nbf/iat` 和时钟偏差；
- `principalId` 只从已验证 Authentication 的冻结 claim 读取；
- handshake attributes 只保存 principal、权限和 JWT 到期时间，不保存原 JWT；
- Token 缺失、无效或过期时 Upgrade 返回 HTTP `401`；身份有效但没有网关权限时返回 `403`；
- Desktop 收到 `401` 后会使用现有企业登录刷新接口刷新一次并重新 Upgrade，第二次 `401` 停止，
  因此不得用 `401` 表示普通网络错误。

### IW-02：身份同步

- 先验证管理面调用方，再解析请求；
- OpenID 只落加密值和 keyed fingerprint；
- 相同映射幂等，principal/OpenID 任一冲突拒绝覆盖并审计；
- 撤销保留历史行，不删除已存 conversation/event。

### IW-03：严格 WSS 协议

- 10 秒内必须收到 `HELLO`；
- 使用独立 strict `ObjectMapper`，拒绝未知字段、重复 key、trailing token 和未知 enum；
- 单帧最大 64 KiB；
- `HELLO` 不接受 principal，`WELCOME.principalId` 只来自已验证上下文；
- `SYNC_REQUEST` 只返回当前 principal 的 conversation key/state，不返回物理设备信息。

### IW-04：单活 session

在一个短事务内：

1. `SELECT` ACTIVE identity binding `FOR UPDATE`；
2. 读取 latest generation，无历史时从 1 开始；
3. 将当前 ONLINE session CAS 为 `SUPERSEDED`；
4. 插入新 ONLINE session；
5. commit 后才注册本地 socket，通知并关闭旧 socket。

`online_principal_id` generated unique index 是并发最后防线。唯一键冲突时整个事务回滚，
不得删索引或无条件覆盖。

### IW-05：心跳与 fencing

- heartbeat 更新必须同时匹配 session/principal/node/generation/ONLINE/version；
- 旧 socket 的 heartbeat、命令和 close 不得影响新 session；
- heartbeat 超时使 session 进入终结状态；JWT 到期时先发送不带 `commandId` 的
  `ERROR { reasonCode: "AUTH_REQUIRED" }`，再关闭 socket；WSS 建立后不能返回 HTTP `401`；
- 每个节点按心跳周期核对自己的 socket 和 DB session，节点通知丢失不影响正确性；
- Desktop 收到 `SESSION_SUPERSEDED` 后不自动重连。

## 5. 必须测试

- 正常 JWT；坏签名、错误算法/issuer/audience、expired、nbf、缺主体全部拒绝；
- expired JWT 的 Upgrade 返回 `401`，权限不足返回 `403`；在线 JWT 到期时先发
  `ERROR/AUTH_REQUIRED` 再断开；
- HELLO/body/Header 无法伪造 principal；
- 已冻结 WSS valid/invalid fixture 全部通过；
- `WELCOME` 后 `SYNC_REQUEST` 收到相关 `SYNC_STATE`；
- 同 principal 两个连接，后者成为唯一 ONLINE；
- 旧 heartbeat/close 不覆盖新 session；
- 身份同步幂等、冲突 fail closed、撤销保留历史；
- 敏感日志扫描通过；
- `./mvnw verify` 在 JDK 1.8 通过。

## 6. 退出条件

测试 Desktop 可用真实 JWT 建立 WSS，稳定心跳并完成 SYNC；同主体的后连接能取代前连接。
招乎业务消息尚未进入 Gateway 是本阶段的预期边界。
