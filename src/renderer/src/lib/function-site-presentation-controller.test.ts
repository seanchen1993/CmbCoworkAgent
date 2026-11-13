import { afterEach, expect, it, vi } from "vitest"
import { FunctionSitePresentationCache, functionSitePresentationKey } from "./function-site-presentation"
import { functionSitePresentationBudget as budget } from "./function-site-presentation-budget"
import { FunctionSitePresentationController, planFunctionSiteInput,
  type FunctionSitePresentationInput } from "./function-site-presentation-controller"

const caches: FunctionSitePresentationCache[] = []
afterEach(() => { for (const cache of caches.splice(0)) cache.invalidate(); vi.useRealTimers() })
function fixture() {
  let authorized = true
  const cache = new FunctionSitePresentationCache(() => authorized)
  caches.push(cache)
  const controller = new FunctionSitePresentationController<() => string>()
  const renderer = () => "committed protected renderer"
  function input(text = "a", width = 800, epoch = 0): FunctionSitePresentationInput<() => string> {
    const value = { text, isFirstOfReply: true }, inputKey = JSON.stringify(value)
    return { component: "AssistantMessage", cache, row: "row", input: value, inputKey,
      key: functionSitePresentationKey("thread", "AssistantMessage", "row", inputKey, width),
      epoch, width, renderer, canRetain: true, current: () => authorized }
  }
  function save(value = input(), text = "protected") {
    cache.saveData(value.key, { component: "AssistantMessage",
      hostMessage: { text, isFirstOfReply: true } }, 100,
    cache.capture("AssistantMessage", value.key, "row"), 800, "host")
    return cache.peek(value.key)!
  }
  return { cache, controller, renderer, input, save, revoke: () => { authorized = false } }
}

it("does not consume, invalidate admissions or promote LRU while planning an abandoned append", () => {
  const f = fixture(), original = f.input(), cached = f.save(original)
  expect(f.controller.commit(f.controller.plan(original), true)).toEqual({ kind: "accepted", redraw: false })
  const pending = f.cache.capture("AssistantMessage", original.key, "row")
  const bytes = budget.stats().bytes
  const plan = f.controller.plan(f.input("ab"))
  expect(plan.selection?.kind).toBe("pending-progress")
  expect(cached.current()).toBe(true)
  expect(pending()).toBe(true)
  expect(budget.stats().bytes).toBe(bytes)
  expect(f.controller.lease()).toBeUndefined()
  expect(f.controller.plan(original).selection?.kind).toBe("exact")
})

it("consumes only the cached DOM actually committed and preserves its original renderer", () => {
  const f = fixture(), cached = f.save()
  f.controller.commit(f.controller.plan(f.input()), true)
  const next = { ...f.input("ab"), renderer: () => "RAW new closure" }
  const plan = f.controller.plan(next)
  expect(f.controller.commit(plan, true)).toEqual({ kind: "accepted", redraw: true })
  expect(cached.current()).toBe(false)
  expect(f.controller.lease()?.lease.current()).toBe(true)
  const selected = f.controller.plan(next).selection!
  expect(selected.kind).toBe("progress")
  expect(selected.renderer).toBe(f.renderer)
  expect(selected.renderer()).not.toContain("RAW")
  expect(f.cache.peek(f.input().key)).toBeNull()
})

it("does not seed a progress lease from a cache branch hidden by a real frame", () => {
  const f = fixture(); f.save()
  f.controller.commit(f.controller.plan(f.input()), false)
  expect(f.controller.plan(f.input("ab")).selection).toBeNull()
  expect(f.controller.lease()).toBeUndefined()
})

it("returns an explicit stale redraw for superseded plans and idempotent StrictMode duplicates", () => {
  const f = fixture(); f.save()
  const first = f.controller.plan(f.input()), interrupted = f.controller.plan(f.input("different", 800, 1))
  f.controller.commit(first, true)
  expect(f.controller.commit(first, true)).toEqual({ kind: "duplicate", redraw: false })
  expect(f.controller.commit(interrupted, false)).toEqual({ kind: "stale", redraw: true })
  expect(f.controller.commit(f.controller.plan(f.input()), true).kind).toBe("accepted")
})

it("a render exception leaves the protected entry queryable and cannot seed continuity", () => {
  const f = fixture(), cached = f.save()
  const plan = f.controller.plan({ ...f.input(), renderer: () => { throw Error("render failed") } })
  expect(() => plan.selection!.renderer()).toThrow("render failed")
  expect(f.controller.isCommitted(plan)).toBe(false)
  expect(f.controller.plan(f.input("ab")).selection).toBeNull()
  expect(cached.current()).toBe(true)
})

it("a reset before layout blocks all later work until an actual current plan commits", () => {
  const f = fixture(); f.save()
  const initial = f.controller.plan(f.input())
  f.controller.commit(initial, true)
  expect(f.controller.isCommitted(initial)).toBe(true)
  const pending = f.controller.plan(f.input("ab"))
  f.controller.reset()
  expect(f.controller.commit(pending, true).kind).toBe("stale")
  expect(f.controller.isCommitted(initial)).toBe(false)
  expect(f.controller.isCommitted(pending)).toBe(false)
  const actual = f.controller.plan(f.input("ab"))
  f.controller.commit(actual, false)
  expect(f.controller.isCommitted(actual)).toBe(true)
})

it.each(["source", "authority", "TTL", "entry replacement"] as const)(
  "rechecks %s between selection and layout commit", reason => {
    vi.useFakeTimers()
    const f = fixture(); f.save()
    const plan = f.controller.plan(f.input())
    if (reason === "source") { f.cache.invalidateProjection("host"); f.controller.reset() }
    if (reason === "authority") f.revoke()
    if (reason === "TTL") vi.advanceTimersByTime(120001)
    if (reason === "entry replacement") f.save(f.input(), "new protected")
    expect(f.controller.commit(plan, true)).toEqual({ kind: "stale", redraw: true })
    expect(f.controller.lease()).toBeUndefined()
    // A subsequent empty/revoked plan settles; it does not form a layout redraw loop.
    expect(f.controller.commit(f.controller.plan(f.input()), false).kind).toBe("accepted")
  }
)

it("keeps width reflow tied to the committed renderer and discards it after replacement", () => {
  const f = fixture(); f.save()
  f.controller.commit(f.controller.plan(f.input()), true)
  const resized = { ...f.input("a", 900), renderer: () => "new closure" }
  const plan = f.controller.plan(resized)
  expect(plan.selection?.kind).toBe("layout")
  expect(plan.selection?.width).toBe(800)
  expect(plan.selection?.renderer).toBe(f.renderer)
  f.controller.commit(plan, true)
  f.controller.commit(f.controller.plan(f.input("replacement", 900, 1)), false)
  expect(f.controller.plan(f.input("a", 800, 2)).selection).toBeNull()
})

it("reset clears previous retirement and cannot revoke a new same-key owner", () => {
  const f = fixture(); f.save()
  f.controller.commit(f.controller.plan(f.input()), true)
  const oldPlan = f.controller.plan(f.input("replacement", 800, 1))
  f.controller.reset()
  const fresh = f.save(f.input(), "fresh protected")
  expect(f.controller.commit(oldPlan, false).kind).toBe("stale")
  f.controller.commit(f.controller.plan(f.input("replacement", 800, 1)), false)
  expect(fresh.current()).toBe(true)
})

it("a delayed retirement never deletes a new entry or its pending same-row admission", () => {
  const f = fixture(); f.save()
  f.controller.commit(f.controller.plan(f.input()), true)
  const plan = f.controller.plan(f.input("replacement", 800, 1))
  f.cache.invalidateKey(f.input().key, false, "row")
  const admission = f.cache.capture("AssistantMessage", f.input().key, "row")
  const fresh = f.save()
  f.controller.commit(plan, false)
  expect(fresh.current()).toBe(true)
  expect(admission()).toBe(true)
})

it("never retires a new same-key owner installed before an old view plans its replacement", () => {
  const f = fixture(); f.save()
  f.controller.commit(f.controller.plan(f.input()), true)
  const fresh = f.save(f.input(), "new owner")
  const freshAdmission = f.cache.capture("AssistantMessage", f.input().key, "row")
  const replacement = f.controller.plan(f.input("different", 800, 1))
  f.controller.commit(replacement, false)
  expect(fresh.current()).toBe(true)
  expect(freshAdmission()).toBe(true)
})

it("leaves a newer capture in the same admission cohort and a replaced measurement intact", () => {
  const f = fixture(), original = f.input(), originalAdmission = f.cache.capture("AssistantMessage", original.key, "row")
  f.cache.measure(original.key, "AssistantMessage", { height: 100, width: 800, layoutWidth: 800 })
  f.controller.commit(f.controller.plan(original), false)
  const currentAdmission = f.cache.capture("AssistantMessage", original.key, "row")
  f.cache.measure(original.key, "AssistantMessage", { height: 200, width: 800, layoutWidth: 800 })
  f.controller.commit(f.controller.plan(f.input("replacement", 800, 1)), false)
  expect(originalAdmission()).toBe(true) // Cohort authorization semantics are unchanged.
  expect(currentAdmission()).toBe(true)
  expect(f.cache.measuredHeight(original.key, 800)).toBe(200)
})

it("does not borrow later resources when its original commit owned no entry or admission", () => {
  const f = fixture(), original = f.input()
  let committed = { key: original.inputKey, revision: 0, epoch: 0 }
  f.controller.commit(f.controller.plan(original), false)
  const oldRevision = committed.revision
  const pending = f.cache.capture("AssistantMessage", original.key, "row")
  const current = f.save(original, "new owner before late old read")
  const draft = planFunctionSiteInput("AssistantMessage", f.input("replacement").input,
    f.input("replacement").inputKey, committed)
  if (f.controller.commit(f.controller.plan(f.input("replacement", 800, draft.epoch)), false).kind === "accepted")
    committed = draft
  f.cache.saveData(original.key, { component: "AssistantMessage",
    hostMessage: { text: "late obsolete result", isFirstOfReply: true } }, 100,
  () => oldRevision === committed.revision && pending(), 800)
  expect(current.current()).toBe(true)
  expect(f.cache.peek(original.key)?.presentation.hostMessage?.text).toBe("new owner before late old read")
})

it("derives input revisions from committed facts, retaining aborted ABA but rejecting committed ABA", () => {
  const first = { text: "a", isFirstOfReply: true }, key = JSON.stringify(first)
  const committed = { key, revision: 3, epoch: 4 }
  const other = { text: "replacement", isFirstOfReply: true }
  const abandoned = planFunctionSiteInput("AssistantMessage", other, JSON.stringify(other), committed)
  expect(abandoned).toEqual({ key: JSON.stringify(other), revision: 4, epoch: 5 })
  expect(planFunctionSiteInput("AssistantMessage", first, key, committed)).toEqual(committed)
  expect(planFunctionSiteInput("AssistantMessage", first, key, abandoned))
    .toEqual({ key, revision: 5, epoch: 6 })
  const append = { ...first, text: "ab" }
  expect(planFunctionSiteInput("AssistantMessage", append, JSON.stringify(append), committed).epoch).toBe(4)
  expect(committed).toEqual({ key, revision: 3, epoch: 4 })
})

it("an old exact observation cannot touch or consume another entry, even sharing presentation data", () => {
  const f = fixture(), old = f.save()
  const fresh = f.save()
  const stale = { ...old, presentation: fresh.presentation, current: () => true }
  expect(f.cache.touch(f.input().key, stale)).toBe(false)
  expect(f.cache.consumeProgress(f.input().key, stale, "row")).toBeNull()
  expect(fresh.current()).toBe(true)
})

it("peek leaves expired records and global budget unchanged until an explicit cache mutation", () => {
  vi.useFakeTimers()
  const f = fixture(); f.save()
  const before = budget.stats()
  vi.advanceTimersByTime(120001)
  expect(f.cache.peek(f.input().key)).toBeNull()
  expect(budget.stats()).toEqual(before)
  f.cache.read(f.input().key)
  expect(budget.stats().bytes).toBeLessThan(before.bytes)
})

it("peek does not protect an old entry from bounded LRU eviction", () => {
  const f = fixture(), old = f.save()
  for (let index = 0; index < 96; index++) {
    f.cache.peek(f.input().key)
    const value = { ...f.input(String(index)), row: `row-${index}` }
    f.cache.saveData(value.key, { component: "AssistantMessage",
      hostMessage: { text: "protected", isFirstOfReply: true } }, 1,
    f.cache.capture("AssistantMessage", value.key, value.row))
  }
  expect(old.current()).toBe(false)
})
