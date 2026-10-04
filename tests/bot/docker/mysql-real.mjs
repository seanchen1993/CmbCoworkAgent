import { hostState } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, start, restart, cleanupTest, verifyListeners } from "../../../deploy/dev/docker/lifecycle.mjs"
import { compileDockerProbe, jdbc } from "../../../deploy/dev/docker/probe.mjs"
import { privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"
export { verifyListeners }

export async function mysqlReal(tools, signal) {
  const state = await hostState(), dir = await privateTemp()
  const proof = []
  try {
    proof.push({ driver: await compileDockerProbe(tools, dir, signal) })
    for (let i = 0; i < 2; i++) {
      const entry = await prepareProject(state, { test: true })
      console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
      try {
        const started = await start(state, entry, { signal })
        const listener = await verifyListeners(started.port)
        const empty = await jdbc(state, entry, tools, dir, "empty", { signal })
        const probe = await jdbc(state, entry, tools, dir, "probe", { signal })
        for (const [action, options] of [["ping", { wrongPassword: true }], ["reject-version", {}]]) {
          let rejected = false
          try { await jdbc(state, entry, tools, dir, action, { ...options, signal }) } catch (error) { rejected = error.failureCode === "exit" && error.exitCode === 1 }
          if (!rejected) throw new Error("B00_EXPECTED_REJECTION")
        }
        const restarted = await restart(state, entry)
        const persisted = await jdbc(state, entry, tools, dir, "persist", { signal })
        proof.push({ project: entry.project, started, listener, empty, probe, restarted, persisted })
      } finally {
        console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) }))
      }
    }
    return proof
  } finally { await removePrivateTemp(dir) }
}

if (process.argv[1]?.endsWith("/mysql-real.mjs")) {
  const [java, javac, jdbcJar] = process.argv.slice(2)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  const timer = setTimeout(cancel, 600000)
  try {
    console.log(JSON.stringify({ status: "verified", proof: await mysqlReal({ java, javac, jdbc: jdbcJar }, controller.signal) }))
  } catch (error) {
    console.log(JSON.stringify({ status: "failed", reason: /^B00_[A-Z_]+$/.test(error.message) ? error.message : error.failureCode || "controlled", exit: error.exitCode ?? 1, diagnostics: error.diagnostics }))
    process.exitCode = 1
  } finally { clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }
}
