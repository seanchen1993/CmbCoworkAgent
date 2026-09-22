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
  type FunctionModelRequest,
  type FunctionModelReply
} from "./model-sdk"
import type { ModIdentity, ModObject } from "../../../shared/mods/types"
import { withFunctionExecution } from "./execution-context"
import { FunctionRegisteredTools } from "./registered-tools"
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
