import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, IpcMain } from "electron"
import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  const metadata = new Map<string, string>()
  const readThread = (threadId: string) => ({ metadata: metadata.get(threadId) })
  return {
    windows: [] as unknown[], root: "", send: vi.fn(), metadata,
    getThreadCore: vi.fn(readThread), getThreadRuntimeScope: vi.fn(readThread)
  }
})
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
vi.mock("../storage", () => ({ getOpenworkDir: () => mocks.root, getPlugins: () => [] }))
vi.mock("../db", () => ({
  getThreadCore: mocks.getThreadCore,
  getThreadRuntimeScope: mocks.getThreadRuntimeScope
}))
vi.mock("../app-attention-events", () => ({ emitAppAttention: () => {} }))
import { configureHostInputResumeHandler, registerUserInputHandlers } from "./user-input"
import { HostUserInputStore } from "../services/host-user-input-store"
import {
  bindHostUserInputScope,
  configureHostUserInputPersistence,
  prepareHostInputInterrupt,
  claimHostInputContinuation,
  requestUserInput
} from "../services/user-input"

const cleanup: Array<() => void> = []
afterEach(() => {
  configureHostInputResumeHandler(undefined)
  configureHostUserInputPersistence(undefined)
  cleanup
    .splice(0)
    .reverse()
    .forEach((run) => run())
  mocks.windows = []
  mocks.metadata.clear()
  mocks.send.mockReset()
  mocks.getThreadCore.mockClear()
  mocks.getThreadRuntimeScope.mockClear()
})

function ipcFixture() {
  mocks.root = mkdtempSync(join(tmpdir(), "host-input-ipc-"))
  cleanup.push(() => rmSync(mocks.root, { recursive: true, force: true }))
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerUserInputHandlers({
    on: (key, handler) => handlers.set(key, handler),
    handle: (key, handler) => handlers.set(key, handler)
  } as unknown as IpcMain)
  expect(existsSync(join(mocks.root, "local-projects"))).toBe(false)
  const owner = {
    isDestroyed: () => false,
    webContents: { id: 1, isDestroyed: () => false, send: mocks.send }
  } as unknown as BrowserWindow
  mocks.windows = [owner]
  return { handlers, owner }
}

function fixture() {
  const { handlers, owner } = ipcFixture()
  const store = new HostUserInputStore(join(mocks.root, "requests.sqlite"))
  cleanup.push(() => store.close())
  configureHostUserInputPersistence({ store: () => store, isCurrent: () => true })
  cleanup.push(
    bindHostUserInputScope(
      "thread",
      {
        projectId: "project",
        operationId: "operation",
        stageId: "draft",
        installedPluginId: "plugin",
        expectedVersion: 1,
        pluginDigest: "a".repeat(64),
        inputFingerprint: "b".repeat(64),
        incarnationKey: "original"
      },
      () => {}
    )
  )
  const record = prepareHostInputInterrupt("thread", "input-tool-id", [
    {
      id: "choice",
      header: "Input",
      question: "Which input?",
      options: [
        { label: "First", description: "First input" },
        { label: "Second", description: "Second input" }
      ]
    }
  ])!
  const response = {
    requestId: record.request.requestId,
    answers: {
      choice: {
        questionId: "choice",
        type: "option",
        optionIndex: 0,
        label: "First",
        description: "First input"
      }
    }
  }
  return { handlers, store, owner, response, record }
}

it("keeps ordinary IPC questions, answers and cancellation independent of a damaged Host store", async () => {
  const { handlers } = ipcFixture()
  const projects = join(mocks.root, "local-projects")
  mkdirSync(projects)
  writeFileSync(join(projects, "user-input.sqlite"), "invalid SQLite contents".repeat(128))

  const getPending = (threadId: string) => handlers.get("userInput:getPending")!({}, threadId)
  expect(getPending("ordinary")).toBeNull()
  expect(mocks.getThreadRuntimeScope).toHaveBeenCalledWith("ordinary")
  expect(mocks.getThreadCore).not.toHaveBeenCalled()
  const questions = [{ id: "q", header: "Input", question: "Which input?", options: [
    { label: "First", description: "First input" }, { label: "Second", description: "Second input" }
  ] }]
  const request = requestUserInput({ threadId: "ordinary", questions })
  const pending = getPending("ordinary") as { requestId: string }
  const resume = vi.fn(async () => {})
  configureHostInputResumeHandler(resume)
  handlers.get("userInput:response")!({ sender: { id: 1 } }, {
    requestId: pending.requestId, answers: { q: { questionId: "q", type: "option", optionIndex: 0,
      label: "First", description: "First input" } }
  })
  await expect(request).resolves.toMatchObject({ requestId: pending.requestId })
  expect(resume).not.toHaveBeenCalled()
  const controller = new AbortController()
  const cancelled = requestUserInput({ threadId: "ordinary", questions, abortSignal: controller.signal })
  const cancelledExpectation = expect(cancelled).rejects.toThrow("cancelled")
  controller.abort()
  await cancelledExpectation
  expect(getPending("ordinary")).toBeNull()

  mocks.metadata.set("managed", JSON.stringify({ hostProjectRuntime: {
    projectId: "project", operationId: "operation"
  } }))
  expect(() => getPending("managed")).toThrow(/not a database/i)
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(() => handlers.get("userInput:ack")!({ sender: { id: 1 } }, {
      requestId: "host-input:pending", threadId: "managed"
    })).not.toThrow()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stored Host acknowledgement"), expect.anything())
  } finally {
    warn.mockRestore()
  }
  expect(getPending("ordinary")).toBeNull()
  expect(mocks.getThreadRuntimeScope).toHaveBeenCalledWith("managed")
  expect(mocks.getThreadCore).not.toHaveBeenCalled()
})

it("persists an answer through the actual IPC handler then resumes once with its trusted window", async () => {
  const f = fixture()
  const resume = vi.fn(async (id: string, threadId: string, owner: BrowserWindow) => {
    expect(owner).toBe(f.owner)
    expect(threadId).toBe("thread")
    expect(f.store.get(id)?.status).toBe("answered")
    claimHostInputContinuation(id)
  })
  configureHostInputResumeHandler(resume)
  f.handlers.get("userInput:response")!({ sender: { id: 1 } }, f.response)
  await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
  f.handlers.get("userInput:response")!({ sender: { id: 1 } }, f.response)
  expect(resume).toHaveBeenCalledTimes(1)
  expect(f.store.get(f.response.requestId)?.continuation?.claimed).toBe(true)
})

it("retains an answer on failed safety admission and rejects unknown-window submissions", async () => {
  const f = fixture()
  const resume = vi.fn(async () => {
    throw Error("RESOURCE_UNCONFIRMED")
  })
  configureHostInputResumeHandler(resume)
  f.handlers.get("userInput:response")!({ sender: { id: 99 } }, f.response)
  expect(f.store.get(f.response.requestId)?.status).toBe("waiting")
  expect(resume).not.toHaveBeenCalled()
  f.handlers.get("userInput:response")!({ sender: { id: 1 } }, f.response)
  await vi.waitFor(() =>
    expect(mocks.send).toHaveBeenCalledWith(
      "userInput:cancel:thread",
      expect.objectContaining({ reason: expect.stringContaining("答案已保存") })
    )
  )
  expect(f.store.get(f.response.requestId)).toMatchObject({
    status: "answered",
    continuation: { claimed: false }
  })
})
