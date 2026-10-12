import { expect, it } from "vitest"
import { botMemoryContext, botSkillCatalog } from "./context"

it("bounds growing memory without silently cutting a fact in half", () => {
  const memories = Array.from({ length: 100 }, (_, index) => ({
    id: `memory-${index}`,
    botId: "bot",
    text: `Fact ${index}: ${"x".repeat(1000)}`,
    revision: 1,
    sourceMessageId: null,
    deletedAt: null,
    updatedAt: index
  }))
  const context = JSON.parse(botMemoryContext(memories))
  expect(JSON.stringify(context.recentFacts).length).toBeLessThanOrEqual(8000)
  expect(context.recentFacts[0].id).toBe("memory-99")
  for (const fact of context.recentFacts)
    expect(fact.text).toBe(memories.find((item) => item.id === fact.id)?.text)
  expect(context.otherCount + context.recentFacts.length).toBe(memories.length)
  expect(context.lookup).toContain("memory_list")
})

it("does not inline workflow bodies into the fixed prompt catalog", () => {
  const catalog = botSkillCatalog([
    {
      id: "skill",
      botId: "bot",
      name: "检查",
      instructions: "x".repeat(64000),
      version: 2,
      enabled: true,
      verified: false,
      createdAt: 1
    }
  ])
  expect(catalog).toEqual([
    { id: "skill", name: "检查", version: 2, enabled: true, verified: false }
  ])
})
