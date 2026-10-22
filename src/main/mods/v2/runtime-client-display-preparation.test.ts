import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionDisplayRouting } from "./display-routing"

const { fork } = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock("electron", () => ({ utilityProcess: { fork } }))
import { FunctionRuntimeClient } from "./runtime-client"

const clients: FunctionRuntimeClient[] = [],
  workers: Worker[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) client.stop()
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
  vi.restoreAllMocks()
})

it("prepares the actual host-entry source off Main through the existing authenticated native load exchange", async () => {
  const entry = new URL("./host-entry.ts", import.meta.url).href
  let stderr = ""
  fork.mockImplementation(() => {
    // Bounded test adapter for Electron's port. The product reuses utilityProcess, not this worker.
    const worker = new Worker(
      `
      const { parentPort } = require('node:worker_threads');
      process.parentPort = { on: (event, callback) => parentPort.on(event, data => callback({data})),
        postMessage: value => parentPort.postMessage(value) };
      require("tsx/cjs");
      try { require(require("node:url").fileURLToPath(${JSON.stringify(entry)})); } catch(error) { console.error(error); process.exit(1) }
    `,
      { eval: true, execArgv: ["--import", "tsx"], stdout: true, stderr: true }
    )
    worker.stderr?.on("data", (data) => {
      stderr += String(data)
    })
    workers.push(worker)
    return Object.assign(worker, {
      kill: () => {
        void worker.terminate()
        return true
      }
    })
  })
  const built = await build({
    stdin: {
      contents: `export function register(on) {
    on("ui.render",{component:"AssistantMessage"},($,e)=>({type:"Text",props:{text:e.props.text}}))
  }`
    },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "__cmbFunctionMod",
    target: "es2016"
  })
  const code = built.outputFiles[0].text,
    client = new FunctionRuntimeClient("native-source-test")
  clients.push(client)
  const guest = await client.load(code).catch((error) => {
    throw Error(`${String(error)}\n${stderr}`)
  })
  const analyze = vi.fn(() => {
    throw Error("Main AST parser must not execute")
  })
  const routing = new FunctionDisplayRouting(analyze)
  expect(routing.qualify([{ guest, code }], "AssistantMessage"), stderr).toEqual({
    native: false,
    expectedRefs: []
  })
  expect(analyze).not.toHaveBeenCalled()
  expect(fork).toHaveBeenCalledTimes(1)
  client.stop()
  expect(() => routing.qualify([{ guest, code }], "AssistantMessage")).not.toThrow()
  expect(routing.qualify([{ guest, code }], "AssistantMessage")).toBeUndefined()
}, 15000)
