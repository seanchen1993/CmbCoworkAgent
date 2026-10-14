import { afterEach, describe, expect, it, vi } from "vitest"
import { CheckpointSnapshotInterpretations } from "./checkpoint-snapshot-interpretation"
import type { FunctionConversationCheckpointMembershipSnapshot } from "../checkpointer/function-conversation-checkpoint-membership"

afterEach(() => vi.restoreAllMocks())
const text = (id = "member", extra = "") =>
  JSON.stringify({
    snapshotDigest: "digest",
    extra,
    cut: { highWater: 1, lineage: [{ branchId: "branch", cut: 1 }] },
    members: [{ uuid: id }]
  })

describe("bounded checkpoint text interpretation, never authority", () => {
  it("interprets exact repeated text once and freezes nested facts", () => {
    const digest = vi.fn(() => "digest"),
      cache = new CheckpointSnapshotInterpretations(digest)
    const encoded = text(),
      first = cache.read(encoded)
    for (let index = 0; index < 100; index++)
      expect(cache.read(encoded).snapshot).toBe(first.snapshot)
    expect(digest).toHaveBeenCalledTimes(1)
    expect(Object.isFrozen(first.snapshot.cut.lineage[0])).toBe(true)
    expect(Object.isFrozen(first.snapshot.members[0])).toBe(true)
    expect(cache.read(`${encoded} `).snapshot).not.toBe(first.snapshot)
    expect(digest).toHaveBeenCalledTimes(2)
  })

  it("bounds retained entries and bypasses oversized text", () => {
    const digest = vi.fn(() => "digest"),
      cache = new CheckpointSnapshotInterpretations(digest)
    cache.read(text("first"))
    for (let index = 0; index < 4; index++) cache.read(text(String(index)))
    cache.read(text("first"))
    expect(digest).toHaveBeenCalledTimes(6)
    const huge = text("huge", "x".repeat(1024 * 1024))
    expect(cache.read(huge).snapshot).not.toBe(cache.read(huge).snapshot)
    expect(digest).toHaveBeenCalledTimes(8)
  })

  it("evicts by text budget before the entry limit and preserves mutable public-style inputs", () => {
    const digest = vi.fn(() => "digest"),
      cache = new CheckpointSnapshotInterpretations(digest)
    const first = text("first", "x".repeat(750_000))
    cache.read(first)
    cache.read(text("second", "x".repeat(750_000)))
    cache.read(text("third", "x".repeat(750_000)))
    cache.read(first)
    expect(digest).toHaveBeenCalledTimes(4)
  })

  it.each(["parse", "stringify"] as const)(
    "keeps replaced JSON.%s callbacks on repeated reads",
    (method) => {
      const digest = vi.fn((content) => JSON.stringify(content))
      const cache = new CheckpointSnapshotInterpretations(digest),
        encoded = text()
      cache.read(encoded)
      const original = JSON[method]
      const hook = vi.spyOn(JSON, method).mockImplementation(original as never)
      cache.read(encoded)
      cache.read(encoded)
      expect(hook.mock.calls.length).toBeGreaterThanOrEqual(2)
      expect(digest).toHaveBeenCalledTimes(3)
    }
  )

  it("indexes only frozen plain member facts and preserves first-match duplicate semantics", () => {
    const cache = new CheckpointSnapshotInterpretations(() => "digest")
    const snapshot = cache.read(text()).snapshot
    expect(cache.member(snapshot, snapshot, "member")).toBe(snapshot.members[0])
    expect(cache.member(snapshot, snapshot, "missing")).toBeUndefined()
    const mutable = JSON.parse(text()) as FunctionConversationCheckpointMembershipSnapshot
    expect(cache.member(mutable, mutable, "member")).toBe(mutable.members[0])
    const changed = mutable.members[0] as { uuid: string }
    changed.uuid = "changed"
    expect(cache.member(mutable, mutable, "member")).toBeUndefined()
    expect(cache.member(mutable, mutable, "changed")).toBe(mutable.members[0])
    const duplicates = cache.read(
      JSON.stringify({
        ...snapshot,
        members: [
          { uuid: "same", ordinal: 0 },
          { uuid: "same", ordinal: 1 }
        ]
      })
    ).snapshot
    expect(cache.member(duplicates, duplicates, "same")).toBe(duplicates.members[0])
  })

  it("does not let a replaced public WeakMap getter supply index facts", () => {
    const cache = new CheckpointSnapshotInterpretations(() => "digest")
    const snapshot = cache.read(text()).snapshot,
      proof = {}
    const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
    const poisoned = { snapshot, index: new Map([["member", { uuid: "forged" }]]) }
    let actual: unknown
    try {
      Object.defineProperty(WeakMap.prototype, "get", { ...original, value: () => poisoned })
      actual = cache.member(proof, snapshot, "member")
    } finally {
      Object.defineProperty(WeakMap.prototype, "get", original)
    }
    expect(actual).toBe(snapshot.members[0])
  })

  it("does not expose cached text records to a replaced Array iterator", () => {
    const cache = new CheckpointSnapshotInterpretations(() => "digest")
    const first = cache.read(text()), invalid = "{broken"
    const original = Object.getOwnPropertyDescriptor(Array.prototype, Symbol.iterator)!
    let failure: unknown, visited = 0
    try {
      Object.defineProperty(Array.prototype, Symbol.iterator, { ...original,
        value: function* () { visited++; yield { text: invalid, ...first } } })
      try { cache.read(invalid) } catch (error) { failure = error }
    } finally { Object.defineProperty(Array.prototype, Symbol.iterator, original) }
    expect(failure).toBeInstanceOf(SyntaxError)
    expect(visited).toBe(0)
    expect(Object.isFrozen(cache.read(text()))).toBe(true)
  })
})
