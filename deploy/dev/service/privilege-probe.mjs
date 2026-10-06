import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { privateTemp, removePrivateTemp, isolatedEnv, run, ownedProcess } from "../process.mjs"
import { createTestDatabase, startTestDatabase, appPassword, cleanupTestDatabase } from "./test-database.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const jdk = "/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home"
const jdbc = "/Users/heyirui/.devclaw-bot-b01-a1/repository/com/mysql/mysql-connector-j/8.0.33/mysql-connector-j-8.0.33.jar"
const controller = new AbortController(), cancel = () => controller.abort()
process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
const timer = setTimeout(cancel, 240000)
let entry, temp, failed = false, cleanupFailed = false
try {
  temp = await privateTemp()
  const env = isolatedEnv(temp, join(jdk, "bin/java"))
  const version = await run(join(jdk, "bin/java"), ["-version"], { env, cwd: temp })
  if (!version.includes('"1.8.0_482"')) throw Error("B1_JDK_VERSION")
  await run(join(jdk, "bin/javac"), ["-d", temp, join(root, "tests/bot/service/DatabasePrivilegeProbe.java")], { env, cwd: temp, signal: controller.signal, timeoutMs: 15000 })
  entry = await createTestDatabase()
  console.log(JSON.stringify({ stage: "registered", project: entry.project, daemon: entry.daemon, timeoutMs: 240000 }))
  console.log(JSON.stringify({ stage: "ready", ...await startTestDatabase(entry, controller.signal) }))
  const password = await appPassword(entry)
  // Password is only stdin to the owned Java child, never argv/env/output.
  const child = ownedProcess(join(jdk, "bin/java"), ["-cp", `${temp}:${jdbc}`, "DatabasePrivilegeProbe"], { env, cwd: temp })
  const stopChild = () => { void child.stop() }, childTimer = setTimeout(stopChild, 15000)
  controller.signal.addEventListener("abort", stopChild, { once: true })
  child.child.stdin.on("error", () => {})
  child.child.stdin.end(`port=${entry.port}\npassword=${password}\n`)
  try {
    const result = await child.done
    const proof = JSON.parse(result.stdout.trim())
    if (result.stderr || result.spawnError || result.overflow || ![0, 1].includes(result.code)) throw Error("B1_PROBE")
    if (proof.status === "failed" && proof.category === "DDL_PRIVILEGE" && /^[0-9A-Z]{5}$/.test(proof.sqlState) && Number.isInteger(proof.errno)) {
      console.log(JSON.stringify({ status: "failed", category: "DDL_PRIVILEGE", sqlState: proof.sqlState, errno: proof.errno }))
      failed = true
    } else if (proof.status === "verified" && result.code === 0 && proof.zeroForeignKeys === true && proof.account === "schema-ALL" && proof.denials === 3) {
      console.log(JSON.stringify({ status: "verified", java: "1.8.0_482", mysql: "5.7.44", jdbc: "8.0.33", account: "schema-ALL", zeroForeignKeys: true, denials: 3 }))
    } else throw Error("B1_PROBE")
  } finally { clearTimeout(childTimer); controller.signal.removeEventListener("abort", stopChild); await child.stop() }
} catch (error) {
  failed = true
  console.log(JSON.stringify({ status: "failed", category: controller.signal.aborted ? "CANCELLED" : /^B1_[A-Z_]+$/.test(error.message) ? error.message : error.failureCode ?? "IO", exitCode: error.exitCode ?? 1 }))
} finally {
  if (entry) try { console.log(JSON.stringify({ stage: "cleanup", ...await cleanupTestDatabase(entry) })) }
  catch { cleanupFailed = true; console.log(JSON.stringify({ stage: "cleanup", status: "failed", project: entry.project })) }
  if (temp) try { await removePrivateTemp(temp) } catch { cleanupFailed = true }
  clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel)
  process.exitCode = failed || cleanupFailed ? 1 : 0
}
