import { afterEach, expect, it, vi } from "vitest"
import { readColdFunctionSession } from "./session-cold-read"

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  selected: vi.fn(),
  defaultModel: vi.fn(),
  path: vi.fn(),
  read: vi.fn()
}))
vi.mock("../../db", () => ({ getThreadCore: mocks.thread }))
vi.mock("../../models/registry", () => ({
  getModelConfigByRef: mocks.selected,
  getAvailableModelConfigOrDefault: mocks.defaultModel
}))
vi.mock("../../storage", () => ({ peekThreadCheckpointPath: mocks.path }))
vi.mock("../../checkpointer/runtime-projection-client", () => ({
  readFunctionSessionTranscriptInWorker: mocks.read
}))
afterEach(() => vi.resetAllMocks())

it("returns only the configured model name and checks metadata again before publication", async () => {
  mocks.thread.mockReturnValue({ metadata: '{"modelId":"chosen"}' })
  mocks.selected.mockReturnValue({ model: "actual-name", apiKey: "private", baseUrl: "private" })
  const result = await readColdFunctionSession(
    "thread",
    "session.model",
    new AbortController().signal
  )
  expect(result.value).toBe("actual-name")
  expect(mocks.selected).toHaveBeenCalledWith("chosen")
  expect(mocks.defaultModel).not.toHaveBeenCalled()
  expect(mocks.read).not.toHaveBeenCalled()
  mocks.thread.mockReturnValue({ metadata: "{}" })
  expect(result.assertLive).toThrow("MODS_CALL_SCOPE_CHANGED")
})

it("distinguishes absent checkpoints from failed/invalid reads and requests only the chosen projection", async () => {
  mocks.thread.mockReturnValue({ metadata: "{}" })
  mocks.path.mockReturnValue("checkpoint.sqlite")
  mocks.read.mockResolvedValue(null)
  const signal = new AbortController().signal
  expect((await readColdFunctionSession("thread", "session.messages", signal)).value).toEqual([])
  expect(mocks.read).toHaveBeenLastCalledWith("checkpoint.sqlite", "thread", signal, "messages")
  mocks.read.mockResolvedValue({ turns: 7 })
  expect((await readColdFunctionSession("thread", "session.turns", signal)).value).toBe(7)
  expect(mocks.read).toHaveBeenLastCalledWith("checkpoint.sqlite", "thread", signal, "turns")
  await expect(readColdFunctionSession("thread", "session.messages", signal)).rejects.toThrow(
    "MODS_SESSION_MESSAGES_INVALID"
  )
  mocks.read.mockRejectedValue(Error("unreadable"))
  await expect(readColdFunctionSession("thread", "session.messages", signal)).rejects.toThrow(
    "unreadable"
  )
})
