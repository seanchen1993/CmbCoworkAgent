-- Incremental Task-only storage. No FKs, execution, leases or external content.
CREATE TABLE task_space_head (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_seq BIGINT NOT NULL,
  task_number BIGINT NOT NULL,
  PRIMARY KEY (space_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tasks (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  task_number VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  body_bytes MEDIUMBLOB NOT NULL,
  PRIMARY KEY (space_id,id),
  UNIQUE KEY uq_task_number (space_id,task_number),
  KEY ix_task_group (space_id,group_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE task_messages (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  author_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_version BIGINT NOT NULL,
  target_bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  body_bytes MEDIUMBLOB NOT NULL,
  PRIMARY KEY (space_id,id),
  UNIQUE KEY uq_task_message_version (space_id,task_id,task_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Old Bot/Group rows remain NULL. Task activities live in the same immutable outbox.
ALTER TABLE mutation_outbox
  ADD COLUMN task_seq BIGINT NULL,
  ADD COLUMN task_group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN event_bytes MEDIUMBLOB NULL,
  ADD UNIQUE KEY uq_outbox_task_seq (space_id,task_seq);

CREATE TABLE task_event_cursors (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  high_water BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id),
  KEY ix_task_cursor_expiry (space_id,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
