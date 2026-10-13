import assert from "node:assert/strict"
import test from "node:test"
import {
  memorySource,
  memoryText,
  memoryVersion,
  parseGroupMemory,
  parseMemoryList,
  parseMemorySnapshot
} from "../../src/main/services/bot/group-memory-validation"
import { groupMemoryEncodedLength } from "../../src/shared/bot/group-memory"
import { memoryFixture, memoryListFixture } from "./group-memory-fixture"

test("memory sources are closed references, never arbitrary URL, authors or personal history", () => {
  for (const source of [
    { kind: "manual" },
    { kind: "task", taskId: "task", taskVersion: 2 },
    { kind: "result", runId: "run" }
  ])
    assert.deepEqual(memorySource(source), source)
  for (const source of [
    { kind: "user", ownerId: "owner" },
    { kind: "manual", url: "https://example.com" },
    { kind: "task", taskId: "task", taskVersion: 0 },
    { kind: "result", runId: "run", author: "owner" },
    { kind: "task", taskId: "task", taskVersion: 1.5 },
    { kind: "task", taskId: "other/task", taskVersion: 1 },
    null
  ])
    assert.throws(() => memorySource(source), /INVALID_PAYLOAD/)
})
test("text and versions share exact UTF16 and Unicode bounds", () => {
  assert.equal(memoryText("中🙂"), "中🙂")
  assert.equal(memoryText("🙂".repeat(256)).length, 512)
  for (const text of ["", "  ", "a".repeat(513), "🙂".repeat(257), "x\0y", "x\uD800", "\uDC00"])
    assert.throws(() => memoryText(text))
  for (const v of ["1", -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN])
    assert.throws(() => memoryVersion(v))
  assert.equal(memoryVersion(0, 0), 0)
})
test("current space and Group are enforced even when the expert is shared", () => {
  const memory = memoryFixture()
  assert.deepEqual(parseGroupMemory(memory, "A", "group"), memory)
  assert.throws(() => parseGroupMemory(memory, "B", "group"), /FORBIDDEN/)
  assert.throws(() => parseGroupMemory(memory, "A", "other"), /FORBIDDEN/)
  assert.throws(
    () => parseGroupMemory({ ...memory, ownerId: "expert" }, "A", "group"),
    /INVALID_PAYLOAD/
  )
  assert.throws(
    () => parseGroupMemory({ ...memory, createdAt: "2026-02-30T08:00:00Z" }, "A", "group"),
    /INVALID_PAYLOAD/
  )
})
test("Run snapshots contain only unique sorted active entries; null means disabled", () => {
  assert.equal(parseMemorySnapshot(null, "A", "group"), null)
  assert.deepEqual(parseMemorySnapshot({ revision: 0, memories: [] }, "A", "group"), {
    revision: 0,
    memories: []
  })
  const m = memoryFixture()
  for (const snapshot of [
    { revision: 1, memories: [m, m] },
    { revision: 0, memories: [m] },
    { revision: 1, memories: [memoryFixture({ id: "z" }), m] },
    { revision: 1, memories: [memoryFixture({ status: "disabled" })] },
    { revision: 1, memories: [memoryFixture({ groupId: "other" })] },
    { revision: 1, memories: [], userMemory: "private" },
    undefined
  ])
    assert.throws(() => parseMemorySnapshot(snapshot, "A", "group"))
})
test("budget covers JSON delimiter escaping, not just raw character length", () => {
  const memories = Array.from({ length: 10 }, (_, i) =>
    memoryFixture({ id: `m${i}`, text: "&".repeat(512) })
  )
  assert.ok(groupMemoryEncodedLength(memories) > 10000)
  assert.throws(() => parseMemorySnapshot({ revision: 1, memories }, "A", "group"))
  assert.throws(() =>
    parseMemorySnapshot(
      {
        revision: 1,
        memories: Array.from({ length: 11 }, (_, i) =>
          memoryFixture({ id: `m${String(i).padStart(2, "0")}` })
        )
      },
      "A",
      "group"
    )
  )
})
test("list includes disabled history but still has bounded roles and policy metadata", () => {
  const list = memoryListFixture()
  list.memories = [memoryFixture({ status: "disabled" })]
  list.canManage = false
  assert.deepEqual(parseMemoryList(list, "A", "group"), list)
  for (const patch of [
    { canManage: "true" },
    { revision: 0 },
    { botPolicies: [] },
    { botPolicies: [list.botPolicies[0], list.botPolicies[0]] },
    { botPolicies: [{ ...list.botPolicies[0], memoryPolicy: "auto" }] },
    {
      memories: Array.from({ length: 101 }, (_, i) =>
        memoryFixture({ id: `m${String(i).padStart(3, "0")}`, status: "disabled" })
      )
    }
  ])
    assert.throws(() => parseMemoryList({ ...list, ...patch }, "A", "group"))
})
