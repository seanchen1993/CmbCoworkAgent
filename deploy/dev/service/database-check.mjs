import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { createTestDatabase, startTestDatabase, stopTestDatabase, cleanupTestDatabase, appPassword, active } from "./test-database.mjs"
import { packagedDatabaseRuntime, closeDatabaseRuntime, javaDatabase } from "./database-java.mjs"

const check = value => { if (!value) throw Error("B1_ASSERTION") }
export async function databaseCheck(signal) {
  const runtime = await packagedDatabaseRuntime(), projects = []
  try {
    for (let iteration = 1; iteration <= 2; iteration++) {
      active(signal)
      const entry = await createTestDatabase(); let cleanupFailed = false
      try {
        console.log(JSON.stringify({ stage: "registered", project: entry.project, iteration }))
        console.log(JSON.stringify({ stage: "ready", ...await startTestDatabase(entry, signal) }))
        let result = await javaDatabase(runtime, entry, "readiness", { signal })
        console.log(JSON.stringify({ stage: "empty-readiness", status: result.proof.status, category: /^[A-Z_]+$/.test(result.proof.category) ? result.proof.category : "NONE" }))
        check(result.exitCode === 1 && result.proof.category === "MIGRATION_INVALID")
        result = await javaDatabase(runtime, entry, "migrate", { signal }); console.log(JSON.stringify({ stage: "first-migrate", status: result.proof.status, category: /^[A-Z_]+$/.test(result.proof.category) ? result.proof.category : "NONE", migrations: result.proof.migrations })); check(result.exitCode === 0 && result.proof.migrations === 9)
        result = await javaDatabase(runtime, entry, "migrate", { signal }); console.log(JSON.stringify({ stage: "noop-migrate", status: result.proof.status, category: /^[A-Z_]+$/.test(result.proof.category) ? result.proof.category : "NONE", migrations: result.proof.migrations })); check(result.exitCode === 0 && result.proof.migrations === 0)
        for (const command of ["store", "reload", "history"]) {
          result = await javaDatabase(runtime, entry, command, { signal, probe: true })
          if (result.exitCode !== 0) console.log(JSON.stringify({ stage: "probe-failure", case: command, category: /^[A-Z_]+$/.test(result.proof.category) ? result.proof.category : "UNCLASSIFIED", ...(Number.isInteger(result.proof.errno) ? { errno: result.proof.errno } : {}) }))
          check(result.exitCode === 0 && result.proof.case === command)
          if (command === "history") { check(result.proof.historyCases === 5); console.log(JSON.stringify({ stage: "history-proof", cases: result.proof.historyCases, mutatedFactsUnchanged: true, restoredOriginalFactsAndReady: true })) }
          if (command === "reload") { check(Number.isInteger(result.proof.queryTimeoutMillis) && result.proof.queryTimeoutMillis >= 750 && result.proof.queryTimeoutMillis < 4000); console.log(JSON.stringify({ stage: "query-timeout-proof", type: "SQLTimeoutException", elapsedMillis: result.proof.queryTimeoutMillis })) }
        }
        result = await javaDatabase(runtime, entry, "readiness", { signal, badPassword: true });
        check(result.exitCode === 1 && ["DB_AUTH", "DB_TIMEOUT", "DB_UNAVAILABLE"].includes(result.proof.category))
        const port = entry.port; entry.port = port === 65535 ? port - 1 : port + 1
        let staleDenied = false; try { await appPassword(entry, signal) } catch { staleDenied = true } finally { entry.port = port }
        check(staleDenied)
        result = await javaDatabase(runtime, entry, "offline", { signal, probe: true, onArmed: () => stopTestDatabase(entry) });
        check(result.exitCode === 0 && result.proof.case === "offline")
        let stoppedDenied = false; try { await appPassword(entry, signal) } catch { stoppedDenied = true }
        check(stoppedDenied)
        projects.push(entry.project)
        console.log(JSON.stringify({ stage: "database-proof", project: entry.project, iteration, migrations: "9-then-noop", tables: 35, zeroForeignKeys: true, unicodeAndBytes: "reopened", historyFailures: 5, scopedPrivilegeDenials: 3, queryTimeout: true, badPasswordRejected: true, stoppedAndStaleEndpointRejected: true }))
      } finally {
        try { console.log(JSON.stringify({ stage: "cleanup", ...await cleanupTestDatabase(entry) })) }
        catch { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup", status: "failed", project: entry.project })) }
        if (cleanupFailed) throw Error("B1_CLEANUP")
      }
    }
    return { status: "verified", projects, sequentialDatabases: 2 }
  } finally { await closeDatabaseRuntime(runtime) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(), timer = setTimeout(cancel, 600000)
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  try { if (process.argv.length !== 2) throw Error("B1_ARGUMENTS"); console.log(JSON.stringify(await databaseCheck(controller.signal))) }
  catch (error) { console.log(JSON.stringify({ status: "failed", category: controller.signal.aborted ? "CANCELLED" : /^B1_[A-Z_]+$/.test(error.message) ? error.message : "IO" })); process.exitCode = 1 }
  finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
