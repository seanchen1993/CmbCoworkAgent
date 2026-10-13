-- Explicit Group memory only. Relationships are checked under the Group lock.
CREATE TABLE group_memory_revisions (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT NOT NULL,
  PRIMARY KEY (space_id,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE group_memories (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  memory_text TEXT NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_json TEXT NOT NULL,
  created_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  updated_by VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,group_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE group_memory_commands (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint BINARY(32) NOT NULL,
  receipt_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (space_id,principal_id,command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE requirement_run_memory_snapshots (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  snapshot_json MEDIUMTEXT NOT NULL,
  PRIMARY KEY (space_id,run_id),
  UNIQUE KEY uq_memory_snapshot_attempt (space_id,attempt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- Existing V5 running attempts never consumed Group memory. Freeze that explicit
-- historical null now; a later duplicate start must not inject newly published data.
INSERT INTO requirement_run_memory_snapshots(space_id,run_id,attempt_id,snapshot_json)
  SELECT space_id,id,attempt_id,'null' FROM requirement_run_queue WHERE status='running';
