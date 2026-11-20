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
