CREATE TABLE f05_probe (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  external_id VARCHAR(64) NOT NULL,
  body VARCHAR(128) NOT NULL,
  observed_at DATETIME(3) NOT NULL,
  version INT NOT NULL,
  UNIQUE KEY uq_f05_external (external_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
