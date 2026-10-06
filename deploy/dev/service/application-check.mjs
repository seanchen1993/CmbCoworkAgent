import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { lstat, readFile } from "node:fs/promises"
import { createTestDatabase, startTestDatabase, cleanupTestDatabase, active } from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase } from "./database-java.mjs"
import { applicationJava, startApplicationJava, stopApplicationChildren, applicationChildFacts } from "./application-java.mjs"
import { applicationResponses, stableMounts } from "./application-proof.mjs"
import { ownedProcess, isolatedEnv } from "../process.mjs"
import { hostState, daemon, docker, RUNTIME, privateDirectory, privateFile } from "../docker/host.mjs"
import { composeSpec, INIT_SQL } from "../docker/compose.mjs"
import { validateContainer, validateNetwork, verifyListeners } from "../docker/lifecycle.mjs"

const filename = fileURLToPath(import.meta.url), root = fileURLToPath(new URL("../../../", import.meta.url))
const check = value => { if (!value) throw Error("C1_ASSERTION") }
async function devProof() {
  const state = await hostState(), identity = await daemon(state)
  const entry = { project: "devclaw-bot-dev", role: "dev", owner: state.owner.id, dir: join(RUNTIME, "devclaw-bot-dev") }
  const dir = await privateDirectory(entry.dir)
  check(JSON.stringify(JSON.parse(await privateFile(join(entry.dir, "owner.json")))) === JSON.stringify({ project: entry.project, role: entry.role, owner: entry.owner }))
  check(await privateFile(join(entry.dir, "compose.json")) === JSON.stringify(composeSpec(entry), null, 2) + "\n")
  for (const name of ["root-password", "app-password", "app-client.cnf", "es-password", "es-client.cnf", "s3-client.json", "s3-config.json", "secret-hashes.json"]) {
    const s = await lstat(join(entry.dir, name)); check(s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid() && s.nlink === 1 && (s.mode & 0o777) === 0o600)
  }
  const init = await lstat(join(entry.dir, "initialize.sql")); check(init.isFile() && !init.isSymbolicLink() && init.uid === process.getuid() && (init.mode & 0o777) === 0o644 && await readFile(join(entry.dir, "initialize.sql"), "utf8") === INIT_SQL)
  const ids = (await docker(state, ["ps", "-aq", "--filter", "label=com.docker.compose.project=devclaw-bot-dev"], { stdoutOnly: true })).split(/\s+/).filter(Boolean); check(ids.length === 3)
  const containers = JSON.parse(await docker(state, ["inspect", ...ids], { stdoutOnly: true })), services = {}
  for (const c of containers) {
    const service = c.Config.Labels["com.docker.compose.service"], port = validateContainer(c, entry, service)
    check(!services[service] && c.State.Running && c.State.Health?.Status === "healthy"); await verifyListeners(port)
    if (service === "mysql") check(c.Id === "693a1c3fd9c1aefc968a850f6187724b3b89864283a78cf9c44c52a015eeba3c")
    services[service] = { id: c.Id, port, image: c.Image, mounts: stableMounts(c.Mounts) }
  }
  check(Object.keys(services).sort().join() === "es,mysql,s3")
  const network = JSON.parse(await docker(state, ["network", "inspect", "devclaw-bot-dev-private"], { stdoutOnly: true }))[0]; validateNetwork(network, entry, containers)
  return { daemon: identity.id, owner: state.owner.id, inode: dir.ino, network: network.Id, services: Object.fromEntries(Object.entries(services).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }
}
async function capacity() {
  await devProof() // no restart/adoption, original three must still be healthy
  const state = await hostState(); await daemon(state)
  const info = JSON.parse(await docker(state, ["info", "--format", "{{json .}}"], { stdoutOnly: true }))
  const stats = (await docker(state, ["stats", "--no-stream", "--format", "{{json .}}"], { stdoutOnly: true })).split("\n").filter(Boolean).map(JSON.parse)
  const bytes = text => {
    const m = /^([0-9.]+)([KMG]?i?B)$/.exec(text.trim()); check(m)
    return Number(m[1]) * ({ B: 1, kB: 1000, KB: 1000, KiB: 1024, MB: 1e6, MiB: 1048576, GB: 1e9, GiB: 1073741824 }[m[2]])
  }
  const used = stats.reduce((sum, x) => sum + bytes(x.MemUsage.split("/")[0]), 0)
  check(info.NCPU === 2 && info.MemTotal >= 4e9 && used + 805306368 + 536870912 < info.MemTotal)
  console.log(JSON.stringify({ stage: "capacity", daemon: info.ID, memoryBytes: info.MemTotal, usedContainerBytes: Math.ceil(used), extraDatabases: 1 }))
}
async function absent(project) {
  check(/^devclaw-bot-test-[a-f0-9]{16}$/.test(project))
  const state = await hostState(); await daemon(state)
  check(!(await docker(state, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { stdoutOnly: true })))
  for (const [type, suffix] of [["network", "private"], ["volume", "data"]]) check(!(await docker(state, [type, "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n").includes(`${project}-${suffix}`))
  try { await lstat(join(RUNTIME, project)); throw Error("C1_RESIDUE") } catch (error) { if (error.code !== "ENOENT") throw error }
}
async function migrated(runtime, entry, signal) {
  for (const expected of [1, 0]) {
    const result = await javaDatabase(runtime, entry, "migrate", { signal })
    if (result.exitCode !== 0) console.log(JSON.stringify({ stage: "migration-failure", category: result.proof.category }))
    check(result.exitCode === 0 && result.proof.migrations === expected)
  }
}
async function probe(runtime, entry, mode, signal) {
  const result = await applicationJava(runtime, entry, mode, signal)
  if (result.exitCode !== 0) console.log(JSON.stringify({ stage: "probe-failure", mode, category: result.proof.category, case: result.proof.stage }))
  check(result.exitCode === 0)
  return result.proof
}
async function race(runtime, entry, modes, signal) {
  const processes = []
  try {
    for (const mode of modes) processes.push(await startApplicationJava(runtime, entry, mode, signal))
    check(processes[0].pid !== processes[1].pid && (await Promise.all(processes.map(x => x.armed))).every(Boolean))
    for (const p of processes) p.release()
    check((await Promise.all(processes.map(x => x.started))).every(Boolean) && processes.every(x => !x.exited))
    if (modes[0] !== "race-same") {
      check((await Promise.all(processes.map(x => x.scoped))).every(Boolean) && processes.every(x => !x.exited))
      for (const p of processes) p.releaseScope()
    }
    const result = await Promise.all(processes.map(x => x.done)); check(result.every(x => x.exitCode === 0))
    const status = result.map(x => x.proof.httpStatus).sort()
    if (modes[0] === "race-same") check(status.join() === "201,201" && result[0].proof.bodyHash === result[1].proof.bodyHash)
    else check(status.join() === "201,409")
    console.log(JSON.stringify({ stage: "race-proof", modes, pids: processes.map(x => x.pid), controlledOverlap: true, bothCommandScopesLocked: modes[0] !== "race-same", statuses: status, receiptHashEqual: modes[0] === "race-same" }))
  } finally { await Promise.all(processes.map(x => x.stop())) }
}
export async function applicationCheck(signal) {
  active(signal); const originalDev = await devProof(); active(signal)
  const runtime = await packagedDatabaseRuntime(), projects = []
  try {
    active(signal)
    for (let iteration = 1; iteration <= 2; iteration++) {
      active(signal); await capacity(); active(signal); const entry = await createTestDatabase()
      try {
        console.log(JSON.stringify({ stage: "registered", project: entry.project, iteration }))
        console.log(JSON.stringify({ stage: "ready", ...await startTestDatabase(entry, signal) }))
        await migrated(runtime, entry, signal)
        const suite = await probe(runtime, entry, "suite", signal); check(applicationResponses(suite) === 6)
        check(suite.denials >= 30 && suite.replays >= 8 && suite.rollbacks === 7 && suite.corruptReceipts === 12)
        console.log(JSON.stringify({ stage: "suite-proof", project: entry.project, iteration, assertions: suite.assertions, denials: suite.denials, replays: suite.replays, rollbacks: suite.rollbacks, corruptReceipts: suite.corruptReceipts, actualAjvResponses: 6 }))
        await probe(runtime, entry, "reopen", signal); await probe(runtime, entry, "race-seed", signal)
        await race(runtime, entry, ["race-same", "race-same"], signal)
        await race(runtime, entry, ["race-cas-a", "race-cas-b"], signal)
        await probe(runtime, entry, "race-verify", signal)
        projects.push(entry.project)
      } finally {
        await stopApplicationChildren(); check(applicationChildFacts().active === 0)
        console.log(JSON.stringify({ stage: "cleanup", ...await cleanupTestDatabase(entry) })); await absent(entry.project)
      }
    }
    return { status: "verified", sequentialDatabases: 2, projects, ...applicationChildFacts() }
  } finally {
    await stopApplicationChildren(); await closeDatabaseRuntime(runtime)
    check(JSON.stringify(await devProof()) === JSON.stringify(originalDev))
    console.log(JSON.stringify({ stage: "original-dev-proof", sameIdsMountsNetwork: true, allHealthy: true, credentialsRead: false }))
  }
}
async function lifecycleChild(mode) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 240000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  let entry, runtime, failed = false, cleanupFailed = false
  try {
    active(controller.signal); await capacity(); active(controller.signal); entry = await createTestDatabase()
    console.log(JSON.stringify({ stage: "registered", project: entry.project }))
    active(controller.signal); runtime = await packagedDatabaseRuntime(); active(controller.signal)
    console.log(JSON.stringify({ stage: "ready", ...await startTestDatabase(entry, controller.signal) }))
    await migrated(runtime, entry, controller.signal)
    const java = await startApplicationJava(runtime, entry, "hold", controller.signal)
    check(await java.armed)
    console.log(JSON.stringify({ stage: "java-armed", pid: java.pid }))
    if (mode === "injected") throw Error("C1_INJECTED")
    active(controller.signal); await java.done; throw Error("C1_CANCEL_NOT_OBSERVED")
  } catch (error) {
    failed = true
    console.log(JSON.stringify({ stage: "failure", category: controller.signal.aborted ? "C1_CANCELLED" : /^C1_[A-Z_]+$/.test(error.message) ? error.message : "IO" }))
  } finally {
    await stopApplicationChildren()
    console.log(JSON.stringify({ stage: "java-stopped", ...applicationChildFacts() }))
    if (entry) try { console.log(JSON.stringify({ stage: "cleanup", ...await cleanupTestDatabase(entry) })) } catch { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup", status: "failed", project: entry.project })) }
    if (runtime) try { await closeDatabaseRuntime(runtime) } catch { cleanupFailed = true }
    clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel)
    process.exitCode = failed || cleanupFailed ? 1 : 0
  }
}
export async function applicationLifecycle(signal) {
  active(signal); const originalDev = await devProof(); active(signal)
  for (const mode of ["injected", "sigterm"]) {
    active(signal)
    const child = ownedProcess(process.execPath, [filename, "--child", mode], { cwd: root, env: isolatedEnv(root), maxOutput: 65536 })
    let sent = false, timedOut = false
    const cancel = () => child.child.kill("SIGTERM")
    signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel()
    const timer = setTimeout(() => { timedOut = true; void child.stop() }, 250000)
    if (mode === "sigterm") child.child.stdout.on("data", () => { if (!sent && child.output.includes('"stage":"java-armed"')) { sent = true; child.child.kill("SIGTERM") } })
    child.child.stdin.end()
    try {
      const r = await child.done; check(!timedOut && r.code === 1 && !r.stderr && !r.spawnError && !r.overflow)
      const lines = r.stdout.trim().split("\n").map(JSON.parse), project = lines.find(x => x.stage === "registered")?.project
      const failure = lines.find(x => x.stage === "failure"), stopped = lines.find(x => x.stage === "java-stopped"), cleanup = lines.find(x => x.stage === "cleanup"), armed = lines.find(x => x.stage === "java-armed"), ready = lines.find(x => x.stage === "ready")
      check(failure?.category === (mode === "injected" ? "C1_INJECTED" : "C1_CANCELLED") && stopped?.active === 0 && stopped.starts === 1 && stopped.secretSends === 1 && Number.isInteger(armed?.pid))
      check(cleanup?.status === "removed" && cleanup.project === project && (mode !== "sigterm" || sent))
      check(ready?.project === project && /^[a-f0-9]{64}$/.test(ready.container) && Number.isInteger(ready.port) && ready.port > 1024 && ready.port <= 65535)
      let javaAlive = false; try { process.kill(armed.pid, 0); javaAlive = true } catch (error) { if (error.code !== "ESRCH") throw error }; check(!javaAlive)
      await absent(project)
      console.log(JSON.stringify({ stage: "application-lifecycle-proof", mode, project, container: ready.container, port: ready.port, javaPid: armed.pid, signal: sent ? "SIGTERM" : "injected", nodeExit: r.code, javaActuallyAbsent: true, activeJava: 0, cleanup: "actually-absent" }))
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); await child.stop() }
  }
  check(JSON.stringify(await devProof()) === JSON.stringify(originalDev))
  return { status: "verified", lifecycleCases: 2 }
}
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  if (process.argv.length === 4 && process.argv[2] === "--child" && ["injected", "sigterm"].includes(process.argv[3])) await lifecycleChild(process.argv[3])
  else {
    const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 1200000)
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
    try {
      if (process.argv.length !== 2) throw Error("C1_ARGUMENTS")
      console.log(JSON.stringify(await applicationCheck(controller.signal)))
      active(controller.signal); console.log(JSON.stringify(await applicationLifecycle(controller.signal)))
    } catch (error) { console.log(JSON.stringify({ status: "failed", category: controller.signal.aborted ? "CANCELLED" : /^C1_[A-Z_]+$/.test(error.message) ? error.message : "IO" })); process.exitCode = 1 }
    finally { clearTimeout(timer); await stopApplicationChildren(); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
  }
}
