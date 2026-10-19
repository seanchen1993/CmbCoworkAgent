import { ownedProcess } from "../process.mjs"
import { active, appPassword } from "./test-database.mjs"
import { groupMemoryBoundaryClassification } from "./group-memory-java.mjs"
const children = new Set()
export async function stopTextDeliveryChildren() {
  const result = await Promise.allSettled([...children].map(child => child.stop()))
  if (result.some(r => r.status !== "fulfilled")) throw Error("TEXT_DELIVERY_CLEANUP")
}
export async function textDeliveryProbe(runtime, entry, action, fixture = {}, signal) {
  if (!["seed-v7", "verify-v7", "exercise"].includes(action)) throw Error("TEXT_DELIVERY_SELECTION")
  active(signal)
  const password = await appPassword(entry, signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, "com.devclaw.botcontrol.persistence.TextDeliveryDatabaseProbe", action], { cwd: runtime.dir, env: runtime.env, maxOutput: 131072 })
  children.add(child)
  let timedOut = false
  const stop = () => { void child.stop() }, timer = setTimeout(() => { timedOut = true; stop() }, 90000)
  signal?.addEventListener("abort", stop, { once: true }); child.child.stdin.on("error", () => {})
  try {
    active(signal)
    child.child.stdin.end(JSON.stringify({ db: { mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }, fixture }))
    const result = await child.done
    active(signal)
    const diagnostic = groupMemoryBoundaryClassification(result, password, timedOut)
    if (diagnostic.rejected) throw Error(diagnostic.category)
    const value = JSON.parse(result.stdout)
    if (result.code !== 0 || value.status !== "verified" || value.case !== action) {
      if (typeof value.site === "string" && /^[A-Za-z0-9_.$:,<>-]{1,600}$/.test(value.site)) console.error(JSON.stringify({ stage: "m03-java-safe-failure-site", site: value.site }))
      throw Error("TEXT_DELIVERY_" + (["input", "publish-rollback-loss", "reject-atomic", "frozen-input", "confirm-history-events", "confirm-replay-bytes", "completed-guards", "historical-create-receipt", "task-event-versions", "revoked-replay", "concurrent-mutations", "summary-pagination", "receipt-association", "managed-bot-binding", "group-withdrawal"].includes(value.phase) || /^summary-(?:[1-9]|[1-3][0-9]|4[01])-(?:observe|enqueue|claim|start|settle|publish|task|message)$/.test(value.phase ?? "") || ["summary-first-page", "summary-last-page"].includes(value.phase) ? value.phase.toUpperCase().replaceAll("-", "_") : "PROBE") + "_" + (/^[A-Z_]+$/.test(value.reason ?? "") ? value.reason : "ASSERTION"))
    }
    return value
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop); await child.stop(); children.delete(child)
    try { process.kill(child.child.pid, 0); throw Error("TEXT_DELIVERY_PID_RESIDUE") } catch (error) { if (error.code !== "ESRCH") throw error }
  }
}
