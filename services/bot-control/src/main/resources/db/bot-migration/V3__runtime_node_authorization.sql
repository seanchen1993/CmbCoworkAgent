-- Internal requirement eligibility only. No FK, credentials, Runs or leases.
CREATE TABLE desktop_runtime_nodes (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  supports_requirement TINYINT NOT NULL,
  capabilities_bytes MEDIUMBLOB NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE group_runtime_grants (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  group_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  node_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_principal_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version BIGINT NOT NULL,
  workspace_ref VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  enabled TINYINT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,group_id),
  UNIQUE KEY uq_group_runtime_grant_id (space_id,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
