# 阶段六：生产加固与联调

> 本阶段不增加新的业务协议，专门验证阶段五闭环在多实例、崩溃、网络不确定、积压和
> 运维操作下仍然正确。
>
> 这是可独立交给代码 Agent 的任务单。交付时只给 Java 网关仓库和本文件，不需要任何外部
> 接口附件。

## 1. 前置材料

- 阶段五端到端联调已通过；
- 生产 TLS、网络、KMS/Vault、数据库、容器和告警基线；
- 审计保留期、数据清理、UNKNOWN 人工处置权限和运维负责人；
- 至少两个 Gateway 实例和可用的招乎测试环境。

## 2. 接口边界

本阶段不修改 WSS Schema、reasonCode 或五个 HTTP 逻辑契约。新增的只是：

- Actuator liveness/readiness；
- Prometheus metrics；
- 受审计的 UNKNOWN reconciliation 运维能力。

如 reconciliation 需要新 HTTP 管理接口，必须先单独冻结认证、授权、幂等、审计和请求/响应
契约；Agent 不得自行对外暴露通用“重试”接口。

## 3. 允许修改范围

- recovery/retention/expiry worker；
- 多节点 session registry 通知与 DB 轮询恢复；
- audit Repository 和受控 reconciliation application service；
- Actuator、metrics、alert 和 dashboard 配置；
- prod profile 启动门禁、TLS 与线程池配置；
- 保留、容量、备份恢复和故障 runbook；
- 双边契约、端到端、并发、恢复和故障注入测试。

禁止为解决运维问题而放宽 JWT/webhook 认证、禁用幂等、删除 UNKNOWN 或增加自动二次执行。

## 4. 任务顺序

### PH-01：启动和周期恢复

- stale ONLINE session -> EXPIRED；
- 未 permit 的过期 lease -> REVOKED，event 回 QUEUED 或 WAITING_SESSION；
- 已 permit 的过期 lease -> event `OUTCOME_UNKNOWN`；
- stale SENDING reply 在幂等安全窗内 -> PENDING，复用原 platform request ID；
- 超出安全窗且无法查询 -> UNKNOWN；
- WAITING_SESSION 超 TTL -> EXPIRED 并只推进连续 cursor；
- 所有恢复动作可重复执行，多节点并行只有一个 CAS 成功。

### PH-02：多实例与连接替代

- DB session/generation 是权威 fencing，本地 socket Map 只保存真实连接对象；
- 新 session activate 事务先提交，再用独立事件事务处理旧 lease；
- pre-permit 旧 lease 撤销后可同 event 重投新 session；
- post-permit 只进 UNKNOWN；
- 节点通知是加速优化，丢失后仍由 DB 轮询关闭旧 socket；
- Desktop 收到 `SESSION_SUPERSEDED` 后不自动重连，避免连接竞争风暴。

### PH-03：保留与审计

- retention 不删除非终态 event、ACTIVE lease、PENDING/SENDING/UNKNOWN outbox；
- 有外键关系的历史数据按子表到父表顺序清理；
- 身份变更、session 替代、lease 撤销、Token 异常和 UNKNOWN 人工处置写 append-only audit；
- audit 不保存 Token、OpenID、principalId、正文或任意 JSON details；
- 人工处置 UNKNOWN 必须验证权限、幂等并记录前后状态。

### PH-04：可观测性与启动门禁

- liveness 只检查进程；readiness 检查 DB 和正式安全 Adapter 初始化；
- 单次招乎 API 失败不应永久摘除 readiness，但必须有 dependency 指标和告警；
- 指标覆盖 ingress 去重、未知身份、WSS、session 替代、event backlog/age、lease、reply
  state/age 和 worker error；
- metrics label 不允许 principal、OpenID、eventId 等高基数业务 ID；
- prod 缺 CallbackAuthenticator、CryptoPort、SecretPort、PlatformTokenProvider 或 IdentitySync
  正式实现时启动失败。

### PH-05：故障演练

必须在至少两个 Gateway 实例下演练：

- 重复/并发 webhook；
- 同 principal 两个 Desktop 连接；
- Desktop 在 pre-permit 和 post-permit 两个时点崩溃；
- Gateway 在 event claim、WSS send、outbox SENDING 后被杀；
- MySQL 短暂不可用、死锁和连接池耗尽；
- 招乎 429、5xx、timeout、HTTP 200/业务失败和结果不确定；
- Token 刷新并发、失败和 401 后二次失败；
- WAITING_SESSION 到期、恢复 worker 重复运行和 retention。

## 5. 必须验收

- 双边契约 fixture 全部通过；
- 并发和故障演练无双执行、无双发 SENT、无 seq 空洞；
- UNKNOWN 不自动重跑/重发；
- 旧 session 不能影响新 session；
- 敏感日志扫描、生产 profile 启动门禁、TLS 和资源饥饿测试通过；
- dashboard、alert、runbook、备份/恢复和 UNKNOWN 处置手册经运维审核；
- 真实招乎测试机器人闭环演练通过；
- `./mvnw verify` 在 JDK 1.8 通过，产物 class major version 52。

## 6. 退出条件

开发、安全、DBA、运维和 Desktop 负责人共同审核演练报告；所有生产阻塞项关闭，不存在
mock/static/plaintext Adapter，才能进入生产发布。
