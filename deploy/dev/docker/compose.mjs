import { join } from "node:path"

export const MYSQL_VERSION = "5.7.44"
export const MYSQL_DIGEST = "sha256:dab0a802b44617303694fb17d166501de279c3031ddeb28c56ecf7fcab5ef0da"
export const MYSQL_IMAGE = `docker.io/library/mysql:${MYSQL_VERSION}@${MYSQL_DIGEST}`
// Docker 29's containerd store reports the manifest as Id. The manifest pins
// its separate OCI config digest; do not confuse the two identities.
export const IMAGE_ID = MYSQL_DIGEST
export const MYSQL_CONFIG_ID = "sha256:5107333e08a87b836d48ff7528b1e84b9c86781cc9f1748bbc1b8c42a870d933"
export const LABEL = "com.devclaw.b00"
export const INIT_SQL = "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'devclaw_app'@'%';\nGRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON `devclaw`.* TO 'devclaw_app'@'%';\n"

export function composeSpec({ project, owner, role, dir }) {
  if (!/^devclaw-bot-(?:dev|test-[a-f0-9]{16})$/.test(project) || !["dev", "test"].includes(role) || !/^[a-f0-9-]{36}$/.test(owner)) throw new Error("B00_PROJECT")
  const labels = { [`${LABEL}.owner`]: owner, [`${LABEL}.project`]: project, [`${LABEL}.role`]: role }
  return {
    name: project,
    services: {
      mysql: {
        image: MYSQL_IMAGE, platform: "linux/amd64", pull_policy: "never",
        environment: { MYSQL_ROOT_PASSWORD_FILE: "/run/secrets/root-password", MYSQL_ROOT_HOST: "localhost", MYSQL_DATABASE: "devclaw", MYSQL_USER: "devclaw_app", MYSQL_PASSWORD_FILE: "/run/secrets/app-password", MYSQL_INITDB_SKIP_TZINFO: "1", TZ: "UTC" },
        command: ["mysqld", "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci", "--default-time-zone=+00:00", "--transaction-isolation=READ-COMMITTED", "--skip-name-resolve", "--local-infile=0", "--skip-log-bin", "--max-connections=24", "--innodb-buffer-pool-size=128M"],
        secrets: [{ source: "root-password", target: "root-password" }, { source: "app-password", target: "app-password" }, { source: "app-client", target: "app-client" }],
        volumes: [{ type: "volume", source: "data", target: "/var/lib/mysql" }, { type: "bind", source: join(dir, "initialize.sql"), target: "/docker-entrypoint-initdb.d/10-limited-account.sql", read_only: true, bind: { create_host_path: false } }],
        ports: [{ target: 3306, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }],
        networks: ["private"], labels,
        mem_limit: "768m", memswap_limit: "768m", cpus: 1, pids_limit: 128,
        cap_drop: ["NET_RAW"], security_opt: ["no-new-privileges:true"],
        healthcheck: { test: ["CMD", "mysql", "--defaults-extra-file=/run/secrets/app-client", "--protocol=TCP", "--host=127.0.0.1", "--database=devclaw", "--execute=SELECT 1"], interval: "2s", timeout: "3s", retries: 45, start_period: "10s" },
        logging: { driver: "json-file", options: { "max-size": "5m", "max-file": "2" } },
        restart: "no", stop_grace_period: "15s"
      }
    },
    volumes: { data: { name: `${project}-data`, labels } },
    networks: { private: { name: `${project}-private`, internal: true, labels } },
    secrets: { "root-password": { file: join(dir, "root-password") }, "app-password": { file: join(dir, "app-password") }, "app-client": { file: join(dir, "app-client.cnf") } }
  }
}
