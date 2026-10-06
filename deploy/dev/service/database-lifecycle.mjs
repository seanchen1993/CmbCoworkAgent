import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { lstat } from "node:fs/promises"
import { createTestDatabase, createUnstartedDatabase, startTestDatabase, cleanupTestDatabase, active } from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase, databaseChildCount } from "./database-java.mjs"
import { ownedProcess, isolatedEnv } from "../process.mjs"
import { hostState, daemon, docker, RUNTIME } from "../docker/host.mjs"

const filename = fileURLToPath(import.meta.url), root = fileURLToPath(new URL("../../../", import.meta.url))
const check = value => { if (!value) throw Error("B1_LIFECYCLE_ASSERTION") }
async function childCase(mode) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 240000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  let entry, runtime, failed = false, cleanupFailed = false
  try {
    active(controller.signal); entry = await createTestDatabase()
    console.log(JSON.stringify({ stage: "registered", project: entry.project }))
    if (mode === "secret-sigterm") {
      runtime = await packagedDatabaseRuntime()
      await startTestDatabase(entry, controller.signal)
      console.log(JSON.stringify({ stage: "secret-check", project: entry.project }))
      await javaDatabase(runtime, entry, "readiness", { signal: controller.signal })
      throw Error("B1_CANCEL_NOT_OBSERVED")
    }
    const proof = await createUnstartedDatabase(entry, controller.signal)
    console.log(JSON.stringify({ stage: "pre-ready", ...proof }))
    if (mode === "injected") throw Error("B1_INJECTED")
    active(controller.signal)
    await new Promise(resolve => controller.signal.addEventListener("abort", resolve, { once: true }))
    throw Error("B1_CANCELLED")
  } catch (error) {
    failed = true
    console.log(JSON.stringify({ stage: "failure", category: controller.signal.aborted ? "B1_CANCELLED" : /^B1_[A-Z_]+$/.test(error.message) ? error.message : "IO", databaseChildStarts: databaseChildCount() }))
  } finally {
    if (entry) try { console.log(JSON.stringify({ stage: "cleanup", ...await cleanupTestDatabase(entry) })) }
    catch { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup", status: "failed", project: entry.project })) }
    if (runtime) try { await closeDatabaseRuntime(runtime) } catch { cleanupFailed = true }
    clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel)
    process.exitCode = failed || cleanupFailed ? 1 : 0
  }
}
async function absent(project) {
  check(/^devclaw-bot-test-[a-f0-9]{16}$/.test(project))
  const state = await hostState(); await daemon(state)
  check(!(await docker(state, ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`], { stdoutOnly: true })))
  for (const [type, suffix] of [["network", "private"], ["volume", "data"]]) check(!(await docker(state, [type, "ls", "--format", "{{.Name}}"], { stdoutOnly: true })).split("\n").includes(`${project}-${suffix}`))
  try { await lstat(join(RUNTIME, project)); throw Error("B1_TEST_RESIDUE") } catch (e) { if (e.code !== "ENOENT") throw e }
}
export async function lifecycleCheck() {
  const proofs = []
  for (const mode of ["injected", "pre-ready-sigterm", "secret-sigterm"]) {
    const child = ownedProcess(process.execPath, [filename, "--child", mode], { cwd: root, env: isolatedEnv(root), maxOutput: 65536 })
    let sent = false, timedOut = false
    const timer = setTimeout(() => { timedOut = true; void child.stop() }, 250000)
    const stage = mode === "secret-sigterm" ? '"stage":"secret-check"' : '"stage":"pre-ready"'
    if (mode !== "injected") child.child.stdout.on("data", () => {
      if (!sent && child.output.includes(stage)) { sent = true; child.child.kill("SIGTERM") }
    })
    child.child.stdin.end()
    try {
      const result = await child.done
      check(!timedOut && result.code === 1 && !result.stderr && !result.spawnError && !result.overflow)
      const lines = result.stdout.trim().split("\n").map(x => JSON.parse(x))
      const project = lines.find(x => x.stage === "registered")?.project
      const failure = lines.find(x => x.stage === "failure"), cleanup = lines.find(x => x.stage === "cleanup")
      check(failure?.category === (mode === "injected" ? "B1_INJECTED" : "B1_CANCELLED") && failure.databaseChildStarts === 0)
      check(cleanup?.status === "removed" && cleanup.project === project)
      if (mode !== "injected") check(sent)
      else check(lines.find(x => x.stage === "pre-ready")?.port === null)
      await absent(project)
      const proof = { mode, project, signal: sent ? "SIGTERM" : "injected", childExit: result.code, databaseChildStarts: 0, cleanup: "actually-absent" }
      proofs.push(proof); console.log(JSON.stringify({ stage: "lifecycle-proof", ...proof }))
    } finally { clearTimeout(timer); await child.stop() }
  }
  return { status: "verified", cases: proofs.length }
}
if (process.argv[1] && resolve(process.argv[1]) === filename) {
  try {
    if (process.argv.length === 4 && process.argv[2] === "--child" && ["injected", "pre-ready-sigterm", "secret-sigterm"].includes(process.argv[3])) await childCase(process.argv[3])
    else if (process.argv.length === 2) console.log(JSON.stringify(await lifecycleCheck()))
    else throw Error("B1_ARGUMENTS")
  } catch (error) { console.log(JSON.stringify({ status: "failed", category: /^B1_[A-Z_]+$/.test(error.message) ? error.message : "IO" })); process.exitCode = 1 }
}
