import { afterEach, expect, it, vi } from "vitest"
const state = vi.hoisted(() => ({ parent: undefined as string | undefined, live: true }))
vi.mock("./coordinator-worker-mods-context", () => ({
  readCoordinatorWorkerModsContext: () => {
    if (!state.live) throw Error("CHILD_SCOPE_CHANGED")
    return state.parent ? { parentThreadId: state.parent } : undefined
  }
}))
vi.mock("./workflow-child-mods-context", () => ({ readWorkflowChildModsContext: () => undefined }))
vi.mock("../db", () => ({
  getThreadCore: vi.fn((id: string) => ({
    thread_id: id,
    created_at: 1,
    updated_at: 2,
    metadata: "full-history",
    status: "idle",
    title: ""
  }))
}))
import { getThreadCore } from "../db"
import { readNativeChildModsThread } from "./native-child-mods-context"
afterEach(() => {
  state.parent = undefined
  state.live = true
  vi.clearAllMocks()
})
it("keeps the original full reader by default and only uses the selected scope reader on the actual parent", () => {
  state.parent = "parent"
  expect(readNativeChildModsThread("child").thread?.metadata).toBe("full-history")
  expect(getThreadCore).toHaveBeenCalledWith("parent")
  const read = vi.fn(() => null)
  expect(readNativeChildModsThread("child", read).thread).toBeNull()
  expect(read).toHaveBeenCalledExactlyOnceWith("parent")
  state.parent = "replacement"
  readNativeChildModsThread("child", read)
  expect(read).toHaveBeenLastCalledWith("replacement")
  state.live = false
  expect(() => readNativeChildModsThread("child", read)).toThrow("CHILD_SCOPE_CHANGED")
  expect(read).toHaveBeenCalledTimes(2)
})
