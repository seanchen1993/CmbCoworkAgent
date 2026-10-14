import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { ModControlStore } from "../control-store"
import { FunctionModels } from "./models"
import type { ResolvedModelConfig } from "../../models/registry"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import {
  functionModelRequest,
  FunctionModelProviderFailure,
  type FunctionModelRequest,
  type FunctionModelReply
} from "./model-sdk"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { withFunctionExecution } from "./execution-context"
import { CompletionBudget, withCompletionBudget } from "./completion-budget"
import { FunctionRegisteredTools } from "./registered-tools"
import { independentPromptFrame } from "./model-prompt-frame"
import type {
  FunctionModelForkReply,
  FunctionModelForkRequest,
  FunctionModelForkSnapshot
} from "./model-operations"

const cleanups: Array<() => void> = []
afterEach(() => {
  vi.useRealTimers()
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "function-models-"))
  const store = new ModControlStore(join(folder, "control.sqlite"))
  const grant = store.grant(folder, "function:demo", "digest", true)
  const config = {
    ref: "custom:chosen",
    id: "chosen",
    name: "Chosen",
    source: "custom",
    model: "configured-model",
    baseUrl: "https://example.invalid/v1",
    apiKey: "private-host-key",
    maxOutputTokens: 4096
  } as ResolvedModelConfig
  const host = {
    assertScope: vi.fn(),
    resolve: vi.fn(async () => config),
    invoke: vi.fn<
      (
        config: ResolvedModelConfig,
        request: FunctionModelRequest,
        signal: AbortSignal
      ) => Promise<FunctionModelReply>
    >(async () => ({
      text: "provider answer",
      inputTokens: 10,
      outputTokens: 4
    })),
    admit: vi.fn(async () => {}),
    publish: vi.fn(async (_identity: ModIdentity, text: string) =>
      text.replace("provider", "protected")
    )
  }
  const models = new FunctionModels(store, host)
  cleanups.push(() => {
    store.close()
    if (
      dirname(resolve(folder)) !== resolve(tmpdir()) ||
      !basename(folder).startsWith("function-models-")
    )
      throw Error("Unexpected cleanup path")
    rmSync(folder, { recursive: true, force: true })
  })
  const call = (signal = new AbortController().signal, maxTokens = 256) =>
    models.complete(
      folder,
      "thread",
      grant,
      { model: "chosen", prompt: "private prompt", maxTokens },
      signal
    )
  return { folder, store, grant, config, host, models, call }
}

it("enforces completion output reservations before the actual provider across repeated checks", async () => {
  const f = fixture()
  const budget = new CompletionBudget(400, 10000)
  f.host.invoke.mockResolvedValue({ text: "answer", inputTokens: 120, outputTokens: 180 })
  await withCompletionBudget(budget, () => f.call(undefined, 200))
  await expect(withCompletionBudget(budget, async () => {
    try { await f.call(undefined, 200) } catch { /* guest recovery cannot authorize a PASS */ }
  })).rejects.toThrow("MODS_COMPLETION_MODEL_BUDGET")
  expect(f.host.invoke).toHaveBeenCalledTimes(1)
  expect(budget.outputReserved).toBe(200)
  expect(budget.inputTokens).toBe(120)
  expect(budget.outputTokens).toBe(180)
})

it("bounds guest inputs and refuses endpoints, credentials, invalid caps and oversized prompts", () => {
  const invalid: ModObject[] = [
    { baseUrl: "https://evil.invalid" },
    { apiKey: "key" },
    { maxTokens: 4097 },
    { maxTokens: 0 },
    { maxTokens: 1.5 },
    { prompt: "x".repeat(32001) }
  ]
  for (const extra of invalid)
    expect(() => functionModelRequest({ model: "default", prompt: "hi", ...extra })).toThrow(
      "MODS_MODEL_ARGUMENTS"
    )
  expect(functionModelRequest({ model: "default", prompt: "hi" })).toEqual({
    model: "default",
    prompt: "hi"
  })
})

it("records final selection and provider usage without storing prompts or host credentials", async () => {
  const f = fixture()
  f.config.maxOutputTokens = 128
  expect(await f.call()).toBe("protected answer")
  expect(f.host.invoke.mock.calls[0][1]).toMatchObject({ maxTokens: 128, prompt: "private prompt" })
  expect(f.host.admit).toHaveBeenCalledOnce()
  const audit = f.store.audit(f.folder)
  expect(audit[0]).toMatchObject({
    toolId: "model.complete",
    status: "succeeded",
    modelUsage: {
      modelRef: "custom:chosen",
      outputTokenLimit: 128,
      inputTokens: 10,
      outputTokens: 4
    }
  })
  expect(JSON.stringify(audit)).not.toMatch(/private prompt|private-host-key/)
  expect(f.models.stats).toEqual({ pending: 0, scopes: 0 })
})

it("checks a captured Claw model policy before requests and again before publishing", async () => {
  const f = fixture()
  let valid = true
  Object.assign(f.host, { captureModel: async () => () => {
    if (!valid) throw new ModFunctionError("CLAW_MODEL_CONFIGURATION_CHANGED")
  } })
  f.host.invoke.mockImplementationOnce(async () => {
    valid = false
    return { text: "stale provider result", inputTokens: 1, outputTokens: 1 }
  })
  await expect(f.call()).rejects.toThrow("CLAW_MODEL_CONFIGURATION_CHANGED")
  expect(f.host.publish).not.toHaveBeenCalled()
  f.host.invoke.mockClear()
  await expect(f.call()).rejects.toThrow("CLAW_MODEL_CONFIGURATION_CHANGED")
  expect(f.host.invoke).not.toHaveBeenCalled()
})

it("keeps the captured startup guard active after its preparation frame and rejects a stale provider result", async () => {
  const f = fixture()
  let valid = true
  Object.assign(f.host, { captureStartup: () => () => {
    if (!valid) throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
  }, prepare: async (_config: unknown, request: FunctionModelRequest) => {
    expect(independentPromptFrame()?.active).toBe(true)
    expect(independentPromptFrame()?.request).toMatchObject({workspace:f.folder,threadId:"thread"})
    return {input:{prompt:request.prompt},inputUpperBound:128,assertBudget:()=>{},
      invoke: async () => {
        expect(independentPromptFrame()).toBeUndefined()
        valid=false
        return {text:"stale provider result",inputTokens:1,outputTokens:1}
      }}
  } })
  await expect(f.call()).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(f.models.stats).toEqual({pending:0,scopes:0})
})

it("rejects startup invalidation during preparation before admission or provider invocation", async () => {
  const f = fixture()
  let valid = true
  Object.assign(f.host, { captureStartup: () => () => {
    if (!valid) throw new ModFunctionError("MODS_CONFIG_SOURCE_CHANGED")
  }, prepare: async () => {
    valid=false
    return {input:{prompt:"prepared"},inputUpperBound:128,assertBudget:()=>{},invoke:f.host.invoke}
  } })
  await expect(f.call()).rejects.toThrow("MODS_CONFIG_SOURCE_CHANGED")
  expect(f.host.admit).not.toHaveBeenCalled()
  expect(f.host.invoke).not.toHaveBeenCalled()
})

it("keeps the persisted budget across service reload and does not call the provider after exhaustion", async () => {
  const f = fixture()
  for (let i = 0; i < 8; i++) await f.call(undefined, 4096)
  const reloaded = new FunctionModels(f.store, f.host)
  await expect(
    reloaded.complete(
      f.folder,
      "another-thread",
      f.grant,
      { model: "chosen", prompt: "hi" },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_MODEL_BUDGET")
  expect(f.host.invoke).toHaveBeenCalledTimes(8)
  expect(f.store.audit(f.folder)).toHaveLength(8)
})

it("keeps nested model usage in the real tool turn and links the actual provider receipt", async () => {
  const f = fixture()
  const tools = new FunctionRegisteredTools(f.store, {
    assertScope: () => {},
    admit: async () => {},
    publish: async (_identity, value) => value
  })
  const consumer = f.store.grant(f.folder, "function:consumer", "snapshot", true)
  await withFunctionExecution(
    {
      workspace: f.folder,
      threadId: "thread",
      turnId: "real-turn",
      agentId: "main",
      leased: true,
      immediate: false,
      userInitiated: false
    },
    () =>
      tools.call(
        f.folder,
        "thread",
        consumer,
        { tool: "mcp__consumer__answer", tool_use_id: "model-tool" },
        "model",
        new AbortController().signal,
        async () => ({ result: await f.call() })
      )
  )
  const audit = f.store.audit(f.folder)
  const parent = audit.find((row) => row.toolId.startsWith("function:"))!
  const model = audit.find((row) => row.toolId === "model.complete")!
  expect(model.identity).toMatchObject({
    parentCallId: parent.identity!.callId,
    turnId: "real-turn",
    agentId: "main",
    modId: f.grant.modId,
    origin: "mod"
  })
  expect(parent.identity?.modId).toBe(consumer.modId)
  expect(f.store.turnSummary(f.folder, "thread", "real-turn")).toMatchObject({ succeeded: 2 })
})

it("retains a completed provider call if usage accounting fails and blocks its output", async () => {
  const f = fixture()
  vi.spyOn(f.store, "recordFunctionModelUsage").mockImplementation(() => {
    throw Error("database")
  })
  await expect(f.call()).rejects.toThrow(/^MODS_MODEL_FAILED$/)
  expect(f.host.invoke).toHaveBeenCalledOnce()
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "succeeded", publication: "blocked" })
})

it("preserves the calling agent and denies a mismatched scope before model resolution", async () => {
  const f = fixture()
  const scope = {
    workspace: f.folder,
    threadId: "thread",
    turnId: "worker-turn",
    agentId: "worker",
    leased: true,
    immediate: false,
    userInitiated: false
  }
  await withFunctionExecution(scope, () => f.call())
  expect(f.store.audit(f.folder)[0].identity).toMatchObject({
    turnId: "worker-turn",
    agentId: "worker"
  })
  await expect(
    withFunctionExecution({ ...scope, threadId: "other" }, () => f.call())
  ).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(f.host.resolve).toHaveBeenCalledOnce()
})

it("bounds concurrent calls and keeps slots until an aborted provider settles", async () => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>((r) => {
    finish = r
  })
  f.host.invoke.mockImplementation(async () => {
    await gate
    return { text: "late", inputTokens: 1, outputTokens: 1 }
  })
  const abort = new AbortController()
  const first = f.call(abort.signal),
    second = f.call()
  const rejected = expect(first).rejects.toThrow("MODS_CANCELLED")
  await expect.poll(() => f.host.invoke.mock.calls.length).toBe(2)
  abort.abort()
  await expect(f.call()).rejects.toThrow("MODS_MODEL_CAPACITY")
  expect(f.models.stats.pending).toBe(2)
  finish()
  await rejected
  await second
  expect(f.models.stats).toEqual({ pending: 0, scopes: 0 })
})

it("revocation after the provider finishes blocks publication while retaining actual execution", async () => {
  const f = fixture()
  f.host.invoke.mockImplementation(async () => {
    f.store.grant(f.folder, f.grant.modId, "digest", false)
    return { text: "private answer", inputTokens: 1, outputTokens: 1 }
  })
  await expect(f.call()).rejects.toThrow("MODS_GRANT_REVOKED")
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "succeeded", publication: "blocked" })
})

it("does not retry uncertain provider failures and hides their request details", async () => {
  const f = fixture()
  f.host.invoke.mockRejectedValue(Error("provider leaked private-host-key and private prompt"))
  await expect(f.call()).rejects.toThrow(/^MODS_MODEL_FAILED$/)
  expect(f.host.invoke).toHaveBeenCalledOnce()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
  f.host.resolve.mockRejectedValue(new ModFunctionError("MODS_MODEL_UNAVAILABLE"))
  await expect(f.call()).rejects.toThrow("MODS_MODEL_UNAVAILABLE")
  expect(f.host.invoke).toHaveBeenCalledOnce()
})

it("rechecks scope after model resolution and stops policy refusals before spending a budget", async () => {
  const f = fixture()
  f.host.resolve.mockImplementation(async () => {
    f.host.assertScope.mockImplementation(() => {
      throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
    })
    return f.config
  })
  await expect(f.call()).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(f.host.invoke).not.toHaveBeenCalled()
  expect(f.store.audit(f.folder)).toEqual([])
  f.host.assertScope.mockImplementation(() => {})
  f.host.resolve.mockResolvedValue(f.config)
  f.host.admit.mockRejectedValue(new ModFunctionError("MODS_POLICY_TOOL_DENIED"))
  await expect(f.call()).rejects.toThrow("MODS_POLICY_TOOL_DENIED")
  expect(f.host.invoke).not.toHaveBeenCalled()
  expect(f.store.audit(f.folder)).toEqual([])
})

it("enforces the call-count budget even for small output requests", async () => {
  const f = fixture()
  for (let i = 0; i < 30; i++) await f.call(undefined, 1)
  await expect(f.call(undefined, 1)).rejects.toThrow("MODS_MODEL_BUDGET")
  expect(f.host.invoke).toHaveBeenCalledTimes(30)
})

it("bounds total provider concurrency across different plugins", async () => {
  const f = fixture()
  let finish!: () => void
  const gate = new Promise<void>((resolve) => {
    finish = resolve
  })
  f.host.invoke.mockImplementation(async () => {
    await gate
    return { text: "done", inputTokens: 1, outputTokens: 1 }
  })
  const pending = Array.from({ length: 4 }, (_, index) =>
    f.models.complete(
      f.folder,
      "thread",
      f.store.grant(f.folder, `function:demo-${index}`, "digest", true),
      { model: "chosen", prompt: "hi" },
      new AbortController().signal
    )
  )
  await expect.poll(() => f.host.invoke.mock.calls.length).toBe(4)
  await expect(f.call()).rejects.toThrow("MODS_MODEL_CAPACITY")
  finish()
  await Promise.all(pending)
  expect(f.models.stats).toEqual({ pending: 0, scopes: 0 })
})

it("expires a stalled request and records uncertain execution without retrying", async () => {
  vi.useFakeTimers()
  const f = fixture()
  let reachedProvider!: () => void
  const started = new Promise<void>((resolve) => {
    reachedProvider = resolve
  })
  f.host.invoke.mockImplementation(
    (_config, _request, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
        reachedProvider()
      })
  )
  const rejected = expect(f.call()).rejects.toThrow("MODS_MODEL_TIMEOUT")
  await started
  await vi.advanceTimersByTimeAsync(60001)
  await rejected
  expect(f.host.invoke).toHaveBeenCalledOnce()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
  expect(f.models.stats).toEqual({ pending: 0, scopes: 0 })
})

it("classifies with one fixed prompt and returns only an allowed label", async () => {
  const f = fixture()
  f.host.invoke.mockResolvedValue({ text: " green \n", inputTokens: 8, outputTokens: 1 })
  await expect(
    f.models.classify(
      f.folder,
      "thread",
      f.grant,
      { text: "pick a color", labels: ["red", "green"] },
      new AbortController().signal
    )
  ).resolves.toBe("green")
  expect(f.host.invoke).toHaveBeenCalledOnce()
  expect(f.host.invoke.mock.calls[0][1].prompt).toContain("red")
  expect(f.host.invoke.mock.calls[0][1].prompt).toContain("pick a color")
})

it("returns undefined for an out-of-set classification and rejects malformed labels", async () => {
  const f = fixture()
  f.host.invoke.mockResolvedValue({ text: "not-a-label" })
  await expect(
    f.models.classify(
      f.folder,
      "thread",
      f.grant,
      { text: "x", labels: ["yes", "no"] },
      new AbortController().signal
    )
  ).resolves.toBeUndefined()
  await expect(
    f.models.classify(
      f.folder,
      "thread",
      f.grant,
      { text: "x", labels: ["yes", "yes"] },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_MODEL_ARGUMENTS")
})

it("rejects failed or empty classifications and fewer than two labels", async () => {
  const f = fixture()
  const input = { text: "x", labels: ["yes", "no"] }
  const call = () =>
    f.models.classify(f.folder, "thread", f.grant, input, new AbortController().signal)
  f.host.invoke.mockRejectedValue(Error("provider error"))
  await expect(call()).rejects.toThrow("MODS_MODEL_FAILED")
  f.host.invoke.mockResolvedValue({ text: " \n " })
  await expect(call()).rejects.toThrow("MODS_MODEL_EMPTY")
  await expect(
    f.models.classify(
      f.folder,
      "thread",
      f.grant,
      { text: "x", labels: ["yes"] },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_MODEL_ARGUMENTS")
})

it("forks only from a host snapshot and returns usage without tools or main-history writes", async () => {
  const f = fixture()
  const snapshot: FunctionModelForkSnapshot = {
    messages: [{ role: "user", text: "existing context" }],
    model: "chosen",
    assertLive: vi.fn(),
    release: vi.fn()
  }
  const capture = vi.fn(() => snapshot)
  const invokeFork = vi.fn<
    (
      config: ResolvedModelConfig,
      request: FunctionModelForkRequest,
      snapshot: FunctionModelForkSnapshot,
      signal: AbortSignal
    ) => Promise<FunctionModelForkReply>
  >(async () => ({ text: "fork answer", usage: { input_tokens: 11, output_tokens: 2 } }))
  Object.assign(f.host, { captureForkSnapshot: capture, invokeFork })
  await expect(
    f.models.fork(
      f.folder,
      "thread",
      f.grant,
      { prompt: "summarize" },
      new AbortController().signal
    )
  ).resolves.toEqual({ text: "fork answer", usage: { input_tokens: 11, output_tokens: 2 } })
  expect(capture).toHaveBeenCalledWith(f.folder, "thread")
  expect(invokeFork).toHaveBeenCalledOnce()
  expect(invokeFork.mock.calls[0][2]).toEqual(snapshot)
  expect(JSON.stringify(f.store.audit(f.folder))).not.toContain("existing context")
  expect(snapshot.release).toHaveBeenCalledOnce()
  await expect(
    f.models.fork(
      f.folder,
      "thread",
      f.grant,
      { prompt: "hijack", model: "other" },
      new AbortController().signal
    )
  ).rejects.toThrow("MODS_MODEL_ARGUMENTS")
})

it("returns null for a cold fork and propagates cancellation and authority loss", async () => {
  const f = fixture()
  const capture = vi.fn(() => null)
  Object.assign(f.host, { captureForkSnapshot: capture })
  await expect(
    f.models.fork(f.folder, "thread", f.grant, { prompt: "cold" }, new AbortController().signal)
  ).resolves.toBeNull()

  const controller = new AbortController()
  controller.abort()
  await expect(
    f.models.classify(
      f.folder,
      "thread",
      f.grant,
      { text: "x", labels: ["x", "y"] },
      controller.signal
    )
  ).rejects.toThrow("MODS_CANCELLED")
})

it("rechecks the captured fork authority after provider completion and releases it", async () => {
  const f = fixture()
  let live = true
  const snapshot: FunctionModelForkSnapshot = {
    model: "chosen",
    messages: [{ role: "user", text: "private context" }],
    assertLive: vi.fn(() => {
      if (!live) throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
    }),
    release: vi.fn()
  }
  Object.assign(f.host, {
    captureForkSnapshot: () => snapshot,
    invokeFork: async () => {
      live = false
      return { text: "stale reply" }
    }
  })
  await expect(
    f.models.fork(f.folder, "thread", f.grant, { prompt: "go" }, new AbortController().signal)
  ).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(snapshot.release).toHaveBeenCalledOnce()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "unknown", publication: "blocked" })
})

it("rejects a fork whose captured runtime is replaced during output publication", async () => {
  const f = fixture()
  let live = true
  const snapshot: FunctionModelForkSnapshot = {
    model: "chosen",
    messages: [{ role: "user", text: "context" }],
    assertLive: () => {
      if (!live) throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
    },
    release: vi.fn()
  }
  Object.assign(f.host, {
    captureForkSnapshot: () => snapshot,
    invokeFork: async () => ({ text: "completed provider result" })
  })
  f.host.publish.mockImplementation(async (_identity, text) => {
    live = false
    return text
  })
  await expect(
    f.models.fork(f.folder, "thread", f.grant, { prompt: "go" }, new AbortController().signal)
  ).rejects.toThrow("MODS_CALL_SCOPE_CHANGED")
  expect(snapshot.release).toHaveBeenCalledOnce()
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "succeeded", publication: "blocked" })
})


it("publishes modern success with real usage while retaining unknown accounting and protected text", async () => {
  const f = fixture()
  f.host.invoke.mockResolvedValueOnce({ text: "provider answer", inputTokens: 20, outputTokens: 4,
    cacheReadInputTokens: 8, cacheCreationInputTokens: 2, uncachedInputTokens: 10 })
  expect(await f.models.completeResult(f.folder, "thread", f.grant,
    { model: "chosen", prompt: "hi", timeoutMs: 321 }, new AbortController().signal)).toEqual({
      isAnswered: true, text: "protected answer", usage: { input_tokens: 10, output_tokens: 4,
        cache_read_input_tokens: 8, cache_creation_input_tokens: 2 } })
  expect(f.host.invoke.mock.calls[0][1].timeoutMs).toBe(321)
  f.host.invoke.mockResolvedValueOnce({ text: "ok" })
  expect(await f.models.completeResult(f.folder, "thread", f.grant,
    { model: "chosen", prompt: "hi" }, new AbortController().signal)).toMatchObject({
      isAnswered: true, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } })
  expect(f.models.stats.pending).toBe(0)
})

it("modern model converts only tagged provider outcomes and never host rejection or revocation", async () => {
  const f = fixture()
  const call = () => f.models.completeResult(f.folder, "thread", f.grant,
    { model: "chosen", prompt: "hi" }, new AbortController().signal)
  f.host.invoke.mockRejectedValueOnce(new FunctionModelProviderFailure({ reason: "api-error", status: 429, error: "rate_limit" }))
  expect(await call()).toMatchObject({ isAnswered: false, reason: "api-error", status: 429, error: "rate_limit" })
  expect(f.host.publish).not.toHaveBeenCalled()
  f.host.invoke.mockRejectedValueOnce(new FunctionModelProviderFailure({ reason: "aborted" }))
  expect(await call()).toMatchObject({ isAnswered: false, reason: "aborted" })
  f.host.invoke.mockResolvedValueOnce({ text: "" })
  expect(await call()).toMatchObject({ isAnswered: false, reason: "empty-reply" })
  f.host.admit.mockRejectedValueOnce(new ModFunctionError("POLICY_DENIED"))
  await expect(call()).rejects.toThrow("POLICY_DENIED")
  f.host.publish.mockRejectedValueOnce(new ModFunctionError("CONTENT_DENIED"))
  await expect(call()).rejects.toThrow("CONTENT_DENIED")
  f.host.invoke.mockImplementationOnce(async () => {
    f.store.grant(f.folder, "function:demo", "different-digest", true)
    throw new FunctionModelProviderFailure({ reason: "api-error", status: 500, error: "server_error" })
  })
  await expect(call()).rejects.toThrow()
  expect(f.models.stats.pending).toBe(0)
})

it("modern fork reports a cold transcript without a provider call and rejects extended inputs", async () => {
  const f = fixture()
  const invokeFork = vi.fn(async () => ({ text: "answer" }))
  Object.assign(f.host, { captureForkSnapshot: () => null, invokeFork })
  expect(await f.models.forkResult(f.folder, "thread", f.grant, { prompt: "hi" }, new AbortController().signal))
    .toEqual({ isAnswered: false, reason: "nothing-to-fork" })
  expect(invokeFork).not.toHaveBeenCalled()
  await expect(f.models.forkResult(f.folder, "thread", f.grant,
    { prompt: "hi", maxTokens: 2 }, new AbortController().signal)).rejects.toThrow("MODS_MODEL_ARGUMENTS")
  await expect(f.models.completeResult(f.folder, "thread", f.grant,
    { model: "chosen", prompt: "hi", effort: "high" }, new AbortController().signal)).rejects.toThrow("MODS_MODEL_EFFORT_UNSUPPORTED")
})


it("never treats modern display zeros as known usage in a real completion budget or ledger", async () => {
  const f = fixture()
  f.host.invoke.mockResolvedValueOnce({ text: "unmetered" })
  const record = vi.spyOn(f.store, "recordFunctionModelUsage")
  const budget = new CompletionBudget(2000, 10000)
  await expect(withCompletionBudget(budget, () => f.models.completeResult(f.folder, "thread", f.grant,
    { model: "chosen", prompt: "hi" }, new AbortController().signal))).rejects.toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
  expect(record).toHaveBeenCalledWith(expect.any(String), undefined, undefined)
  expect(f.host.publish).not.toHaveBeenCalled()
  expect(() => budget.assert()).toThrow("MODS_COMPLETION_USAGE_UNAVAILABLE")
  expect(f.store.audit(f.folder)[0]).toMatchObject({ status: "succeeded", publication: "blocked" })
})

it("modern warm forks protect text, preserve cached usage and release the snapshot on every outcome", async () => {
  const f = fixture()
  const release = vi.fn()
  const snapshot: FunctionModelForkSnapshot = { model: "chosen", messages: [{ role: "user", text: "history" }], release }
  const invokeFork = vi.fn(async () => ({ text: "provider fork", accounting: {
    text: "provider fork", inputTokens: 20, outputTokens: 3, uncachedInputTokens: 8,
    cacheReadInputTokens: 10, cacheCreationInputTokens: 2 } }))
  Object.assign(f.host, { captureForkSnapshot: () => snapshot, invokeFork })
  const call = () => f.models.forkResult(f.folder, "thread", f.grant, {prompt:"continue"}, new AbortController().signal)
  expect(await call()).toEqual({isAnswered:true,text:"protected fork",usage:{input_tokens:8,output_tokens:3,
    cache_read_input_tokens:10,cache_creation_input_tokens:2}})
  expect(release).toHaveBeenCalledOnce()
  f.host.publish.mockRejectedValueOnce(new ModFunctionError("CONTENT_DENIED"))
  await expect(call()).rejects.toThrow("CONTENT_DENIED")
  expect(release).toHaveBeenCalledTimes(2)
  invokeFork.mockRejectedValueOnce(new FunctionModelProviderFailure({reason:"api-error",status:503,error:"server_error"}))
  expect(await call()).toMatchObject({isAnswered:false,reason:"api-error",status:503})
  expect(release).toHaveBeenCalledTimes(3)
})


it("budgets the whole prepared call before claiming and rejects recursive preparation", async () => {
  const f = fixture()
  const invoke = vi.fn(async () => ({ text: "prepared answer", inputTokens: 1, outputTokens: 1 }))
  Object.assign(f.host, { prepare: async () => {
    await expect(f.call()).rejects.toThrow("MODS_MODEL_COMPOSE_REENTRANT")
    return { input: { messages: [{ role: "system", text: "expanded rules" }] },
      inputUpperBound: 1200, assertBudget: vi.fn(), invoke }
  } })
  const budget = new CompletionBudget(1000, 10000)
  await expect(withCompletionBudget(budget, () => f.call())).rejects.toThrow("MODS_COMPLETION_MODEL_BUDGET")
  expect(invoke).not.toHaveBeenCalled()
  expect(f.host.invoke).not.toHaveBeenCalled()
  expect(f.store.audit(f.folder)).toEqual([])
  expect(f.models.stats.pending).toBe(0)
})

it("uses the captured configured ref for a fork even when the public name is ambiguous", async () => {
  const f = fixture()
  const release = vi.fn()
  Object.assign(f.host, {
    captureForkSnapshot: () => ({ model: "gpt-4", modelRef: "custom:second-provider",
      messages: [{ role: "user", text: "history" }], release }),
    invokeFork: vi.fn(async () => ({ text: "fork result", usage: { input_tokens: 1, output_tokens: 1 } }))
  })
  await f.models.fork(f.folder, "thread", f.grant, { prompt: "question" }, new AbortController().signal)
  expect(f.host.resolve).toHaveBeenCalledWith("custom:second-provider", f.folder, "thread")
  expect(release).toHaveBeenCalledTimes(1)
})
