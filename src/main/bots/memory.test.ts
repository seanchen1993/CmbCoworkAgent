import { existsSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BotMemoryService } from "./memory"
import { botDirectory } from "./paths"

const resources: Array<{ root: string; memory: BotMemoryService }> = []
function setup(onChanged?: (botId: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "cmb-bot-memory-"))
  const memory = new BotMemoryService(root, onChanged)
  resources.push({ root, memory })
  return { root, memory }
}
afterEach(async () => {
  for (const { memory, root } of resources.splice(0)) {
    await memory.close()
    rmSync(root, { recursive: true, force: true })
  }
})

describe("Bot private memory", () => {
  it("filters scope before search ranking and keeps both shared facts and each group's own facts", async () => {
    const { memory } = setup()
    const shared = memory.write("bot-a", {
      name: "Sapphire",
      content: "Sapphire shared format",
      scope: { kind: "shared" }
    })
    const groupA = memory.writeInContext(
      "bot-a",
      { name: "Sapphire", content: "Sapphire group A" },
      { groupId: "a" }
    )
    const groupB = memory.writeInContext(
      "bot-a",
      { name: "Sapphire", content: "Sapphire group B" },
      { groupId: "b" }
    )
    for (let i = 0; i < 12; i++)
      memory.write("bot-a", { name: "Sapphire", content: "Sapphire private " + i })
    const ids = (groupId: string) =>
      memory
        .list("bot-a", { groupId })
        .map((entry) => entry.id)
        .sort()
    expect(ids("a")).toEqual([shared.id, groupA.id].sort())
    expect(ids("b")).toEqual([shared.id, groupB.id].sort())
    expect(memory.list("bot-a", {}).every((entry) => entry.scope?.kind !== "group")).toBe(true)
    expect(
      (await memory.search("bot-a", "Sapphire", { groupId: "a" })).map((entry) => entry.id).sort()
    ).toEqual([shared.id, groupA.id].sort())
    // Scope changes invalidate access immediately, including the existing search index.
    memory.write("bot-a", {
      ...shared,
      expectedVersion: shared.version,
      scope: { kind: "private" }
    })
    expect(
      (await memory.search("bot-a", "Sapphire", { groupId: "a" })).map((entry) => entry.id)
    ).toEqual([groupA.id])
  })
  it("limits group writes to that group and leaves sharing decisions to the owner", () => {
    const { memory } = setup()
    const privateFact = memory.write("bot-a", { name: "Private", content: "Private" })
    const shared = memory.write("bot-a", {
      name: "Shared",
      content: "Shared",
      scope: { kind: "shared" }
    })
    const own = memory.writeInContext(
      "bot-a",
      { name: "Group", content: "Group" },
      { groupId: "a" }
    )
    const other = memory.writeInContext(
      "bot-a",
      { name: "Other", content: "Other" },
      { groupId: "b" }
    )
    for (const entry of [privateFact, shared, other]) {
      expect(() =>
        memory.writeInContext(
          "bot-a",
          { ...entry, expectedVersion: entry.version, content: "Overwrite" },
          { groupId: "a" }
        )
      ).toThrow()
      expect(() =>
        memory.removeInContext("bot-a", entry.id, entry.version, { groupId: "a" })
      ).toThrow()
    }
    expect(() =>
      memory.writeInContext(
        "bot-a",
        { name: "Escape", content: "No", scope: { kind: "shared" } },
        { groupId: "a" }
      )
    ).toThrow()
    const updated = memory.writeInContext(
      "bot-a",
      { ...own, expectedVersion: own.version, content: "Corrected" },
      { groupId: "a" }
    )
    expect(updated.scope).toEqual({ kind: "group", groupId: "a" })
    const promoted = memory.write("bot-a", {
      ...updated,
      expectedVersion: updated.version,
      scope: { kind: "shared" }
    })
    expect(memory.list("bot-a", { groupId: "b" }).map((entry) => entry.id)).toContain(promoted.id)
  })
  it("does not let private automatic summaries update shared or group facts", () => {
    const { memory } = setup()
    const shared = memory.write("bot-a", {
      name: "Shared",
      content: "Original",
      scope: { kind: "shared" }
    })
    const group = memory.writeInContext(
      "bot-a",
      { name: "Group", content: "Original" },
      { groupId: "a" }
    )
    memory.applySummary(
      "bot-a",
      memory.editVersion("bot-a"),
      [shared, group].map((entry) => ({
        action: "update",
        filename: `${entry.id}.md`,
        name: entry.name,
        description: entry.name,
        content: "Changed"
      }))
    )
    expect(memory.list("bot-a").every((entry) => entry.content.trim() === "Original")).toBe(true)
  })
  it("deduplicates new private facts within the same automatic summary batch", () => {
    const { memory } = setup()
    const operation = {
      action: "create" as const,
      type: "reference" as const,
      filename: "reference_fact.md",
      name: "Format",
      description: "Format",
      content: "Prefer concise answers"
    }
    memory.applySummary("bot-a", 0, [operation, operation])
    expect(memory.list("bot-a")).toHaveLength(1)
  })
  it("keeps legacy facts private and preserves scope when editing without a new scope", () => {
    const { root, memory } = setup()
    memory.list("bot-a")
    const id = "legacy"
    writeFileSync(
      join(root, "memories", "bot-a", `${id}.md`),
      "---\nname: Legacy\ndescription: Legacy\ntype: reference\n---\n\nOnly in private\n"
    )
    const legacy = memory.list("bot-a")[0]
    expect(legacy.scope).toEqual({ kind: "private" })
    expect(memory.forPrompt("bot-a", { groupId: "g" })).toEqual([])
    const updated = memory.write("bot-a", {
      id,
      name: "Legacy",
      content: "Updated",
      expectedVersion: legacy.version
    })
    expect(updated.scope).toEqual({ kind: "private" })
    const shared = memory.write("bot-a", {
      ...updated,
      expectedVersion: updated.version,
      scope: { kind: "shared" }
    })
    const edited = memory.write("bot-a", {
      id,
      name: "Legacy",
      content: "Shared update",
      expectedVersion: shared.version
    })
    expect(edited.scope).toEqual({ kind: "shared" })
    expect(memory.forPrompt("bot-a", { groupId: "g" }).map((entry) => entry.id)).toEqual([id])
  })
  it("snapshots only current private facts newest first without retaining edited or deleted copies", () => {
    const changed = vi.fn()
    const { root, memory } = setup(changed)
    const old = memory.write("bot-a", { name: "Old", content: "Prefer blue" })
    const recent = memory.write("bot-a", { name: "Recent", content: "Prefer TypeScript" })
    memory.write("bot-b", { name: "Other Bot", content: "Private to B" })
    const snapshot = () =>
      memory.forPrompt("bot-a").map((entry) => ({ ...entry, content: entry.content.trim() }))
    utimesSync(join(root, "memories", "bot-a", `${old.id}.md`), 1, 1)
    expect(snapshot()).toEqual([recent, old])
    const edited = memory.write("bot-a", {
      ...old,
      expectedVersion: old.version,
      content: "Prefer red"
    })
    utimesSync(join(root, "memories", "bot-a", `${recent.id}.md`), 1, 1)
    expect(snapshot()).toEqual([edited, recent])
    memory.remove("bot-a", edited.id, edited.version)
    changed.mockClear()
    expect(snapshot()).toEqual([recent])
    expect(memory.forPrompt("bot-b")[0].content.trim()).toBe("Private to B")
    expect(changed).not.toHaveBeenCalled()
  })
  it("notifies only the changed namespace after committed edits, shares and summary batches", () => {
    const changed = vi.fn()
    const { memory } = setup(changed)
    const entry = memory.write("bot-a", { name: "Format", content: "Two decimals" })
    expect(changed.mock.calls).toEqual([["bot-a"]])
    expect(() => memory.write("bot-a", { ...entry, expectedVersion: "stale" })).toThrow()
    expect(changed).toHaveBeenCalledTimes(1)
    const copy = memory.share("bot-a", entry.id, entry.version, "bot-b")
    expect(changed.mock.calls).toEqual([["bot-a"], ["bot-b"]])
    const version = memory.editVersion("bot-a")
    memory.applySummary("bot-a", version, [
      {
        action: "update",
        filename: `${entry.id}.md`,
        content: "Three decimals",
        name: "Format",
        description: "Format"
      },
      {
        action: "create",
        type: "user",
        filename: "language.md",
        content: "Chinese",
        name: "Language",
        description: "Language"
      }
    ])
    expect(changed.mock.calls).toEqual([["bot-a"], ["bot-b"], ["bot-a"]])
    expect(memory.list("bot-a")).toHaveLength(2)
    memory.applySummary("bot-a", version, [
      { action: "skip", filename: `${entry.id}.md`, reason: "No change" }
    ])
    expect(changed).toHaveBeenCalledTimes(3)
    memory.remove("bot-b", copy.id, copy.version)
    expect(changed.mock.calls).toEqual([["bot-a"], ["bot-b"], ["bot-a"], ["bot-b"]])
    expect(memory.list("bot-b")).toEqual([])
  })

  it("does not turn a persisted memory into a failed operation when an observer throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const { memory } = setup(() => {
        throw new Error("Observer unavailable")
      })
      const saved = memory.write("bot-a", { name: "Format", content: "Two decimals" })
      expect(memory.list("bot-a")[0]).toMatchObject({ id: saved.id, version: saved.version })
      expect(memory.list("bot-a")[0].content.trim()).toBe("Two decimals")
      expect(memory.editVersion("bot-a")).toBe(1)
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("retires a deleted Bot's index and rejects stale summaries and searches", async () => {
    const { root, memory } = setup()
    memory.write("bot-a", { name: "Language", content: "Prefer TypeScript" })
    memory.write("bot-b", { name: "Other", content: "Keep this" })
    const version = memory.editVersion("bot-a")
    await memory.search("bot-a", "TypeScript")
    await memory.removeBot("bot-a")
    memory.applySummary("bot-a", version, [
      {
        action: "create",
        type: "user",
        filename: "stale.md",
        name: "Stale",
        description: "Stale",
        content: "No"
      }
    ])
    expect(existsSync(join(root, "memories", "bot-a"))).toBe(false)
    await expect(memory.search("bot-a", "TypeScript")).rejects.toThrow("已删除")
    expect(memory.list("bot-b")).toHaveLength(1)
    await memory.removeBot("bot-a")
    expect(existsSync(join(root, "memories", "bot-a"))).toBe(false)
  })
  it("shares only the selected version as an independent fact", () => {
    const { memory } = setup()
    const selected = memory.write("bot-a", { name: "Shared", content: "TypeScript" })
    memory.write("bot-a", { name: "Private", content: "Do not share this" })
    expect(() => memory.share("bot-a", selected.id, "stale", "bot-b")).toThrow("刷新")
    expect(memory.list("bot-b")).toEqual([])
    const copied = memory.share("bot-a", selected.id, selected.version, "bot-b")
    expect(copied.id).not.toBe(selected.id)
    expect(memory.list("bot-b")).toHaveLength(1)
    memory.write("bot-b", { ...copied, expectedVersion: copied.version, content: "Python" })
    expect(
      memory
        .list("bot-a")
        .find((item) => item.id === selected.id)
        ?.content.trim()
    ).toBe("TypeScript")
  })
  it("never revives a deleted fact or overwrites a manual edit with an older summary", () => {
    const { memory } = setup()
    const fact = memory.write("bot-a", { name: "Preference", content: "Prefer blue" })
    const version = memory.editVersion("bot-a")
    memory.remove("bot-a", fact.id, fact.version)
    memory.applySummary("bot-a", version, [
      {
        action: "create",
        type: "user",
        filename: "user_color.md",
        name: "Color",
        description: "Color",
        content: "Prefer blue"
      }
    ])
    expect(memory.list("bot-a")).toEqual([])
    const second = memory.write("bot-a", { name: "Preference", content: "Prefer green" })
    const secondVersion = memory.editVersion("bot-a")
    memory.write("bot-a", { ...second, expectedVersion: second.version, content: "Prefer red" })
    memory.applySummary("bot-a", secondVersion, [
      {
        action: "update",
        filename: `${second.id}.md`,
        name: "Preference",
        description: "Color",
        content: "Prefer green"
      }
    ])
    expect(memory.list("bot-a")[0].content.trim()).toBe("Prefer red")
  })
  it("commits summaries within one namespace and handles repeated updates without stale versions", async () => {
    const { memory } = setup()
    const fact = memory.write("bot-a", { name: "Preference", content: "Prefer blue" })
    const version = memory.editVersion("bot-a")
    memory.applySummary("bot-a", version, [
      {
        action: "update",
        filename: `${fact.id}.md`,
        name: "Preference",
        description: "Color",
        content: "Prefer green"
      },
      {
        action: "update",
        filename: `${fact.id}.md`,
        name: "Preference",
        description: "Color",
        content: "Prefer red"
      },
      {
        action: "update",
        filename: "../bot-b/secret.md",
        name: "Invalid",
        description: "Invalid",
        content: "Should not exist"
      }
    ])
    expect(memory.list("bot-a")).toHaveLength(1)
    expect(memory.list("bot-a")[0].content.trim()).toBe("Prefer red")
    expect(memory.list("bot-b")).toEqual([])
    expect(memory.editVersion("bot-a")).toBe(version)
    await memory.close()
    memory.applySummary("bot-a", version, [
      {
        action: "create",
        type: "user",
        filename: "user_late.md",
        name: "Late",
        description: "Late",
        content: "Late"
      }
    ])
    expect(memory.list("bot-a")).toHaveLength(1)
  })
  it("reuses the original search index without mixing Bot namespaces", async () => {
    const { memory } = setup()
    memory.write("bot-a", { name: "Release", content: "Release codename is sapphire." })
    memory.write("bot-b", { name: "Release", content: "Release codename is amber." })
    const [a, b, again] = await Promise.all([
      memory.search("bot-a", "sapphire"),
      memory.search("bot-b", "sapphire"),
      memory.search("bot-a", "sapphire")
    ])
    expect(a.length).toBeGreaterThan(0)
    expect(a[0].id).not.toContain("/")
    expect(b).toEqual([])
    expect(again).toEqual(a)
  })
  it("rejects stale edits and removes deleted entries from search", async () => {
    const { memory } = setup()
    const original = memory.write("bot-a", { name: "Memory", content: "unique mango" })
    await memory.search("bot-a", "mango")
    const updated = memory.write("bot-a", {
      ...original,
      expectedVersion: original.version,
      content: "unique coconut"
    })
    expect(() => memory.remove("bot-a", original.id, original.version)).toThrow("刷新")
    expect(await memory.search("bot-a", "mango")).toEqual([])
    memory.remove("bot-a", updated.id, updated.version)
    expect(await memory.search("bot-a", "coconut")).toEqual([])
  })
  it("rejects traversal and symbolic links before index initialization", async () => {
    const { root, memory } = setup()
    expect(() => memory.list("../outside")).toThrow()
    const external = join(root, "outside.md")
    writeFileSync(external, "sensitive test fixture")
    const directory = botDirectory(root, "memories", "bot-a")
    symlinkSync(external, join(directory, "linked.md"))
    expect(() => memory.list("bot-a")).toThrow("格式")
    await expect(memory.search("bot-a", "sensitive")).rejects.toThrow("格式")
  })
})
