import { once } from "node:events"
import { mkdtempSync, readFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { HumanMessage } from "@langchain/core/messages"
import { createAgent } from "langchain"
import ts from "typescript"
import { afterEach, expect, it, vi } from "vitest"
import { createFunctionStepModelResolver, getModelInstance } from "./runtime"
import { isRetryableApiError } from "./failover"
import { evaluateGoalWithModel } from "./goals/evaluator"
import type { ThreadGoal } from "./goals/types"
import * as models from "../models/registry"
import {
  ModDevelopmentService,
  setModDevelopmentService
} from "../mods/devtools/development-service"
import { AuthoringDraftStore } from "../mods/devtools/authoring-store"
import type { AuthoringAtomicSettings } from "../mods/devtools/authoring-config-snapshot"
import {
  assertCreatorModelAccounting,
  type CreatorModelAccounting
} from "../mods/devtools/creator-model-accounting"
import { CompletionBudget, withCompletionBudget } from "../mods/v2/completion-budget"
import { createModModelBoundary } from "./mods-model-boundary"
import { FunctionGuestRuntime } from "../mods/v2/guest-runtime"
import { dispatchFunctionStream } from "../mods/v2/stream-dispatcher"
import { ModRuntimeAuthorities } from "../mods/runtime-instance"
import { TraceCollector, flushTraceWriteQueue } from "./trace/collector"
import { bindCreatorTraceUsage, readCreatorTraceId } from "./trace/live-tool-evidence"
import { TurnTraceRecorder } from "./trace/turn-trace-recorder"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  setModDevelopmentService(undefined)
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.unstubAllEnvs()
})

function accountingFixture(
  policy: { modelAttemptLimit?: number; hardMoneyLimit?: { amount: number; currency: string } } = {}
) {
  const values = new Map<string, string>()
  let incarnation = 1
  let goal: string | undefined = "goal:one"
  let rejectCas = false
  const settings: AuthoringAtomicSettings = {
    getSetting: (key, fallback) => values.get(key) ?? fallback ?? "",
    compareAndSetSetting: (key, expected, value) => {
      if (rejectCas) return false
      if (values.get(key) !== expected) return false
      values.set(key, value)
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
    versionsRoot: resolve("output/creator-model-test"),
    workerEntry: "unused",
    changed: vi.fn(),
    requestGroup: () => goal,
    modelBudget: policy,
    context: (threadId) => {
      const version = incarnation
      return {
        scope: {
          workspace: "workspace",
          threadId,
          incarnation: { token: String(version), legacyCreatedAt: 1 }
        },
        assertCurrent: () => {
          if (version !== incarnation) throw Error("DEVELOPMENT_SCOPE_CHANGED")
        }
      }
    }
  })
  return {
    service,
    values,
    rejectCas: () => {
      rejectCas = true
    },
    prepare: async () => {
      await service.setMode("creator", "workspace", "creator")
      return service.captureModelAccounting("creator", "workspace", "main")!
    },
    replace: () => {
      incarnation++
    },
    setGoal: (value: string | undefined) => {
      goal = value
    },
    model: () => {
      const row = service.status("creator").request
      return row && !("error" in row) ? row.model : undefined
    }
  }
}

function sse(usage = true) {
  return (
    `data: ${JSON.stringify({ id: "accounting", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n` +
    (usage
      ? `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`
      : "") +
    "data: [DONE]\n\n"
  )
}
async function server(reply: (response: ServerResponse, index: number) => void) {
  let requests = 0
  const http = createServer(async (request, response) => {
    for await (const _part of request) {
      void _part
    }
    reply(response, ++requests)
  })
  http.listen(0, "127.0.0.1")
  await once(http, "listening")
  cleanups.push(async () => {
    http.closeAllConnections()
    await new Promise<void>((done) => http.close(() => done()))
  })
  const address = http.address() as { port: number }
  return {
    count: () => requests,
    config: {
      id: "accounting",
      model: "accounting-fixture",
      apiKey: "fixture-only",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      maxOutputTokens: 32
    }
  }
}
function success(response: ServerResponse) {
  response.setHeader("content-type", "text/event-stream")
  response.end(sse())
}

/** Evaluate the real production primary resolver's arguments, not a copied test wiring. */
function primaryStepResolver(
  config: Parameters<typeof getModelInstance>[0],
  receipt: CreatorModelAccounting,
  retries = 1
): ReturnType<typeof createFunctionStepModelResolver> {
  const source = ts.createSourceFile(
    "runtime.ts",
    readFileSync(join(__dirname, "runtime.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  )
  let expression: ts.CallExpression | undefined
  const find = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "modStepModel") {
      const resolver = (child: ts.Node): void => {
        if (
          ts.isCallExpression(child) &&
          child.expression.getText(source) === "createFunctionStepModelResolver"
        )
          expression = child
        ts.forEachChild(child, resolver)
      }
      resolver(node.initializer)
    }
    ts.forEachChild(node, find)
  }
  find(source)
  expect(expression).toBeDefined()
  return new Function(
    "createFunctionStepModelResolver",
    "customConfig",
    "creatorAccounting",
    "retryHooks",
    "maxRetryAttempts",
    "threadId",
    "assertClawModel",
    `return (${expression!.getText(source)})`
  )(createFunctionStepModelResolver, config, receipt, undefined, retries, "creator", undefined)
}

async function consumePrimaryBoundary(
  config: Parameters<typeof getModelInstance>[0],
  receipt: CreatorModelAccounting,
  retries = 1
) {
  vi.stubEnv("CMB_COWORK_TRACES_DIR", mkdtempSync(join(tmpdir(), "creator-primary-trace-")))
  vi.stubEnv("CMB_COWORK_TRACE_STORAGE_MODE", "plaintext")
  const tracer = new TraceCollector("creator", "real primary boundary", config.model, {
    includeSkillEval: false
  })
  const traceContext = tracer.getTraceContext()
  const accounting = receipt.forTrace(readCreatorTraceId(traceContext))
  bindCreatorTraceUsage(traceContext, (usage) => accounting.recordTrace(usage))
  const owners = new ModRuntimeAuthorities()
  const { authority } = owners.create({
    workspace: "workspace",
    threadId: "creator",
    turnId: "turn",
    agentId: "main"
  })
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("turn.step",async function*($,event,next){for await(const frame of next(event)){
      if(frame.kind==="text")yield {...frame,text:"guest:"+frame.text};else yield frame
    }})
  }}`)
  const delegate = getModelInstance(config, undefined, 1, "agent", "creator", accounting)
  const initialProvider = vi.spyOn(delegate, "stream")
  const boundary = createModModelBoundary(
    delegate,
    {
      functionModelStream: (_owner, input, core, signal) =>
        Promise.resolve(
          dispatchFunctionStream(
            [
              {
                name: "accounted-primary",
                root: "/accounted-primary",
                tier: "user",
                guest,
                capabilities: []
              }
            ],
            input,
            { signal, core }
          )
        )
    },
    authority,
    { model: config.model, agentId: "main", turnId: "turn" },
    { resolve: primaryStepResolver(config, accounting, retries) }
  )
  const agent = createAgent({ model: boundary, tools: [] })
  const recorder = new TurnTraceRecorder({ tracer, userMessageId: "user" })
  let text = ""
  let failed = false
  try {
    for await (const [mode, value] of await agent.stream(
      { messages: [new HumanMessage({ id: "user", content: "real boundary request" })] },
      { streamMode: ["values"] }
    )) {
      recorder.onRawValues(value)
      if (mode === "values") text = String(value.messages.at(-1)?.content ?? "")
    }
  } catch (error) {
    failed = true
    throw error
  } finally {
    const trace = await tracer.finish(failed ? "error" : "success")
    await flushTraceWriteQueue()
    expect(initialProvider).not.toHaveBeenCalled()
    owners.close()
    await guest.dispose()
    if (!failed) expect(trace.totalModelCalls).toBe(1)
  }
  return { text, traceId: tracer.getTraceId() }
}

it("primary Mod-aware replacement provider charges original CAS and original real trace across a new goal/model", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  const http = await server(success)
  const first = await consumePrimaryBoundary(http.config, receipt)
  expect(first.text).toContain("guest:ok")
  expect(http.count()).toBe(1)
  expect(f.model()).toMatchObject({ attempts: 1, recordedModelCalls: 1, traceIds: [first.traceId] })
  f.setGoal("goal:replacement")
  const next = f.service.captureModelAccounting("creator", "workspace", "new-human-model")!
  const second = await consumePrimaryBoundary({ ...http.config, model: "replacement-model" }, next)
  expect(http.count()).toBe(2)
  expect(f.model()).toMatchObject({
    attempts: 1,
    recordedModelCalls: 1,
    traceIds: [second.traceId]
  })
  const rows = [...f.values.values()]
    .flatMap((value) => {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    })
    .filter((row) => row?.model?.attempts)
  expect(rows.map((row) => row.model.attempts.length)).toEqual([1, 1])
})

it("primary Mod-aware replacement charges every actual retry and keeps original trace calls separate", async () => {
  const f = accountingFixture({ modelAttemptLimit: 2 }),
    receipt = await f.prepare()
  const http = await server((response, index) => {
    if (index === 1) response.writeHead(502, { "content-type": "application/json" }).end("{}")
    else success(response)
  })
  await consumePrimaryBoundary(http.config, receipt, 2)
  expect(http.count()).toBe(2)
  expect(f.model()).toMatchObject({
    attempts: 2,
    usageUnknownAttempts: 1,
    usageReportedAttempts: 1,
    recordedModelCalls: 1,
    coverage: "partial"
  })
})

it("primary Mod-aware replacement cannot retry a failed provider beyond the original CAS budget", async () => {
  const f = accountingFixture({ modelAttemptLimit: 1 }),
    receipt = await f.prepare()
  const http = await server((response) =>
    response.writeHead(502, { "content-type": "application/json" }).end("{}")
  )
  await expect(consumePrimaryBoundary(http.config, receipt, 2)).rejects.toThrow()
  expect(http.count()).toBe(1)
  expect(f.model()).toMatchObject({ attempts: 1, usageUnknownAttempts: 1 })
  expect(f.model()?.cost).not.toHaveProperty("amount")
})
async function consume(
  config: Parameters<typeof getModelInstance>[0],
  receipt: CreatorModelAccounting,
  purpose: Parameters<typeof getModelInstance>[3] = "agent",
  retries = 1,
  signal?: AbortSignal
) {
  let text = ""
  const model = getModelInstance(config, undefined, retries, purpose, undefined, receipt)
  for await (const part of await model.stream([new HumanMessage("fixture")], { signal }))
    text += part.content
  return text
}

it("charges real provider attempts across main, compaction, function completion and a born child", async () => {
  const f = accountingFixture({ modelAttemptLimit: 4 }),
    receipt = await f.prepare()
  const http = await server(success)
  expect(await consume(http.config, receipt.forTrace("parent"))).toBe("ok")
  expect(await consume(http.config, receipt, "context-compaction")).toBe("ok")
  const completion = new CompletionBudget(4000, 10000)
  await withCompletionBudget(completion, () => consume(http.config, receipt, "function-completion"))
  expect(completion.inputTokens).toBe(0)
  const child = receipt.forTrace("child", new AbortController().signal)
  f.setGoal("goal:new")
  await consume(http.config, child)
  await expect(consume(http.config, receipt, "agent", 4)).rejects.toThrow()
  expect(http.count()).toBe(4)
  expect(f.model()).toMatchObject({
    attempts: 4,
    usageReportedAttempts: 4,
    coverage: "complete",
    inputTokens: 44,
    outputTokens: 12,
    traceIds: ["parent", "child"]
  })
  expect(f.model()?.cost).not.toHaveProperty("amount")
  expect(f.values.size).toBe(1)
})

it("charges each HTTP retry and preserves unknown failed usage after a successful attempt", async () => {
  const f = accountingFixture({ modelAttemptLimit: 3 }),
    receipt = await f.prepare()
  const http = await server((response, index) => {
    if (index === 1) {
      response.writeHead(502, { "content-type": "application/json" })
      response.end('{"error":{"message":"failed"}}')
    } else success(response)
  })
  expect(await consume(http.config, receipt, "agent", 2)).toBe("ok")
  expect(http.count()).toBe(2)
  expect(f.model()).toMatchObject({
    attempts: 2,
    usageReportedAttempts: 1,
    usageUnknownAttempts: 1,
    coverage: "partial"
  })
})

it("does not send the retry past the limit, and provider failover cannot classify its wrapped error as retryable", async () => {
  const f = accountingFixture({ modelAttemptLimit: 1 }),
    receipt = await f.prepare()
  const http = await server((response) => {
    response.writeHead(502, { "content-type": "application/json" })
    response.end("{}")
  })
  let failure: unknown
  try {
    await consume(http.config, receipt, "agent", 3)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeDefined()
  expect(http.count()).toBe(1)
  expect(isRetryableApiError(failure)).toBe(false)
  expect(
    isRetryableApiError(
      new Error("network error", { cause: Error("DEVELOPMENT_MODEL_ATTEMPT_BUDGET") })
    )
  ).toBe(false)
  await expect(consume(http.config, receipt)).rejects.toThrow()
  expect(http.count()).toBe(1)
})

it("rejects unsupported hard currency, foreign receipts, expired owners and aborted children before HTTP", async () => {
  const money = accountingFixture({ hardMoneyLimit: { amount: 20, currency: "CNY" } }),
    receipt = await money.prepare()
  const http = await server(success)
  await expect(consume(http.config, receipt)).rejects.toThrow()
  expect(money.model()).toMatchObject({ attempts: 0, cost: { state: "unavailable" } })
  expect(money.model()?.cost).not.toHaveProperty("amount")
  const ordinary = accountingFixture(),
    parent = await ordinary.prepare()
  const controller = new AbortController(),
    child = parent.forTrace("child", controller.signal)
  controller.abort()
  await expect(consume(http.config, child)).rejects.toThrow()
  ordinary.replace()
  await expect(consume(http.config, parent)).rejects.toThrow()
  await expect(
    consume(http.config, {
      claim: parent.claim,
      forTrace: parent.forTrace,
      forChild: parent.forChild,
      recordTrace: parent.recordTrace
    })
  ).rejects.toThrow("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
  expect(http.count()).toBe(0)
})

it("keeps legitimate born background children on their original billing group after the foreground ends", async () => {
  const f = accountingFixture({ modelAttemptLimit: 3 }),
    parent = await f.prepare()
  const foreground = new AbortController(),
    physicalChild = new AbortController()
  const capturedParent = parent.forTrace("foreground", foreground.signal)
  const child = capturedParent.forChild(
    "creator",
    "owned-child",
    "workspace",
    "background",
    physicalChild.signal
  )
  foreground.abort()
  f.setGoal("goal:other")
  const http = await server(success)
  await consume(http.config, child)
  const lateChild = capturedParent.forChild(
    "creator",
    "later-owned-child",
    "workspace",
    "late-background",
    physicalChild.signal
  )
  await consume(http.config, lateChild)
  expect(() => capturedParent.forChild("foreign-parent", "other", "workspace")).toThrow(
    "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE"
  )
  expect(() =>
    assertCreatorModelAccounting(child, { workspace: "workspace", threadId: "different-child" })
  ).toThrow("DEVELOPMENT_MODEL_ACCOUNTING_SCOPE")
  expect(() => capturedParent.forChild("creator", "other", "foreign-workspace")).toThrow(
    "DEVELOPMENT_MODEL_ACCOUNTING_SCOPE"
  )
  physicalChild.abort()
  await expect(consume(http.config, child)).rejects.toThrow()
  expect(http.count()).toBe(2)
  expect(f.service.status("creator").request).toMatchObject({
    groupId: "goal:one",
    model: { attempts: 2, traceIds: ["background", "late-background"] }
  })
})

it("binds the real bare Goal judge to the original creator goal and includes its JSON repair call", async () => {
  const f = accountingFixture({ modelAttemptLimit: 2 })
  await f.prepare()
  setModDevelopmentService(f.service)
  const http = await server((response, index) => {
    response.setHeader("content-type", "application/json")
    response.end(
      JSON.stringify({
        id: `judge-${index}`,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: index === 1 ? "invalid" : '{"verdict":"complete","reason":"fixture"}'
            }
          }
        ],
        usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
      })
    )
  })
  vi.spyOn(models, "getModelConfigs").mockReturnValue([
    {
      ...http.config,
      name: "Accounting fixture",
      source: "custom",
      ref: "custom:accounting",
      maxTokens: 4000
    }
  ])
  const goal: ThreadGoal = {
    threadId: "creator",
    goalId: "one",
    activeWindowId: "window",
    objective: "fixture",
    completionCondition: "fixture",
    context: {},
    status: "active",
    turnsUsed: 1,
    maxTurns: 3,
    lastVerdict: null,
    lastReason: null,
    pausedReason: null,
    consecutiveParseFailures: 0,
    ledger: { progress: [], evidence: [], blockers: [] },
    createdAt: 1,
    updatedAt: 1
  }
  expect(
    (
      await evaluateGoalWithModel(
        { goal, assistantResponse: "actual fixture", toolCalls: [] },
        { modelId: "custom:accounting" }
      )
    ).verdict
  ).toBe("complete")
  expect(http.count()).toBe(2)
  expect(f.model()).toMatchObject({
    attempts: 2,
    usageReportedAttempts: 2,
    inputTokens: 14,
    outputTokens: 4
  })
  await expect(
    evaluateGoalWithModel(
      { goal, assistantResponse: "again", toolCalls: [] },
      { modelId: "custom:accounting" }
    )
  ).rejects.toThrow()
  expect(http.count()).toBe(2)
})

it("does not count missing provider usage as zero and retains a real provider-reported zero", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  const http = await server((response, index) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(
      index === 1
        ? sse(false)
        : sse().replace(
            '"prompt_tokens":11,"completion_tokens":3,"total_tokens":14',
            '"prompt_tokens":0,"completion_tokens":0,"total_tokens":0'
          )
    )
  })
  await consume(http.config, receipt)
  expect(f.model()).not.toHaveProperty("inputTokens")
  await consume(http.config, receipt)
  expect(f.model()).toMatchObject({
    usageUnknownAttempts: 1,
    usageReportedAttempts: 1,
    inputTokens: 0,
    outputTokens: 0
  })
})

it("latches an unconfirmed CAS rather than retrying the actual request under another provider", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  f.rejectCas()
  const http = await server(success)
  await expect(consume(http.config, receipt, "agent", 4)).rejects.toThrow()
  expect(http.count()).toBe(0)
  expect(f.model()).toMatchObject({ attempts: 0, usagePendingAttempts: 0 })
})

it("preserves original provider bytes when creator-only bounded usage observation cannot parse them", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  const body = sse().replace('"content":"ok"', `"content":"${"x".repeat(1100 * 1024)}"`)
  const http = await server((response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(body)
  })
  expect((await consume(http.config, receipt)).length).toBe(1100 * 1024)
  expect(f.model()).toMatchObject({ attempts: 1, usageUnknownAttempts: 1 })
  expect(f.model()).not.toHaveProperty("inputTokens")
})

it("marks an SSE EOF without its terminal marker unknown while leaving the original model result intact", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  const http = await server((response) => {
    response.setHeader("content-type", "text/event-stream")
    response.end(sse().replace("data: [DONE]\n\n", ""))
  })
  expect(await consume(http.config, receipt)).toBe("ok")
  expect(f.model()).toMatchObject({ attempts: 1, usageUnknownAttempts: 1, coverage: "partial" })
  expect(f.model()).not.toHaveProperty("inputTokens")
})

it("charges an actually submitted cancelled stream as unknown and physically closes the provider body", async () => {
  const f = accountingFixture(),
    receipt = await f.prepare()
  let reached!: () => void
  const submitted = new Promise<void>((resolve) => {
    reached = resolve
  })
  let closed = false
  const http = await server((response) => {
    response.setHeader("content-type", "text/event-stream")
    response.write(sse(false).replace("data: [DONE]\n\n", ""))
    response.on("close", () => {
      closed = true
    })
    reached()
  })
  const controller = new AbortController()
  const pending = consume(http.config, receipt, "agent", 1, controller.signal)
  const rejected = expect(pending).rejects.toThrow()
  await submitted
  controller.abort()
  await rejected
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(closed).toBe(true)
  expect(http.count()).toBe(1)
  expect(f.model()).toMatchObject({ attempts: 1, usageUnknownAttempts: 1 })
  expect(f.model()).not.toHaveProperty("inputTokens")
})
