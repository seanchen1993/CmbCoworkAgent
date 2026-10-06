-- B1 v2: no physical FKs or ineffective MySQL5.7 CHECK constraints.
-- C/D must check all space/version/member relationships under transaction locks.
-- JSON bodies are original bounded UTF8 bytes, not MySQL JSON normalization.
CREATE TABLE bots (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  name_json VARCHAR(3074) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_bot_version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id),
  KEY ix_bot_current_version (space_id,id,current_bot_version_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bot_versions (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  number BIGINT NOT NULL,
  config_bytes MEDIUMBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id),
  UNIQUE KEY uq_bot_version_number (space_id,bot_id,number),
  KEY ix_bot_version_owner (space_id,bot_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bot_maintainers (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT NOT NULL,
  PRIMARY KEY (space_id,bot_id,principal_id),
  UNIQUE KEY uq_maintainer_ordinal (space_id,bot_id,ordinal),
  KEY ix_maintainer_principal (space_id,principal_id,bot_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE groups (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  name_json VARCHAR(3074) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  limits_bytes MEDIUMBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_members (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT NOT NULL,
  PRIMARY KEY (space_id,group_id,principal_id),
  UNIQUE KEY uq_member_ordinal (space_id,group_id,ordinal),
  KEY ix_member_principal (space_id,principal_id,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_bots (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bot_version_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  role VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ordinal INT NOT NULL,
  PRIMARY KEY (space_id,group_id,bot_id),
  UNIQUE KEY uq_group_bot_ordinal (space_id,group_id,ordinal),
  KEY ix_group_bot_version (space_id,bot_id,bot_version_id,group_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE command_scope (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (space_id,principal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE command_receipts (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  fingerprint BINARY(32) NOT NULL,
  http_status SMALLINT NOT NULL,
  body_bytes MEDIUMBLOB NOT NULL,
  created_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,principal_id,command_id),
  KEY ix_receipt_target (space_id,target_type,target_id),
  KEY ix_receipt_expiry (space_id,expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mutation_outbox (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_type VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_version BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id),
  UNIQUE KEY uq_outbox_command (space_id,principal_id,command_id),
  KEY ix_outbox_target (space_id,target_type,target_id,target_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
