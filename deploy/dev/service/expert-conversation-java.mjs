import { ownedProcess } from "../process.mjs"
import { active, appPassword } from "./test-database.mjs"
import { groupMemoryBoundaryClassification } from "./group-memory-java.mjs"
const children = new Set()
export async function stopExpertConversationChildren() {
  const results = await Promise.allSettled([...children].map(child => child.stop()))
  if (results.some(result => result.status !== "fulfilled")) throw Error("EXPERT_CONVERSATION_CLEANUP")
}
export async function expertConversationProbe(runtime, entry, action, fixture = {}, signal) {
  if (!["seed-v8", "verify-v8", "exercise"].includes(action)) throw Error("EXPERT_CONVERSATION_SELECTION")
  active(signal)
  const password = await appPassword(entry, signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, "com.devclaw.botcontrol.persistence.ExpertConversationDatabaseProbe", action], { cwd: runtime.dir, env: runtime.env, maxOutput: 131072 })
  children.add(child)
  let timedOut = false
  const stop = () => { void child.stop() }, timer = setTimeout(() => { timedOut = true; stop() }, 90000)
  signal?.addEventListener("abort", stop, { once: true }); child.child.stdin.on("error", () => {})
  try {
    child.child.stdin.end(JSON.stringify({ db: { mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }, fixture }))
    const result = await child.done
    active(signal)
    const diagnostic = groupMemoryBoundaryClassification(result, password, timedOut)
    if (diagnostic.rejected) throw Error(diagnostic.category)
    const value = JSON.parse(result.stdout)
    if (result.code !== 0 || value.status !== "verified" || value.case !== action) throw Error("EXPERT_CONVERSATION_" + (/^[a-z-]+$/.test(value.phase ?? "") ? value.phase.toUpperCase().replaceAll("-", "_") : "PROBE") + "_" + (/^[A-Z0-9_]+$/.test(value.reason ?? "") ? value.reason : "ASSERTION"))
    return value
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop); await child.stop(); children.delete(child)
    try { process.kill(child.child.pid, 0); throw Error("EXPERT_CONVERSATION_PID_RESIDUE") } catch (error) { if (error.code !== "ESRCH") throw error }
  }
}
