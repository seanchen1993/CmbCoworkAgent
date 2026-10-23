import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { HookProcessCleanupError } from "../hooks/owned-process-error"
import { HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES } from "./adapter-detail-protocol"

const state = vi.hoisted(() => ({
  root: "",
  deadlineMs: 500,
  prepare: vi.fn(),
  spawn: vi.fn()
}))
vi.mock("../storage", () => ({ getOpenworkDir: () => state.root }))
vi.mock("./notifications", () => ({ harnessNotifications: {} }))
vi.mock("./extension-context", () => ({
  prepareExtensionContext: (...args: unknown[]) => state.prepare(...args),
  readExtensionContextProjection: () => undefined
}))
vi.mock("../hooks/owned-command", () => ({
  startOwnedHookCommand: (...args: unknown[]) => state.spawn(...args)
}))
vi.mock("./invocation-lifecycle", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./invocation-lifecycle")>()
  return {
    ...actual,
    createHarnessInvocationDeadline: (timeout: number, signal?: AbortSignal) =>
      actual.createHarnessInvocationDeadline(Math.min(timeout, state.deadlineMs), signal)
  }
})
vi.mock("./catalog-client", () => ({
  cancelHarnessCatalogScope: () => {},
  readHarnessProjectContextsInWorker: async () => ({
    projects: {
      p: {
        project: {
          projectId: "p",
          name: "p",
          projectCode: "p",
          projectDir: "p",
          workspacePath: state.root,
          lifecycle: { status: "active" },
          "harness-adapter": { id: "plugin", name: "plugin", type: "plugin" }
        },
        plugin: { id: "plugin", name: "plugin", path: state.root, version: "1.0.0" },
        sessionContextInjectionSource: "plugin",
        selectedDeployUnits: [],
        configSnapshot: {
          error: null,
          value: {
            apiVersion: 1,
            inspectCommands: {
              [process.platform]: { session_context_inject: `"${process.execPath}" --version` }
            }
          }
        }
      }
    }
  })
}))

import { buildHarnessFeatureAgentContext } from "./service"

type PhysicalResult = { code: number | null; error?: Error }
const drains: Array<{ resolve(value: PhysicalResult): void }> = []
const read = (signal?: AbortSignal) =>
  buildHarnessFeatureAgentContext({ harnessFeature: { projectId: "p", slug: "f" } }, { signal })
const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error) => ({ error })
  )

beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), "cmb-context-lifecycle-"))
  await mkdir(join(state.root, "board_core"))
  state.deadlineMs = 500
  state.prepare.mockReset().mockResolvedValue(undefined)
  state.spawn.mockReset().mockImplementation((input: { stdout(chunk: Buffer): void }) => {
    input.stdout(Buffer.from(JSON.stringify({ ok: true, sessionContext: "original context" })))
    let resolve!: (value: PhysicalResult) => void
    const completion = new Promise<PhysicalResult>((done) => {
      resolve = done
    })
    drains.push({ resolve })
    return { completion, stop: vi.fn() }
  })
})
afterEach(async () => {
  for (const drain of drains.splice(0)) drain.resolve({ code: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))
  await rm(state.root, { recursive: true, force: true })
})

it("keeps cancelled physical work admitted until confirmed cleanup, without optional fallback", async () => {
  const controller = new AbortController()
  const first = settle(read(controller.signal))
  await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(1))
  controller.abort(new DOMException("user cancelled context", "AbortError"))
  expect(await first).toMatchObject({ error: { name: "AbortError" } })
  const second = settle(read())
  await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(2))
  const queuedController = new AbortController()
  const queued = settle(read(queuedController.signal))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(state.spawn).toHaveBeenCalledTimes(2)
  queuedController.abort(new DOMException("cancel queued context", "AbortError"))
  expect(await queued).toMatchObject({ error: { name: "AbortError" } })
  drains[0].resolve({ code: 0 })
  drains[1].resolve({ code: 0 })
  expect(await second).toMatchObject({ value: { harnessAgentsPrompt: "original context" } })
})

it("expires during preparation and forbids a late completion from starting a process", async () => {
  state.deadlineMs = 50
  let finish!: (value: undefined) => void
  state.prepare.mockImplementation(
    () =>
      new Promise<undefined>((resolve) => {
        finish = resolve
      })
  )
  const result = await settle(read())
  expect(result).toMatchObject({ error: { name: "HarnessInvocationTimeoutError" } })
  expect(state.spawn).not.toHaveBeenCalled()
  finish(undefined)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(state.spawn).not.toHaveBeenCalled()
})

it("bounds queued admission by the total deadline while physical cleanup keeps its slots", async () => {
  state.deadlineMs = 150
  const first = settle(read())
  const second = settle(read())
  await vi.waitFor(() => expect(state.spawn).toHaveBeenCalledTimes(2))
  const queued = settle(read())
  const results = await Promise.all([first, second, queued])
  for (const result of results)
    expect(result).toMatchObject({ error: { name: "HarnessInvocationTimeoutError" } })
  expect(state.spawn).toHaveBeenCalledTimes(2)
  for (const drain of drains) drain.resolve({ code: 0 })
})

it("keeps a missing interpreter error visible in an optional-context warning", async () => {
  state.spawn.mockImplementation(() => {
    throw Error("CONTEXT_INTERPRETER_NOT_FOUND")
  })
  const result = await read()
  expect(result?.sessionContextInjectWarning).toContain("CONTEXT_INTERPRETER_NOT_FOUND")
  expect(result?.harnessAgentsPrompt).toBeUndefined()
})

it("stops an owner whose synchronous first output exceeds the original buffer limit", async () => {
  const stop = vi.fn()
  state.spawn.mockImplementation((input: { stdout(chunk: Buffer): void }) => {
    input.stdout(Buffer.alloc(HARNESS_ADAPTER_DETAIL_MAX_INPUT_BYTES + 1))
    return { stop, completion: Promise.resolve({ code: 0 }) }
  })
  const result = await read()
  expect(stop).toHaveBeenCalledOnce()
  expect(result?.sessionContextInjectWarning).toContain("exceeded maxBuffer")
  expect(result?.harnessAgentsPrompt).toBeUndefined()
})

it("quarantines unknown physical cleanup instead of releasing either writer lease", async () => {
  const releases = [vi.fn(), vi.fn()]
  state.prepare
    .mockImplementationOnce(async () => ({ release: releases[0], env: {} }))
    .mockImplementationOnce(async () => ({ release: releases[1], env: {} }))
  state.spawn.mockImplementation(() => ({
    completion: Promise.reject(new HookProcessCleanupError()),
    stop: vi.fn()
  }))
  await expect(read()).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
  await expect(read()).rejects.toThrow("HOOK_PROCESS_CLEANUP_UNCONFIRMED")
  for (const release of releases) expect(release).not.toHaveBeenCalled()
  state.deadlineMs = 50
  await expect(read()).rejects.toMatchObject({ name: "HarnessInvocationTimeoutError" })
  expect(state.spawn).toHaveBeenCalledTimes(2)
})
