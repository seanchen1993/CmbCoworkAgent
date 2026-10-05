// B1 test-only adapter. Never adopts dev/unknown entries or reads root secrets.
import { randomBytes } from "node:crypto"
import { join } from "node:path"
import { lstat, readFile, writeFile, rm } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { hostState, daemon, docker, privateDirectory, privateFile, RUNTIME } from "../docker/host.mjs"
import { composeSpec, INIT_SQL, LABEL } from "../docker/compose.mjs"
import { image, validateContainer, validateNetwork, verifyListeners } from "../docker/lifecycle.mjs"

const owned = new Map()
const fail = category => { throw new Error(`B1_${category}`) }
export function metadata(stat, mode, directory = false) {
  if (stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== mode ||
      (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) fail("PRIVATE_METADATA")
}
export function markerMatches(marker, entry) {
  if (!isDeepStrictEqual(marker, { project: entry.project, role: "test", owner: entry.owner })) fail("OWNER")
}
function registered(entry) {
  if (!entry || owned.get(entry.project) !== entry || entry.role !== "test" ||
      !/^devclaw-bot-test-[a-f0-9]{16}$/.test(entry.project) || entry.dir !== join(RUNTIME, entry.project)) fail("UNREGISTERED")
}
export async function validateTestMetadata(entry) {
  registered(entry)
  const stat = await privateDirectory(entry.dir)
  if (stat.ino !== entry.inode.ino || stat.dev !== entry.inode.dev) fail("DIRECTORY_OWNER")
  // Check ALL metadata before reading even the application credential.
  for (const name of ["owner.json", "compose.json", "root-password", "app-password", "app-client.cnf"]) metadata(await lstat(join(entry.dir, name)), 0o600)
  metadata(await lstat(join(entry.dir, "initialize.sql")), 0o644)
  markerMatches(JSON.parse(await privateFile(join(entry.dir, "owner.json"))), entry)
  const expected = JSON.stringify(composeSpec(entry), null, 2) + "\n"
  if (await privateFile(join(entry.dir, "compose.json")) !== expected ||
      await readFile(join(entry.dir, "initialize.sql"), "utf8") !== INIT_SQL) fail("CONFIGURATION")
}
export async function createTestDatabase() {
  const state = await hostState()
  const identity = await daemon(state)
  await image(state) // cached exact official digest; never pull
  const project = `devclaw-bot-test-${randomBytes(8).toString("hex")}`
  const dir = join(RUNTIME, project)
  const stat = await privateDirectory(dir, true)
  const entry = { project, role: "test", dir, owner: state.owner.id, inode: { ino: stat.ino, dev: stat.dev }, state, daemon: identity.id }
  owned.set(project, entry)
  try {
    const app = randomBytes(32).toString("hex")
    // New bootstrap root secret is written once and never read by this adapter.
    for (const [name, content] of [
      ["owner.json", JSON.stringify({ project, role: "test", owner: entry.owner }) + "\n"],
      ["root-password", randomBytes(32).toString("hex") + "\n"],
      ["app-password", app + "\n"],
      ["app-client.cnf", `[client]\nuser=devclaw_app\npassword=${app}\n\n`],
      ["compose.json", JSON.stringify(composeSpec(entry), null, 2) + "\n"]
    ]) await writeFile(join(dir, name), content, { mode: 0o600, flag: "wx" })
    await writeFile(join(dir, "initialize.sql"), INIT_SQL, { mode: 0o644, flag: "wx" })
    await validateTestMetadata(entry)
    return entry
  } catch (error) {
    // Only files in this newly registered inode. No Docker mutation occurred.
    const now = await privateDirectory(dir)
    if (now.ino === stat.ino && now.dev === stat.dev) { await rm(dir, { recursive: true }); owned.delete(project) }
    throw error
  }
}
function labels(data, entry, container = false) {
  const value = container ? data.Config.Labels : data.Labels
  if (value?.[`${LABEL}.owner`] !== entry.owner || value?.[`${LABEL}.project`] !== entry.project ||
      value?.[`${LABEL}.role`] !== "test" || value?.["com.docker.compose.project"] !== entry.project) fail("RESOURCE_OWNER")
}
export function containerPolicy(data, entry, ready = false) {
  if (ready) return validateContainer(data, entry, "mysql")
  // Readiness-independent removal: actual configuration/mounts/security are
  // still checked by B00. Only absent runtime port/network attachment may be
  // projected for its readiness-only assertions; present values are never hidden.
  const checked = structuredClone(data)
  const ports = checked.NetworkSettings.Ports ?? {}
  if (Object.entries(ports).some(([key, value]) => key !== "3306/tcp" && value !== null)) fail("LOOPBACK")
  if (ports["3306/tcp"] == null) {
    checked.NetworkSettings.Ports = { ...ports, "3306/tcp": [{ HostIp: "127.0.0.1", HostPort: "65535" }] }
  }
  const networks = checked.NetworkSettings.Networks ?? {}
  if (!Object.keys(networks).length) checked.NetworkSettings.Networks = { [`${entry.project}-private`]: {} }
  const port = validateContainer(checked, entry, "mysql")
  return ports["3306/tcp"] == null ? null : port
}
export async function testResources(entry, signal, ready = false) {
  await validateTestMetadata(entry)
  if ((await daemon(entry.state)).id !== entry.daemon) fail("DAEMON")
  const inspect = args => docker(entry.state, args, { stdoutOnly: true, timeoutMs: 15000, signal })
  const ids = (await inspect(["ps", "-aq", "--filter", `label=com.docker.compose.project=${entry.project}`])).split(/\s+/).filter(Boolean)
  if (ids.length > 1) fail("UNEXPECTED_RESOURCE")
  const containers = ids.length ? JSON.parse(await inspect(["inspect", ...ids])) : []
  let port = null
  for (const c of containers) {
    labels(c, entry, true)
    if (c.Name !== `/${entry.project}-mysql-1`) fail("UNEXPECTED_RESOURCE")
    port = containerPolicy(c, entry, ready)
    if (entry.container && c.Id !== entry.container) fail("RESOURCE_CHANGED")
  }
  let network = null, volume = null
  for (const type of ["network", "volume"]) {
    const names = (await inspect([type, "ls", "--format", "{{.Name}}"])) .split("\n")
    const suffixes = type === "network" ? ["private"] : ["data", "es-data", "s3-data"]
    for (const suffix of suffixes) if (names.includes(`${entry.project}-${suffix}`)) {
      if (suffix !== (type === "network" ? "private" : "data")) fail("UNEXPECTED_RESOURCE")
      const data = JSON.parse(await inspect([type, "inspect", `${entry.project}-${suffix}`]))[0]
      labels(data, entry)
      if (type === "network") { validateNetwork(data, entry, containers); network = data }
      else {
        if (data.Name !== `${entry.project}-data` || data.Driver !== "local" || Object.keys(data.Options ?? {}).length) fail("VOLUME_POLICY")
        volume = data
      }
    }
  }
  return { containers, port, network, volume }
}
export async function startTestDatabase(entry, signal) {
  await testResources(entry, signal)
  await docker(entry.state, ["compose", "--project-name", entry.project, "--file", join(entry.dir, "compose.json"), "up", "--detach", "--wait", "--wait-timeout", "150", "--no-build", "--pull", "never", "mysql"], { signal, timeoutMs: 170000, maxOutput: 262144 })
  const current = await testResources(entry, signal, true)
  if (current.containers.length !== 1 || !current.network || !current.volume || current.containers[0].State.Health?.Status !== "healthy") fail("READINESS")
  await verifyListeners(current.port)
  entry.container = current.containers[0].Id
  entry.port = current.port
  return { project: entry.project, container: entry.container, port: entry.port, daemon: entry.daemon }
}
export async function appPassword(entry) {
  const current = await testResources(entry, undefined, true)
  if (!entry.container || !entry.port || current.containers.length !== 1 || !current.containers[0].State.Running ||
      current.containers[0].State.Health?.Status !== "healthy" || current.port !== entry.port) fail("READINESS")
  await verifyListeners(current.port)
  const value = await privateFile(join(entry.dir, "app-password"))
  if (!/^[a-f0-9]{64}\n$/.test(value) || await privateFile(join(entry.dir, "app-client.cnf")) !== `[client]\nuser=devclaw_app\npassword=${value.trim()}\n\n`) fail("SECRET")
  return value.trim()
}
export async function cleanupTestDatabase(entry) {
  const current = await testResources(entry) // cancellation must not cancel cleanup
  for (const c of current.containers) await docker(entry.state, ["rm", "--force", c.Id], { timeoutMs: 30000 })
  if (current.network) await docker(entry.state, ["network", "rm", current.network.Id], { timeoutMs: 15000 })
  if (current.volume) await docker(entry.state, ["volume", "rm", `${entry.project}-data`], { timeoutMs: 15000 })
  const after = await testResources(entry)
  if (after.containers.length || after.network || after.volume) fail("CLEANUP")
  await validateTestMetadata(entry)
  await rm(entry.dir, { recursive: true })
  owned.delete(entry.project)
  try { await lstat(entry.dir); fail("CLEANUP") } catch (error) { if (error.code !== "ENOENT") throw error }
  return { project: entry.project, status: "removed", resources: "exact-test-only" }
}
