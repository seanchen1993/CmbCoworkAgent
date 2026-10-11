import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { ownedProcess } from "../process.mjs"
import {
  active,
  appPassword,
  createTestDatabase,
  startTestDatabase,
  cleanupTestDatabase
} from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase } from "./database-java.mjs"
import { httpCapacity, httpDevProof, httpAbsent } from "./http-proof.mjs"

const check = (value) => {
  if (!value) throw Error("R01_NODE_ASSERTION")
}
const actions = new Set(["seed-v2", "exercise", "cas", "reopen"])
const children = new Set()
export async function stopRuntimeNodeChildren() {
  const results = await Promise.allSettled([...children].map((child) => child.stop()))
  if (results.some((result) => result.status !== "fulfilled")) throw Error("R01_NODE_CLEANUP")
}
// Fixed test main, secrets only from currently verified owned disposable DBs.
export async function runtimeNodeProbe(runtime, entry, action, fixture = {}, signal) {
  if (!actions.has(action)) throw Error("R01_NODE_SELECTION")
  active(signal)
  const password = await appPassword(entry, signal)
  active(signal)
  const input = JSON.stringify({
    db: {
      mode: "local-dev",
      host: "127.0.0.1",
      port: entry.port,
      schema: "devclaw",
      user: "devclaw_app",
      password
    },
    fixture
  })
  const child = ownedProcess(
    runtime.java,
    [
      "-Xmx256m",
      "-Duser.timezone=UTC",
      "-cp",
      runtime.classpath,
      "com.devclaw.botcontrol.persistence.RuntimeNodeDatabaseProbe",
      action
    ],
    { cwd: runtime.dir, env: runtime.env, maxOutput: 8192 }
  )
  children.add(child)
  let timedOut = false
  const stop = () => {
    void child.stop()
  }
  const timer = setTimeout(() => {
    timedOut = true
    stop()
  }, 45000)
  signal?.addEventListener("abort", stop, { once: true })
  child.child.stdin.on("error", () => {})
  try {
    active(signal)
    child.child.stdin.end(input)
    const result = await child.done
    active(signal)
    if (
      timedOut ||
      result.stderr ||
      result.spawnError ||
      result.overflow ||
      ![0, 1].includes(result.code) ||
      result.stdout.trim().split("\n").length !== 1
    )
      throw Error("R01_NODE_BOUNDARY")
    const proof = JSON.parse(result.stdout)
    if (proof.status !== "verified" || result.code !== 0 || proof.case !== action) {
      // No raw child text or exception/SQL messages are forwarded.
      console.log(
        JSON.stringify({
          stage: "node-probe-failure",
          action,
          phase: /^[a-z-]+$/.test(proof.phase) ? proof.phase : "unknown",
          category: /^[A-Z_]+$/.test(proof.category) ? proof.category : "UNKNOWN"
        })
      )
      throw Error("R01_NODE_PROBE")
    }
    return proof
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    await child.stop()
    children.delete(child)
    try {
      process.kill(child.child.pid, 0)
      throw Error("R01_NODE_RESIDUE")
    } catch (error) {
      if (error.code !== "ESRCH") throw error
    }
  }
}
function selectFixture(proof) {
  const fixture = {}
  for (const key of ["bot", "botVersion", "group", "task"]) {
    check(typeof proof[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(proof[key]))
    fixture[key] = proof[key]
  }
  return fixture
}
export async function runtimeNodeCheck(signal) {
  active(signal)
  const original = await httpDevProof(),
    runtime = await packagedDatabaseRuntime(),
    projects = []
  try {
    for (let iteration = 1; iteration <= 2; iteration++) {
      console.log(JSON.stringify(await httpCapacity(signal)))
      active(signal)
      const entry = await createTestDatabase()
      try {
        console.log(JSON.stringify({ stage: "node-registered", iteration, project: entry.project }))
        console.log(
          JSON.stringify({
            stage: "node-database-ready",
            ...(await startTestDatabase(entry, signal))
          })
        )
        let fixture = {}
        if (iteration === 2) {
          const seed = await runtimeNodeProbe(runtime, entry, "seed-v2", {}, signal)
          check(seed.migrations === 2 && /^[a-f0-9]{64}$/.test(seed.v2Facts))
          fixture = { ...selectFixture(seed), v2Facts: seed.v2Facts, migrations: seed.migrations }
        }
        const migration = await javaDatabase(runtime, entry, "migrate", { signal })
        check(migration.exitCode === 0 && migration.proof.migrations === (iteration === 1 ? 3 : 1))
        const noop = await javaDatabase(runtime, entry, "migrate", { signal })
        check(noop.exitCode === 0 && noop.proof.migrations === 0)
        const exercised = await runtimeNodeProbe(runtime, entry, "exercise", fixture, signal)
        check(
          exercised.grantVersion === 4 && exercised.nodeVersion === 4 && exercised.denials >= 30
        )
        fixture = {
          ...selectFixture(exercised),
          grantVersion: 4,
          nodeVersion: 4,
          denials: exercised.denials
        }
        // Two independent JVM transactions: exactly one CAS wins, neither retries.
        const settled = await Promise.allSettled([
          runtimeNodeProbe(runtime, entry, "cas", fixture, signal),
          runtimeNodeProbe(runtime, entry, "cas", fixture, signal)
        ])
        check(settled.every((result) => result.status === "fulfilled"))
        const raced = settled.map((result) => result.value)
        check(
          raced.filter((result) => result.winner === true).length === 1 &&
            raced.filter((result) => result.winner === false).length === 1 &&
            raced.every((result) => result.grantVersion === 5)
        )
        fixture.grantVersion = 5
        const reopened = await runtimeNodeProbe(runtime, entry, "reopen", fixture, signal)
        check(
          reopened.restored === true && reopened.grantVersion === 5 && reopened.nodeVersion === 4
        )
        console.log(
          JSON.stringify({
            stage: "node-proof",
            iteration,
            project: entry.project,
            emptyOrV2Upgrade:
              iteration === 1 ? "empty-V1-V2-V3" : "actual-V2-bytes-and-history-preserved",
            denials: exercised.denials,
            designatedNodeOnly: true,
            staleHeartbeatWait: true,
            revokedAndExpiredDenied: true,
            rollback: 2,
            commitAfterUnknownReadBack: true,
            independentJvmCasWinners: 1,
            reopened: true,
            noExecution: true
          })
        )
        projects.push(entry.project)
      } finally {
        let failed = false
        for (const finish of [
          stopRuntimeNodeChildren,
          async () => {
            console.log(
              JSON.stringify({ stage: "node-cleanup", ...(await cleanupTestDatabase(entry)) })
            )
          },
          () => httpAbsent(entry.project)
        ])
          try {
            await finish()
          } catch {
            failed = true
          }
        if (failed) throw Error("R01_NODE_CLEANUP")
      }
    }
    return {
      status: "verified",
      sequentialDatabases: 2,
      projects,
      activeNodeChildren: children.size
    }
  } finally {
    let failed = false
    for (const finish of [
      stopRuntimeNodeChildren,
      () => closeDatabaseRuntime(runtime),
      async () => {
        check(isDeepStrictEqual(original, await httpDevProof()))
        console.log(
          JSON.stringify({
            stage: "node-original-dev",
            sameIdentityHealthy: true,
            credentialsRead: false
          })
        )
      }
    ])
      try {
        await finish()
      } catch {
        failed = true
      }
    if (failed) throw Error("R01_NODE_CLEANUP")
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(),
    cancel = () => controller.abort(),
    timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)
  try {
    if (process.argv.length !== 2) throw Error("R01_NODE_ARGUMENTS")
    console.log(JSON.stringify(await runtimeNodeCheck(controller.signal)))
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "failed",
        category: controller.signal.aborted
          ? "CANCELLED"
          : /^R01_NODE_[A-Z_]+$/.test(error.message)
            ? error.message
            : "IO"
      })
    )
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    await stopRuntimeNodeChildren()
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
  }
}
