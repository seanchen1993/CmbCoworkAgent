import { randomBytes, randomUUID } from "node:crypto"
import { join } from "node:path"
import { constants } from "node:fs"
import { lstat, mkdir, writeFile, open, rm } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { hostState, daemon, docker, privateDirectory, RUNTIME } from "../docker/host.mjs"
import { composeSpec, LABEL } from "../docker/compose.mjs"
import { image, validateContainer, validateNetwork, verifyListeners } from "../docker/lifecycle.mjs"
import { B1_TEST_INIT_SQL } from "./test-database.mjs"

const TEMPLATE = "devclaw-bot-test-0000000000000000", check = value => { if (!value) throw Error("PARTNER_RESOURCE") }
export const PARTNER_PROJECT = "devclaw-bot-partner-dev"
export async function partnerPrivateFile(path, maximum = 65536) {
  const before = await lstat(path)
  check(before.isFile() && !before.isSymbolicLink() && before.uid === process.getuid() && before.nlink === 1 && (before.mode & 0o777) === 0o600 && before.size <= maximum)
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat(); check(stat.ino === before.ino && stat.dev === before.dev && stat.size === before.size)
    const bytes = Buffer.alloc(stat.size); check((await file.read(bytes, 0, bytes.length, 0)).bytesRead === bytes.length)
    check((await file.read(Buffer.alloc(1), 0, 1, bytes.length)).bytesRead === 0)
    const after = await lstat(path); check(after.ino === stat.ino && after.dev === stat.dev && after.size === stat.size && !after.isSymbolicLink() && after.nlink === 1 && (after.mode & 0o777) === 0o600)
    return bytes.toString("utf8")
  } finally { await file.close() }
}
export async function partnerWrite(path, value) {
  let existing
  try { existing = await lstat(path); check(existing.isFile() && !existing.isSymbolicLink() && existing.uid === process.getuid() && existing.nlink === 1 && (existing.mode & 0o777) === 0o600) } catch (error) { if (error.code !== "ENOENT") throw error }
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | (existing ? 0 : constants.O_EXCL), 0o600)
  try { const stat = await file.stat(); if (existing) { check(stat.ino === existing.ino && stat.dev === existing.dev); await file.truncate(0) }; await file.writeFile(value); await file.sync() } finally { await file.close() }
}
function labels(entry) { return { [`${LABEL}.owner`]: entry.owner, [`${LABEL}.project`]: entry.project, [`${LABEL}.role`]: entry.role, "com.devclaw.partner.nonce": entry.nonce } }
export function partnerCompose(entry) {
  const original = composeSpec({ project: TEMPLATE, owner: entry.owner, role: "test", dir: entry.dir }), actualLabels = labels(entry)
  return { name: entry.project, services: { mysql: { ...original.services.mysql, labels: actualLabels } },
    volumes: { data: { name: `${entry.project}-data`, labels: actualLabels } },
    networks: { private: { ...original.networks.private, name: `${entry.project}-private`, labels: actualLabels } },
    secrets: Object.fromEntries(["root-password", "app-password", "app-client"].map(key => [key, original.secrets[key]])) }
}
function ownership(data, entry, container = false) {
  const actual = container ? data.Config.Labels : data.Labels
  for (const [key, value] of Object.entries(labels(entry))) check(actual?.[key] === value)
  check(actual?.["com.docker.compose.project"] === entry.project)
}
export async function partnerEntry({ test = false, create = false, project = PARTNER_PROJECT } = {}) {
  check(test ? /^devclaw-bot-partner-test-[a-f0-9]{16}$/.test(project) : project === PARTNER_PROJECT)
  const state = await hostState(), identity = await daemon(state), dir = join(RUNTIME, project)
  let stat
  try { stat = await privateDirectory(dir) } catch (error) {
    if (error.code !== "ENOENT" || !create) throw error
    const occupied = await docker(state, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { stdoutOnly: true })
    const volumes = (await docker(state, ["volume", "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n"), networks = (await docker(state, ["network", "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n")
    check(!occupied && !volumes.includes(`${project}-data`) && !networks.includes(`${project}-private`))
    await mkdir(dir, { mode: 0o700 }); stat = await privateDirectory(dir)
    const entry = { project, role: test ? "partner-test" : "partner-dev", dir, owner: state.owner.id, nonce: randomUUID(), daemon: identity.id, inode: { ino: stat.ino, dev: stat.dev } }
    const app = randomBytes(32).toString("hex")
    for (const [name, bytes] of [["owner.json", JSON.stringify(entry) + "\n"], ["root-password", randomBytes(32).toString("hex") + "\n"], ["app-password", app + "\n"], ["app-client.cnf", `[client]\nuser=devclaw_app\npassword=${app}\n\n`], ["compose.json", JSON.stringify(partnerCompose(entry), null, 2) + "\n"]]) await writeFile(join(dir, name), bytes, { mode: 0o600, flag: "wx" })
    await writeFile(join(dir, "initialize.sql"), B1_TEST_INIT_SQL, { mode: 0o644, flag: "wx" })
  }
  const entry = JSON.parse(await partnerPrivateFile(join(dir, "owner.json")))
  check(isDeepStrictEqual(Object.keys(entry).sort(), ["project", "role", "dir", "owner", "nonce", "daemon", "inode"].sort()) && entry.project === project && entry.dir === dir && entry.owner === state.owner.id && entry.daemon === identity.id && entry.role === (test ? "partner-test" : "partner-dev") && /^[a-f0-9-]{36}$/.test(entry.nonce) && entry.inode.ino === stat.ino && entry.inode.dev === stat.dev)
  for (const name of ["root-password", "app-password", "app-client.cnf", "compose.json"]) { const file = await lstat(join(dir, name)); check(file.isFile() && !file.isSymbolicLink() && file.uid === process.getuid() && file.nlink === 1 && (file.mode & 0o777) === 0o600) }
  check(await partnerPrivateFile(join(dir, "compose.json")) === JSON.stringify(partnerCompose(entry), null, 2) + "\n")
  const sql = await open(join(dir, "initialize.sql"), constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const file = await sql.stat(); check(file.isFile() && file.uid === process.getuid() && file.nlink === 1 && (file.mode & 0o777) === 0o644 && file.size === Buffer.byteLength(B1_TEST_INIT_SQL)); check(await sql.readFile("utf8") === B1_TEST_INIT_SQL) } finally { await sql.close() }
  return { ...entry, state }
}
// Actual partner labels/name/nonce/mounts are checked BEFORE a narrow projection
// of validated project-specific names into the unchanged B00 security validator.
export function partnerContainer(data, entry) {
  ownership(data, entry, true); check(data.Config.Labels["com.docker.compose.service"] === "mysql" && data.HostConfig.NetworkMode === `${entry.project}-private`)
  const projected = structuredClone(data)
  projected.Config.Labels = { ...projected.Config.Labels, [`${LABEL}.project`]: TEMPLATE, [`${LABEL}.role`]: "test", "com.docker.compose.project": TEMPLATE }
  projected.HostConfig.NetworkMode = `${TEMPLATE}-private`
  for (const mount of projected.Mounts) if (mount.Type === "volume") { check(mount.Name === `${entry.project}-data` && mount.Source === `/var/lib/docker/volumes/${entry.project}-data/_data`); mount.Name = `${TEMPLATE}-data`; mount.Source = `/var/lib/docker/volumes/${TEMPLATE}-data/_data` }
  const currentNetworks = Object.keys(projected.NetworkSettings.Networks)
  check(currentNetworks.length === 0 && !data.State.Running || currentNetworks.length === 1 && currentNetworks[0] === `${entry.project}-private`)
  projected.NetworkSettings.Networks = { [`${TEMPLATE}-private`]: currentNetworks.length ? projected.NetworkSettings.Networks[currentNetworks[0]] : {} }
  let port = null
  if (projected.NetworkSettings.Ports["3306/tcp"] == null) { check(!data.State.Running); projected.NetworkSettings.Ports["3306/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "65535" }] }
  else port = Number(projected.NetworkSettings.Ports["3306/tcp"][0]?.HostPort)
  validateContainer(projected, { project: TEMPLATE, owner: entry.owner, role: "test", dir: entry.dir }, "mysql")
  return port
}
export async function partnerResources(entry) {
  const actual = await partnerEntry({ test: entry.role === "partner-test", project: entry.project })
  for (const key of ["project", "role", "dir", "owner", "nonce", "daemon", "inode"]) check(isDeepStrictEqual(actual[key], entry[key]))
  const state = actual.state
  const ids = (await docker(state, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${entry.project}`], { stdoutOnly: true })).split(/\s+/).filter(Boolean)
  check(ids.length <= 1); const containers = ids.length ? JSON.parse(await docker(state, ["inspect", ...ids], { stdoutOnly: true })) : []
  let port = null; for (const container of containers) port = partnerContainer(container, entry)
  let network = null, volume = null
  for (const [type, suffix] of [["network", "private"], ["volume", "data"]]) {
    const names = (await docker(state, [type, "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n")
    if (!names.includes(`${entry.project}-${suffix}`)) continue
    const value = JSON.parse(await docker(state, [type, "inspect", `${entry.project}-${suffix}`], { stdoutOnly: true }))[0]; ownership(value, entry)
    if (type === "network") { validateNetwork(value, entry, containers); network = value } else { check(value.Name === `${entry.project}-data` && value.Driver === "local" && !Object.keys(value.Options ?? {}).length); volume = value }
  }
  return { containers, network, volume, port, state }
}
export async function partnerDatabaseStart(entry, signal) {
  const before = await partnerResources(entry); await image(before.state)
  await docker(before.state, ["compose", "--project-name", entry.project, "--file", join(entry.dir, "compose.json"), "up", "--detach", "--wait", "--wait-timeout", "150", "--no-build", "--pull", "never", "mysql"], { signal, timeoutMs: 170000, maxOutput: 262144 })
  const actual = await partnerResources(entry); check(actual.containers.length === 1 && actual.network && actual.volume && actual.containers[0].State.Health?.Status === "healthy" && actual.port)
  await verifyListeners(actual.port); return actual
}
export async function partnerAppPassword(entry) {
  await partnerResources(entry)
  const value = await partnerPrivateFile(join(entry.dir, "app-password")); check(/^[a-f0-9]{64}\n$/.test(value) && await partnerPrivateFile(join(entry.dir, "app-client.cnf")) === `[client]\nuser=devclaw_app\npassword=${value.trim()}\n\n`)
  await partnerResources(entry)
  return value.trim()
}
export async function partnerDatabaseStop(entry) {
  const actual = await partnerResources(entry)
  for (const container of actual.containers) if (container.State.Running) await docker(actual.state, ["stop", "--time", "3", container.Id], { timeoutMs: 20000 })
  const stopped = await partnerResources(entry); check(stopped.containers.every(container => !container.State.Running)); return stopped
}
export async function cleanupPartnerTest(entry) {
  check(entry.role === "partner-test" && /^devclaw-bot-partner-test-[a-f0-9]{16}$/.test(entry.project))
  const actual = await partnerResources(entry)
  for (const container of actual.containers) await docker(actual.state, ["rm", "--force", container.Id], { timeoutMs: 30000 })
  if (actual.network) await docker(actual.state, ["network", "rm", actual.network.Id], { timeoutMs: 15000 })
  if (actual.volume) await docker(actual.state, ["volume", "rm", `${entry.project}-data`], { timeoutMs: 15000 })
  const after = await partnerResources(entry); check(!after.containers.length && !after.network && !after.volume)
  await partnerEntry({ test: true, project: entry.project }); await rm(entry.dir, { recursive: true })
}
export function partnerTestProject() { return `devclaw-bot-partner-test-${randomBytes(8).toString("hex")}` }
