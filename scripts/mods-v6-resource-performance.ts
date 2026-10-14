import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { FunctionProcessHost, type FunctionProcessContext } from "../src/main/mods/v2/process-sdk"

async function main() {
  const host = new FunctionProcessHost()
  const controller = new AbortController()
  const context: FunctionProcessContext = {
    cwd: process.cwd(),
    signal: controller.signal,
    assertLive() {
      controller.signal.throwIfAborted()
    },
    authorize: async () => {
      /* This local benchmark explicitly starts its own fixture. */
    },
    publish: async (value) => value
  }
  const started = performance.now()
  const streams = Array.from({ length: 5 }, () =>
    host.spawn(
      {
        argv: [process.execPath, "-e", "setInterval(()=>{},1000)"],
        init: { env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {} }
      },
      context
    )
  )
  const pulls = streams.map((stream) => stream.stream.next().catch(() => undefined))
  try {
    await Promise.all(streams.map((stream) => stream.started))
    const startupMs = performance.now() - started
    const idleStarted = performance.now()
    const cpu = process.cpuUsage()
    const rss = process.memoryUsage().rss
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const idleMs = performance.now() - idleStarted
    const cpuUsed = process.cpuUsage(cpu)
    const idleRssDelta = process.memoryUsage().rss - rss
    const closeStarted = performance.now()
    await Promise.all(streams.map((stream) => stream.close()))
    await Promise.all(pulls)
    const closeMs = performance.now() - closeStarted
    const report = {
      fixture: "five approved silent native processes, pending first pull; no model/network",
      platform: process.platform,
      node: process.version,
      startupMs,
      idleMs,
      idleHostCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
      idleHostCpuPercent: (cpuUsed.user + cpuUsed.system) / (idleMs * 10),
      idleHostRssDeltaBytes: idleRssDelta,
      closeMs,
      limits: "Per-stream queue pauses at 1MiB; hard cap 1MiB+128KiB. Child/helper memory excluded."
    }
    const output = resolve(process.argv[2] ?? "output/mods-v6-validation/resource-performance.json")
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, JSON.stringify(report, null, 2) + "\n")
    console.log(JSON.stringify(report))
  } finally {
    controller.abort()
    await Promise.allSettled(streams.map((stream) => stream.close()))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
