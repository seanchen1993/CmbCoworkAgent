import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { BotMemoryService } from "./memory"
import { botDirectory } from "./paths"

const resources: Array<{ root: string; memory: BotMemoryService }> = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), "cmb-bot-memory-"))
  const memory = new BotMemoryService(root)
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
