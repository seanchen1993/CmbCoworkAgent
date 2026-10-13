import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ownedProcess } from "../process.mjs"
import { active, appPassword, createTestDatabase, startTestDatabase, cleanupTestDatabase } from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase } from "./database-java.mjs"
import { httpCapacity, httpDevProof, httpAbsent } from "./http-proof.mjs"

const children = new Set(), actions = new Set(["seed-v4", "verify-v4", "seed", "seed-clarified", "messages", "exercise", "start", "renew", "settle", "read"])
const check = (value) => { if (!value) throw Error("R01_EXECUTION_ASSERTION") }
export async function stopRequirementExecutionChildren() {
  const stopped = await Promise.allSettled([...children].map(child => child.stop()))
  if (stopped.some(result => result.status !== "fulfilled")) throw Error("R01_EXECUTION_CLEANUP")
}
// Finite fixed test main; NEVER accepts node identity or credentials in fixture.
async function probe(runtime, entry, action, fixture, signal) {
  if (!actions.has(action)) throw Error("R01_EXECUTION_SELECTION")
  active(signal)
  const password = await appPassword(entry, signal)
  active(signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath,
    "com.devclaw.botcontrol.persistence.RequirementExecutionDatabaseProbe", action],
  { cwd: runtime.dir, env: runtime.env, maxOutput: 131072 })
  children.add(child)
  let timedOut = false
  const stop = () => { void child.stop() }, timer = setTimeout(() => { timedOut = true; stop() }, 45000)
  signal?.addEventListener("abort", stop, { once: true })
  child.child.stdin.on("error", () => {})
  try {
    active(signal)
    child.child.stdin.end(JSON.stringify({ db: { mode: "local-dev", host: "127.0.0.1", port: entry.port,
      schema: "devclaw", user: "devclaw_app", password }, fixture }))
    const result = await child.done
    active(signal)
    if (timedOut || result.stderr || result.spawnError || result.overflow || ![0, 1].includes(result.code) ||
        result.stdout.trim().split("\n").length !== 1) throw Error("R01_EXECUTION_BOUNDARY")
    const value = JSON.parse(result.stdout)
    if (result.code !== 0 || value.status !== "verified" || value.case !== action) {
      const category = /^[A-Z_]+$/.test(value.category) ? value.category : "R01_EXECUTION_PROBE"
      throw Error(category)
    }
    return value
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    await child.stop()
    children.delete(child)
    try { process.kill(child.child.pid, 0); throw Error("R01_EXECUTION_RESIDUE") } catch (error) { if (error.code !== "ESRCH") throw error }
  }
}
const snapshot = value => JSON.parse(JSON.stringify(value))
async function withDatabase(callback, signal, upgrade = false) {
  active(signal)
  const original = await httpDevProof(), runtime = await packagedDatabaseRuntime()
  let entry
  try {
    console.log(JSON.stringify(await httpCapacity(signal)))
    entry = await createTestDatabase()
    console.log(JSON.stringify({ stage: "execution-registered", project: entry.project }))
    console.log(JSON.stringify({ stage: "execution-database-ready", ...(await startTestDatabase(entry, signal)) }))
    const previous = upgrade ? await probe(runtime, entry, "seed-v4", {}, signal) : null
    const migration = await javaDatabase(runtime, entry, "migrate", { signal })
    check(migration.exitCode === 0 && migration.proof.migrations === (upgrade ? 2 : 6))
    const noop = await javaDatabase(runtime, entry, "migrate", { signal })
    check(noop.exitCode === 0 && noop.proof.migrations === 0)
    if (upgrade) check((await probe(runtime, entry, "verify-v4", { v4Facts: previous.v4Facts }, signal)).v4Preserved)
    return await callback(runtime, entry, previous)
  } finally {
    let failed = false
    for (const finish of [
      stopRequirementExecutionChildren,
      ...(entry ? [async () => { console.log(JSON.stringify({ stage: "execution-cleanup", ...(await cleanupTestDatabase(entry)) })) },
        () => httpAbsent(entry.project)] : []),
      () => closeDatabaseRuntime(runtime),
      async () => { check(isDeepStrictEqual(original, await httpDevProof())); console.log(JSON.stringify({ stage: "execution-original-dev", sameIdentityHealthy: true, credentialsRead: false })) }
    ]) { try { await finish() } catch { failed = true } }
    if (failed) throw Error("R01_EXECUTION_CLEANUP")
  }
}
/** Own one isolated real MySQL5.7 fixture until callback completes. Business
 * DTOs only; closure pins runId, Java creates/authenticates fixed node per action.
 * Callback mutation cannot change the pinned database run or identity. */
export async function withRequirementExecutionFixture(callback, options = {}) {
  if (typeof callback !== "function") throw Error("R01_EXECUTION_CALLBACK")
  return withDatabase(async (runtime, entry) => {
    const seeded = await probe(runtime, entry, "seed-clarified", {}, options.signal), runId = seeded.run.id
    let lastRun = seeded.run, open = true
    const invoke = async (action, extra = {}) => {
      if (!open) throw Error("R01_EXECUTION_FIXTURE_CLOSED")
      return probe(runtime, entry, action, { runId, ...extra }, options.signal)
    }
    const start = async () => { const value = await invoke("start"); lastRun = value.run; return snapshot({ run: value.run, input: value.input }) }
    const renew = async () => { const value = await invoke("renew"); lastRun = value.run; return snapshot(value.run) }
    const settle = async (outcome, text) => snapshot((await invoke("settle", { outcome, text })).result)
    const read = async () => { const value = await invoke("read"); lastRun = value.run; return snapshot(value.result) }
    try {
      await callback({ run: snapshot(seeded.run), input: snapshot(seeded.input), start, renew, settle, read })
      const result = await read()
      return { run: snapshot(lastRun), result }
    } finally { open = false }
  }, options.signal)
}
async function roundTripCheck(signal) {
  return withRequirementExecutionFixture(async ({ run, input, start, renew, settle, read }) => {
    check(run.status === "starting" && input.task.id === run.taskId && input.botVersion.id === run.botVersionId)
    check(run.taskVersion === 2 && input.messages.length === 1 && input.messages[0].taskVersion === 2 && input.messages[0].message.text.includes("CLARIFICATION_SENTINEL"))
    const [started, duplicate] = await Promise.all([start(), start()])
    check(started.run.status === "running" && isDeepStrictEqual(started, duplicate))
    const renewed = await renew()
    check(renewed.attemptId === run.attemptId && renewed.leaseId === run.leaseId)
    const [persisted, replay] = await Promise.all([settle("succeeded", "本地需求分析结果"), settle("succeeded", "本地需求分析结果")])
    check(isDeepStrictEqual(persisted, replay) && isDeepStrictEqual(persisted, await read()))
  }, { signal })
}
export async function requirementExecutionMessagesCheck(signal) {
  const bounded = await withDatabase((runtime, entry) => probe(runtime, entry, "messages", {}, signal), signal)
  check(bounded.messagesBounded && bounded.scopeAndTargetFiltered && bounded.frozenVersionFiltered && bounded.artifactRejected && bounded.storageSchemaCrosschecked && bounded.denials === 5)
  const roundTrip = await roundTripCheck(signal)
  check(roundTrip.result.text === "本地需求分析结果")
  return { status: "verified", sequentialDatabases: 2, messageDenials: bounded.denials, realClarificationRoundTrip: true, activeExecutionChildren: children.size }
}
export async function requirementExecutionCheck(signal) {
  const exercise = await withDatabase((runtime, entry, previous) => probe(runtime, entry, "exercise", { runId: previous.run.id }, signal), signal, true)
  check(exercise.denials >= 25 && exercise.atomicResult && exercise.lostReceiptRecovered && exercise.capacityReleased && exercise.expiredUnknownReserved)
  const roundTrip = await roundTripCheck(signal)
  check(roundTrip.result.text === "本地需求分析结果")
  return { status: "verified", sequentialDatabases: 2, denials: exercise.denials, realJdbcRoundTrip: true, activeExecutionChildren: children.size }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try { if (process.argv.length !== 2 && !(process.argv.length === 3 && process.argv[2] === "--messages-only")) throw Error("R01_EXECUTION_ARGUMENTS"); console.log(JSON.stringify(await (process.argv.length === 3 ? requirementExecutionMessagesCheck : requirementExecutionCheck)(controller.signal))) }
  catch (error) { console.log(JSON.stringify({ status: "failed", category: controller.signal.aborted ? "CANCELLED" : /^[A-Z_]+$/.test(error.message) ? error.message : "IO" })); process.exitCode = 1 }
  finally { clearTimeout(timer); await stopRequirementExecutionChildren(); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
