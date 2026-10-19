-- Internal conversation roles, immutable execution context and once-only coordination.
-- No physical foreign keys; every association is checked under Group/Task locks.
CREATE TABLE expert_service_identity (
 singleton TINYINT NOT NULL,
 instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(singleton)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO expert_service_identity(singleton,instance_id) VALUES(1,UUID());
CREATE TABLE expert_task_conversations (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 role VARCHAR(8) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 main_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
 carried_context MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,task_id), UNIQUE KEY uq_expert_main(space_id,group_id,bot_id,main_key),
 KEY ix_expert_conversation_owner(space_id,group_id,bot_id,principal_id,role,task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE expert_conversation_inputs (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_version BIGINT NOT NULL,
 group_version BIGINT NOT NULL,
 bot_version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
 profile VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 digest VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 fingerprint BINARY(32) NOT NULL,
 body_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,principal_id,command_id), UNIQUE KEY uq_expert_input_run(space_id,run_id),
 KEY ix_expert_input_task(space_id,task_id,task_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE expert_conversation_commands (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
 operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 fingerprint BINARY(32) NOT NULL,
 receipt_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,principal_id,command_id), UNIQUE KEY uq_expert_source_consumed(space_id,source_run_id),
 KEY ix_expert_command_task(space_id,task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE requirement_run_queue
 ADD COLUMN execution_profile VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN context_digest VARCHAR(71) CHARACTER SET ascii COLLATE ascii_bin NULL;
CREATE INDEX ix_expert_run_history ON requirement_run_queue(space_id,task_id,status,task_version,created_at,id);

CREATE INDEX requirement_conversation_owner ON requirement_run_queue(space_id,task_id,created_at,id);
