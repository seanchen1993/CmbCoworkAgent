import { ownedProcess } from "../process.mjs"
import { active, appPassword } from "./test-database.mjs"

const children = new Set(), actions = new Set(["seed-v5", "verify-v5", "faults", "expire", "facts", "other-space"])
const phases = new Set(["input", "seed-v5", "verify-v5", "write-faults", "expire", "other-space"])
// Pure classification only: never retain/return any child bytes, error detail,
// credential, command line or runtime path in a diagnostic.
export function groupMemoryBoundaryClassification(result, password, timedOut = false) {
  const stdout = typeof result.stdout === "string" ? result.stdout : ""
  const lines = stdout.trim() ? stdout.trim().split("\n").length : 0
  const flags = {
    stderr: Boolean(result.stderr), spawn: Boolean(result.spawnError), overflow: Boolean(result.overflow), timeout: Boolean(timedOut),
    exit: result.code === null ? "NONE" : Number.isInteger(result.code) && result.code >= 0 && result.code <= 255 ? String(result.code) : "UNKNOWN",
    lines: lines === 0 ? "ZERO" : lines === 1 ? "ONE" : "MULTIPLE",
    password: typeof password === "string" && password.length > 0 && stdout.includes(password),
    jdbc: /jdbc:mysql:/.test(stdout), exception: /Exception/.test(stdout), stack: /at com\.devclaw\./.test(stdout)
  }
  const rejected = flags.stderr || flags.spawn || flags.overflow || flags.timeout || ![0, 1].includes(result.code) || typeof result.stdout !== "string" || flags.lines !== "ONE" || flags.password || flags.jdbc || flags.exception || flags.stack
  const category = "GROUP_MEMORY_BOUNDARY_" + Object.entries(flags).map(([key, value]) => `${key.toUpperCase()}_${typeof value === "boolean" ? Number(value) : value}`).join("_")
  return { rejected, flags, category }
}
export async function stopGroupMemoryChildren() {
  const result = await Promise.allSettled([...children].map(child => child.stop()))
  if (result.some(value => value.status !== "fulfilled")) throw Error("GROUP_MEMORY_CLEANUP")
}
export async function groupMemoryProbe(runtime, entry, action, fixture = {}, signal) {
  if (!actions.has(action)) throw Error("GROUP_MEMORY_SELECTION")
  active(signal); const password = await appPassword(entry, signal); active(signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, "com.devclaw.botcontrol.persistence.GroupMemoryDatabaseProbe", action], { cwd: runtime.dir, env: runtime.env, maxOutput: 131072 })
  let timedOut = false
  children.add(child); const stop = () => { void child.stop() }, timer = setTimeout(() => { timedOut = true; stop() }, 45000)
  signal?.addEventListener("abort", stop, { once: true }); child.child.stdin.on("error", () => {})
  try {
    active(signal); child.child.stdin.end(JSON.stringify({ db: { mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }, fixture }))
    const result = await child.done; active(signal)
    const diagnostic = groupMemoryBoundaryClassification(result, password, timedOut)
    if (diagnostic.rejected) throw Error(diagnostic.category)
    let value
    try { value = JSON.parse(result.stdout) } catch { throw Error("GROUP_MEMORY_PROOF_JSON_INVALID") }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("GROUP_MEMORY_PROOF_SHAPE_INVALID")
    if (result.code !== 0 || value.status !== "verified" || value.case !== action) throw Error(`GROUP_MEMORY_${phases.has(value.phase) ? value.phase.toUpperCase().replaceAll("-", "_") : "PROBE"}`)
    return value
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop); await child.stop(); children.delete(child)
    try { process.kill(child.child.pid, 0); throw Error("GROUP_MEMORY_PID_RESIDUE") } catch (error) { if (error.code !== "ESRCH") throw error }
  }
}
