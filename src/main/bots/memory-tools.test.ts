import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { BotDefinition } from "../../shared/bots/contracts"
import { BotMemoryService } from "./memory"

const flags = vi.hoisted(() => ({ enabled: true }))
vi.mock("../storage", () => ({ isMemoryEnabled: () => flags.enabled }))
import { createBotMemoryTools } from "./tools"

let root: string, memory: BotMemoryService
beforeEach(async () => {
  flags.enabled = true
  root = await mkdtemp(join(tmpdir(), "bot-memory-tools-"))
  memory = new BotMemoryService(root)
})
afterEach(async () => {
  await memory.close()
  await rm(root, { recursive: true, force: true })
})
const bot = { id: "a" } as BotDefinition
function tools(signal = new AbortController().signal, allowDelete = true) {
  return createBotMemoryTools(bot, memory, signal, allowDelete)
}

it("deletes only the versioned private entry and invalidates a pending summary", async () => {
  const entry = memory.write("a", { name: "Synthetic preference", content: "HERON_472" })
  const privateB = memory.write("b", { name: "Other Bot", content: "OTHER_128" })
  const editVersion = memory.editVersion("a")
  const forget = tools().find((tool) => tool.name === "bot_forget")!
  await expect(
    forget.invoke({ id: privateB.id, expectedVersion: privateB.version })
  ).rejects.toThrow()
  await forget.invoke({ id: entry.id, expectedVersion: entry.version })
  memory.applySummary("a", editVersion, [
    {
      action: "create",
      type: "reference",
      filename: "old.md",
      name: entry.name,
      description: entry.name,
      content: entry.content
    }
  ])
  expect(memory.list("a")).toEqual([])
  expect(memory.list("b")).toHaveLength(1)
  expect(await memory.search("a", "HERON_472")).toEqual([])
})
it("rejects stale versions, disabled memory and cancellation without losing the entry", async () => {
  const original = memory.write("a", { name: "Preference", content: "Old" })
  const entry = memory.write("a", {
    id: original.id,
    expectedVersion: original.version,
    name: "Preference",
    content: "New"
  })
  const controller = new AbortController()
  const forget = tools(controller.signal).find((tool) => tool.name === "bot_forget")!
  await expect(
    forget.invoke({ id: original.id, expectedVersion: original.version })
  ).rejects.toThrow("更新")
  flags.enabled = false
  await expect(forget.invoke({ id: entry.id, expectedVersion: entry.version })).rejects.toThrow(
    "关闭"
  )
  flags.enabled = true
  controller.abort(new Error("cancelled"))
  await expect(forget.invoke({ id: entry.id, expectedVersion: entry.version })).rejects.toThrow(
    "cancelled"
  )
  expect(memory.list("a")[0].content.trim()).toBe("New")
})
it("does not expose deletion unless the direct-user adapter explicitly enables it", () => {
  expect(
    createBotMemoryTools(bot, memory, new AbortController().signal).map((tool) => tool.name)
  ).not.toContain("bot_forget")
  expect(tools(undefined, false).map((tool) => tool.name)).not.toContain("bot_forget")
  expect(tools().map((tool) => tool.name)).toContain("bot_forget")
})

it("preserves disabled, missing and conflicting memory operations as error ToolMessages", async () => {
  const entry = memory.write("a", { name: "Preference", content: "Original" })
  const all = tools()
  const args: Record<string, Record<string, unknown>> = {
    bot_memory_search: { query: "Preference" },
    bot_memory_list: {},
    bot_memory_get: { id: entry.id },
    bot_remember: { name: "New", content: "Must not be saved" },
    bot_forget: { id: entry.id, expectedVersion: entry.version }
  }
  flags.enabled = false
  for (const tool of all) {
    const result = await tool.invoke({
      type: "tool_call",
      id: `disabled-${tool.name}`,
      name: tool.name,
      args: args[tool.name]
    })
    expect(result.status).toBe("error")
    expect(result.tool_call_id).toBe(`disabled-${tool.name}`)
    expect(result.content).toContain("关闭")
  }
  flags.enabled = true
  for (const [name, input] of [
    ["bot_memory_get", { id: "missing" }],
    [
      "bot_remember",
      { id: entry.id, expectedVersion: "stale", name: entry.name, content: "Wrong" }
    ],
    ["bot_forget", { id: entry.id, expectedVersion: "stale" }]
  ] as const) {
    const tool = all.find((tool) => tool.name === name)!
    const result = await tool.invoke({ type: "tool_call", id: `failed-${name}`, name, args: input })
    expect(result.status).toBe("error")
    expect(result.tool_call_id).toBe(`failed-${name}`)
  }
  expect(memory.list("a").map((item) => item.content.trim())).toEqual(["Original"])
})
