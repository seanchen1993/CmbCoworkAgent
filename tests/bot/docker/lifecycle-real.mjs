import { fileURLToPath } from "node:url"
import { join } from "node:path"
import { lstat } from "node:fs/promises"
import { hostState, docker, BASE, RUNTIME, TOOLS } from "../../../deploy/dev/docker/host.mjs"
import { prepareProject, start, resources, cleanupTest } from "../../../deploy/dev/docker/lifecycle.mjs"
import { ownedProcess, run, isolatedEnv, privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const file = fileURLToPath(import.meta.url)
function safeError(error) { return { reason: /^B00_[A-Z0-9_]+$/.test(error.message) ? error.message : error.failureCode ?? "controlled", diagnosticsUnavailable: error.diagnosticsUnavailable === true, stopFailed: error.stopFailed === true } }

async function child() {
  const controller = new AbortController(), cancel = () => controller.abort()
  process.once("SIGTERM", cancel); process.once("SIGINT", cancel)
  const timer = setTimeout(cancel, 120000)
  const state = await hostState(), entry = await prepareProject(state, { test: true })
  console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
  try { await start(state, entry, { signal: controller.signal }); await new Promise(resolve => { if (controller.signal.aborted) resolve(); else controller.signal.addEventListener("abort", resolve, { once: true }) }); throw new Error("B00_CANCELLED") }
  catch (error) { console.log(JSON.stringify({ stage: "cancelled", ...safeError(error) })); process.exitCode = 1 }
  finally {
    console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) }))
    clearTimeout(timer); process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel)
  }
}

export async function lifecycleReal() {
  const state = await hostState(), dir = await privateTemp(), proof = []
  try {
    // A local absent Unix daemon must fail, not skip, within the normal bound.
    let absent = false
    try { await run(TOOLS.docker, ["--config", join(BASE, "client"), "--host", `unix://${dir}/absent.sock`, "info"], { env: state.env, cwd: BASE, timeoutMs: 5000 }) } catch (e) { absent = e.failureCode === "exit" && e.exitCode === 1 }
    if (!absent) throw new Error("B00_ABSENT_DAEMON")
    for (const override of [{ DOCKER_HOST: "tcp://192.0.2.1:2375" }, { COLIMA_PROFILE: "default" }]) {
      const p = ownedProcess(process.execPath, [fileURLToPath(new URL("../../../deploy/dev/docker/cli.mjs", import.meta.url)), "status"], { env: { ...isolatedEnv(dir), ...override }, cwd: dir })
      try { const result = await p.done; if (result.code !== 1 || !result.output.includes('"reason":"B00_HOST_OVERRIDE"')) throw new Error("B00_OVERRIDE_REJECTION") } finally { await p.stop() }
    }
    proof.push({ missingLocalDaemon: "exit1", remoteSocket: "rejected_before_connect", wrongProfile: "rejected_before_connect" })
    const entry = await prepareProject(state, { test: true })
    console.log(JSON.stringify({ stage: "claimed", project: entry.project }))
    try {
      let injected = false
      try { await start(state, entry, { failAt: "after-start" }) } catch (e) { injected = e.message === "B00_INJECTED" && !e.stopFailed }
      const current = await resources(state, entry)
      if (!injected || Object.keys(current.containers).length !== 3 || Object.values(current.containers).some(c => c.State.Running) || Object.keys(current.volumes).length !== 3) throw new Error("B00_FAILURE_STOP")
      proof.push({ project: entry.project, injectedFailure: "stopped_all_three", data: "retained_until_test_cleanup" })
    } finally { console.log(JSON.stringify({ stage: "cleaned", result: await cleanupTest(state, entry) })) }
    const p = ownedProcess(process.execPath, [file, "--signal-child"], { cwd: dir, env: isolatedEnv(dir) })
    let project, sent = false
    const deadline = Date.now() + 90000
    try {
      while (!p.exited && Date.now() < deadline) {
        const first = p.output.split("\n").find(line => line.includes('"stage":"claimed"'))
        if (first) project = JSON.parse(first).project
        if (project) {
          if (!/^devclaw-bot-test-[a-f0-9]{16}$/.test(project)) throw new Error("B00_CHILD_PROJECT")
          const live = await docker(state, ["ps", "-q", "--filter", `label=com.docker.compose.project=${project}`], { stdoutOnly: true, timeoutMs: 5000 })
          if (live) { p.child.kill("SIGTERM"); sent = true; break }
        }
        await delay(100)
      }
      if (!sent) throw new Error("B00_SIGNAL_SETUP")
      let timer, result
      try { result = await Promise.race([p.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("B00_SIGNAL_TIMEOUT")), 60000) })]) } finally { clearTimeout(timer) }
      if (result.code !== 1 || !result.output.includes('"stage":"cleaned"') || !result.output.includes('"stopFailed":false')) throw new Error("B00_SIGNAL_CLEANUP")
      for (const [type, command] of [["container", ["ps", "-aq"]], ["volume", ["volume", "ls", "-q"]], ["network", ["network", "ls", "-q"]]]) {
        const owned = await docker(state, [...command, "--filter", `label=com.docker.compose.project=${project}`], { stdoutOnly: true })
        if (owned) throw new Error("B00_SIGNAL_CLEANUP")
      }
      try { await lstat(join(RUNTIME, project)); throw new Error("B00_SIGNAL_CLEANUP") } catch (e) { if (e.code !== "ENOENT") throw e }
      proof.push({ project, signal: "SIGTERM", childExit: result.code, containers: "none", volumes: "none", network: "none", directory: "ENOENT" })
    } finally { await p.stop() }
    return proof
  } finally { await removePrivateTemp(dir) }
}

if (process.argv[1] === file) {
  try { if (process.argv[2] === "--signal-child") await child(); else console.log(JSON.stringify({ status: "verified", proof: await lifecycleReal() })) }
  catch (error) { console.log(JSON.stringify({ status: "failed", ...safeError(error) })); process.exitCode = 1 }
}
