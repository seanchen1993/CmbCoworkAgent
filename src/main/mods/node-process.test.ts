import { afterAll, afterEach, beforeAll, expect, it } from "vitest"
import { build } from "esbuild"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { ModRuntimeClient } from "./runtime-client-core"
import { FunctionRuntimeClient } from "./v2/runtime-client-core"
import { launchNodeModProcess } from "./node-process"
import type { FunctionInvocation } from "../../shared/mods/v2/contracts"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout as delay } from "node:timers/promises"
import { ManagedModPolicy, DEFAULT_MOD_POLICY } from "./policy-core"
import { APIError } from "openai"
import { serializeBotFailure } from "../bots/error-diagnostic"
import { captureBotModelAttemptFailure } from "../bots/model-error-diagnostic-scope"

let directory: string
const clients: { stop(): void }[] = []
const invocation: FunctionInvocation = {
  event: "command.run",
  origin: { plugin: "engine", tier: "core" },
  capabilities: ["session.id"],
  plugin: { name: "probe", root: "/probe" }
}
const body = (value: string) => `var __cmbFunctionMod={register(on){${value}}}`
function client() {
  const value = new FunctionRuntimeClient(join(directory, "v2.cjs"), launchNodeModProcess)
  clients.push(value)
  return value
}
beforeAll(async () => {
  await mkdir(resolve("output"), { recursive: true })
  directory = await mkdtemp(resolve("output/mods-node-"))
  const result = await build({
    entryPoints: { v1: "src/main/mods/host-entry.ts", v2: "src/main/mods/v2/host-entry.ts" },
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outdir: directory,
    outExtension: { ".js": ".cjs" },
    external: ["quickjs-emscripten"],
    metafile: true
  })
  expect(
    Object.keys(result.metafile!.inputs).some((path) =>
      /desktop-process|runtime-client\.ts/.test(path)
    )
  ).toBe(false)
  expect(
    Object.values(result.metafile!.outputs)
      .flatMap((output) => output.imports)
      .some((item) => item.path === "electron")
  ).toBe(false)
})
afterEach(() => {
  for (const value of clients.splice(0)) value.stop()
})
afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true })
})

it("preserves exact model failure provenance through the real Function Mods worker and QuickJS error round trip", async () => {
  const connection = client()
  const guest = await connection.load(
    body('on("command.run",async($)=>({text:await $.model.complete({prompt:"test"})}))')
  )
  const sdk = APIError.generate(
    429,
    { message: "rejected opaque-provider-key-private" },
    "rejected",
    new Headers({ "x-request-id": "worker-provider" })
  )
  captureBotModelAttemptFailure(
    sdk,
    { status: 429, requestId: "worker-provider", callId: "worker-model-call" },
    ["opaque-provider-key-private"]
  )
  const error = await guest
    .invoke(
      "0",
      {},
      async () => {
        throw sdk
      },
      { ...invocation, capabilities: ["model.complete"] }
    )
    .catch((failure: unknown) => failure)
  const failure = serializeBotFailure(error)
  expect(failure.diagnostic).toMatchObject({
    status: 429,
    requestId: "worker-provider",
    callId: "worker-model-call"
  })
  expect(JSON.stringify(failure)).not.toContain("opaque-provider-key-private")
  expect(connection.stats).toMatchObject({ pending: 0, calls: 0 })
})

it("never trusts a guest diagnostic or reuses a prior invocation's failure proof for a later tool error", async () => {
  const connection = client()
  const guest = await connection.load(
    body(`let previous; on("command.run",async($,e)=>{
    if(e.first){try{await $.session.id()}catch(error){previous=error;throw error}}
    const error=Error("EACCES"); error.requestId="forged-provider";
    if(e.copy) Object.defineProperty(error,"__hostFailure",{value:previous.__hostFailure});
    throw error;
  })`)
  )
  const sdk = APIError.generate(
    429,
    { message: "old" },
    "old",
    new Headers({ "x-request-id": "old-worker-provider" })
  )
  captureBotModelAttemptFailure(sdk, {
    status: 429,
    requestId: "old-worker-provider",
    callId: "old-model-call"
  })
  const first = await guest
    .invoke(
      "0",
      { first: true },
      async () => {
        throw sdk
      },
      invocation
    )
    .catch((failure: unknown) => failure)
  expect(serializeBotFailure(first).diagnostic?.requestId).toBe("old-worker-provider")
  for (const copy of [false, true]) {
    const later = await guest
      .invoke("0", { copy }, async () => ({}), invocation)
      .catch((failure: unknown) => failure)
    expect(serializeBotFailure(later).diagnostic).not.toHaveProperty("requestId")
    expect(serializeBotFailure(later).diagnostic).not.toHaveProperty("callId")
  }
  expect(connection.stats).toMatchObject({ pending: 0, calls: 0 })
})

it("does not let guest code copy a real provider failure's proof to an unrelated error in the same invocation", async () => {
  const connection = client()
  const guest = await connection.load(
    body(`on("command.run",async($)=>{
    let previous; try{await $.session.id()}catch(error){previous=error}
    const error=Error("EACCES");
    Object.defineProperty(error,"__hostFailure",{value:previous.__hostFailure});
    throw error;
  })`)
  )
  const sdk = APIError.generate(
    429,
    { message: "old" },
    "old",
    new Headers({ "x-request-id": "same-invocation-provider" })
  )
  captureBotModelAttemptFailure(sdk, {
    status: 429,
    requestId: "same-invocation-provider",
    callId: "same-invocation-call"
  })
  const error = await guest
    .invoke(
      "0",
      {},
      async () => {
        throw sdk
      },
      invocation
    )
    .catch((failure: unknown) => failure)
  const failure = serializeBotFailure(error)
  expect(failure.message).toBe("EACCES")
  expect(failure.diagnostic).not.toHaveProperty("requestId")
  expect(failure.diagnostic).not.toHaveProperty("callId")
  expect(connection.stats).toMatchObject({ pending: 0, calls: 0 })
})

it("runs the existing v1 isolated runtime, with scoped next and no host globals", async () => {
  const legacy = new ModRuntimeClient(join(directory, "v1.cjs"), launchNodeModProcess)
  clients.push(legacy)
  const registrations = await legacy.load(
    "legacy",
    `var __cmbMod={default:{register(on){on.tool({id:"wrap",tools:["host:read_file"]},async($,e,next)=>({value:await next({args:{file_path:"note.txt"}}),globals:[typeof process,typeof require,typeof fetch]}))}}}`
  )
  expect(registrations).toHaveLength(1)
  const calls: unknown[] = []
  expect(
    await legacy.invoke("legacy", "wrap", {}, async (method, input) => {
      calls.push([method, input])
      return "content"
    })
  ).toEqual({ value: "content", globals: ["undefined", "undefined", "undefined"] })
  expect(calls).toEqual([["next", { args: { file_path: "note.txt" } }]])
  await legacy.unload("legacy")
  await expect(legacy.invoke("legacy", "wrap", {}, async () => null)).rejects.toThrow()
})

it.each(["v1", "v2"] as const)(
  "does not kill a healthy %s worker when the parent event loop briefly stalls",
  async (version) => {
    const connection =
      version === "v1"
        ? new ModRuntimeClient(join(directory, "v1.cjs"), launchNodeModProcess)
        : client()
    if (connection instanceof ModRuntimeClient) clients.push(connection)
    const invoke =
      connection instanceof ModRuntimeClient
        ? await (async () => {
            await connection.load(
              "healthy",
              'var __cmbMod={default:{register(on){on.command({id:"ping",command:"ping"},async()=>"alive")}}}'
            )
            return async () =>
              expect(await connection.invoke("healthy", "ping", {}, async () => null)).toBe("alive")
          })()
        : await (async () => {
            const guest = await connection.load(body('on("command.run",async()=>({text:"alive"}))'))
            return async () =>
              expect(await guest.invoke("0", {}, async () => ({}), invocation)).toEqual({
                value: { text: "alive" }
              })
          })()
    await invoke()
    const generation = connection.stats.generation
    await delay(300)
    // The child continues sending heartbeats while the parent's timers phase is blocked.
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2400)
        resolve()
      }, 25)
    )
    await delay(400)
    expect(connection.stats.generation).toBe(generation)
    await invoke()
  },
  15_000
)

it("publishes large managed policy results in the actual worker without granting its budget by runtime name", async () => {
  const connection = new ModRuntimeClient(join(directory, "v1.cjs"), launchNodeModProcess)
  clients.push(connection)
  const literals = Array.from(
    { length: 64 },
    (_, i) => `PRIVATE_VALUE_${i.toString().padStart(2, "0")}`
  )
  const policy = new ManagedModPolicy(
    { ...DEFAULT_MOD_POLICY, required: true, redactLiterals: literals },
    connection
  )
  const text = literals.join(" ").repeat(240)
  const result = await policy.filter({ text, nested: { text }, isError: true })
  expect(JSON.stringify(result.value)).not.toContain("PRIVATE_VALUE_")
  expect(result.ruleIds).toContain("deployment-literal")
  expect((result.value as { isError: boolean }).isError).toBe(true)
  policy.stop()
  await connection.load(
    "managed-policy",
    'var __cmbMod={default:{register(on){on.command({id:"loop",command:"loop"},async()=>{while(true){}})}}}'
  )
  await expect(connection.invoke("managed-policy", "loop", {}, async () => null)).rejects.toThrow(
    "MODS_BUDGET_EXCEEDED"
  )
})

it("keeps concurrent v2 replies bound to their invocation and cancels only one frame", async () => {
  const connection = client(),
    guest = await connection.load(
      body(`on("command.run",async($,e)=>({text:e.id+await $.session.id()}))`)
    )
  let started!: () => void
  const waiting = new Promise<void>((resolve) => {
    started = resolve
  })
  const abort = new AbortController()
  const first = guest
    .invoke(
      "0",
      { id: "A" },
      async (_method, _args, signal) => {
        started()
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        )
        return { value: "a" }
      },
      { ...invocation, signal: abort.signal }
    )
    .catch((error) => error)
  await waiting
  expect(await guest.invoke("0", { id: "B" }, async () => ({ value: "b" }), invocation)).toEqual({
    value: { text: "Bb" }
  })
  abort.abort()
  expect(await first).toBeInstanceOf(Error)
  expect(await guest.invoke("0", { id: "C" }, async () => ({ value: "c" }), invocation)).toEqual({
    value: { text: "Cc" }
  })
  expect(connection.stats.pending).toBe(0)
  expect(connection.stats.calls).toBe(0)
})

it("fences results from a killed worker and never retries an in-flight host effect", async () => {
  const connection = client(),
    guest = await connection.load(body(`on("command.run",async($)=>({text:await $.session.id()}))`))
  let calls = 0,
    release!: () => void,
    submitted!: () => void
  const ready = new Promise<void>((resolve) => {
    submitted = resolve
  })
  const pending = guest
    .invoke(
      "0",
      {},
      async () => {
        calls++
        submitted()
        await new Promise<void>((resolve) => {
          release = resolve
        })
        return { value: "late" }
      },
      invocation
    )
    .catch((error) => error)
  await ready
  process.kill(connection.stats.pid!, "SIGKILL")
  expect(await pending).toBeInstanceOf(Error)
  const next = await connection.load(body(`on("command.run",async()=>({text:"new worker"}))`))
  release()
  expect(await next.invoke("0", {}, async () => ({}), invocation)).toEqual({
    value: { text: "new worker" }
  })
  expect(calls).toBe(1)
  await expect(guest.invoke("0", {}, async () => ({}), invocation)).rejects.toThrow("MODS_UNLOADED")
})

it("interrupts synchronous guest loops without blocking the parent process", async () => {
  const connection = client(),
    guest = await connection.load(body(`on("command.run",async()=>{while(true){}})`))
  let ticks = 0
  const timer = setInterval(() => ticks++, 10)
  try {
    await expect(
      guest.invoke("0", {}, async () => ({}), { ...invocation, timeoutMs: 150 })
    ).rejects.toThrow()
    expect(ticks).toBeGreaterThan(1)
  } finally {
    clearInterval(timer)
  }
  const next = await connection.load(body(`on("command.run",async()=>({text:"ok"}))`))
  expect(await next.invoke("0", {}, async () => ({}), invocation)).toEqual({
    value: { text: "ok" }
  })
})

it("exits its actual worker when the owning IPC channel disappears", async () => {
  const child = spawn(process.execPath, [join(directory, "v2.cjs")], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {},
    serialization: "advanced"
  })
  const exited = once(child, "exit")
  try {
    const ready = await once(child, "message")
    expect(ready[0]).toEqual({ type: "ready" })
    child.disconnect()
    expect((await exited)[0]).toBe(0)
  } finally {
    if (child.exitCode === null) child.kill()
    await exited
  }
})
