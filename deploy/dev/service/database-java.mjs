import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { run, privateTemp, removePrivateTemp, isolatedEnv, ownedProcess } from "../process.mjs"
import { appPassword, active } from "./test-database.mjs"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const jdk = "/Users/heyirui/Library/Java/JavaVirtualMachines/corretto-1.8.0_482-1/Contents/Home"
export async function packagedDatabaseRuntime() {
  const dir = await privateTemp(), java = join(jdk, "bin/java"), env = isolatedEnv(dir, java)
  try {
    const jar = join(root, "services/bot-control/target/bot-control-0.0.1-SNAPSHOT.jar")
    await run(join(jdk, "bin/jar"), ["xf", jar], { cwd: dir, env, timeoutMs: 15000 })
    return { dir, java, env, classpath: `${join(dir, "BOOT-INF/classes")}:${join(dir, "BOOT-INF/lib/*")}:${join(root, "services/bot-control/target/test-classes")}` }
  } catch (error) { await removePrivateTemp(dir); throw error }
}
export async function closeDatabaseRuntime(runtime) { await removePrivateTemp(runtime.dir) }

// Only an actually registered, currently owner/daemon/port/listener-verified
// test DB may supply a password. Java input does not claim a self-reported owner.
export async function javaDatabase(runtime, entry, command, { signal, probe = false, badPassword = false, onArmed } = {}) {
  const permitted = probe ? ["store", "reload", "history", "offline"] : ["migrate", "readiness"]
  if (!permitted.includes(command) || (badPassword && (probe || command !== "readiness")) || (onArmed && (!probe || command !== "offline"))) throw Error("B1_SELECTION")
  active(signal)
  const password = await appPassword(entry, signal)
  active(signal)
  const input = JSON.stringify({ mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password: badPassword ? "0".repeat(64) : password })
  const main = `com.devclaw.botcontrol.persistence.${probe ? "DatabaseIntegrationProbe" : "DatabaseCommand"}`
  active(signal)
  const child = ownedProcess(runtime.java, ["-Duser.timezone=UTC", "-cp", runtime.classpath, main, command], { cwd: runtime.dir, env: runtime.env, maxOutput: 32768 })
  let timedOut = false, armedPromise, armed = false
  const stop = () => { void child.stop() }
  const timer = setTimeout(() => { timedOut = true; stop() }, 45000)
  signal?.addEventListener("abort", stop, { once: true })
  if (onArmed) child.child.stdout.on("data", () => {
    if (!armed && child.output.includes('{"stage":"armed"}')) { armed = true; armedPromise = Promise.resolve().then(onArmed); armedPromise.catch(stop) }
  })
  child.child.stdin.on("error", () => {})
  try {
    active(signal) // cancellation while ready/secret validation must not send it
    child.child.stdin.end(input)
    const result = await child.done
    if (armedPromise) await armedPromise
    active(signal)
    if (timedOut || result.spawnError || result.overflow || result.stderr || ![0, 1].includes(result.code)) throw Error("B1_JAVA_BOUNDARY")
    const lines = result.stdout.trim().split("\n")
    if (onArmed && (!armed || lines.shift() !== '{"stage":"armed"}')) throw Error("B1_JAVA_BOUNDARY")
    if (lines.length !== 1) throw Error("B1_JAVA_BOUNDARY")
    const proof = JSON.parse(lines[0])
    if (!["verified", "failed"].includes(proof.status) || (proof.status === "verified") !== (result.code === 0)) throw Error("B1_JAVA_BOUNDARY")
    // Caller never emits arbitrary child text. Only fixed expected categories.
    return { exitCode: result.code, proof }
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); await child.stop() }
}
