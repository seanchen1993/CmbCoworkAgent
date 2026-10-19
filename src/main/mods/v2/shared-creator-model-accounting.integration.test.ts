import { once } from "node:events"
import { AsyncResource } from "node:async_hooks"
import { createServer } from "node:http"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, expect, it, vi } from "vitest"
import { ModsManager } from "../manager"
import { FunctionModels } from "./models"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { invokeFunctionModel } from "./model-provider"
import { functionModelRequest } from "./model-sdk"
import type { ResolvedModelConfig } from "../../models/registry"
import { CreatorRequestBudgets } from "../devtools/creator-request-budget"
import {
  assertCreatorModelAccounting,
  bindCreatorModelAccounting,
  issueCreatorModelAccounting,
  readCreatorModelAccounting
} from "../devtools/creator-model-accounting"

vi.mock("electron", () => ({
  app: { getPath: () => tmpdir(), getName: () => "test", getVersion: () => "0" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
  dialog: {}
}))

const cleanup: Array<() => void | Promise<void>> = []
beforeAll(async () => {
  await import("../../agent/runtime")
}, 60000)
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(accounted = true, remoteStatus?: number) {
  const root = mkdtempSync(join(tmpdir(), "shared-creator-model-"))
  const manager = new ModsManager(
    join(root, "control.sqlite"),
    () => [],
    async () => true,
    () => {}
  )
  manager.configure(root, true, false)
  const workspace = manager.workspaceKey(root)
  const controller = new AbortController()
  const parent = manager.createRuntimeAuthority({
    workspace,
    threadId: "parent",
    turnId: "original-turn",
    signal: controller.signal
  })
  const unbind = manager.bindThread({
    ...parent.authority,
    runtimeAuthority: parent.authority,
    signal: controller.signal
  })
  cleanup.push(() => {
    unbind()
    manager.close()
    rmSync(root, { recursive: true, force: true })
  })
  const settings = new Map<string, string>()
  const budgets = new CreatorRequestBudgets({
    getSetting: (key, fallback) => settings.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (settings.get(key) !== expected) return false
      settings.set(key, value)
      return true
    }
  })
  let current = true
  const accounting = accounted
    ? issueCreatorModelAccounting(
        {
          assertCurrent: () => {
            if (!current) throw Error("DEVELOPMENT_SCOPE_CHANGED")
          },
          claim: (traceId) => {
            const id = budgets.claimModel("creator", "original-request", traceId)
            return {
              settle: (usage) => budgets.settleModel("creator", "original-request", id, usage)
            }
          }
        },
        undefined,
        undefined,
        { workspace, threadId: "parent" }
      )
    : undefined
  if (accounting) {
    budgets.bindModel("creator", "original-request", undefined, { modelAttemptLimit: 1 })
    bindCreatorModelAccounting(parent.authority, accounting)
  }
  let requests = 0
  const http = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    requests++
    if (remoteStatus) {
      response.writeHead(remoteStatus, { "content-type": "application/json" })
      response.end(JSON.stringify({ error: { message: "DEVELOPMENT_MODEL_ATTEMPT_BUDGET" } }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.end(
      `data: ${JSON.stringify({ id: "sdk", choices: [{ index: 0, delta: { role: "assistant", content: "actual SDK reply" }, finish_reason: "stop" }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n` +
        "data: [DONE]\n\n"
    )
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanup.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  })
  const address = http.address() as { port: number }
  const config: ResolvedModelConfig = {
    id: "fixture",
    ref: "custom:fixture",
    source: "custom",
    name: "Fixture",
    model: "fixture",
    apiKey: "fixture-only",
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    maxOutputTokens: 32
  }
  const grant = manager.store.grant(workspace, "function:nested", "actual-digest", true)
  const models = new FunctionModels(manager.store, {
    assertScope: () => {
      manager.functionSharedModelAuthority(parent.authority, "reviewer")
    },
    resolve: async () => config,
    invoke: invokeFunctionModel,
    admit: async () => {},
    publish: async (_identity, text) => text
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"ask",description:"Ask"});return next(e)});
    on("command.run",async($,e)=>{var request={model:"fixture",prompt:"actual nested SDK",maxTokens:32};
      if(e.args==="forge")request.budget={modelAttemptLimit:999};
      return {text:JSON.stringify(await $.model.complete(request))}});
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "nested",
        root,
        tier: "user",
        guest,
        modelProtocol: "result-v1",
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace,
      threadId: "parent",
      assertLive: () => {},
      publish: async (value) => value,
      completeModelResult: (_plugin, input, signal) =>
        models.completeResult(workspace, "parent", grant, input, signal)
    }
  )
  cleanup.push(() => session.close())
  await session.start()
  const run = <T>(body: () => Promise<T>) =>
    manager.withSharedAgent(
      parent.authority,
      "task:reviewer",
      controller.signal,
      { blockedToolNames: new Set(), readOnly: true },
      body,
      undefined,
      { description: "review", type: "reviewer" }
    )
  const rawAsk = (args = "") => session.run("ask", args)
  const ask = async (args = "") => JSON.parse(String((await rawAsk(args)).text))
  return {
    manager,
    parent,
    workspace,
    accounting,
    budgets,
    run,
    ask,
    rawAsk,
    controller,
    requests: () => requests,
    revoke: () => {
      current = false
    }
  }
}

it("real shared role Guest SDK HTTP consumes the parent's CAS once and rejects a second provider request", async () => {
  const f = await fixture()
  await f.run(async () => {
    expect((await f.ask()).isAnswered).toBe(true)
    await expect(f.ask()).rejects.toThrow("DEVELOPMENT_MODEL_ATTEMPT_BUDGET")
    const child = f.manager.functionSharedModelAuthority(f.parent.authority, "reviewer")
    const inherited = readCreatorModelAccounting(child)
    expect(inherited).toBeDefined()
    expect(inherited).not.toBe(f.accounting)
    assertCreatorModelAccounting(inherited!, { workspace: f.workspace, threadId: "parent" })
  })
  expect(f.requests()).toBe(1)
  expect(f.budgets.latest("creator")?.model?.attempts).toMatchObject([
    { state: "reported", inputTokens: 11, outputTokens: 3 }
  ])
}, 20000)

it("remote 502 with a budget-looking message remains the original provider api-error", async () => {
  const f = await fixture(true, 502)
  await f.run(async () => {
    expect(await f.ask()).toMatchObject({
      isAnswered: false,
      reason: "api-error",
      status: 502,
      error: "server_error"
    })
  })
  expect(f.requests()).toBe(1)
  expect(f.budgets.latest("creator")?.model?.attempts).toMatchObject([{ state: "unknown" }])
}, 20000)

it("a Guest cannot inject a wider billing budget through its public model request", async () => {
  const f = await fixture()
  await f.run(async () => {
    // Invalid optional handler arguments are isolated by the original guest dispatcher;
    // they cannot fabricate a completion result or enter the native provider.
    expect((await f.rawAsk("forge")).text).toBeUndefined()
    expect(() =>
      functionModelRequest(
        { model: "fixture", prompt: "invalid", budget: { modelAttemptLimit: 999 } },
        "result-v1"
      )
    ).toThrow("MODS_MODEL_ARGUMENTS")
  })
  expect(f.requests()).toBe(0)
  expect(f.budgets.latest("creator")?.model?.attempts).toEqual([])
}, 20000)

it("ordinary shared roles without a parent billing receipt keep the original unmetered SDK path", async () => {
  const f = await fixture(false)
  await f.run(async () => {
    expect((await f.ask()).isAnswered).toBe(true)
    expect((await f.ask()).isAnswered).toBe(true)
    expect(
      readCreatorModelAccounting(
        f.manager.functionSharedModelAuthority(f.parent.authority, "reviewer")
      )
    ).toBeUndefined()
  })
  expect(f.requests()).toBe(2)
  expect(f.budgets.latest("creator")).toBeUndefined()
}, 20000)

it("a revoked parent billing scope cannot issue a nested SDK HTTP request", async () => {
  const f = await fixture()
  await f.run(async () => {
    f.revoke()
    await expect(f.ask()).rejects.toThrow("DEVELOPMENT_SCOPE_CHANGED")
  })
  expect(f.requests()).toBe(0)
  expect(f.budgets.latest("creator")?.model?.attempts).toEqual([])
}, 20000)

it("a completed role cannot reuse its old SDK execution scope", async () => {
  const f = await fixture()
  let late!: () => Promise<unknown>
  await f.run(async () => {
    late = AsyncResource.bind(f.ask)
  })
  await expect(late()).rejects.toThrow("MODS_CALL_SCOPE_EXPIRED")
  expect(f.requests()).toBe(0)
  expect(f.budgets.latest("creator")?.model?.attempts).toEqual([])
}, 20000)

it("the original workspace epoch guard still refuses a revoked shared role before HTTP", async () => {
  const f = await fixture()
  await f.run(async () => {
    f.manager.configure(f.workspace, false, false)
    await expect(f.ask()).rejects.toThrow()
  })
  expect(f.requests()).toBe(0)
  expect(f.budgets.latest("creator")?.model?.attempts).toEqual([])
}, 20000)
