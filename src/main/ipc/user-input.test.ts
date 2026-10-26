import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserWindow, IpcMain } from "electron"
import { afterEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ windows: [] as unknown[], root: "", send: vi.fn() }))
vi.mock("electron", () => ({ BrowserWindow: { getAllWindows: () => mocks.windows } }))
vi.mock("../storage", () => ({ getOpenworkDir: () => mocks.root, getPlugins: () => [] }))
vi.mock("../db", () => ({ getThreadCore: () => undefined }))
vi.mock("../app-attention-events", () => ({ emitAppAttention: () => {} }))
import { configureHostInputResumeHandler, registerUserInputHandlers } from "./user-input"
import { HostUserInputStore } from "../services/host-user-input-store"
import {
  bindHostUserInputScope,
  configureHostUserInputPersistence,
  prepareHostInputInterrupt,
  claimHostInputContinuation
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
  mocks.send.mockReset()
})

function fixture() {
  mocks.root = mkdtempSync(join(tmpdir(), "host-input-ipc-"))
  cleanup.push(() => rmSync(mocks.root, { recursive: true, force: true }))
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerUserInputHandlers({
    on: (key, handler) => handlers.set(key, handler),
    handle: (key, handler) => handlers.set(key, handler)
  } as unknown as IpcMain)
  expect(existsSync(join(mocks.root, "local-projects"))).toBe(false)
  const store = new HostUserInputStore(join(mocks.root, "requests.sqlite"))
  cleanup.push(() => store.close())
  configureHostUserInputPersistence({ store: () => store, isCurrent: () => true })
  const owner = {
    isDestroyed: () => false,
    webContents: { id: 1, isDestroyed: () => false, send: mocks.send }
  } as unknown as BrowserWindow
  mocks.windows = [owner]
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
