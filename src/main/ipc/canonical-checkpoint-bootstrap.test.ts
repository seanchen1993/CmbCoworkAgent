import { beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(), tuple: vi.fn(), verify: vi.fn(), exec: vi.fn()
}))
vi.mock("../db", () => ({ getDb: () => ({ exec: mocks.exec }) }))
vi.mock("../storage", () => ({ getDbPath: () => "messages.sqlite",
  getThreadCheckpointPath: () => "checkpoint.sqlite" }))
vi.mock("../checkpointer/runtime-projection-client", () => ({
  readLatestCheckpointRuntimeTupleInWorker: mocks.runtime,
  readLatestCheckpointTupleInWorker: mocks.tuple
}))
vi.mock("../checkpointer/function-conversation-canonical-display", () => ({
  verifyCanonicalCheckpointWorkerDisplay: mocks.verify
}))
import { readCanonicalCheckpointBootstrap } from "./canonical-checkpoint-bootstrap"

const runtime = { checkpoint: { id: "checkpoint", channel_values: { todos: [] } } }
const input = () => ({ threadId: "thread", workspace: "owned",
  incarnation: { token: "incarnation", legacyCreatedAt: 1 },
  foregroundKey: "thread-hydration:1", assertCurrent: vi.fn() })
beforeEach(() => {
  vi.resetAllMocks()
  mocks.runtime.mockResolvedValue(runtime)
  mocks.exec.mockReturnValue([{ values: [[1]] }])
  mocks.tuple.mockImplementation(async (_path, _thread, _ns, options) =>
    options.verifyDisplay({ checkpoint: { id: "checkpoint" } }))
  mocks.verify.mockImplementation((value, _thread, _id, current, admitted) => {
    current()
    admitted()
    return value
  })
})

it("returns only runtime state after complete membership admission and never writes a migration marker", async () => {
  const result = await readCanonicalCheckpointBootstrap(input())
  expect(result?.runtimeTuple).toBe(runtime)
  expect(result?.stats.migratedMessages).toBe(0)
  expect(mocks.tuple.mock.calls[0][3]).toMatchObject({ messageLimit: 1,
    messageByteBudget: 64 * 1024, nativeDisplay: { threadId: "thread", workspace: "owned",
      incarnation: { token: "incarnation", legacyCreatedAt: 1 }, checkpointId: "checkpoint" } })
  expect(mocks.exec.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true)
})

it("leaves unmarked legacy checkpoints on the original path without a native scan", async () => {
  mocks.exec.mockReturnValue([])
  expect(await readCanonicalCheckpointBootstrap(input())).toBeNull()
  expect(mocks.tuple).not.toHaveBeenCalled()
})

it("does not infer full durable coverage from a valid but mixed canonical checkpoint", async () => {
  mocks.verify.mockImplementation(value => value)
  expect(await readCanonicalCheckpointBootstrap(input())).toBeNull()
})

it("propagates proof and scope failure instead of granting native bootstrap", async () => {
  mocks.verify.mockImplementation(() => { throw Error("bad projection seal") })
  await expect(readCanonicalCheckpointBootstrap(input())).rejects.toThrow("bad projection seal")
  const retired = input()
  retired.assertCurrent.mockImplementation(() => { throw Error("thread retired") })
  await expect(readCanonicalCheckpointBootstrap(retired)).rejects.toThrow("thread retired")
})

it("treats a genuinely new thread without a checkpoint as the original empty source", async () => {
  mocks.runtime.mockResolvedValue(null)
  expect(await readCanonicalCheckpointBootstrap(input())).toBeNull()
  expect(mocks.exec).not.toHaveBeenCalled()
})
