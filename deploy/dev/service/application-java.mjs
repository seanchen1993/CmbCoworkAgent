import { ownedProcess } from "../process.mjs"
import { appPassword, active } from "./test-database.mjs"

const modes = new Set(["suite", "reopen", "race-seed", "race-same", "race-cas-a", "race-cas-b", "race-verify", "hold"])
const controlled = mode => mode === "hold" || mode.startsWith("race-") && !["race-seed", "race-verify"].includes(mode)
const children = new Set()
let starts = 0, secretSends = 0
export function applicationChildFacts() { return { starts, secretSends, active: children.size } }
export function applicationMode(mode) { if (!modes.has(mode)) throw Error("C1_SELECTION"); return controlled(mode) }
export async function stopApplicationChildren() { await Promise.all([...children].map(child => child.stop())) }

export function parseApplicationProof(result, mode) {
  applicationMode(mode)
  if (result.spawnError || result.overflow || result.stderr || ![0, 1].includes(result.code)) throw Error("C1_JAVA_BOUNDARY")
  const lines = result.stdout.trim().split("\n").map(line => JSON.parse(line))
  if (controlled(mode)) {
    if (lines.shift()?.stage !== "armed") throw Error("C1_JAVA_BOUNDARY")
    if (mode !== "hold" && lines.shift()?.stage !== "started") throw Error("C1_JAVA_BOUNDARY")
    if (["race-cas-a", "race-cas-b"].includes(mode) && lines.shift()?.stage !== "scoped") throw Error("C1_JAVA_BOUNDARY")
  }
  if (lines.length !== 1) throw Error("C1_JAVA_BOUNDARY")
  const proof = lines[0]
  if (!["verified", "failed"].includes(proof.status) || (proof.status === "verified") !== (result.code === 0)) throw Error("C1_JAVA_BOUNDARY")
  if (proof.status === "failed") {
    if (proof.category !== "C1_PROBE_FAILURE" || !/^[a-z-]+$/.test(proof.stage)) throw Error("C1_JAVA_BOUNDARY")
  } else {
    for (const key of ["assertions", "denials", "replays", "rollbacks", "corruptReceipts"]) if (!Number.isSafeInteger(proof[key]) || proof[key] < 0) throw Error("C1_JAVA_BOUNDARY")
    if (mode.startsWith("race-") && controlled(mode) && (![201, 409].includes(proof.httpStatus) || !/^[A-Za-z0-9+/]{43}=$/.test(proof.bodyHash))) throw Error("C1_JAVA_BOUNDARY")
  }
  return { exitCode: result.code, proof }
}

// Only the fixed test main may receive this process's currently verified app
// credential. No arbitrary command, class, URL, environment or SQL selector.
export async function startApplicationJava(runtime, entry, mode, signal) {
  const keepOpen = applicationMode(mode)
  active(signal)
  const password = await appPassword(entry, signal)
  active(signal)
  const input = JSON.stringify({ mode: "local-dev", host: "127.0.0.1", port: entry.port, schema: "devclaw", user: "devclaw_app", password }) + "\n"
  active(signal)
  const child = ownedProcess(runtime.java, ["-Xmx256m", "-Duser.timezone=UTC", "-cp", runtime.classpath, "com.devclaw.botcontrol.application.ApplicationIntegrationProbe", mode], { cwd: runtime.dir, env: runtime.env, maxOutput: 1048576 })
  children.add(child); starts++
  let armedResolve, startedResolve, scopedResolve, timedOut = false, released = false, scopeReleased = false
  const armed = new Promise(resolve => { armedResolve = resolve }), started = new Promise(resolve => { startedResolve = resolve }), scoped = new Promise(resolve => { scopedResolve = resolve })
  const stop = () => { void child.stop() }
  const timer = setTimeout(() => { timedOut = true; stop() }, 90000)
  signal?.addEventListener("abort", stop, { once: true })
  child.child.stdin.on("error", () => {})
  child.child.stdout.on("data", () => {
    if (child.output.includes('{"stage":"armed"}\n')) armedResolve(true)
    if (child.output.includes('{"stage":"started"}\n')) startedResolve(true)
    if (child.output.includes('{"stage":"scoped"}\n')) scopedResolve(true)
  })
  const done = (async () => {
    try {
      const result = await child.done
      active(signal)
      if (timedOut) throw Error("C1_JAVA_TIMEOUT")
      return parseApplicationProof(result, mode)
    } finally {
      clearTimeout(timer); signal?.removeEventListener("abort", stop)
      await child.stop(); children.delete(child); armedResolve(false); startedResolve(false); scopedResolve(false)
    }
  })()
  done.catch(() => {}) // cancellation can precede the caller's awaited stage
  try {
    active(signal) // also catches abort during ready/secret validation
    secretSends++
    if (keepOpen) child.child.stdin.write(input); else child.child.stdin.end(input)
  } catch (error) { await child.stop(); try { await done } catch {} throw error }
  return {
    pid: child.child.pid, armed, started, scoped, done,
    get exited() { return child.exited },
    release() {
      active(signal)
      if (!keepOpen || released || child.exited) throw Error("C1_CONTROL")
      released = true
      if (["race-cas-a", "race-cas-b"].includes(mode)) child.child.stdin.write("go\n"); else child.child.stdin.end("go\n")
    },
    releaseScope() {
      active(signal)
      if (!["race-cas-a", "race-cas-b"].includes(mode) || !released || scopeReleased || child.exited) throw Error("C1_CONTROL")
      scopeReleased = true; child.child.stdin.end("commit-go\n")
    },
    async stop() { await child.stop(); try { await done } catch {} }
  }
}
export async function applicationJava(runtime, entry, mode, signal) {
  if (applicationMode(mode)) throw Error("C1_CONTROL")
  return (await startApplicationJava(runtime, entry, mode, signal)).done
}
