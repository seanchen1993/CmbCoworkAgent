import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { writeFile, readFile, lstat, rm } from "node:fs/promises"
import { RUNTIME, docker, daemon, privateDirectory, privateFile } from "./host.mjs"
import { composeSpec, INIT_SQL, IMAGE_ID, MYSQL_IMAGE, LABEL } from "./compose.mjs"

const ownedTests = new Map()

export async function prepareProject(state, { test = false, existing = false } = {}) {
  const project = test ? `devclaw-bot-test-${randomBytes(8).toString("hex")}` : "devclaw-bot-dev"
  const role = test ? "test" : "dev"
  const dir = join(RUNTIME, project)
  if (!existing) try {
    await privateDirectory(dir, true)
    await writeFile(join(dir, "owner.json"), JSON.stringify({ project, role, owner: state.owner.id }) + "\n", { mode: 0o600, flag: "wx" })
    const root = randomBytes(32).toString("hex"), app = randomBytes(32).toString("hex")
    for (const [name, value] of [["root-password", root], ["app-password", app], ["app-client.cnf", `[client]\nuser=devclaw_app\npassword=${app}\n`]]) {
      await writeFile(join(dir, name), value + "\n", { mode: 0o600, flag: "wx" })
    }
    await writeFile(join(dir, "secret-hashes.json"), JSON.stringify({ root: hash(root), app: hash(app) }) + "\n", { mode: 0o600, flag: "wx" })
    // Static SQL has no secrets. mysqld's uid must read the individually RO-mounted file.
    await writeFile(join(dir, "initialize.sql"), INIT_SQL, { mode: 0o644, flag: "wx" })
    await writeFile(join(dir, "compose.json"), JSON.stringify(composeSpec({ project, owner: state.owner.id, role, dir }), null, 2) + "\n", { mode: 0o600, flag: "wx" })
  } catch (error) { if (error.code !== "EEXIST" || test) throw error }
  const entry = { project, role, dir, owner: state.owner.id }
  const s = await privateDirectory(dir)
  entry.inode = { ino: s.ino, dev: s.dev }
  await validateProject(entry)
  if (test) ownedTests.set(project, entry)
  return entry
}

export async function validateProject(entry) {
  if (!entry || entry.dir !== join(RUNTIME, entry.project || "") || !/^devclaw-bot-(?:dev|test-[a-f0-9]{16})$/.test(entry.project) || (entry.role === "dev" ? entry.project !== "devclaw-bot-dev" : entry.role !== "test" || !entry.project.startsWith("devclaw-bot-test-"))) throw new Error("B00_DIRECTORY_OWNER")
  const s = await privateDirectory(entry.dir)
  if (entry.inode && (s.ino !== entry.inode.ino || s.dev !== entry.inode.dev)) throw new Error("B00_DIRECTORY_OWNER")
  const owner = JSON.parse(await privateFile(join(entry.dir, "owner.json")))
  if (JSON.stringify(owner) !== JSON.stringify({ project: entry.project, role: entry.role, owner: entry.owner })) throw new Error("B00_RESOURCE_OWNER")
  const root = (await privateFile(join(entry.dir, "root-password"))).trim()
  const app = (await privateFile(join(entry.dir, "app-password"))).trim()
  if (!/^[a-f0-9]{64}$/.test(root) || !/^[a-f0-9]{64}$/.test(app) || app === root) throw new Error("B00_SECRET")
  const expectedHashes = JSON.parse(await privateFile(join(entry.dir, "secret-hashes.json")))
  if (expectedHashes.root !== hash(root) || expectedHashes.app !== hash(app)) throw new Error("B00_SECRET_CONFIG")
  if (await privateFile(join(entry.dir, "app-client.cnf")) !== `[client]\nuser=devclaw_app\npassword=${app}\n\n`) throw new Error("B00_SECRET_CONFIG")
  const actual = JSON.parse(await privateFile(join(entry.dir, "compose.json")))
  if (JSON.stringify(actual) !== JSON.stringify(composeSpec({ project: entry.project, owner: entry.owner, role: entry.role, dir: entry.dir }))) throw new Error("B00_COMPOSE_CONFIG")
  const sqlStat = await lstat(join(entry.dir, "initialize.sql"))
  if (!sqlStat.isFile() || sqlStat.isSymbolicLink() || sqlStat.uid !== process.getuid() || sqlStat.nlink !== 1 || await readFile(join(entry.dir, "initialize.sql"), "utf8") !== INIT_SQL) throw new Error("B00_INIT_CONFIG")
}

function hash(value) { return createHash("sha256").update(value).digest("hex") }

export async function compose(state, entry, args, options = {}) {
  await validateProject(entry)
  return docker(state, ["compose", "--project-name", entry.project, "--file", join(entry.dir, "compose.json"), ...args], options)
}

export async function image(state, { pull = false } = {}) {
  await daemon(state)
  if (pull) await docker(state, ["pull", "--platform", "linux/amd64", MYSQL_IMAGE], { timeoutMs: 600000, maxOutput: 262144 })
  const data = JSON.parse(await docker(state, ["image", "inspect", MYSQL_IMAGE], { stdoutOnly: true }))[0]
  if (data.Id !== IMAGE_ID || data.Descriptor?.digest !== IMAGE_ID || !data.RepoDigests?.includes(`mysql@${IMAGE_ID}`) || data.Architecture !== "amd64" || data.Os !== "linux" || !data.Config.Env.some((v) => /^MYSQL_VERSION=5\.7\.44(?:-|$)/.test(v))) throw new Error("B00_IMAGE_VERSION")
  return { image: MYSQL_IMAGE, id: data.Id, architecture: data.Architecture }
}

function resourceOwner(data, entry, type) {
  const labels = type === "container" ? data.Config.Labels : data.Labels
  if (labels?.[`${LABEL}.owner`] !== entry.owner || labels?.[`${LABEL}.project`] !== entry.project || labels?.[`${LABEL}.role`] !== entry.role || labels?.["com.docker.compose.project"] !== entry.project) throw new Error("B00_RESOURCE_OWNER")
}

export async function resources(state, entry) {
  await validateProject(entry)
  const ids = (await docker(state, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${entry.project}`], { stdoutOnly: true })).split(/\s+/).filter(Boolean)
  if (ids.length > 1) throw new Error("B00_UNEXPECTED_CONTAINER")
  const result = { container: null, volume: null, network: null }
  if (ids.length) {
    result.container = JSON.parse(await docker(state, ["inspect", ids[0]], { stdoutOnly: true }))[0]
    resourceOwner(result.container, entry, "container")
    if (result.container.Config.Labels["com.docker.compose.service"] !== "mysql") throw new Error("B00_UNEXPECTED_CONTAINER")
  }
  // Exact names, plus both our labels and Compose ownership, are required before any mutation.
  for (const [type, name] of [["volume", `${entry.project}-data`], ["network", `${entry.project}-private`]]) {
    const listed = (await docker(state, [type, "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n")
    if (listed.includes(name)) {
      result[type] = JSON.parse(await docker(state, [type, "inspect", name], { stdoutOnly: true }))[0]
      resourceOwner(result[type], entry, type)
    }
  }
  return result
}

export function validateContainer(data, entry) {
  resourceOwner(data, entry, "container")
  const h = data.HostConfig
  if (data.Image !== IMAGE_ID || h.Privileged || h.NetworkMode === "host" || h.Memory !== 805306368 || h.MemorySwap !== 805306368 || h.NanoCpus !== 1000000000 || h.PidsLimit !== 128 || h.LogConfig.Type !== "json-file" || h.LogConfig.Config["max-size"] !== "5m" || h.LogConfig.Config["max-file"] !== "2") throw new Error("B00_CONTAINER_POLICY")
  if (!h.SecurityOpt.includes("no-new-privileges:true") || !h.CapDrop.includes("NET_RAW")) throw new Error("B00_CONTAINER_SECURITY")
  const expectedMounts = [
    { type: "volume", source: `/var/lib/docker/volumes/${entry.project}-data/_data`, destination: "/var/lib/mysql", rw: true },
    { type: "bind", source: join(entry.dir, "initialize.sql"), destination: "/docker-entrypoint-initdb.d/10-limited-account.sql", rw: false },
    { type: "bind", source: join(entry.dir, "root-password"), destination: "/run/secrets/root-password", rw: false },
    { type: "bind", source: join(entry.dir, "app-password"), destination: "/run/secrets/app-password", rw: false },
    { type: "bind", source: join(entry.dir, "app-client.cnf"), destination: "/run/secrets/app-client", rw: false }
  ]
  const normalize = (values) => JSON.stringify(values.sort((a, b) => a.destination.localeCompare(b.destination)))
  if (normalize(data.Mounts.map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW }))) !== normalize(expectedMounts)) throw new Error("B00_CONTAINER_MOUNT")
  if (!data.Mounts.some((m) => m.Type === "volume" && m.Name === `${entry.project}-data` && m.Destination === "/var/lib/mysql")) throw new Error("B00_CONTAINER_VOLUME")
  for (const [key, value] of Object.entries(data.NetworkSettings.Ports)) {
    if (key !== "3306/tcp" && value !== null) throw new Error("B00_LOOPBACK")
  }
  if (Object.keys(h.PortBindings).length !== 1 || !h.PortBindings["3306/tcp"] || h.PortBindings["3306/tcp"].length !== 1 || h.PortBindings["3306/tcp"][0].HostIp !== "127.0.0.1") throw new Error("B00_LOOPBACK")
  const ports = data.NetworkSettings.Ports["3306/tcp"]
  if (!ports || ports.length !== 1 || ports[0].HostIp !== "127.0.0.1") throw new Error("B00_LOOPBACK")
  const port = Number(ports[0].HostPort)
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || port === 3306) throw new Error("B00_LOOPBACK")
  if (Object.keys(data.NetworkSettings.Networks).length !== 1 || !data.NetworkSettings.Networks[`${entry.project}-private`]) throw new Error("B00_PRIVATE_NETWORK")
  return port
}

export async function start(state, entry, { signal, failAt } = {}) {
  await daemon(state)
  await image(state)
  await resources(state, entry)
  if (signal?.aborted) throw new Error("B00_CANCELLED")
  try {
    await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "120", "--no-build", "--pull", "never"], { timeoutMs: 140000, maxOutput: 262144, signal })
    if (failAt === "after-start") throw new Error("B00_INJECTED")
    const current = await resources(state, entry)
    if (!current.container || !current.volume || !current.network || current.network.Internal !== true || current.container.State.Health.Status !== "healthy") throw new Error("B00_READINESS")
    const port = validateContainer(current.container, entry)
    return { project: entry.project, container: current.container.Id, volume: `${entry.project}-data`, network: `${entry.project}-private`, port, host: "127.0.0.1", image: MYSQL_IMAGE, status: "healthy" }
  } catch (error) {
    // Even a timed-out Compose client may have created a container. Reconcile exact owned resources.
    await stop(state, entry)
    throw error
  }
}

export async function stop(state, entry) {
  await daemon(state)
  const current = await resources(state, entry)
  if (current.container) {
    await docker(state, ["stop", "--time", "15", current.container.Id], { timeoutMs: 30000 })
    const data = JSON.parse(await docker(state, ["inspect", current.container.Id], { stdoutOnly: true }))[0]
    resourceOwner(data, entry, "container")
    if (data.State.Running) throw new Error("B00_STOP_FAILED")
  }
  return { project: entry.project, status: "stopped", data: "preserved" }
}

export async function cleanupTest(state, entry) {
  if (entry.role !== "test") throw new Error("B00_TEST_ONLY")
  if (!entry.inode || ownedTests.get(entry.project) !== entry || entry.dir !== join(RUNTIME, entry.project)) throw new Error("B00_DIRECTORY_OWNER")
  await daemon(state)
  const current = await resources(state, entry)
  if (current.container) await docker(state, ["rm", "--force", current.container.Id], { timeoutMs: 30000 })
  if (current.network) await docker(state, ["network", "rm", `${entry.project}-private`])
  if (current.volume) await docker(state, ["volume", "rm", `${entry.project}-data`])
  const after = await resources(state, entry)
  if (after.container || after.network || after.volume) throw new Error("B00_CLEANUP_FAILED")
  await validateProject(entry)
  await rm(entry.dir, { recursive: true })
  try { await lstat(entry.dir); throw new Error("B00_CLEANUP_FAILED") } catch (error) { if (error.code !== "ENOENT") throw error }
  ownedTests.delete(entry.project)
  return { project: entry.project, container: "removed", network: "removed", volume: "removed", directory: "removed" }
}

export async function appSql(state, entry, sql) {
  const current = await resources(state, entry)
  if (!current.container) throw new Error("B00_CONTAINER_MISSING")
  return docker(state, ["exec", "-i", current.container.Id, "mysql", "--defaults-extra-file=/run/secrets/app-client", "--protocol=TCP", "--host=127.0.0.1", "--database=devclaw", "--batch", "--skip-column-names"], { input: sql, stdoutOnly: true })
}

export async function restart(state, entry) {
  await stop(state, entry)
  return start(state, entry)
}
