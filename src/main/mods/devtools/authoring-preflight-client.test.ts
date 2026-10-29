import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { Worker } from "node:worker_threads"
import { afterEach, expect, it, vi } from "vitest"
import { AuthoringPreflightClient } from "./authoring-preflight-client"
import { AuthoringStructureError } from "./authoring-structure-diagnostics"

const roots: string[] = []
const clients: AuthoringPreflightClient[] = []
async function create(code: string) {
  const root = await mkdtemp(join(tmpdir(), "cmb-authoring-worker-test-"))
  roots.push(root)
  const entry = join(root, "worker.cjs")
  await writeFile(entry, code, "utf8")
  const client = new AuthoringPreflightClient(entry)
  clients.push(client)
  return client
}
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(clients.splice(0).map((client) => client.stop()))
  for (const root of roots.splice(0)) {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()))
    assert(basename(root).startsWith("cmb-authoring-worker-test-"))
    await rm(root, { recursive: true, force: true })
  }
})

it("keeps the main event loop responsive and aborts a CPU-bound real Worker", async () => {
  const client = await create("while(true){}")
  const controller = new AbortController()
  let heartbeats = 0
  const heartbeat = setInterval(() => {
    heartbeats++
  }, 10)
  const timer = setTimeout(() => controller.abort(), 100)
  try {
    await expect(client.run(tmpdir(), controller.signal)).rejects.toThrow(
      "AUTHORING_PREVIEW_CANCELLED"
    )
    expect(heartbeats).toBeGreaterThan(0)
    await expect(client.run(tmpdir(), new AbortController().signal)).rejects.toThrow(
      "AUTHORING_PREFLIGHT_CLOSED"
    )
  } finally {
    clearInterval(heartbeat)
    clearTimeout(timer)
  }
})

it("waits for native termination acknowledgement before publishing cancellation", async () => {
  const original = Worker.prototype.terminate
  let release!: () => void
  let terminated!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const native = new Promise<void>((resolve) => {
    terminated = resolve
  })
  vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function (this: Worker) {
    const code = await original.call(this)
    terminated()
    await gate
    return code
  })
  const client = await create("while(true){}")
  const controller = new AbortController()
  let settled = false
  const result = client.run(tmpdir(), controller.signal).then(
    () => {
      settled = true
      return "success"
    },
    (error) => {
      settled = true
      return error.message
    }
  )
  controller.abort()
  await native
  expect(settled).toBe(false)
  release()
  expect(await result).toBe("AUTHORING_PREVIEW_CANCELLED")
})

it("rejects worker failure and malformed output after terminating the worker", async () => {
  for (const code of [
    'throw Error("private source")',
    'require("node:worker_threads").parentPort.postMessage({ok:true,text:"bad"});setInterval(()=>{},1000)'
  ]) {
    const client = await create(code)
    await expect(client.run(tmpdir(), new AbortController().signal)).rejects.toThrow(
      "AUTHORING_PREFLIGHT_FAILED"
    )
    await client.stop()
  }
})

it("preserves only fixed structural diagnostics across the actual Worker boundary", async () => {
  const client = await create(
    'require("node:worker_threads").parentPort.postMessage({ok:false,structureCode:"CLAW_COMPONENT_ENTRY_CONFLICT",message:"PRIVATE_WORKER_SOURCE"});setInterval(()=>{},1000)'
  )
  const failure = await client.run(tmpdir(), new AbortController().signal).catch((error) => error)
  expect(failure).toBeInstanceOf(AuthoringStructureError)
  expect(failure.message).toBe("CLAW_COMPONENT_ENTRY_CONFLICT")
  expect(failure.diagnostic.path).toBe("/entry")
  expect(JSON.stringify(failure)).not.toContain("PRIVATE_WORKER_SOURCE")
})

it.each(["PRIVATE_WORKER_SOURCE", "__proto__", "constructor", "MODS_PRIVATE_SECRET"])(
  "rejects unknown structural code %s without exposing it",
  async (code) => {
    const client = await create(
      `require("node:worker_threads").parentPort.postMessage({ok:false,structureCode:${JSON.stringify(code)}})`
    )
    await expect(client.run(tmpdir(), new AbortController().signal)).rejects.toThrow(
      "AUTHORING_PREFLIGHT_FAILED"
    )
  }
)
