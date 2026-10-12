-- Internal one-attempt text result; application transaction enforces association.
CREATE TABLE requirement_run_results (
  space_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  run_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_text MEDIUMTEXT NOT NULL,
  settled_at DATETIME(3) NOT NULL,
  PRIMARY KEY (space_id,run_id),
  UNIQUE KEY uq_requirement_result_attempt (space_id,attempt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
