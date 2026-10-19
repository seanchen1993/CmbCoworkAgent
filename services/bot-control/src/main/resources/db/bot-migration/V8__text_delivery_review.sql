-- Internal immutable text deliverables. All associations checked under Group/Task locks; no FKs.
CREATE TABLE task_delivery_heads (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 revision BIGINT NOT NULL,
 body_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,task_id), KEY ix_delivery_head_group(space_id,group_id,task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE task_delivery_versions (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 number BIGINT NOT NULL,
 source_run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 source_attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 summary_bytes BLOB NOT NULL,
 body_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,id), UNIQUE KEY uq_delivery_number(space_id,task_id,number),
 UNIQUE KEY uq_delivery_run(space_id,source_run_id), UNIQUE KEY uq_delivery_attempt(space_id,source_attempt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE task_delivery_decisions (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 body_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,id), UNIQUE KEY uq_delivery_decision(space_id,version_id),
 KEY ix_delivery_decision_task(space_id,task_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE task_delivery_commands (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 fingerprint BINARY(32) NOT NULL,
 receipt_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,principal_id,command_id), KEY ix_delivery_command_task(space_id,task_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE requirement_run_delivery_inputs (
 space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 body_bytes MEDIUMBLOB NOT NULL,
 PRIMARY KEY(space_id,run_id), KEY ix_delivery_input_task(space_id,task_id,run_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
ALTER TABLE requirement_run_queue ADD COLUMN delivery_version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL, ADD KEY ix_requirement_task_status(space_id,task_id,status);
