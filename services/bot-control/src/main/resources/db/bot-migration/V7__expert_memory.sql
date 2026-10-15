-- Expert knowledge is independent of Group-private knowledge. No data promotion.
CREATE TABLE bot_memory_revisions (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT NOT NULL,
  PRIMARY KEY (space_id,bot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE bot_memories (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  memory_text TEXT NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_json TEXT NOT NULL,
  created_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,bot_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE bot_memory_commands (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint BINARY(32) NOT NULL,
  receipt_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (space_id,principal_id,command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE group_expert_memory_modes (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (space_id,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Persist selection at enqueue, never reinterpret existing queues or snapshots.
ALTER TABLE requirement_run_queue ADD COLUMN memory_scope VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'group';
