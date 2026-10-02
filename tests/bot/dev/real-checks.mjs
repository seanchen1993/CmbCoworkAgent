import assert from "node:assert/strict"
import { access } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import net from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { realProbe } from "../../../deploy/dev/mysql-probe.mjs"
import { ownedProcess, isolatedEnv, privateTemp, removePrivateTemp } from "../../../deploy/dev/process.mjs"

async function assertClosed(port) {
  await assert.rejects(new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("port check timed out")) })
    socket.once("connect", () => { socket.destroy(); resolve() })
    socket.once("error", reject)
  }), { code: "ECONNREFUSED" })
}

async function verifyResources(resources) {
  const created = resources.find((entry) => entry.directory && !entry.cleaned)
  assert.ok(created, "real temporary resource allocated")
  assert.equal(resources.at(-1).cleaned, true)
  await assert.rejects(access(created.directory), { code: "ENOENT" })
  const started = resources.filter((entry) => entry.phase)
  for (const entry of started) {
    assert.ok(resources.some((record) => record.stopped && record.pid === entry.pid), "owned process close awaited")
    assert.throws(() => process.kill(entry.pid, 0), { code: "ESRCH" }) // read-only existence check; never kill by PID
    if (entry.port) { assert.notEqual(entry.port, 3306); await assertClosed(entry.port) }
  }
  return { directoryRemoved: true, stoppedOwnedProcesses: started.map((entry) => entry.pid), portsClosed: started.filter((entry) => entry.port).map((entry) => entry.port) }
}

async function signalCheck(config, tools, signal) {
  const dir = await privateTemp()
  const args = [fileURLToPath(new URL("real-child.mjs", import.meta.url)), "real", "--profile", config.profile]
  for (const key of ["java", "javac", "mysql", "mysqld", "mysql-messages", "jdbc"]) if (tools[key]) args.push(`--${key}`, tools[key])
  const child = ownedProcess(process.execPath, args, { cwd: dir, env: isolatedEnv(dir, tools.java) })
  child.child.stdin.end()
  const timeout = setTimeout(() => { void child.stop() }, 40000)
  const cancel = () => { void child.stop() }
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    const deadline = Date.now() + 35000
    while (!child.output.includes('"phase":"network-disabled"') && !child.exited && Date.now() < deadline && !signal?.aborted) await delay(20)
    assert.ok(child.output.includes('"phase":"network-disabled"'), "actual MySQL child started before SIGTERM")
    await child.stop() // sends SIGTERM to this held Node child, awaits its finally
    const result = await child.done
    assert.equal(result.code, 0)
    const events = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    assert.ok(events.some((event) => event.failure?.reason === "cancelled"))
    return { classification: "real", failureFixture: "OS_SIGTERM", passed: true, verifiedCleanup: await verifyResources(events.flatMap((event) => event.resource ? [event.resource] : [])) }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    await child.stop()
    await removePrivateTemp(dir)
  }
}

export async function runRealChecks(config, tools, signal, emit = () => {}) {
  const directories = new Set()
  for (let iteration = 0; iteration < 2; iteration++) {
    const resources = []
    const result = await realProbe(config, tools, { signal, onResource: (entry) => resources.push(entry) })
    const directory = resources[0].directory
    assert.ok(!directories.has(directory), "independently empty instance each run")
    directories.add(directory)
    emit({ iteration: iteration + 1, ...result, verifiedCleanup: await verifyResources(resources) })
  }
  for (const fault of ["after-initialize", "after-bootstrap", "after-listen", "bootstrap-startup-failure"]) {
    const resources = []
    await assert.rejects(realProbe(config, tools, { signal, fault, onResource: (entry) => resources.push(entry) }), (error) => {
      assert.equal(error.code, "DEV_PROBE_FAILED")
      assert.equal(error.diagnostic.reason, fault === "bootstrap-startup-failure" ? "exit" : "injected")
      return true
    })
    emit({ classification: "real", failureFixture: fault, passed: true, verifiedCleanup: await verifyResources(resources) })
  }
  emit(await signalCheck(config, tools, signal))
}
