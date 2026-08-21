-- ChatX 统一机器人网关 MySQL 5.7 基线 DDL
--
-- 使用方式：
--   1. 由 Flyway 作为首个基线迁移执行，不要在业务代码启动时自动建表。
--   2. 必须使用 InnoDB、utf8mb4、严格 SQL mode 和 UTC session。
--   3. MySQL 5.7 的 DDL 会隐式提交；发布前必须在空库验证，不得依赖 DDL 事务回滚。
--   4. 本文件故意不使用 IF NOT EXISTS，避免静默掩盖 schema drift。
--   5. MySQL 5.7 不强制 CHECK 约束；状态枚举、时间先后和分段范围由 domain 强校验。

SET NAMES utf8mb4 COLLATE utf8mb4_bin;
SET time_zone = '+00:00';

CREATE TABLE chatx_gw_identity_binding (
  binding_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '绑定记录ID，网关生成的小写UUID',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '来自已验证JWT的企业主体ID',
  open_id_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '招乎用户OpenID的密钥指纹，用于等值查询',
  open_id_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '经批准加密组件加密的招乎用户OpenID',
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '绑定状态：ACTIVE或REVOKED',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及CAS版本号',
  created_at DATETIME(3) NOT NULL COMMENT '记录创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '记录最后更新时间，UTC',
  revoked_at DATETIME(3) NULL COMMENT '绑定撤销时间，UTC；未撤销时为空',
  active_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN status = 'ACTIVE' THEN principal_id ELSE NULL END
    ) STORED COMMENT 'ACTIVE状态下用于保证企业主体唯一的生成列',
  active_open_id_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN status = 'ACTIVE' THEN open_id_fingerprint ELSE NULL END
    ) STORED COMMENT 'ACTIVE状态下用于保证OpenID指纹唯一的生成列',
  PRIMARY KEY (binding_id),
  UNIQUE KEY uq_identity_active_principal (active_principal_id),
  UNIQUE KEY uq_identity_active_open_id (active_open_id_fingerprint),
  KEY idx_identity_principal_history (principal_id, status, updated_at),
  KEY idx_identity_open_id_history (open_id_fingerprint, status, updated_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '企业主体与招乎用户OpenID绑定记录';

CREATE TABLE chatx_gw_desktop_session (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '桌面连接会话ID，成功HELLO后生成的小写UUID',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '来自已验证JWT的企业主体ID',
  node_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '持有真实WebSocket连接的网关节点ID',
  connection_generation BIGINT NOT NULL COMMENT '企业主体维度单调递增的连接代次',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话状态：ONLINE、OFFLINE、SUPERSEDED或EXPIRED',
  connected_at DATETIME(3) NOT NULL COMMENT '连接建立时间，UTC',
  last_heartbeat_at DATETIME(3) NOT NULL COMMENT '最近一次有效心跳时间，UTC',
  disconnected_at DATETIME(3) NULL COMMENT '连接终止时间，UTC；在线时为空',
  jwt_expires_at DATETIME(3) NOT NULL COMMENT '本次连接使用的JWT到期时间，UTC',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及CAS版本号',
  online_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN state = 'ONLINE' THEN principal_id ELSE NULL END
    ) STORED COMMENT 'ONLINE状态下用于保证企业主体单活的生成列',
  PRIMARY KEY (session_id),
  UNIQUE KEY uq_session_online_principal (online_principal_id),
  UNIQUE KEY uq_session_principal_generation (principal_id, connection_generation),
  KEY idx_session_principal_state_generation (principal_id, state, connection_generation),
  KEY idx_session_node_state_heartbeat (node_id, state, last_heartbeat_at),
  KEY idx_session_state_heartbeat (state, last_heartbeat_at),
  KEY idx_session_state_jwt_expiry (state, jwt_expires_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '经企业身份认证的单活桌面连接会话';

CREATE TABLE chatx_gw_conversation (
  conversation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '对Desktop暴露的不透明会话ID，小写UUID',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话所属企业主体ID，创建后不可变',
  peer_open_id_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '用户招乎OpenID的密钥指纹',
  peer_open_id_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '经批准加密组件加密的用户招乎OpenID，作为回复目标',
  robot_open_id_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '统一机器人招乎OpenID的密钥指纹',
  next_sequence BIGINT NOT NULL DEFAULT 1 COMMENT '下一条入站事件应分配的会话序号',
  delivery_cursor_sequence BIGINT NOT NULL DEFAULT 0 COMMENT '已持久接收或终结的连续投递游标',
  session_wait_active TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否处于等待桌面上线窗口：0否、1是',
  session_wait_generation BIGINT NOT NULL DEFAULT 0 COMMENT '等待桌面上线提示的幂等代次',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '会话状态：ACTIVE、SUSPENDED或REVOKED',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及CAS版本号',
  created_at DATETIME(3) NOT NULL COMMENT '会话创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '会话最后更新时间，UTC',
  PRIMARY KEY (conversation_key),
  UNIQUE KEY uq_conversation_business_key (
    principal_id,
    peer_open_id_fingerprint,
    robot_open_id_fingerprint
  ),
  KEY idx_conversation_principal_state (principal_id, state, updated_at),
  KEY idx_conversation_waiting (session_wait_active, updated_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '企业主体拥有的招乎机器人单聊会话';

CREATE TABLE chatx_gw_platform_inbox (
  platform_message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '招乎webhook的msgId，平台消息永久去重键',
  payload_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '规范化白名单字段的SHA-256摘要，用于检测同ID异内容',
  message_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '招乎原始消息类型msgType',
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '入站状态：RECEIVED、NORMALIZED、IGNORED或IDENTITY_UNKNOWN',
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '成功归一化后关联的入站事件ID；未生成事件时为空',
  received_at DATETIME(3) NOT NULL COMMENT '首次收到webhook的时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '入站记录最后更新时间，UTC',
  PRIMARY KEY (platform_message_id),
  UNIQUE KEY uq_platform_inbox_event (event_id),
  KEY idx_platform_inbox_state_received (state, received_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '不保存原始报文的持久化webhook去重收件箱';

CREATE TABLE chatx_gw_inbound_event (
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '网关生成的稳定入站事件ID，小写UUID',
  platform_message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '来源招乎平台消息ID',
  conversation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '事件所属不透明会话ID',
  conversation_sequence BIGINT NOT NULL COMMENT '会话内从1开始严格递增的事件序号',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '事件所属企业主体ID，创建后冻结',
  message_text_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '经批准加密组件加密的文本正文；按保留策略可为空',
  occurred_at DATETIME(3) NOT NULL COMMENT '招乎消息发生时间，统一转换为UTC',
  state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '事件状态，取值由领域状态机校验',
  first_delivered_at DATETIME(3) NULL COMMENT '首次通过WSS投递到Desktop的时间，UTC',
  received_at DATETIME(3) NULL COMMENT 'Desktop持久化并返回received ACK的时间，UTC',
  accepted_at DATETIME(3) NULL COMMENT 'Desktop取得执行许可的时间，UTC',
  finished_at DATETIME(3) NULL COMMENT '事件进入终态的时间，UTC',
  terminal_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '事件终态或异常终止原因码',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及CAS版本号',
  created_at DATETIME(3) NOT NULL COMMENT '事件创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '事件最后更新时间，UTC',
  PRIMARY KEY (event_id),
  UNIQUE KEY uq_event_platform_message (platform_message_id),
  UNIQUE KEY uq_event_conversation_sequence (conversation_key, conversation_sequence),
  KEY idx_event_conversation_state_sequence (
    conversation_key,
    state,
    conversation_sequence
  ),
  KEY idx_event_state_updated (state, updated_at),
  KEY idx_event_principal_state_created (principal_id, state, created_at),
  CONSTRAINT fk_event_conversation
    FOREIGN KEY (conversation_key)
    REFERENCES chatx_gw_conversation (conversation_key),
  CONSTRAINT fk_event_platform_inbox
    FOREIGN KEY (platform_message_id)
    REFERENCES chatx_gw_platform_inbox (platform_message_id)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '按会话严格排序的归一化入站事件';

-- platform_inbox.event_id 是对归一化结果的可空反向指针。为避免与 inbound_event 形成循环外键，
-- 只保留唯一索引；application service 必须在同一个入站事务内写入两边。

CREATE TABLE chatx_gw_event_lease (
  lease_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '每次事件投递生成的租约ID，小写UUID',
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '租约对应的入站事件ID',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '事件及租约所属企业主体ID',
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '签发租约时的Desktop会话ID',
  connection_generation BIGINT NOT NULL COMMENT '签发租约时的连接代次，用于阻断旧连接',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '租约状态：ACTIVE、REVOKED或EXPIRED',
  issued_at DATETIME(3) NOT NULL COMMENT '租约签发时间，UTC',
  expires_at DATETIME(3) NOT NULL COMMENT '租约接收阶段到期时间，UTC',
  permit_acquired_at DATETIME(3) NULL COMMENT 'Desktop取得执行许可的时间，UTC',
  permit_expires_at DATETIME(3) NULL COMMENT '执行许可到期时间，UTC',
  revoke_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '租约撤销或过期原因码',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及CAS版本号',
  active_event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN state = 'ACTIVE' THEN event_id ELSE NULL END
    ) STORED COMMENT 'ACTIVE状态下用于保证事件仅有一个租约的生成列',
  PRIMARY KEY (lease_id),
  UNIQUE KEY uq_lease_active_event (active_event_id),
  KEY idx_lease_event_state (event_id, state),
  KEY idx_lease_session_state (session_id, state),
  KEY idx_lease_state_expiry (state, expires_at),
  KEY idx_lease_state_permit_expiry (state, permit_expires_at),
  CONSTRAINT fk_lease_event
    FOREIGN KEY (event_id)
    REFERENCES chatx_gw_inbound_event (event_id),
  CONSTRAINT fk_lease_session
    FOREIGN KEY (session_id)
    REFERENCES chatx_gw_desktop_session (session_id)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '入站事件投递租约与执行许可';

CREATE TABLE chatx_gw_client_command (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '命令所属的已认证Desktop会话ID',
  command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Desktop提供的命令幂等ID',
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '命令所属企业主体ID',
  command_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'WSS命令类型',
  payload_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '规范化命令载荷摘要，用于检测同ID异内容',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '命令状态：PROCESSING、COMPLETED或FAILED',
  result_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '可重放的网关响应消息类型',
  result_payload_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '可重放的脱敏响应JSON，不得包含敏感信息',
  created_at DATETIME(3) NOT NULL COMMENT '命令首次创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '命令最后更新时间，UTC',
  expires_at DATETIME(3) NOT NULL COMMENT '命令幂等记录可清理时间，UTC',
  PRIMARY KEY (session_id, command_id),
  KEY idx_client_command_expiry (expires_at),
  KEY idx_client_command_principal_state (principal_id, state, created_at),
  CONSTRAINT fk_client_command_session
    FOREIGN KEY (session_id)
    REFERENCES chatx_gw_desktop_session (session_id)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = 'Desktop会话内命令幂等及可重放结果';

CREATE TABLE chatx_gw_reply_outbox (
  outbox_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '回复发件箱记录ID，小写UUID',
  source VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '回复来源：CLIENT_REPLY或SYSTEM_NOTICE',
  delivery_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '一次逻辑回复的稳定投递ID',
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '关联入站事件ID；主动消息或定时提醒可为空',
  conversation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '正常回复或离线提示的会话目标',
  direct_to_id_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '未映射身份系统提示使用的加密OpenID直达目标',
  idempotency_key VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Desktop提供的稳定回复幂等键',
  payload_hash VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '规范化业务载荷摘要，用于检测同键异内容',
  segment_index INT NOT NULL COMMENT '回复分段下标，从0开始',
  segment_count INT NOT NULL COMMENT '一次逻辑回复的总分段数，范围1至8',
  content_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT '经批准加密组件加密的待发送文本',
  platform_request_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '发送给招乎的ROBOT-MESSAGE-ID，创建后不可更换',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '发送状态：PENDING、SENDING、SENT、UNKNOWN或FAILED',
  platform_message_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '招乎发送成功后返回的平台消息ID',
  attempt_count INT NOT NULL DEFAULT 0 COMMENT '平台发送尝试次数',
  first_attempt_at DATETIME(3) NULL COMMENT '首次调用招乎发送接口的时间，UTC',
  next_attempt_at DATETIME(3) NULL COMMENT '下一次允许重试的时间，UTC',
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '最近一次脱敏平台错误码或内部原因码',
  send_attempt_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '当前发送抢占尝试ID，用于结果fencing',
  send_owner_node_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '当前执行发送尝试的网关节点ID',
  sending_started_at DATETIME(3) NULL COMMENT '当前发送尝试开始时间，UTC',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及worker CAS版本号',
  created_at DATETIME(3) NOT NULL COMMENT '发件箱记录创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT '发件箱记录最后更新时间，UTC',
  PRIMARY KEY (outbox_id),
  UNIQUE KEY uq_reply_idempotency_key (idempotency_key),
  UNIQUE KEY uq_reply_delivery_segment (delivery_id, segment_index),
  UNIQUE KEY uq_reply_platform_request (platform_request_id),
  KEY idx_reply_state_retry (state, next_attempt_at, created_at),
  KEY idx_reply_delivery_state_segment (delivery_id, state, segment_index),
  KEY idx_reply_sending_recovery (state, sending_started_at),
  KEY idx_reply_event (event_id),
  CONSTRAINT fk_reply_conversation
    FOREIGN KEY (conversation_key)
    REFERENCES chatx_gw_conversation (conversation_key),
  CONSTRAINT fk_reply_event
    FOREIGN KEY (event_id)
    REFERENCES chatx_gw_inbound_event (event_id)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '持久化分段招乎回复发件箱';

CREATE TABLE chatx_gw_platform_token (
  provider_key VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '官方机器人Token提供方及凭据槽位标识',
  access_token_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '经批准加密组件加密的access token',
  refresh_token_ciphertext LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT '经批准加密组件加密的refresh token',
  access_token_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT 'access token密钥指纹，用于401后防重复刷新',
  access_token_expires_at DATETIME(3) NULL COMMENT 'access token到期时间，UTC',
  refresh_token_expires_at DATETIME(3) NULL COMMENT 'refresh token到期时间，UTC；平台未提供时为空',
  state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT 'Token状态：EMPTY、VALID、REFRESHING或ERROR',
  refresh_owner_node_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '持有Token刷新租约的网关节点ID',
  refresh_started_at DATETIME(3) NULL COMMENT '本次Token刷新开始时间，UTC',
  refresh_lease_expires_at DATETIME(3) NULL COMMENT 'Token刷新租约到期时间，UTC',
  last_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '最近一次Token获取或刷新脱敏错误码',
  version BIGINT NOT NULL DEFAULT 0 COMMENT '乐观锁及刷新租约CAS版本号',
  created_at DATETIME(3) NOT NULL COMMENT 'Token槽位创建时间，UTC',
  updated_at DATETIME(3) NOT NULL COMMENT 'Token槽位最后更新时间，UTC',
  PRIMARY KEY (provider_key),
  KEY idx_platform_token_refresh_lease (state, refresh_lease_expires_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '网关范围内加密机器人Token及多节点刷新租约';

CREATE TABLE chatx_gw_audit_log (
  audit_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '审计记录ID，小写UUID',
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '受审计的业务动作类型',
  outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '动作结果，如SUCCESS、DENIED或FAILED',
  actor_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '操作者类型，不保存操作者敏感标识',
  actor_fingerprint VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '操作者标识的密钥指纹；无需关联时为空',
  subject_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '被操作业务对象类型',
  subject_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL COMMENT '被操作对象的不透明业务ID，不保存OpenID',
  previous_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '操作前状态',
  new_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '操作后状态',
  reason_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '动作结果对应的稳定脱敏原因码',
  trace_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL COMMENT '脱敏调用链路ID',
  created_at DATETIME(3) NOT NULL COMMENT '审计记录创建时间，UTC',
  PRIMARY KEY (audit_id),
  KEY idx_audit_subject_created (subject_type, subject_id, created_at),
  KEY idx_audit_action_created (action, created_at),
  KEY idx_audit_created (created_at)
) ENGINE = InnoDB
  DEFAULT CHARACTER SET = utf8mb4
  COLLATE = utf8mb4_bin
  ROW_FORMAT = DYNAMIC
  COMMENT = '不含敏感载荷的只追加安全审计日志';
