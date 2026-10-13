import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { mkdir, lstat, open, readFile, rm, unlink } from "node:fs/promises"
import { createHash, randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { run, ownedProcess, isolatedEnv } from "../process.mjs"
import { privateDirectory } from "../docker/host.mjs"
import { partnerEntry, partnerResources, partnerDatabaseStart, partnerDatabaseStop, partnerAppPassword, partnerPrivateFile, partnerWrite, PARTNER_PROJECT } from "./partner-dev-resources.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url)), jdk = "/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home", java = join(jdk, "bin/java")
const check = value => { if (!value) throw Error("PARTNER_DEV") }, hash = bytes => createHash("sha256").update(bytes).digest("hex")
const cfgPath = entry => join(entry.dir, "partner.json"), processPath = entry => join(entry.dir, "process.json"), connectionPath = entry => join(entry.dir, "connection.json")
const token = () => randomBytes(32).toString("hex")
const stoppedProcesses = new WeakMap()
export function partnerBootstrapConfig() {
  const scope = { spaceId: "A", member: true, canCreateBot: true, canCreateGroup: true, knowledgeRefs: [], repositoryRefs: [], skillAllowlist: [], capabilityCeiling: ["requirements.analyze"] }
  return { identity: { principals: ["owner", "business"].map(principalId => ({ principalId, active: true, spaces: [{ ...scope }] })), bearers: ["owner", "business"].map(principalId => ({ principalId, token: token() })) },
    nodes: [{ spaceId: "A", nodeId: "node", ownerPrincipalId: "owner", credential: `dcn1_${token()}`, expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }],
    access: ["owner", "business"].map(principalId => ({ spaceId: "A", principalId, capabilities: ["requirements.analyze"], workspaceRefs: ["view"] })) }
}
async function config(entry) {
  await partnerResources(entry)
  try { await lstat(cfgPath(entry)) } catch (error) { if (error.code !== "ENOENT") throw error; await partnerWrite(cfgPath(entry), JSON.stringify(partnerBootstrapConfig()) + "\n") }
  const value = JSON.parse(await partnerPrivateFile(cfgPath(entry)))
  check(Object.keys(value).sort().join() === "access,identity,nodes")
  check(value.identity?.principals?.map(p => p.principalId).sort().join() === "business,owner" && value.identity?.bearers?.map(p => p.principalId).sort().join() === "business,owner" && value.nodes?.length === 1)
  const node = value.nodes[0]; check(node.spaceId === "A" && node.nodeId === "node" && node.ownerPrincipalId === "owner" && /^dcn1_[a-f0-9]{64}$/.test(node.credential))
  for (const p of value.identity.bearers) check(/^[a-f0-9]{64}$/.test(p.token))
  check(value.access?.length === 2 && value.access.every(a => a.spaceId === "A" && ["owner", "business"].includes(a.principalId) && a.capabilities?.join() === "requirements.analyze" && a.workspaceRefs?.join() === "view"))
  return value
}
export async function partnerProcessInfo(pid, probes = {
  exists: value => process.kill(value, 0),
  read: value => run("/bin/ps", ["-ww", "-p", String(value), "-o", "lstart=,command="], { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, timeoutMs: 5000 })
}) {
  check(Number.isInteger(pid) && pid > 1)
  try { probes.exists(pid) } catch (error) { if (error.code === "ESRCH") return null; throw error }
  try {
    return await probes.read(pid)
  } catch (failure) {
    // The owned process can exit between kill(pid,0) and ps. Only confirmed
    // ESRCH is absence; a live/reused PID or diagnostic failure stays closed.
    try { probes.exists(pid) } catch (error) { if (error.code === "ESRCH") return null; throw error }
    throw failure
  }
}
const processInfo = pid => partnerProcessInfo(pid)
async function record(entry) {
  await partnerResources(entry)
  let value
  try { value = JSON.parse(await partnerPrivateFile(processPath(entry), 16384)) } catch (error) { if (error.code === "ENOENT") return null; throw error }
  check(Object.keys(value).sort().join() === ["kind", "project", "nonce", "pid", "port", "info", "runtime", "runtimeInode", "jarHash"].sort().join() && value.kind === "partner-process-v1" && value.project === entry.project && value.nonce === entry.nonce && /^[a-f0-9]{64}$/.test(value.jarHash))
  check(typeof value.runtime === "string" && value.runtime.startsWith(`${entry.dir}/server-`) && /^[a-f0-9]{16}$/.test(value.runtime.slice(`${entry.dir}/server-`.length)))
  const stat = await privateDirectory(value.runtime); check(stat.ino === value.runtimeInode.ino && stat.dev === value.runtimeInode.dev)
  const expected = `${java} -Xmx256m -Duser.timezone=UTC -Ddevclaw.partner.owner=${entry.nonce} -cp ${join(value.runtime, "BOOT-INF/classes")}:${join(value.runtime, "BOOT-INF/lib/*")} com.devclaw.botcontrol.http.PartnerHttpMain`
  check(typeof value.info === "string" && value.info.endsWith(expected) && (value.port === null || Number.isInteger(value.port) && value.port > 1024 && value.port <= 65535))
  const info = await processInfo(value.pid)
  if (info === null) return { ...value, alive: false }
  check(info === value.info)
  const ports = await listenerPorts(value.pid)
  if (value.port !== null) check(ports.length === 1 && ports[0] === value.port)
  else {
    const log = await partnerPrivateFile(join(entry.dir, "server.log"), 8192)
    if (log.includes("\n")) { const ready = JSON.parse(log.trim()); check(ready.stage === "partner-ready" && ports.length === 1 && ports[0] === ready.port); value.port = ready.port }
    else throw Error("PARTNER_STATE_UNKNOWN")
  }
  return { ...value, alive: true }
}
async function listenerPorts(pid) {
  const child = ownedProcess("/usr/sbin/lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fpn"], { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, maxOutput: 4096 })
  child.child.stdin.end(); const timer = setTimeout(() => { void child.stop() }, 5000)
  try {
    const value = await child.done
    if (value.code === 1 && !value.stdout && !value.stderr) return []
    check(value.code === 0 && !value.stderr && !value.overflow && !value.spawnError)
    const lines = value.stdout.trim().split("\n"), names = lines.filter(v => v.startsWith("n"))
    check(lines.filter(v => v.startsWith("p")).join() === `p${pid}` && names.every(v => /^n127\.0\.0\.1:[0-9]+$/.test(v)))
    return names.map(v => Number(v.slice(v.lastIndexOf(":") + 1)))
  } finally { clearTimeout(timer); await child.stop() }
}
function killOwned(value) {
  if (!stoppedProcesses.has(value)) stoppedProcesses.set(value, stopOwnedProcess(value))
  return stoppedProcesses.get(value)
}
async function stopOwnedProcess(value) {
  const info = await processInfo(value.pid), ports = info === null ? [] : await listenerPorts(value.pid)
  if (info !== null) {
    check(info === value.info); process.kill(value.pid, "SIGTERM")
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && await processInfo(value.pid) !== null) await new Promise(resolve => setTimeout(resolve, 50))
    const remaining = await processInfo(value.pid)
    if (remaining !== null) {
      check(remaining === value.info); process.kill(value.pid, "SIGKILL")
      const final = Date.now() + 3000
      while (Date.now() < final && await processInfo(value.pid) !== null) await new Promise(resolve => setTimeout(resolve, 50))
      check(await processInfo(value.pid) === null)
    }
  }
  for (const port of new Set([...ports, ...(value.port ? [value.port] : [])])) {
    const child = ownedProcess("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"], { env: { PATH: "/usr/bin:/bin", LANG: "C", TZ: "UTC" }, maxOutput: 4096 })
    child.child.stdin.end(); const timer = setTimeout(() => { void child.stop() }, 5000)
    try { const result = await child.done; check(result.code === 1 && !result.stdout && !result.stderr && !result.overflow && !result.spawnError) }
    finally { clearTimeout(timer); await child.stop() }
  }
}
async function runtime(entry) {
  await partnerResources(entry)
  const dir = join(entry.dir, `server-${randomBytes(8).toString("hex")}`); await mkdir(dir, { mode: 0o700 }); const stat = await privateDirectory(dir)
  const jar = join(root, "services/bot-control/target/bot-control-0.0.1-SNAPSHOT.jar"), before = hash(await readFile(jar)), env = isolatedEnv(dir, java)
  await run(join(jdk, "bin/jar"), ["xf", jar], { cwd: dir, env, timeoutMs: 15000 }); check(hash(await readFile(jar)) === before)
  return { dir, inode: { ino: stat.ino, dev: stat.dev }, java, env, classpath: `${join(dir, "BOOT-INF/classes")}:${join(dir, "BOOT-INF/lib/*")}`, jarHash: before }
}
async function removeRuntime(entry, value) {
  check(value.dir.startsWith(`${entry.dir}/server-`) && /^[a-f0-9]{16}$/.test(value.dir.slice(`${entry.dir}/server-`.length)))
  const stat = await privateDirectory(value.dir); check(stat.ino === value.inode.ino && stat.dev === value.inode.dev); await rm(value.dir, { recursive: true })
}
export async function partnerDevStatus(entry) {
  const actual = await partnerResources(entry), current = await record(entry)
  const database = actual.containers.length ? actual.containers[0].State.Running && actual.containers[0].State.Health?.Status === "healthy" ? "healthy" : "stopped" : "not-created"
  return { status: current?.alive ? database === "healthy" ? "running" : "degraded" : "stopped", project: entry.project, database, ...(current?.alive ? { pid: current.pid, port: current.port, connectionFile: connectionPath(entry) } : {}), data: "preserved" }
}
async function operation(entry, callback) {
  await partnerResources(entry)
  const path = join(entry.dir, "operation.lock"), bytes = JSON.stringify({ pid: process.pid, info: await processInfo(process.pid), nonce: entry.nonce }) + "\n"
  let file
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) } catch (error) {
    if (error.code !== "EEXIST") throw error
    const stale = JSON.parse(await partnerPrivateFile(path, 16384)); check(stale.nonce === entry.nonce && Number.isInteger(stale.pid) && typeof stale.info === "string")
    if (await processInfo(stale.pid) !== null) throw Error("PARTNER_BUSY")
    await unlink(path); file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  }
  const stat = await file.stat()
  try { await file.writeFile(bytes); await file.sync(); return await callback() }
  finally { await file.close(); const actual = await lstat(path); check(actual.ino === stat.ino && actual.dev === stat.dev && await partnerPrivateFile(path, 16384) === bytes); await unlink(path) }
}
export async function partnerDevStart(entry, signal) { return operation(entry, () => start(entry, signal)) }
async function start(entry, signal) {
  const existing = await record(entry)
  if (existing?.alive) { const status = await partnerDevStatus(entry); check(status.status === "running"); return status }
  let child, value, rt, sent = false
  const abort = () => { if (child && value) { void killOwned(value).catch(() => {}) } }
  signal?.addEventListener("abort", abort, { once: true })
  try {
    check(!signal?.aborted)
    const userConfig = await config(entry), db = await partnerDatabaseStart(entry, signal), password = await partnerAppPassword(entry)
    rt = await runtime(entry)
    const dbConfig = { mode: "local-dev", host: "127.0.0.1", port: db.port, schema: "devclaw", user: "devclaw_app", password }
    const migrate = JSON.parse(await run(rt.java, ["-Duser.timezone=UTC", "-cp", rt.classpath, "com.devclaw.botcontrol.persistence.DatabaseCommand", "migrate"], { cwd: rt.dir, env: rt.env, input: JSON.stringify(dbConfig), timeoutMs: 60000, signal }))
    check(migrate.status === "verified" && [0, 1, 6].includes(migrate.migrations))
    await partnerWrite(join(entry.dir, "server.log"), ""); await partnerWrite(join(entry.dir, "server-error.log"), "")
    const out = await open(join(entry.dir, "server.log"), constants.O_WRONLY | constants.O_NOFOLLOW), error = await open(join(entry.dir, "server-error.log"), constants.O_WRONLY | constants.O_NOFOLLOW)
    const args = ["-Xmx256m", "-Duser.timezone=UTC", `-Ddevclaw.partner.owner=${entry.nonce}`, "-cp", rt.classpath, "com.devclaw.botcontrol.http.PartnerHttpMain"]
    try { child = spawn(rt.java, args, { cwd: rt.dir, env: rt.env, detached: true, stdio: ["pipe", out.fd, error.fd], shell: false }); child.on("error", () => {}) } finally { await out.close(); await error.close() }
    child.stdin.on("error", () => {})
    const info = await processInfo(child.pid); check(info?.endsWith(`${rt.java} ${args.join(" ")}`))
    value = { kind: "partner-process-v1", project: entry.project, nonce: entry.nonce, pid: child.pid, port: null, info, runtime: rt.dir, runtimeInode: rt.inode, jarHash: rt.jarHash }
    await partnerWrite(processPath(entry), JSON.stringify(value) + "\n")
    check(!signal?.aborted)
    const input = JSON.stringify({ legacy: { mode: "local-dev", http: { host: "127.0.0.1", port: 0 }, db: dbConfig, identity: userConfig.identity }, nodes: userConfig.nodes, access: userConfig.access })
    check(Buffer.byteLength(input) <= 65536)
    await new Promise((resolve, reject) => child.stdin.end(input, error => error ? reject(error) : resolve())); sent = true
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      check(!signal?.aborted)
      check(await processInfo(value.pid) === value.info)
      const stderr = await partnerPrivateFile(join(entry.dir, "server-error.log"), 8192); check(!stderr)
      const log = await partnerPrivateFile(join(entry.dir, "server.log"), 8192)
      if (log.includes("\n")) {
        const ready = JSON.parse(log.trim()); check(ready.stage === "partner-ready" && Number.isInteger(ready.port) && ready.port > 1024 && ready.port <= 65535)
        const ports = await listenerPorts(value.pid); check(ports.length === 1 && ports[0] === ready.port); value.port = ready.port; break
      }
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    check(value.port)
    const bearer = principalId => userConfig.identity.bearers.find(p => p.principalId === principalId).token
    const descriptor = { version: 1, url: `http://127.0.0.1:${value.port}`, spaceId: "A", nodeId: "node", ownerPrincipalId: "owner", businessPrincipalId: "business", workspaceRef: "view", ownerToken: bearer("owner"), businessToken: bearer("business"), nodeToken: userConfig.nodes[0].credential }
    await partnerWrite(connectionPath(entry), JSON.stringify(descriptor) + "\n"); await partnerWrite(processPath(entry), JSON.stringify(value) + "\n")
    child.unref()
    return { status: "running", project: entry.project, pid: value.pid, port: value.port, connectionFile: connectionPath(entry), data: "preserved" }
  } catch (error) {
    if (value) await killOwned(value)
    else if (child?.pid) { child.kill("SIGTERM"); await new Promise(resolve => child.once("close", resolve)) }
    await partnerDatabaseStop(entry)
    if (rt && !sent) await removeRuntime(entry, rt)
    throw error
  } finally { signal?.removeEventListener("abort", abort) }
}
export async function partnerDevStop(entry) { return operation(entry, () => stop(entry)) }
async function stop(entry) {
  const current = await record(entry)
  if (current?.alive) await killOwned(current)
  await partnerDatabaseStop(entry)
  const status = await partnerDevStatus(entry); check(status.status === "stopped"); return status
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 240000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try {
    check(process.argv.length === 3 && ["start", "status", "stop"].includes(process.argv[2]))
    let entry
    try { entry = await partnerEntry({ create: process.argv[2] === "start" }) } catch (error) { if (error.code !== "ENOENT") throw error; console.log(JSON.stringify({ status: "not-created", project: PARTNER_PROJECT })); }
    if (entry) console.log(JSON.stringify(process.argv[2] === "start" ? await partnerDevStart(entry, controller.signal) : process.argv[2] === "stop" ? await partnerDevStop(entry) : await partnerDevStatus(entry)))
  } catch { console.log(JSON.stringify({ status: "failed", category: controller.signal.aborted ? "CANCELLED" : "PARTNER_DEV" })); process.exitCode = 1 }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
