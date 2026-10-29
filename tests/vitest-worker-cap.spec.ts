/** Actual child Tinypool regression. Run alone: npx tsx tests/vitest-worker-cap.spec.ts */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

async function main(): Promise<void> {
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const temporaryRoot = await realpath(tmpdir())
  const owned = await mkdtemp(join(temporaryRoot, "vitest-worker-cap-"))
  assert.equal(dirname(owned), temporaryRoot)
  const active = new Set<string>()
  const entered = new Set<string>()
  const completed = new Set<string>()
  const workerPids = new Set<number>()
  const pending: ServerResponse[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const protocolErrors: string[] = []
  let peak = 0
  const server = createServer((request, response) => {
    const match = /^\/(hold|leave)\/([1-4])$/.exec(request.url ?? "")
    const pid = Number(request.headers["x-probe-pid"])
    if (request.method !== "POST" || !match || !Number.isSafeInteger(pid) || pid < 1) {
      protocolErrors.push("invalid request")
      response.writeHead(400).end()
      return
    }
    const [, operation, id] = match
    if (operation === "hold") {
      if (entered.has(id)) {
        protocolErrors.push(`duplicate hold ${id}`)
        response.writeHead(409).end()
        return
      }
      entered.add(id)
      active.add(id)
      workerPids.add(pid)
      peak = Math.max(peak, active.size)
      pending.push(response)
      // Hold real fixture executions until a second worker arrives, then briefly overlap.
      // Each fixture keeps its ordinary 5000ms test timeout; only the parent has an OS budget.
      if (pending.length >= 2) {
        const pair = pending.splice(0, 2)
        const timer = setTimeout(() => {
          timers.delete(timer)
          for (const held of pair) held.writeHead(200).end()
        }, 250)
        timers.add(timer)
      }
    } else {
      if (!active.delete(id) || completed.has(id)) {
        protocolErrors.push(`unmatched leave ${id}`)
        response.writeHead(409).end()
        return
      }
      completed.add(id)
      response.writeHead(200).end()
    }
  })
  try {
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    assert(address && typeof address !== "string")
    const endpoint = `http://127.0.0.1:${address.port}`
    await mkdir(join(owned, "fixtures"))
    for (let id = 1; id <= 4; id++) {
      await writeFile(
        join(owned, "fixtures", `${id}.test.mjs`),
        `
it("measures actual worker ${id}", async () => {
  const headers = { "x-probe-pid": String(process.pid) }
  const held = await fetch(${JSON.stringify(`${endpoint}/hold/${id}`)}, { method: "POST", headers })
  try {
    expect(held.status).toBe(200)
  } finally {
    const left = await fetch(${JSON.stringify(`${endpoint}/leave/${id}`)}, { method: "POST", headers })
    expect(left.status).toBe(200)
  }
})
`
      )
    }
    const configPath = join(owned, "vitest.config.mts")
    const basePath = relative(owned, join(repository, "vitest.config.ts")).replaceAll("\\", "/")
    const baseImport = basePath.startsWith(".") || isAbsolute(basePath) ? basePath : `./${basePath}`
    await writeFile(
      configPath,
      `
import base from ${JSON.stringify(baseImport)}
const parallel = base.test.projects.find(project => project.test?.name === "parallel")
if (!parallel) throw Error("Original parallel project missing")
export default {
  ...base,
  root: ${JSON.stringify(owned)},
  test: {
    ...base.test,
    globals: true,
    projects: [{ ...parallel, test: {
      ...parallel.test, include: ["fixtures/*.test.mjs"], exclude: []
    } }]
  }
}
`
    )
    const runner = join(owned, "run.mjs")
    const vitestNode = pathToFileURL(createRequire(import.meta.url).resolve("vitest/node")).href
    await writeFile(
      runner,
      `
import { createVitest } from ${JSON.stringify(vitestNode)}
const context = await createVitest("test", {
  root: ${JSON.stringify(owned)}, config: ${JSON.stringify(configPath)},
  watch: false, reporters: ["dot"]
})
try {
  console.log("WORKER_PROBE_CONFIG=" + JSON.stringify({
    maxWorkers: context.config.maxWorkers, minWorkers: context.config.minWorkers,
    testTimeout: context.config.testTimeout,
    projects: context.projects.map(project => ({
      maxWorkers: project.config.maxWorkers, minWorkers: project.config.minWorkers,
      testTimeout: project.config.testTimeout
    }))
  }))
  if (context.config.maxWorkers !== 2 || context.config.minWorkers !== 1)
    throw Error("Original global worker cap is missing; refuse to spawn an unbounded pool")
  await context.start()
  const files = context.state.getFiles()
  if (files.length !== 4 || files.some(file => file.result?.state !== "pass") ||
      context.state.getUnhandledErrors().length) process.exitCode = 1
} finally {
  await context.close()
}
`
    )
    const child = spawn(process.execPath, [runner], {
      cwd: owned,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TEMP: owned, TMP: owned, TMPDIR: owned }
    })
    let terminating = false
    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null) return
      if (terminating) return
      terminating = true
      if (process.platform === "win32" && child.pid) {
        // Only this probe's newly spawned process tree; never enumerate or stop another run.
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        })
        killer.on("error", () => {
          child.kill()
        })
      } else child.kill()
    }
    let output = ""
    let timedOut = false
    let overflow = false
    const collect = (chunk: Buffer) => {
      if (overflow) return
      output += chunk.toString("utf8")
      if (Buffer.byteLength(output) > 128 * 1024) {
        overflow = true
        terminate()
      }
    }
    child.stdout.on("data", collect)
    child.stderr.on("data", collect)
    // New parent-only startup/teardown allowance, not a change to any test case timeout.
    const timer = setTimeout(() => {
      timedOut = true
      terminate()
    }, 60_000)
    let code: unknown
    try {
      const result = await once(child, "close")
      code = result[0]
    } finally {
      clearTimeout(timer)
      terminate()
    }
    assert(!timedOut, `Child Vitest exceeded its OS startup budget\n${output}`)
    assert(!overflow, "Child Vitest exceeded its bounded diagnostic output")
    assert.equal(code, 0, output)
    const marker = output.split(/\r?\n/).find((line) => line.startsWith("WORKER_PROBE_CONFIG="))
    assert(marker, output)
    const effective = JSON.parse(marker.slice("WORKER_PROBE_CONFIG=".length))
    assert.equal(effective.maxWorkers, 2)
    assert.equal(effective.minWorkers, 1)
    assert.equal(effective.testTimeout, 5000)
    assert.deepEqual(effective.projects, [{ maxWorkers: 2, minWorkers: 1, testTimeout: 5000 }])
    assert.deepEqual(protocolErrors, [])
    assert.equal(entered.size, 4)
    assert.equal(completed.size, 4)
    assert.equal(active.size, 0)
    assert.equal(peak, 2, "The real Tinypool must execute exactly two fixture files at once")
    assert(workerPids.size >= 2, "Concurrent fixtures must come from actual child workers")
    console.log(
      `Vitest worker cap PASS: global=2/1, actual peak=${peak}, fixtures=4, timeout=5000ms`
    )
  } finally {
    for (const timer of timers) clearTimeout(timer)
    for (const response of pending) response.destroy()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
    const actualOwned = await realpath(owned)
    assert.equal(actualOwned, owned)
    assert.equal(dirname(actualOwned), temporaryRoot)
    await rm(actualOwned, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
