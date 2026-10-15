import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { ExpertMemoryList } from "../../src/shared/bot/expert-memory"
import {
  parseExpertMemoryList,
  parseRunMemorySnapshot
} from "../../src/main/services/bot/expert-memory-validation"
import { expertLocalData } from "../../src/main/services/bot/expert-local-data"
import { descriptor } from "./partner-local-fixture"
import { memoryFixture } from "./group-memory-fixture"

export function expertList(): ExpertMemoryList {
  const { groupId: _group, source: _source, ...memory } = memoryFixture()
  return {
    botId: "expert",
    revision: 1,
    canManage: true,
    memories: [{ ...memory, botId: "expert", source: { kind: "manual" } }]
  }
}
test("expert memory has real bot ownership, manual-only provenance and bounded legacy compatibility", () => {
  const list = expertList()
  assert.deepEqual(parseExpertMemoryList(list, "A", "expert"), list)
  for (const value of [
    { ...list, botId: "other" },
    {
      ...list,
      memories: [
        { ...list.memories[0], source: { kind: "task", taskId: "private", taskVersion: 1 } }
      ]
    },
    { ...list, memories: [{ ...list.memories[0], groupId: "private" }] },
    { ...list, memories: [{ ...list.memories[0], spaceId: "B" }] },
    { ...list, memories: [list.memories[0], list.memories[0]] }
  ])
    assert.throws(() => parseExpertMemoryList(value, "A", "expert"))
  const snapshot = { scope: "bot", botId: "expert", revision: 1, memories: list.memories }
  assert.deepEqual(parseRunMemorySnapshot(snapshot, "A", "g", "expert", "bot"), snapshot)
  assert.throws(() => parseRunMemorySnapshot(snapshot, "A", "g", "expert", "group"))
  assert.throws(() => parseRunMemorySnapshot(snapshot, "A", "g", "other", "bot"))
  assert.deepEqual(
    parseRunMemorySnapshot({ revision: 1, memories: [memoryFixture()] }, "A", "group", "expert"),
    { revision: 1, memories: [memoryFixture()] }
  )
  assert.equal(parseRunMemorySnapshot(null, "A", "g", "expert", "bot"), null)
})
test("default expert directory is stable, private, isolated and stores no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "expert-data-"))
  try {
    const data = await expertLocalData(root, "service-a", descriptor(), "expert")
    assert.equal(
      data.path,
      (await expertLocalData(root, "service-a", descriptor(32124), "expert")).path
    )
    assert.notEqual(
      data.path,
      (await expertLocalData(root, "service-b", descriptor(), "expert")).path
    )
    assert.notEqual(
      data.path,
      (
        await expertLocalData(
          root,
          "service-a",
          { ...descriptor(), ownerPrincipalId: "other" },
          "expert"
        )
      ).path
    )
    assert.notEqual(
      data.path,
      (await expertLocalData(root, "service-a", descriptor(), "other-expert")).path
    )
    await data.sync(expertList())
    const cache = JSON.parse(await readFile(join(data.path, "memory-cache.json"), "utf8"))
    assert.equal(cache.botId, "expert")
    assert.equal(cache.revision, 1)
    assert.equal(cache.memories[0].text, expertList().memories[0].text)
    assert(!JSON.stringify(cache).includes(descriptor().ownerToken))
    assert.equal((await stat(data.path)).mode & 0o777, 0o700)
    assert.equal((await stat(join(data.path, "memory-cache.json"))).mode & 0o777, 0o600)
    await data.sync({ botId: "expert", revision: 2, memories: [], canManage: true })
    assert.deepEqual(
      JSON.parse(await readFile(join(data.path, "memory-cache.json"), "utf8")).memories,
      []
    )
    await data.sync({
      ...expertList(),
      revision: 100,
      memories: Array.from({ length: 100 }, (_, i) => ({
        ...expertList().memories[0],
        id: `m${String(i).padStart(3, "0")}`,
        text: "中".repeat(512),
        status: "disabled" as const
      }))
    })
    assert.equal(
      JSON.parse(await readFile(join(data.path, "memory-cache.json"), "utf8")).memories.length,
      100
    )
    await assert.rejects(data.sync({ ...expertList(), botId: "other" }))
  } finally {
    await rm(root, { recursive: true })
  }
})
test("unsafe expert identifiers, symlink roots and replaced cache files are refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "expert-symlink-")),
    elsewhere = await mkdtemp(join(tmpdir(), "expert-outside-"))
  try {
    await assert.rejects(expertLocalData(root, "service", descriptor(), "../escape"))
    await symlink(elsewhere, join(root, "linked"))
    await assert.rejects(expertLocalData(join(root, "linked"), "service", descriptor(), "expert"))
    const data = await expertLocalData(root, "service", descriptor(), "expert")
    await symlink(join(elsewhere, "never-write"), join(data.path, "memory-cache.json"))
    await assert.rejects(data.sync(expertList()))
    await assert.rejects(stat(join(elsewhere, "never-write")))
  } finally {
    await rm(root, { recursive: true })
    await rm(elsewhere, { recursive: true })
  }
})
