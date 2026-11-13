import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Thread } from "../types"
import { useAppStore } from "./store"

const row = (token: string | null, updatedAt = 1): Thread => ({
  thread_id: "mutation-scope", created_at: new Date(1), updated_at: new Date(updatedAt),
  title: "chat", status: "idle", metadata: token === null ? {} : { cmb_thread_incarnation: token }
})
const page = (thread: Thread) => ({ threads: [thread], hasMore: false,
  beforeUpdatedAt: null, beforeThreadId: null })

beforeEach(() => useAppStore.setState({ threads: [], currentThreadId: null, accountRevision: 0 }))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

it.each(["update", "patchMetadata"] as const)(
  "does not replace a recreated row with an old %s reply after a real directory refresh", async method => {
    const original = row("original"), replacement = row("replacement", 2)
    const pending = Promise.withResolvers<Thread>()
    const update = vi.fn(() => pending.promise)
    vi.stubGlobal("window", { api: { threads: {
      [method]: update, listPage: vi.fn(async () => page(replacement))
    } } })
    useAppStore.setState({ threads: [original], currentThreadId: original.thread_id })
    const writing = method === "update"
      ? useAppStore.getState().updateThread(original.thread_id, { title: "old reply" })
      : useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { model: "old-model" } })
    await useAppStore.getState().loadThreads()
    expect(useAppStore.getState().threads[0]).toBe(replacement)
    pending.resolve({ ...original, title: "old reply", updated_at: new Date(3) })
    await writing
    expect(useAppStore.getState().threads[0]).toBe(replacement)
    expect(useAppStore.getState().currentThreadId).toBe(original.thread_id)
  }
)

it("observes a changed incarnation even when every scalar directory revision is identical", async () => {
  const original = row("original"), replacement = row("replacement")
  useAppStore.setState({ threads: [original] })
  vi.stubGlobal("window", { api: { threads: { listPage: vi.fn(async () => page(replacement)) } } })
  await useAppStore.getState().loadThreads()
  expect(useAppStore.getState().threads[0]).toBe(replacement)
})

it("does not start a stale generated-title write against a replacement row", async () => {
  const original = row("original"), replacement = row("replacement", 2)
  const pending = Promise.withResolvers<string>()
  const update = vi.fn(async () => ({ ...replacement, title: "old generated title" }))
  vi.stubGlobal("window", { api: { threads: { generateTitle: vi.fn(() => pending.promise),
    update, listPage: vi.fn(async () => page(replacement)) } } })
  useAppStore.setState({ threads: [original] })
  const generating = useAppStore.getState().generateTitleForFirstMessage(original.thread_id, "old prompt")
  await useAppStore.getState().loadThreads()
  pending.resolve("old generated title")
  await generating
  expect(update).not.toHaveBeenCalled()
  expect(useAppStore.getState().threads[0]).toBe(replacement)
})

it.each([false, true])("keeps the first legacy token promotion when directory promotion happened=%s", async promoted => {
  const original = row(null), returned = { ...row("first-token", 3), metadata: {
    cmb_thread_incarnation: "first-token", model: "selected", keep: true } }
  const pending = Promise.withResolvers<Thread>()
  vi.stubGlobal("window", { api: { threads: { patchMetadata: vi.fn(() => pending.promise),
    listPage: vi.fn(async () => page(row("first-token", 2))) } } })
  useAppStore.setState({ threads: [original] })
  const writing = useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { model: "selected" } })
  if (promoted) await useAppStore.getState().loadThreads()
  pending.resolve(returned)
  await writing
  expect(useAppStore.getState().threads[0]).toBe(returned)
})

it("accepts a fresh host response already matching the actual replacement directory", async () => {
  const original = row("original"), actual = row("replacement", 2), returned = row("replacement", 3)
  const pending = Promise.withResolvers<Thread>()
  vi.stubGlobal("window", { api: { threads: { update: vi.fn(() => pending.promise),
    listPage: vi.fn(async () => page(actual)) } } })
  useAppStore.setState({ threads: [original] })
  const writing = useAppStore.getState().updateThread(original.thread_id, { title: "fresh host title" })
  await useAppStore.getState().loadThreads()
  pending.resolve(returned)
  await writing
  expect(useAppStore.getState().threads[0]).toBe(returned)
})

it("preserves same-incarnation workspace/title changes and concurrent host-row arrival semantics", async () => {
  const original = row("original"), first = Promise.withResolvers<Thread>(), second = Promise.withResolvers<Thread>()
  const firstReply = { ...original, updated_at: new Date(4), metadata: {
    ...original.metadata, first: true, second: true, workspacePath: "C:/new" } }
  const secondReply = { ...original, title: "new title", updated_at: new Date(3), metadata: {
    ...original.metadata, first: true, second: true, workspacePath: "C:/new" } }
  vi.stubGlobal("window", { api: { threads: {
    patchMetadata: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    listPage: vi.fn(async () => page({ ...original, title: "intermediate", updated_at: new Date(2),
      metadata: { ...original.metadata, workspacePath: "C:/new" } }))
  } } })
  useAppStore.setState({ threads: [original] })
  const a = useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { first: true } })
  const b = useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { second: true } })
  await useAppStore.getState().loadThreads()
  second.resolve(secondReply); await b
  expect(useAppStore.getState().threads[0]).toBe(secondReply)
  first.resolve(firstReply); await a
  expect(useAppStore.getState().threads[0]).toBe(firstReply)
  expect(useAppStore.getState().threads[0].metadata).toMatchObject({ first: true, second: true })
})

it("does not move an old reply across an account revision or recreate a removed row", async () => {
  const original = row("original"), first = Promise.withResolvers<Thread>()
  vi.stubGlobal("window", { api: { threads: { update: vi.fn(() => first.promise) } } })
  useAppStore.setState({ threads: [original] })
  const updating = useAppStore.getState().updateThread(original.thread_id, { title: "old account" })
  useAppStore.setState({ accountRevision: 1 })
  first.resolve({ ...original, title: "old account" }); await updating
  expect(useAppStore.getState().threads[0]).toBe(original)
  const second = Promise.withResolvers<Thread>()
  vi.stubGlobal("window", { api: { threads: { patchMetadata: vi.fn(() => second.promise) } } })
  const patching = useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { model: "old" } })
  useAppStore.setState({ threads: [] })
  second.resolve(original); await patching
  expect(useAppStore.getState().threads).toEqual([])
})

it("copies date scalars and never scans unrelated metadata during a mutation", async () => {
  const original = row("original"), pending = Promise.withResolvers<Thread>()
  const huge = vi.fn(() => { throw Error("unrelated metadata must not be scanned") })
  Object.defineProperty(original.metadata!, "huge", { enumerable: true, get: huge })
  vi.stubGlobal("window", { api: { threads: { patchMetadata: vi.fn(() => pending.promise) } } })
  useAppStore.setState({ threads: [original] })
  const writing = useAppStore.getState().patchThreadMetadata(original.thread_id, { set: { model: "new" } })
  original.created_at.setTime(2)
  pending.resolve({ ...original, created_at: new Date(1), title: "old date reply" })
  await writing
  expect(useAppStore.getState().threads[0]).toBe(original)
  expect(huge).not.toHaveBeenCalled()
})

it.each(["update", "patchMetadata"] as const)(
  "does not let a %s call with no original row overwrite a later loaded same-scope row", async method => {
    const actual = row("loaded-after-request", 2), pending = Promise.withResolvers<Thread>()
    vi.stubGlobal("window", { api: { threads: { [method]: vi.fn(() => pending.promise),
      listPage: vi.fn(async () => page(actual)) } } })
    const writing = method === "update"
      ? useAppStore.getState().updateThread(actual.thread_id, { title: "unowned reply" })
      : useAppStore.getState().patchThreadMetadata(actual.thread_id, { set: { model: "unowned" } })
    await useAppStore.getState().loadThreads()
    pending.resolve({ ...actual, title: "unowned reply", updated_at: new Date(3) })
    await writing
    expect(useAppStore.getState().threads[0]).toBe(actual)
  }
)
