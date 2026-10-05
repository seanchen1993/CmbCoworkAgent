import { join } from "node:path"
import { randomBytes, createHash } from "node:crypto"
import { writeFile, readFile, lstat, rm } from "node:fs/promises"
import { isDeepStrictEqual } from "node:util"
import { run } from "../process.mjs"
import { RUNTIME, docker, daemon, privateDirectory, privateFile } from "./host.mjs"
import { composeSpec, INIT_SQL, S3_START, IMAGE_ID, MYSQL_IMAGE, LABEL } from "./compose.mjs"
import { SERVICE_IMAGES, serviceImage } from "./service-images.mjs"
import { serviceReadiness } from "./readiness.mjs"

const ownedTests = new Map()

export async function prepareProject(state, { test = false, existing = false } = {}) {
  const project = test ? `devclaw-bot-test-${randomBytes(8).toString("hex")}` : "devclaw-bot-dev"
  const role = test ? "test" : "dev"
  const dir = join(RUNTIME, project)
  if (!existing) try {
    await privateDirectory(dir, true)
    await writeFile(join(dir, "owner.json"), JSON.stringify({ project, role, owner: state.owner.id }) + "\n", { mode: 0o600, flag: "wx" })
    const root = randomBytes(32).toString("hex"), app = randomBytes(32).toString("hex"), es = randomBytes(32).toString("hex")
    const s3 = { accessKey: randomBytes(16).toString("hex"), secretKey: randomBytes(32).toString("hex") }
    for (const [name, value] of [["root-password", root], ["app-password", app], ["app-client.cnf", `[client]\nuser=devclaw_app\npassword=${app}\n`], ["es-password", es], ["es-client.cnf", `user = "elastic:${es}"\n`], ["s3-client.json", JSON.stringify(s3)], ["s3-config.json", JSON.stringify(s3Config(s3))]]) {
      await writeFile(join(dir, name), value + "\n", { mode: 0o600, flag: "wx" })
    }
    await writeFile(join(dir, "secret-hashes.json"), JSON.stringify({ root: hash(root), app: hash(app), es: hash(es), s3: hash(JSON.stringify(s3)) }) + "\n", { mode: 0o600, flag: "wx" })
    // Static SQL has no secrets. mysqld's uid must read the individually RO-mounted file.
    await writeFile(join(dir, "initialize.sql"), INIT_SQL, { mode: 0o644, flag: "wx" })
    await writeFile(join(dir, "s3-start.sh"), S3_START, { mode: 0o644, flag: "wx" })
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
  const es = (await privateFile(join(entry.dir, "es-password"))).trim()
  const s3 = JSON.parse(await privateFile(join(entry.dir, "s3-client.json")))
  if (![root, app, es, s3.secretKey].every((v) => /^[a-f0-9]{64}$/.test(v)) || new Set([root, app, es, s3.secretKey]).size !== 4 || !/^[a-f0-9]{32}$/.test(s3.accessKey)) throw new Error("B00_SECRET")
  const expectedHashes = JSON.parse(await privateFile(join(entry.dir, "secret-hashes.json")))
  if (!isDeepStrictEqual(expectedHashes, { root: hash(root), app: hash(app), es: hash(es), s3: hash(JSON.stringify(s3)) })) throw new Error("B00_SECRET_CONFIG")
  if (await privateFile(join(entry.dir, "app-client.cnf")) !== `[client]\nuser=devclaw_app\npassword=${app}\n\n`) throw new Error("B00_SECRET_CONFIG")
  if (await privateFile(join(entry.dir, "es-client.cnf")) !== `user = "elastic:${es}"\n\n` || await privateFile(join(entry.dir, "s3-config.json")) !== JSON.stringify(s3Config(s3)) + "\n") throw new Error("B00_SECRET_CONFIG")
  const actual = JSON.parse(await privateFile(join(entry.dir, "compose.json")))
  if (JSON.stringify(actual) !== JSON.stringify(composeSpec({ project: entry.project, owner: entry.owner, role: entry.role, dir: entry.dir }))) throw new Error("B00_COMPOSE_CONFIG")
  for (const [name, expected] of [["initialize.sql", INIT_SQL], ["s3-start.sh", S3_START]]) {
    const stat = await lstat(join(entry.dir, name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o644 || await readFile(join(entry.dir, name), "utf8") !== expected) throw new Error("B00_INIT_CONFIG")
  }
}

function hash(value) { return createHash("sha256").update(value).digest("hex") }
function s3Config(credentials) { return { identities: [{ name: "devclaw-local", credentials: [credentials], actions: ["Admin", "Read", "Write", "List", "Tagging"] }] } }

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

export async function resources(state, entry, { signal, deadline } = {}) {
  await validateProject(entry)
  const inspect = args => {
    if (signal?.aborted) throw new Error("B00_CANCELLED")
    const timeoutMs = deadline === undefined ? 15000 : Math.min(15000, deadline - Date.now())
    if (timeoutMs <= 0) throw new Error("B00_RESOURCE_TIMEOUT")
    return docker(state, args, { stdoutOnly: true, signal, timeoutMs })
  }
  const ids = (await inspect(["ps", "-aq", "--filter", `label=com.docker.compose.project=${entry.project}`])).split(/\s+/).filter(Boolean)
  if (ids.length > 3) throw new Error("B00_UNEXPECTED_CONTAINER")
  const result = { containers: {}, volumes: {}, container: null, volume: null, network: null }
  if (ids.length) for (const container of JSON.parse(await inspect(["inspect", ...ids]))) {
    resourceOwner(container, entry, "container")
    const service = container.Config.Labels["com.docker.compose.service"]
    if (!["mysql", "es", "s3"].includes(service) || result.containers[service]) throw new Error("B00_UNEXPECTED_CONTAINER")
    result.containers[service] = container
  }
  // Exact names, plus both our labels and Compose ownership, are required before any mutation.
  for (const [type, suffix] of [["volume", "data"], ["volume", "es-data"], ["volume", "s3-data"], ["network", "private"]]) {
    const name = `${entry.project}-${suffix}`
    const listed = (await inspect([type, "ls", "--format", "{{.Name}}"])) .split("\n")
    if (listed.includes(name)) {
      const resource = JSON.parse(await inspect([type, "inspect", name]))[0]
      resourceOwner(resource, entry, type)
      if (type === "network") { validateNetwork(resource, entry, Object.values(result.containers)); result.network = resource }
      else result.volumes[suffix] = resource
    }
  }
  return { ...result, container: result.containers.mysql ?? null, volume: result.volumes.data ?? null }
}

export function validateNetwork(data, entry, containers) {
  resourceOwner(data, entry, "network")
  if (data.Name !== `${entry.project}-private` || data.Driver !== "bridge" || data.Internal !== false || data.EnableIPv6 !== false || !isDeepStrictEqual(data.Options, { "com.docker.network.bridge.host_binding_ipv4": "127.0.0.1" })) throw new Error("B00_NETWORK_POLICY")
  if (containers && !isDeepStrictEqual(Object.keys(data.Containers ?? {}).sort(), containers.filter(c => c.State.Running).map(c => c.Id).sort())) throw new Error("B00_NETWORK_MEMBERS")
}

export function validateContainer(data, entry, service = "mysql") {
  resourceOwner(data, entry, "container")
  const all = composeSpec({ project: entry.project, owner: entry.owner, role: entry.role, dir: entry.dir })
  const expected = all.services[service]
  if (!expected || data.Config.Labels["com.docker.compose.service"] !== service) throw new Error("B00_UNEXPECTED_CONTAINER")
  const h = data.HostConfig
  const id = service === "mysql" ? IMAGE_ID : SERVICE_IMAGES[service].digest
  const memory = Number.parseInt(expected.mem_limit) * 1048576
  if (data.Image !== id || h.Privileged || h.NetworkMode !== `${entry.project}-private` || h.Memory !== memory || h.MemorySwap !== memory || h.NanoCpus !== expected.cpus * 1000000000 || h.PidsLimit !== expected.pids_limit || h.LogConfig.Type !== "json-file" || !isDeepStrictEqual(h.LogConfig.Config, expected.logging.options)) throw new Error("B00_CONTAINER_POLICY")
  if (!isDeepStrictEqual(h.SecurityOpt, ["no-new-privileges:true"]) || !isDeepStrictEqual(h.CapDrop.map((value) => value.replace(/^CAP_/, "")), ["NET_RAW"]) || h.CapAdd?.length) throw new Error("B00_CONTAINER_SECURITY")
  if (data.Config.User !== (expected.user ?? "") || (expected.command && !isDeepStrictEqual(data.Config.Cmd, expected.command)) || (expected.entrypoint && !isDeepStrictEqual(data.Config.Entrypoint, expected.entrypoint)) || !isDeepStrictEqual(data.Config.Healthcheck?.Test, expected.healthcheck.test)) throw new Error("B00_CONTAINER_CONFIG")
  const env = Object.fromEntries(data.Config.Env.map((v) => { const i = v.indexOf("="); return [v.slice(0, i), v.slice(i + 1)] }))
  if (Object.entries(expected.environment).some(([k, v]) => env[k] !== v) || ["MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD", "ELASTIC_PASSWORD", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"].some((key) => env[key] !== undefined)) throw new Error("B00_CONTAINER_CONFIG")
  const expectedMounts = expected.volumes.map((v) => v.type === "volume" ? { type: "volume", source: `/var/lib/docker/volumes/${all.volumes[v.source].name}/_data`, destination: v.target, rw: true } : { type: "bind", source: v.source, destination: v.target, rw: !v.read_only })
  for (const secret of expected.secrets) expectedMounts.push({ type: "bind", source: all.secrets[secret.source].file, destination: `/run/secrets/${secret.target}`, rw: false })
  const normalize = (values) => JSON.stringify(values.sort((a, b) => a.destination.localeCompare(b.destination)))
  if (normalize(data.Mounts.map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW }))) !== normalize(expectedMounts)) throw new Error("B00_CONTAINER_MOUNT")
  for (const v of expected.volumes.filter((v) => v.type === "volume")) if (!data.Mounts.some((m) => m.Type === "volume" && m.Name === all.volumes[v.source].name && m.Destination === v.target)) throw new Error("B00_CONTAINER_VOLUME")
  const portKey = `${expected.ports[0].target}/tcp`
  for (const [key, value] of Object.entries(data.NetworkSettings.Ports)) {
    if (key !== portKey && value !== null) throw new Error("B00_LOOPBACK")
  }
  if (Object.keys(h.PortBindings).length !== 1 || !h.PortBindings[portKey] || h.PortBindings[portKey].length !== 1 || h.PortBindings[portKey][0].HostIp !== "127.0.0.1") throw new Error("B00_LOOPBACK")
  const ports = data.NetworkSettings.Ports[portKey]
  if (!ports || ports.length !== 1 || ports[0].HostIp !== "127.0.0.1") throw new Error("B00_LOOPBACK")
  const port = Number(ports[0].HostPort)
  if (!Number.isInteger(port) || port <= 1024 || port > 65535 || [3306, 9200, 9300, 8333, 9333, 8888].includes(port)) throw new Error("B00_LOOPBACK")
  if (Object.keys(data.NetworkSettings.Networks).length !== 1 || !data.NetworkSettings.Networks[`${entry.project}-private`]) throw new Error("B00_PRIVATE_NETWORK")
  return port
}

export async function start(state, entry, { signal, failAt } = {}) {
  await daemon(state)
  await image(state)
  await serviceImage(state, "es")
  await serviceImage(state, "s3")
  await resources(state, entry)
  if (signal?.aborted) throw new Error("B00_CANCELLED")
  try {
    await compose(state, entry, ["up", "--detach", "--wait", "--wait-timeout", "180", "--no-build", "--pull", "never"], { timeoutMs: 200000, maxOutput: 262144, signal })
    if (failAt === "after-start") throw new Error("B00_INJECTED")
    const current = await resources(state, entry)
    if (Object.keys(current.containers).length !== 3 || Object.keys(current.volumes).length !== 3 || !current.network) throw new Error("B00_READINESS")
    const ports = {}, containers = {}
    for (const [service, container] of Object.entries(current.containers)) {
      if (container.State.Health?.Status !== "healthy") throw new Error("B00_READINESS")
      ports[service] = validateContainer(container, entry, service)
      await verifyListeners(ports[service])
      containers[service] = container.Id
    }
    const readiness = await serviceReadiness(state, entry, ports, signal)
    return { project: entry.project, containers, volumes: Object.keys(current.volumes).map((suffix) => `${entry.project}-${suffix}`), network: `${entry.project}-private`, ports, port: ports.mysql, host: "127.0.0.1", image: MYSQL_IMAGE, status: "healthy", readiness }
  } catch (error) {
    // Even a timed-out Compose client may have created a container. Reconcile exact owned resources.
    return finishFailedStart(error, async () => {
      const current = await resources(state, entry), diagnostics = []
      for (const [service, container] of Object.entries(current.containers)) {
        const text = await docker(state, ["logs", "--tail", "40", container.Id], { timeoutMs: 10000, maxOutput: 65536 })
        // Raw logs stay in memory only. Fixed classifications never copy messages.
        diagnostics.push(classifyStartup(service, container, text))
      }
      return diagnostics
    }, () => stop(state, entry))
  }
}

export async function finishFailedStart(error, readDiagnostics, stopOwned) {
  try { error.diagnostics = await readDiagnostics() } catch { error.diagnosticsUnavailable = true }
  // Diagnostics are best-effort. Always attempt owner-checked stopping, retain
  // the original controlled failure and separately mark a cleanup failure.
  try { await stopOwned() } catch { error.stopFailed = true }
  throw error
}

export function classifyStartup(service, container, text) {
  const permissionLines = text.split("\n").filter((line) => /permission denied|AccessDeniedException|not writable/i.test(line))
  const permissionPaths = ["/data/state", "/data", "/data/filerldb2", "./filerldb2", "/run/secrets/s3-config", "/usr/share/elasticsearch/data", "/usr/share/elasticsearch/config"].filter((path) => permissionLines.some((line) => line.includes(path)))
  return { service, status: container.State.Status, exit: container.State.ExitCode, health: container.State.Health?.Status ?? null, permission: permissionLines.length > 0, permissionPaths, preflight: text.includes("B00_S3_PREFLIGHT_OK"), secretUnreadable: text.includes("B00_S3_SECRET_UNREADABLE"), dataUnwritable: text.includes("B00_S3_DATA_UNWRITABLE"), filerMetadata: /(?:filerldb|filer store|filer.*leveldb)/i.test(text), workingDir: ["", "/", "/data", "/data/state"].includes(container.Config.WorkingDir) ? container.Config.WorkingDir : "other", unknownFlag: /flag provided but not defined/i.test(text), rootRejected: /can not run elasticsearch as root|cannot run elasticsearch as root/i.test(text), configRead: /error.*(?:read|load).*config/i.test(text) }
}

export async function stop(state, entry) {
  await daemon(state)
  const current = await resources(state, entry)
  for (const container of Object.values(current.containers)) {
    await docker(state, ["stop", "--time", "15", container.Id], { timeoutMs: 30000 })
    const data = JSON.parse(await docker(state, ["inspect", container.Id], { stdoutOnly: true }))[0]
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
  for (const container of Object.values(current.containers)) await docker(state, ["rm", "--force", container.Id], { timeoutMs: 30000 })
  if (current.network) await docker(state, ["network", "rm", `${entry.project}-private`])
  for (const suffix of Object.keys(current.volumes)) await docker(state, ["volume", "rm", `${entry.project}-${suffix}`])
  const after = await resources(state, entry)
  if (Object.keys(after.containers).length || after.network || Object.keys(after.volumes).length) throw new Error("B00_CLEANUP_FAILED")
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

export async function restart(state, entry, { signal } = {}) {
  await stop(state, entry)
  if (signal?.aborted) throw new Error("B00_CANCELLED")
  return start(state, entry, { signal })
}

export async function verifyListeners(port) {
  for (let attempt = 0; attempt < 30; attempt++) {
    let output
    try { output = await run("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fn"], { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdoutOnly: true }) }
    catch (error) { if (error.failureCode !== "exit" || error.exitCode !== 1) throw error }
    const addresses = (output ?? "").split("\n").filter((line) => line.startsWith("n"))
    if (addresses.some((line) => line !== `n127.0.0.1:${port}`)) throw new Error("B00_HOST_LISTENER")
    if (addresses.length) return { port, listeners: addresses.length, address: "127.0.0.1" }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error("B00_HOST_LISTENER")
}
