import { expect, it, vi } from "vitest"
import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { captureThreadTranscriptSourceScope } from "./thread-transcript-source-scope"

function fixture(workspacePath?: unknown) {
  const current = vi.fn(),
    query = vi.fn((_args: unknown[]) => ({ workspacePath }))
  const prepare = vi.fn(() => query)
  const row = { thread_id: "thread" }
  Object.defineProperty(row, "metadata", {
    get() {
      throw Error("Do not parse large metadata")
    }
  })
  const read = {
    row,
    incarnation: { token: "original", legacyCreatedAt: 1 },
    assertCurrent: current,
    database: { prepareReadOne: prepare } as unknown as Pick<NativeSqliteAdapter, "prepareReadOne">
  }
  return { read, current, query, prepare }
}

it("attaches original incarnation and only the native workspace scalar under the original guard", () => {
  const f = fixture()
  f.query.mockImplementation((args) => {
    expect(f.current).toHaveBeenCalledTimes(1)
    expect(args).toEqual(["thread"])
    return { workspacePath: "/workspace" }
  })
  const scope = captureThreadTranscriptSourceScope("thread", f.read)
  expect(scope).toEqual({
    threadId: "thread",
    workspacePath: "/workspace",
    incarnation: { token: "original", legacyCreatedAt: 1 }
  })
  expect(f.current).toHaveBeenCalledTimes(2)
  expect(f.prepare).toHaveBeenCalledTimes(1)
  expect(Object.isFrozen(scope?.incarnation)).toBe(true)
})

it.each([undefined, null, 42, {}, "", "   "])(
  "keeps no-workspace ordinary pages valid without inventing scope from %j",
  (workspace) => {
    const f = fixture(workspace)
    const scope = captureThreadTranscriptSourceScope("thread", f.read)
    expect(scope).toEqual({
      threadId: "thread",
      incarnation: { token: "original", legacyCreatedAt: 1 }
    })
  }
)

it("refuses original source retirement before preparing SQL", () => {
  const f = fixture(),
    changed = Error("ORIGINAL_READ_RETIRED")
  f.current.mockImplementation(() => {
    throw changed
  })
  expect(() => captureThreadTranscriptSourceScope("thread", f.read)).toThrow(changed)
  expect(f.prepare).not.toHaveBeenCalled()
})

it("refuses source replacement during the scalar read instead of publishing a new scope", () => {
  const f = fixture(),
    changed = Error("ORIGINAL_READ_RETIRED")
  f.current
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw changed
    })
  expect(() => captureThreadTranscriptSourceScope("thread", f.read)).toThrow(changed)
  expect(f.query).toHaveBeenCalledTimes(1)
})

it("does not select a different thread ID even when given a copied page request", () => {
  const f = fixture()
  expect(() => captureThreadTranscriptSourceScope("other", f.read)).toThrow(
    "MODS_CONVERSATION_THREAD_CHANGED"
  )
  expect(f.prepare).not.toHaveBeenCalled()
})

it("omits an unrepresentable header without truncating the native identity or changing page reads", () => {
  const workspace = "\u0001".repeat(32769),
    f = fixture(workspace)
  expect(captureThreadTranscriptSourceScope("thread", f.read)).toBeUndefined()
  expect(workspace.length).toBe(32769)
  expect(f.current).toHaveBeenCalledTimes(2)
})
