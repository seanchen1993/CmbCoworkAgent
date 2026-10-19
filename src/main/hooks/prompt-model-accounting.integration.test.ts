import { once } from "node:events"
import { readFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import { ModDevelopmentService } from "../mods/devtools/development-service"
import type { AuthoringAtomicSettings } from "../mods/devtools/authoring-config-snapshot"
import { createHookAccountingBinder } from "./model-accounting"
import { resetHookOnceStateForTests, runHooks, type HookContext } from "./runner"
import type { HookConfig, HookEvent } from "./types"
import { fireSessionEnd, fireSessionStartOnce } from "./session-lifecycle"
import { runCompletionHooksWithRevision } from "../agent/skill-lifecycle/completion-hooks"
import { createHookScope } from "./scope"

const model = vi.hoisted(() => ({
  hooks: [] as HookConfig[],
  config: {
    id: "hook-accounting",
    name: "Hook accounting",
    model: "hook-accounting",
    apiKey: "fixture-only",
    baseUrl: "",
    maxOutputTokens: 64
  }
}))
vi.mock("../models/registry", () => ({
  getAvailableModelConfigOrDefault: () => model.config,
  getModelConfigByRef: () => model.config
}))
vi.mock("../storage", () => ({
  getHookLoggingConfig: () => ({ diagnostic: true }),
  getUserInfo: () => undefined
}))
vi.mock("../mods/manager", () => ({ getModsManager: () => undefined }))
vi.mock("./log-record", () => ({ persistHookResultRecord: vi.fn() }))
vi.mock("../services/event-reporter", () => ({ trackEvent: vi.fn() }))
vi.mock("../mods/builtins/policy-decisions", () => ({ observeBuiltinPolicyDecision: vi.fn() }))
vi.mock("../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: vi.fn()
}))
vi.mock("../services/setup-state", () => ({
  hasWorkspaceBeenInitialised: () => false,
  markWorkspaceInitialised: vi.fn()
}))
vi.mock("./scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scope")>()),
  resolveEnabledHooksForRun: (_workspace: unknown, event: HookEvent) =>
    model.hooks.filter((hook) => hook.event === event)
}))

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  model.hooks = []
  await fireSessionEnd("creator")
  for (const cleanup of cleanups.splice(0)) await cleanup()
  resetHookOnceStateForTests()
  vi.restoreAllMocks()
})

async function fixture(limit = 8, hardMoney = false, workspace = "workspace") {
  const rows = new Map<string, string>()
  let incarnation = 1
  const settings: AuthoringAtomicSettings = {
    getSetting: (key, fallback) => rows.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, next) => {
      if (rows.get(key) !== expected) return false
      rows.set(key, next)
      return true
    }
  }
  const service = new ModDevelopmentService({
    drafts: new AuthoringDraftStore(settings),
    historySettings: settings,
    runtime: {
      developmentRetention: () => ({ releasable: true, revisions: [] }),
      developmentStatus: () => [],
      stageDevelopment: vi.fn(),
      approveDevelopment: vi.fn(),
      stopDevelopment: vi.fn()
    },
    versionsRoot: resolve("output/prompt-hook-accounting-test"),
    workerEntry: "unused",
    changed: vi.fn(),
    requestGroup: () => "goal:original",
    modelBudget: {
      modelAttemptLimit: limit,
      ...(hardMoney ? { hardMoneyLimit: { amount: 1, currency: "CNY" } } : {})
    },
    context: (threadId) => {
      const captured = incarnation
      return {
        scope: {
          workspace,
          threadId,
          incarnation: { token: String(captured), legacyCreatedAt: 1 }
        },
        assertCurrent: () => {
          if (captured !== incarnation) throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  })
  await service.setMode("creator", workspace, "creator")
  const receipt = service.captureModelAccounting("creator", workspace, "original-native-run")!
  const signal = new AbortController()
  const bind = createHookAccountingBinder(
    receipt,
    { workspace, threadId: "creator" },
    signal.signal
  )
  return {
    service,
    receipt,
    bind,
    signal,
    rows,
    replace: () => {
      incarnation++
    },
    context: (): HookContext =>
      bind({ workspacePath: workspace, sessionId: "creator", toolName: "read_file" }),
    accounting: () => {
      const request = service.status("creator").request
      return request && !("error" in request) ? request.model : undefined
    }
  }
}

async function provider(reply?: (response: ServerResponse) => void) {
  const requests: Record<string, unknown>[] = []
  const http = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
    if (reply) reply(response)
    else
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "actual-hook",
          object: "chat.completion",
          created: 1,
          model: "hook-accounting",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"decision":"allow"}' },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
        })
      )
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  model.config.baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`
  cleanups.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  })
  return requests
}

function hook(event: HookEvent, extra: Partial<HookConfig> = {}): HookConfig {
  return {
    id: `prompt-${event}`,
    event,
    type: "prompt",
    prompt: "Allow this safe fixture action",
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...extra
  }
}

it("charges original UserPromptSubmit/PreToolUse/PostToolUse/Stop HTTP once each through real CAS", async () => {
  const f = await fixture(),
    requests = await provider()
  for (const event of ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"] as const)
    await runHooks([hook(event)], event, f.context())
  expect(requests).toHaveLength(4)
  expect(f.accounting()?.attempts).toBe(4)
  expect(f.accounting()).toMatchObject({
    inputTokens: 44,
    outputTokens: 12,
    usageReportedAttempts: 4
  })
  expect(JSON.stringify(requests)).not.toContain("original-native-run")
  expect(JSON.stringify(f.context())).not.toContain("receipt")
  expect(Object.keys(f.context())).toEqual(["workspacePath", "sessionId", "toolName"])
})

it("does not turn exhausted budget into an ordinary allow fallback or send another HTTP", async () => {
  const f = await fixture(1),
    requests = await provider()
  await runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  await expect(runHooks([hook("Stop")], "Stop", f.context())).rejects.toThrow()
  expect(requests).toHaveLength(1)
  expect(f.accounting()?.attempts).toBe(1)
})

it("has no accounting side effect for a noncreator call and shares a once executor", async () => {
  const f = await fixture(),
    requests = await provider()
  await runHooks([hook("PreToolUse")], "PreToolUse", {
    sessionId: "ordinary",
    workspacePath: "workspace"
  })
  expect(f.accounting()?.attempts).toBe(0)
  await Promise.all(
    [1, 2].map(() => runHooks([hook("PreToolUse", { once: true })], "PreToolUse", f.context()))
  )
  expect(requests).toHaveLength(2)
  expect(f.accounting()?.attempts).toBe(1)
})

it("uses the original child receipt before child runtime construction without fabricating a trace", async () => {
  const f = await fixture(),
    requests = await provider()
  const child = f.receipt.forChild("creator", "physical-child", "workspace", undefined)
  const bind = createHookAccountingBinder(child, {
    workspace: "workspace",
    threadId: "physical-child"
  })
  await runHooks(
    [hook("UserPromptSubmit")],
    "UserPromptSubmit",
    bind({ sessionId: "physical-child", workspacePath: "workspace" })
  )
  await runHooks(
    [hook("Stop")],
    "Stop",
    bind({ sessionId: "physical-child", workspacePath: "workspace" })
  )
  expect(requests).toHaveLength(2)
  expect(f.accounting()?.attempts).toBe(2)
  expect(f.accounting()?.traceIds).toEqual([])
  expect(() => f.bind({ sessionId: "physical-child", workspacePath: "workspace" })).toThrow(
    "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE"
  )
})

it("blocks stale creator ownership before HTTP and preserves cancellation without billing", async () => {
  const f = await fixture(),
    requests = await provider()
  const context = f.context()
  f.replace()
  await expect(runHooks([hook("PreToolUse")], "PreToolUse", context)).rejects.toThrow()
  expect(requests).toHaveLength(0)
  const fresh = await fixture()
  fresh.signal.abort()
  await expect(runHooks([hook("PreToolUse")], "PreToolUse", fresh.context())).rejects.toThrow()
  expect(requests).toHaveLength(0)
  expect(fresh.accounting()?.attempts).toBe(0)
})

it("retains provider-error fallback while recording a real failed attempt with unknown usage", async () => {
  const f = await fixture(),
    requests = await provider((response) => {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":{"message":"ordinary provider failure"}}')
    })
  const result = await runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  expect(result?.blocked).toBe(false)
  expect(requests).toHaveLength(1)
  expect(f.accounting()?.attempts).toBe(1)
  expect(f.accounting()?.usageUnknownAttempts).toBe(1)
})

it("bills native Setup/SessionStart before runtime, but never retains billing for independent SessionEnd", async () => {
  const f = await fixture(),
    requests = await provider()
  model.hooks = [hook("Setup"), hook("SessionStart"), hook("SessionEnd")]
  await fireSessionStartOnce(
    "creator",
    "workspace",
    undefined,
    createHookScope(),
    undefined,
    "original-native-run",
    undefined,
    undefined,
    undefined,
    f.bind
  )
  await vi.waitFor(() => {
    expect(requests).toHaveLength(2)
    expect(f.accounting()?.attempts).toBe(2)
  })
  await fireSessionEnd("creator")
  expect(requests).toHaveLength(3)
  expect(f.accounting()?.attempts).toBe(2)
})

it("the original native completion Stop cannot swallow a creator budget failure as passed", async () => {
  const f = await fixture(1),
    requests = await provider()
  await runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  model.hooks = [hook("Stop")]
  await expect(
    runCompletionHooksWithRevision({
      threadId: "creator",
      workspacePath: "workspace",
      runId: "original-native-run",
      abortSignal: f.signal.signal,
      hookScope: createHookScope(),
      getStopContext: () => ({}),
      runRevision: vi.fn(),
      sendNotice: vi.fn(),
      sendError: vi.fn(),
      maxRevisionAttempts: 1,
      revisionPromptPrefix: "fixture",
      bindHookAccounting: f.bind
    })
  ).rejects.toThrow()
  expect(requests).toHaveLength(1)
})

it("rejects an unsupported hard cost limit before its first real Hook HTTP", async () => {
  const f = await fixture(8, true),
    requests = await provider()
  await expect(runHooks([hook("PreToolUse")], "PreToolUse", f.context())).rejects.toThrow()
  expect(requests).toHaveLength(0)
  expect(f.accounting()?.attempts).toBe(0)
})

it("aborts an actual held Hook HTTP using the original owner signal and leaves usage unknown", async () => {
  const f = await fixture()
  const seen = Promise.withResolvers<void>()
  const requests = await provider(() => seen.resolve())
  const running = runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  const rejected = expect(running).rejects.toThrow()
  await seen.promise
  f.signal.abort()
  await rejected
  expect(requests).toHaveLength(1)
  expect(f.accounting()?.attempts).toBe(1)
  expect(f.accounting()?.usageUnknownAttempts).toBe(1)
})

it("records missing usage as unknown while preserving the original valid Hook decision", async () => {
  const f = await fixture(),
    requests = await provider((response) => {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          id: "actual-no-usage",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: '{"decision":"allow"}'
              },
              finish_reason: "stop"
            }
          ]
        })
      )
    })
  const result = await runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  expect(result?.blocked).toBe(false)
  expect(requests).toHaveLength(1)
  expect(f.accounting()?.usageUnknownAttempts).toBe(1)
})

it("a held prompt observer returns immediately, then reports exact budget denial without another HTTP or once success", async () => {
  const f = await fixture(1)
  const seen = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  const requests = await provider((response) => {
    seen.resolve()
    void release.promise.then(() =>
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: '{"decision":"allow"}' },
              finish_reason: "stop"
            }
          ],
          usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 }
        })
      )
    )
  })
  const observed = vi.fn()
  expect(await runHooks([hook("SessionStart")], "SessionStart", f.context(), observed)).toBeNull()
  expect(observed).not.toHaveBeenCalled()
  await seen.promise
  expect(f.accounting()?.attempts).toBe(1)
  release.resolve()
  await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1))
  for (let i = 0; i < 2; i++) {
    await runHooks([hook("SubagentStart", { once: true })], "SubagentStart", f.context(), observed)
    await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(i + 2))
  }
  expect(requests).toHaveLength(1)
  for (const call of observed.mock.calls.slice(1))
    expect(call[2]).toMatchObject({
      exitCode: 1,
      decision: "block",
      reason: "DEVELOPMENT_MODEL_ATTEMPT_BUDGET"
    })
})

it("billing does not turn a real held command observer into a synchronous gate", async () => {
  const f = await fixture(8, false, process.cwd()),
    observed = vi.fn()
  const command = `"${process.execPath}" -e "process.stdout.write('observer-running');setTimeout(()=>process.stdout.write('observer-done'),150)"`
  expect(
    await runHooks(
      [hook("Notification", { type: "command", command })],
      "Notification",
      f.context(),
      observed
    )
  ).toBeNull()
  expect(observed).not.toHaveBeenCalled()
  await vi.waitFor(() => {
    expect(observed).toHaveBeenCalledTimes(1)
    expect(observed.mock.calls[0][2]).toMatchObject({ exitCode: 0 })
    expect(observed.mock.calls[0][2].stdout).toContain("observer-done")
  })
  expect(f.accounting()?.attempts).toBe(0)
})

it("captures a native request only after stale internal notification early exits and before its first Hook", () => {
  const source = readFileSync(resolve("src/main/ipc/agent.ts"), "utf8")
  const capture = source.indexOf("const creatorAccounting = captureAgentCreatorAccounting({")
  const stale = source.indexOf(
    'finishTraceInBackground(tracer, "success", "STALE_COORDINATOR_NOTIFICATION"'
  )
  const hooks = source.indexOf("await fireSessionStartOnce(")
  expect(stale).toBeGreaterThan(0)
  expect(capture).toBeGreaterThan(stale)
  expect(hooks).toBeGreaterThan(capture)
  const beforeCapture = source.slice(
    source.lastIndexOf("// Workflow completion turn:", capture),
    capture
  )
  expect(beforeCapture).toContain("return")
  expect(beforeCapture).not.toContain("captureAgentCreatorAccounting(")
})

it("does not treat a remote HTTP error's budget-looking text as a local native budget denial", async () => {
  const f = await fixture(),
    requests = await provider((response) => {
      response
        .writeHead(500, { "Content-Type": "application/json" })
        .end('{"error":{"message":"DEVELOPMENT_MODEL_ATTEMPT_BUDGET"}}')
    })
  const result = await runHooks([hook("PreToolUse")], "PreToolUse", f.context())
  expect(result?.blocked).toBe(false)
  expect(requests).toHaveLength(1)
  expect(f.accounting()?.usageUnknownAttempts).toBe(1)
})
