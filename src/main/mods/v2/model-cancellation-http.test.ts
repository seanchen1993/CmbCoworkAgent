import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ModControlStore } from "../control-store"
import { FunctionModels } from "./models"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { invokeFunctionModel } from "./model-provider"
import { CompletionBudget, withCompletionBudget } from "./completion-budget"
import type { ResolvedModelConfig } from "../../models/registry"

const cleanups: Array<() => Promise<void>> = []
beforeAll(async () => {
  await import("../../agent/runtime")
}, 60000)
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function fixture() {
  let started = 0
  let closed = 0
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      // Consume the real provider request before stalling.
      void chunk
    }
    started++
    response.once("close", () => {
      closed++
    })
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.flushHeaders()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const root = await mkdtemp(join(tmpdir(), "mods-model-cancel-http-"))
  const store = new ModControlStore(join(root, "control.sqlite"))
  const grant = store.grant(root, "function:modern", "digest", true)
  const config = {
    ref: "custom:cancel-http",
    source: "custom",
    id: "cancel-http",
    name: "Fixture",
    baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    model: "gpt-4",
    apiKey: "fixture-key",
    maxTokens: 2048,
    maxOutputTokens: 512
  } as ResolvedModelConfig
  const published = vi.fn(async (_identity, text: string) => text)
  const models = new FunctionModels(store, {
    assertScope: vi.fn(),
    resolve: async () => config,
    invoke: invokeFunctionModel,
    admit: async () => {},
    publish: published
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    await rm(root, { recursive: true, force: true })
  })
  return { models, store, grant, root, published, started: () => started, closed: () => closed }
}

it("real HTTP cancellation keeps unknown accounting and cannot be caught into a passing completion budget", async () => {
  const f = await fixture()
  const budget = new CompletionBudget(4096, 10000)
  const controller = new AbortController()
  const outcome = withCompletionBudget(budget, async () => {
    const pending = f.models.completeResult(
      f.root,
      "thread",
      f.grant,
      { model: "fixture", prompt: "private prompt", maxTokens: 32 },
      controller.signal
    )
    const rejected = expect(pending).rejects.toThrow("MODS_CANCELLED")
    await vi.waitFor(() => expect(f.started()).toBe(1))
    controller.abort()
    await rejected
    return "guest caught cancellation"
  })
  await expect(outcome).rejects.toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
  await vi.waitFor(() => expect(f.closed()).toBe(1))
  expect(f.models.stats).toEqual({ pending: 0, scopes: 0 })
  expect(f.published).not.toHaveBeenCalled()
  expect(f.store.audit(f.root)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
  expect(f.store.audit(f.root)[0].modelUsage).not.toHaveProperty("inputTokens")
}, 20000)

it("a real session exit cancels both HTTP requests and releases model capacity without exposing partial text", async () => {
  const f = await fixture()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"ask",description:"Ask"});return next(e)});
    on("command.run",async $=>{await Promise.all([
      $.model.complete({model:"fixture",prompt:"one"}),$.model.complete({model:"fixture",prompt:"two"})]);return {text:"LATE"}});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "modern",
        root: f.root,
        tier: "user",
        guest,
        modelProtocol: "result-v1",
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: f.root,
      assertLive: vi.fn(),
      publish: async (value) => value,
      completeModelResult: (_plugin, input, signal) =>
        f.models.completeResult(f.root, "thread", f.grant, input, signal)
    }
  )
  try {
    await session.start()
    const pending = session.run("ask", "")
    const rejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(f.started()).toBe(2))
    await session.close()
    await rejected
    await vi.waitFor(() => expect(f.closed()).toBe(2))
    await vi.waitFor(() => expect(f.models.stats).toEqual({ pending: 0, scopes: 0 }))
    expect(f.published).not.toHaveBeenCalled()
    const calls = f.store.audit(f.root).filter((call) => call.toolId === "model.complete")
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.status === "unknown" && call.publication === "blocked")).toBe(
      true
    )
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  } finally {
    await session.close()
  }
}, 20000)
