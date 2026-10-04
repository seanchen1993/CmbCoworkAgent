import { join } from "node:path"
import { SERVICE_IMAGES } from "./service-images.mjs"

export const MYSQL_VERSION = "5.7.44"
export const MYSQL_DIGEST = "sha256:dab0a802b44617303694fb17d166501de279c3031ddeb28c56ecf7fcab5ef0da"
export const MYSQL_IMAGE = `docker.io/library/mysql:${MYSQL_VERSION}@${MYSQL_DIGEST}`
// Docker 29's containerd store reports the manifest as Id. The manifest pins
// its separate OCI config digest; do not confuse the two identities.
export const IMAGE_ID = MYSQL_DIGEST
export const MYSQL_CONFIG_ID = "sha256:5107333e08a87b836d48ff7528b1e84b9c86781cc9f1748bbc1b8c42a870d933"
export const LABEL = "com.devclaw.b00"
export const INIT_SQL = "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'devclaw_app'@'%';\nGRANT SELECT, INSERT, UPDATE, DELETE, CREATE, INDEX ON `devclaw`.* TO 'devclaw_app'@'%';\n"
export const S3_START = `#!/bin/sh
set -eu
case "$B00_UID" in ''|*[!0-9]*|0) exit 1;; esac
test ! -L /data/state
mkdir -p /data/state
chown "$B00_UID:$B00_UID" /data/state
exec su-exec "$B00_UID:$B00_UID" /usr/bin/weed "$@"
`

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
      },
      es: {
        image: SERVICE_IMAGES.es.reference, platform: "linux/arm64", pull_policy: "never", user: `${process.getuid()}:0`,
        environment: { "discovery.type": "single-node", "cluster.name": project, "node.name": "devclaw-es", "node.store.allow_mmap": "false", "network.host": "0.0.0.0", "transport.bind_host": "127.0.0.1", "xpack.security.enabled": "true", "xpack.security.autoconfiguration.enabled": "false", "xpack.security.enrollment.enabled": "false", "xpack.security.http.ssl.enabled": "false", "xpack.security.transport.ssl.enabled": "false", "xpack.license.self_generated.type": "basic", "xpack.ml.enabled": "false", "ingest.geoip.downloader.enabled": "false", ELASTIC_PASSWORD_FILE: "/run/secrets/es-password", ES_JAVA_OPTS: "-Xms512m -Xmx512m", TZ: "UTC" },
        secrets: [{ source: "es-password", target: "es-password" }, { source: "es-client", target: "es-client" }],
        volumes: [{ type: "volume", source: "es-data", target: "/usr/share/elasticsearch/data" }],
        ports: [{ target: 9200, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }],
        networks: ["private"], labels, mem_limit: "1280m", memswap_limit: "1280m", cpus: 1, pids_limit: 512,
        cap_drop: ["NET_RAW"], security_opt: ["no-new-privileges:true"],
        healthcheck: { test: ["CMD", "curl", "--config", "/run/secrets/es-client", "--fail", "--silent", "--max-time", "3", "http://127.0.0.1:9200/_cluster/health"], interval: "3s", timeout: "5s", retries: 40, start_period: "20s" },
        logging: { driver: "json-file", options: { "max-size": "5m", "max-file": "2" } }, restart: "no", stop_grace_period: "15s"
      },
      s3: {
        image: SERVICE_IMAGES.s3.reference, platform: "linux/arm64", pull_policy: "never", user: "0:0",
        entrypoint: ["/bin/sh", "/run/devclaw/s3-start.sh"],
        command: ["-logtostderr=true", "server", "-dir=/data/state", "-ip=127.0.0.1", "-ip.bind=127.0.0.1", "-s3", "-s3.ip.bind=0.0.0.0", "-s3.port=8333", "-s3.config=/run/secrets/s3-config", "-s3.iam=false", "-s3.port.iceberg=0", "-s3.port.lance=0", "-s3.autoCreateBucket=false", "-s3.allowDeleteBucketNotEmpty=false", "-master.telemetry=false", "-master.volumeSizeLimitMB=128", "-volume.max=4", "-volume.fileSizeLimitMB=16", "-filer.exposeDirectoryData=false"],
        environment: { B00_UID: String(process.getuid()), TZ: "UTC" },
        secrets: [{ source: "s3-config", target: "s3-config" }],
        volumes: [{ type: "volume", source: "s3-data", target: "/data" }, { type: "bind", source: join(dir, "s3-start.sh"), target: "/run/devclaw/s3-start.sh", read_only: true, bind: { create_host_path: false } }],
        ports: [{ target: 8333, published: "0", host_ip: "127.0.0.1", protocol: "tcp" }],
        networks: ["private"], labels, mem_limit: "512m", memswap_limit: "512m", cpus: 0.75, pids_limit: 128,
        cap_drop: ["NET_RAW"], security_opt: ["no-new-privileges:true"],
        healthcheck: { test: ["CMD", "wget", "--quiet", "--output-document=/dev/null", "http://127.0.0.1:9333/cluster/status"], interval: "3s", timeout: "3s", retries: 40, start_period: "10s" },
        logging: { driver: "json-file", options: { "max-size": "5m", "max-file": "2" } }, restart: "no", stop_grace_period: "15s"
      }
    },
    volumes: { data: { name: `${project}-data`, labels }, "es-data": { name: `${project}-es-data`, labels }, "s3-data": { name: `${project}-s3-data`, labels } },
    networks: { private: { name: `${project}-private`, driver: "bridge", internal: false, enable_ipv6: false, driver_opts: { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" }, labels } },
    secrets: { "root-password": { file: join(dir, "root-password") }, "app-password": { file: join(dir, "app-password") }, "app-client": { file: join(dir, "app-client.cnf") }, "es-password": { file: join(dir, "es-password") }, "es-client": { file: join(dir, "es-client.cnf") }, "s3-config": { file: join(dir, "s3-config.json") } }
  }
}
