import { randomUUID } from "node:crypto"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { Thread } from "../types"
import { useAppStore } from "./store"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../../shared/mods/v2/resource-budgets"

type Publisher = ReturnType<ReturnType<typeof useAppStore.getState>["captureThreadSummaryRead"]>
const pending: Publisher[] = []
const read = (id: string) => { const publisher = useAppStore.getState().captureThreadSummaryRead(id); pending.push(publisher); return publisher }
const row = (id: string, token = "original"): Thread => ({ thread_id: id, title: id,
  status: "idle", created_at: new Date(1), updated_at: new Date(1), metadata: { cmb_thread_incarnation: token } })
beforeEach(() => useAppStore.setState({ threads: [], accountRevision: 0 }))
afterEach(() => { for (const publisher of pending.splice(0)) publisher.close(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it("allows an initially unloaded thread's first read, once, without requiring a directory page", () => {
  const id = randomUUID(), publisher = read(id), returned = row(id)
  expect(publisher.isCurrent()).toBe(true)
  expect(publisher.publish(returned)).toBe(true)
  expect(useAppStore.getState().threads[0]).toBe(returned)
  expect(publisher.publish(row(id, "another"))).toBe(false)
  expect(publisher.isCurrent()).toBe(false)
})

it("permits fresh discovery when the original visible incarnation has stayed current", () => {
  const id = randomUUID(), original = row(id), returned = row(id, "fresh-host-owner")
  useAppStore.setState({ threads: [original] })
  expect(read(id).publish(returned)).toBe(true)
  expect(useAppStore.getState().threads[0]).toBe(returned)
})

it.each([true, false])("does not lend the original/absent fallback after target ABA, present=%s", present => {
  const id = randomUUID(), original = row(id)
  useAppStore.setState({ threads: present ? [original] : [] })
  const publisher = read(id)
  useAppStore.getState().addThreadSummary(row(id, "replacement"))
  useAppStore.setState({ threads: present ? [original] : [] })
  // Identity transitions are not deletion/account revocation. Only an exact
  // actual-current reply may now publish; the original/absent fallback is gone.
  expect(publisher.publish(row(id, "not-the-actual-current-owner"))).toBe(false)
  expect(useAppStore.getState().threads).toEqual(present ? [original] : [])
})

it("prioritizes irreversible deletion revocation even when the reply matches the new current row", () => {
  const id = randomUUID(), original = row(id), replacement = row(id, "replacement")
  useAppStore.setState({ threads: [original] })
  const publisher = read(id)
  useAppStore.getState().finalizeThreadDeletions([id])
  useAppStore.getState().addThreadSummary(replacement)
  expect(publisher.publish({ ...replacement, title: "late" })).toBe(false)
  expect(useAppStore.getState().threads[0]).toBe(replacement)
})

it.each(["original", null])("accepts a fresh reply matching the actual directory after promotion from %s", token => {
  const id = randomUUID(), original = row(id), replacement = row(id, "new-current")
  if (token === null) original.metadata = {}
  useAppStore.setState({ threads: [original] })
  const publisher = read(id)
  useAppStore.getState().addThreadSummary(replacement)
  const fresh = { ...replacement, title: "fresh host reply" }
  expect(publisher.publish(fresh)).toBe(true)
  expect(useAppStore.getState().threads[0]).toBe(fresh)
})

it("does not revoke for same-incarnation title/workspace/touch or unrelated thread updates", () => {
  const id = randomUUID(), other = randomUUID(), original = row(id)
  useAppStore.setState({ threads: [original, row(other)] })
  const publisher = read(id)
  useAppStore.getState().syncThreadWorkspaceSummary(id, "C:/target")
  useAppStore.getState().syncThreadWorkspaceSummary(other, "C:/unrelated")
  useAppStore.getState().touchThreadSummaries([id, other], new Date(2))
  expect(publisher.isCurrent()).toBe(true)
  const returned = { ...original, title: "fresh title", metadata: { ...original.metadata, workspacePath: "C:/target" } }
  expect(publisher.publish(returned)).toBe(true)
})

it("revokes before awaiting a deletion and permits a fresh read after a failed deletion", async () => {
  const id = randomUUID(), original = row(id), deleting = Promise.withResolvers<void>()
  useAppStore.setState({ threads: [original] })
  vi.stubGlobal("window", { api: { threads: { delete: vi.fn(() => deleting.promise) } } })
  const old = read(id)
  const removal = useAppStore.getState().deleteThread(id).catch(error => error)
  expect(old.isCurrent()).toBe(false)
  expect(read(id).isCurrent()).toBe(false)
  deleting.reject(Error("controlled deletion rollback"))
  await removal
  expect(old.publish(original)).toBe(false)
  const fresh = read(id)
  expect(fresh.isCurrent()).toBe(true)
  old.close()
  expect(fresh.publish(original)).toBe(true)
})

it("revokes an initially absent target on committed finalize, even without a state change", () => {
  const id = randomUUID(), publisher = read(id)
  useAppStore.getState().finalizeThreadDeletions([id])
  expect(publisher.publish(row(id))).toBe(false)
  expect(useAppStore.getState().threads).toEqual([])
})

it("keeps account ABA and an in-place Date change from restoring an old publisher", () => {
  const id = randomUUID(), original = row(id)
  useAppStore.setState({ threads: [original] })
  const account = read(id)
  useAppStore.setState({ accountRevision: 1 })
  useAppStore.setState({ accountRevision: 0 })
  expect(account.publish(original)).toBe(false)
  const date = read(id)
  original.created_at.setTime(2)
  expect(date.publish({ ...original, created_at: new Date(1) })).toBe(false)
})

it("bounds live pending publishers and does not return credit on revocation before close", () => {
  const limit = FUNCTION_MOD_RESOURCE_BUDGETS.rendererThreadSummaryRead.pending
  const ids = Array.from({ length: limit }, () => randomUUID())
  const held = ids.map(read)
  expect(held.every(publisher => publisher.isCurrent())).toBe(true)
  const extraId = randomUUID(), overflow = read(extraId)
  expect(overflow.isCurrent()).toBe(false)
  expect(overflow.publish(row(extraId))).toBe(false)
  useAppStore.getState().finalizeThreadDeletions([ids[0]])
  expect(read(randomUUID()).isCurrent()).toBe(false)
  held[0].close()
  const successor = read(extraId)
  expect(successor.isCurrent()).toBe(true)
  held[0].close()
  expect(read(randomUUID()).isCurrent()).toBe(false)
  expect(successor.publish(row(extraId))).toBe(true)
})

it("releases the actual store subscription on close and rejects another thread's reply", () => {
  const id = randomUUID(), originalSubscribe = useAppStore.subscribe
  const unsubscribed = vi.fn()
  vi.spyOn(useAppStore, "subscribe").mockImplementation(listener => {
    const unsubscribe = originalSubscribe(listener)
    return () => { unsubscribed(); unsubscribe() }
  })
  const publisher = read(id)
  expect(publisher.publish(row("wrong-id"))).toBe(false)
  publisher.close()
  expect(unsubscribed).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().threads).toEqual([])
})
