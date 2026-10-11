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
  if (!value) throw Error("R01_RUN_ASSERTION")
}
const actions = new Set([
    "seed-v3",
    "exercise",
    "enqueue",
    "claim",
    "admission-business",
    "admission-owner",
    "reopen"
  ]),
  children = new Set()
export async function stopRequirementRunChildren() {
  const results = await Promise.allSettled([...children].map((child) => child.stop()))
  if (results.some((result) => result.status !== "fulfilled")) throw Error("R01_RUN_CLEANUP")
}
// Fixed test main/action list; passwords only through verified disposable DB stdin.
export async function requirementRunProbe(runtime, entry, action, fixture = {}, signal) {
  if (!actions.has(action)) throw Error("R01_RUN_SELECTION")
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
      "com.devclaw.botcontrol.persistence.RequirementRunDatabaseProbe",
      action
    ],
    { cwd: runtime.dir, env: runtime.env, maxOutput: 8192 }
  )
  children.add(child)
  let timedOut = false
  const stop = () => {
      void child.stop()
    },
    timer = setTimeout(() => {
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
      throw Error("R01_RUN_BOUNDARY")
    const proof = JSON.parse(result.stdout)
    if (proof.status !== "verified" || result.code !== 0 || proof.case !== action) {
      console.log(
        JSON.stringify({
          stage: "run-probe-failure",
          action,
          phase: /^[a-z-]+$/.test(proof.phase) ? proof.phase : "unknown",
          category: /^[A-Z_]+$/.test(proof.category) ? proof.category : "UNKNOWN"
        })
      )
      throw Error("R01_RUN_PROBE")
    }
    return proof
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", stop)
    await child.stop()
    children.delete(child)
    try {
      process.kill(child.child.pid, 0)
      throw Error("R01_RUN_RESIDUE")
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
export async function requirementRunCheck(signal) {
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
        console.log(JSON.stringify({ stage: "run-registered", iteration, project: entry.project }))
        console.log(
          JSON.stringify({
            stage: "run-database-ready",
            ...(await startTestDatabase(entry, signal))
          })
        )
        let fixture = {}
        if (iteration === 2) {
          const seed = await requirementRunProbe(runtime, entry, "seed-v3", {}, signal)
          check(seed.migrations === 3 && /^[a-f0-9]{64}$/.test(seed.v3Facts))
          fixture = { ...selectFixture(seed), v3Facts: seed.v3Facts, migrations: 3 }
        }
        const migration = await javaDatabase(runtime, entry, "migrate", { signal })
        check(migration.exitCode === 0 && migration.proof.migrations === (iteration === 1 ? 4 : 1))
        const noop = await javaDatabase(runtime, entry, "migrate", { signal })
        check(noop.exitCode === 0 && noop.proof.migrations === 0)
        const exercised = await requirementRunProbe(runtime, entry, "exercise", fixture, signal)
        check(exercised.denials >= 25 && exercised.taskVersion === 2)
        fixture = {
          ...selectFixture(exercised),
          taskVersion: 2,
          unknownRun: exercised.unknownRun,
          committedRun: exercised.committedRun,
          raceDeadline: exercised.raceDeadline
        }
        const enqueues = await Promise.allSettled([
          requirementRunProbe(runtime, entry, "enqueue", fixture, signal),
          requirementRunProbe(runtime, entry, "enqueue", fixture, signal)
        ])
        check(enqueues.every((result) => result.status === "fulfilled"))
        const queued = enqueues.map((result) => result.value)
        check(queued[0].runId === queued[1].runId && queued[0].createdAt === queued[1].createdAt)
        fixture.runId = queued[0].runId
        const claims = await Promise.allSettled([
          requirementRunProbe(runtime, entry, "claim", fixture, signal),
          requirementRunProbe(runtime, entry, "claim", fixture, signal)
        ])
        check(claims.every((result) => result.status === "fulfilled"))
        check(isDeepStrictEqual(claims[0].value, claims[1].value))
        const restored = await requirementRunProbe(runtime, entry, "reopen", fixture, signal)
        check(restored.restored === true && restored.queueRows === 10)
        const admitted = await Promise.allSettled([
          requirementRunProbe(runtime, entry, "admission-business", fixture, signal),
          requirementRunProbe(runtime, entry, "admission-owner", fixture, signal)
        ])
        check(admitted.every((result) => result.status === "fulfilled"))
        check(admitted.filter((result) => result.value.winner === true).length === 1)
        const afterAdmission = await requirementRunProbe(runtime, entry, "reopen", fixture, signal)
        check(afterAdmission.restored === true && afterAdmission.queueRows === 11)
        console.log(
          JSON.stringify({
            stage: "run-proof",
            iteration,
            project: entry.project,
            denials: exercised.denials,
            emptyOrActualV3Upgrade:
              iteration === 1 ? "empty-V1-V2-V3-V4" : "all-V3-bytes-and-history-preserved",
            designatedOnly: true,
            offlineWaiting: true,
            frozenInputVersions: true,
            enqueueJvmCount: 2,
            identicalEnqueue: true,
            claimJvmCount: 2,
            identicalAttemptAndLease: true,
            independentActorAdmissionWinners: 1,
            rollback: 2,
            lostCommitReadBack: 2,
            reopened: true,
            expiredClaimUnknownNoReplay: true,
            noExecution: true
          })
        )
        projects.push(entry.project)
      } finally {
        let failed = false
        for (const finish of [
          stopRequirementRunChildren,
          async () => {
            console.log(
              JSON.stringify({ stage: "run-cleanup", ...(await cleanupTestDatabase(entry)) })
            )
          },
          () => httpAbsent(entry.project)
        ]) {
          try {
            await finish()
          } catch {
            failed = true
          }
        }
        if (failed) throw Error("R01_RUN_CLEANUP")
      }
    }
    return {
      status: "verified",
      sequentialDatabases: 2,
      projects,
      activeRunChildren: children.size
    }
  } finally {
    let failed = false
    for (const finish of [
      stopRequirementRunChildren,
      () => closeDatabaseRuntime(runtime),
      async () => {
        check(isDeepStrictEqual(original, await httpDevProof()))
        console.log(
          JSON.stringify({
            stage: "run-original-dev",
            sameIdentityHealthy: true,
            credentialsRead: false
          })
        )
      }
    ]) {
      try {
        await finish()
      } catch {
        failed = true
      }
    }
    if (failed) throw Error("R01_RUN_CLEANUP")
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(),
    cancel = () => controller.abort(),
    timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel)
  process.once("SIGINT", cancel)
  try {
    if (process.argv.length !== 2) throw Error("R01_RUN_ARGUMENTS")
    console.log(JSON.stringify(await requirementRunCheck(controller.signal)))
  } catch (error) {
    console.log(
      JSON.stringify({
        status: "failed",
        category: controller.signal.aborted
          ? "CANCELLED"
          : /^R01_RUN_[A-Z_]+$/.test(error.message)
            ? error.message
            : "IO"
      })
    )
    process.exitCode = 1
  } finally {
    clearTimeout(timer)
    await stopRequirementRunChildren()
    process.removeListener("SIGTERM", cancel)
    process.removeListener("SIGINT", cancel)
  }
}
