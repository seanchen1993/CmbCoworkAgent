import test from "node:test"
import assert from "node:assert/strict"
import { metadata, markerMatches, validateTestMetadata, cleanupTestDatabase, containerPolicy, readAppSecret, active } from "../../../deploy/dev/service/test-database.mjs"
import { composeSpec, IMAGE_ID } from "../../../deploy/dev/docker/compose.mjs"
import { privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"
import { writeFile, chmod, unlink, symlink, link, rename } from "node:fs/promises"
import { join } from "node:path"

function stat(extra = {}) { return { uid: process.getuid(), mode: 0o600, nlink: 1, isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, ...extra } }
test("B1 checks private metadata before content (mode/uid/link/type/nlink)", () => {
  metadata(stat(), 0o600)
  for (const bad of [{ uid: process.getuid() + 1 }, { mode: 0o644 }, { nlink: 2 }, { isSymbolicLink: () => true }, { isFile: () => false }]) {
    assert.throws(() => metadata(stat(bad), 0o600), /B1_PRIVATE_METADATA/)
  }
})

test("B1 actual private app files reject missing/mode/symlink/hardlink/content before secret leaves", async () => {
  const dir = await privateTemp(), password = "a".repeat(64)
  const app = join(dir, "app-password"), client = join(dir, "app-client.cnf")
  const reset = async () => { await writeFile(app, password + "\n", { mode: 0o600 }); await writeFile(client, `[client]\nuser=devclaw_app\npassword=${password}\n\n`, { mode: 0o600 }) }
  try {
    await reset(); assert.equal(await readAppSecret(dir), password)
    await chmod(app, 0o644); await assert.rejects(readAppSecret(dir), /PRIVATE_/); await chmod(app, 0o600)
    await rename(app, join(dir, "retained")); await assert.rejects(readAppSecret(dir)); await rename(join(dir, "retained"), app)
    await unlink(app); await symlink(client, app); await assert.rejects(readAppSecret(dir), /PRIVATE_/); await unlink(app); await reset()
    await link(app, join(dir, "extra-link")); await assert.rejects(readAppSecret(dir), /PRIVATE_/); await unlink(join(dir, "extra-link"))
    await writeFile(app, "SENTINEL_SECRET\n"); await assert.rejects(readAppSecret(dir), /B1_SECRET/); await reset()
    await writeFile(client, "SENTINEL_SECRET\n"); await assert.rejects(readAppSecret(dir), /B1_SECRET/)
  } finally { await removePrivateTemp(dir) }
})
test("B1 cancellation guard refuses already-aborted work", () => {
  const controller = new AbortController(); controller.abort()
  assert.throws(() => active(controller.signal), /B1_CANCELLED/)
})

function unstarted() {
  const entry = { project: "devclaw-bot-test-0000000000000000", owner: "00000000-0000-0000-0000-000000000000", role: "test", dir: "/private/test-only" }
  const spec = composeSpec(entry), expected = spec.services.mysql
  const mounts = expected.volumes.map(v => v.type === "volume" ? { Type: "volume", Source: `/var/lib/docker/volumes/${entry.project}-data/_data`, Destination: v.target, RW: true, Name: `${entry.project}-data` } : { Type: "bind", Source: v.source, Destination: v.target, RW: false })
  for (const v of expected.secrets) mounts.push({ Type: "bind", Source: spec.secrets[v.source].file, Destination: `/run/secrets/${v.target}`, RW: false })
  const data = { Image: IMAGE_ID, State: { Running: false }, Config: { User: "", Cmd: expected.command, Env: Object.entries(expected.environment).map(([k, v]) => `${k}=${v}`), Healthcheck: { Test: expected.healthcheck.test }, Labels: { ...expected.labels, "com.docker.compose.project": entry.project, "com.docker.compose.service": "mysql" } },
    HostConfig: { Privileged: false, NetworkMode: `${entry.project}-private`, Memory: 768 * 1048576, MemorySwap: 768 * 1048576, NanoCpus: 1000000000, PidsLimit: 128, LogConfig: { Type: "json-file", Config: expected.logging.options }, SecurityOpt: ["no-new-privileges:true"], CapDrop: ["NET_RAW"], CapAdd: [], PortBindings: { "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] } },
    Mounts: mounts, NetworkSettings: { Ports: { "3306/tcp": null, "33060/tcp": null }, Networks: {} } }
  return { entry, data }
}
test("B1 removal projection reports not-ready and cannot hide malicious ports/network/policy", () => {
  const { entry, data } = unstarted(), original = structuredClone(data)
  assert.equal(containerPolicy(data, entry), null)
  assert.deepEqual(data, original)
  assert.throws(() => containerPolicy(data, entry, true), /B00_LOOPBACK/)
  for (const corrupt of [
    d => { d.NetworkSettings.Ports["8080/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    d => { d.NetworkSettings.Ports["3306/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "32879" }] },
    d => { d.NetworkSettings.Networks = { foreign: {} } },
    d => { d.HostConfig.Privileged = true },
    d => { d.HostConfig.PortBindings["8080/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "8080" }] },
    d => { d.Mounts[1].RW = true },
    d => { d.Config.Labels["com.devclaw.b00.owner"] = "foreign" }
  ]) {
    const bad = structuredClone(data); corrupt(bad)
    assert.throws(() => containerPolicy(bad, entry), /B[01]0?_[A-Z_]+/)
  }
})
test("B1 rejects unknown ownership and never adopts dev or forged test entries", async () => {
  const entry = { project: "devclaw-bot-test-0000000000000000", owner: "owner" }
  markerMatches({ project: entry.project, role: "test", owner: "owner" }, entry)
  for (const bad of [{ project: entry.project, role: "dev", owner: "owner" }, { project: entry.project, role: "test", owner: "other" }, { project: entry.project, role: "test", owner: "owner", arbitrary: true }]) {
    assert.throws(() => markerMatches(bad, entry), /B1_OWNER/)
  }
  for (const forged of [{ project: "devclaw-bot-dev" }, entry, null]) {
    await assert.rejects(validateTestMetadata(forged), /B1_UNREGISTERED/)
    await assert.rejects(cleanupTestDatabase(forged), /B1_UNREGISTERED/)
  }
})
