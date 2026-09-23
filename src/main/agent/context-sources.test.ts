import { describe, expect, it } from "vitest"
import { buildFunctionSessionContextSources } from "./context-sources"

const config = {
  memorySources: ["/workspace/MEMORY.md", "/workspace/missing.md"],
  skillSources: ["/workspace/skills"],
  pluginSkillSources: [{ sourceDir: "/workspace/skills", pluginName: "review-plugin" }],
  mcpTools: [
    {
      toolId: "provider_read",
      toolName: "read",
      providerAlias: "docs",
      visibility: "eager" as const
    },
    {
      toolId: "provider_search",
      toolName: "search",
      providerAlias: "docs",
      visibility: "lazy" as const
    }
  ],
  agents: [{ name: "Explore", source: "built-in", description: "Inspect files" }],
  autoCompactThreshold: 8000
}
const state = {
  memoryContents: { "/workspace/MEMORY.md": "remember this", "/other/MEMORY.md": "not enabled" },
  skillsMetadata: [
    {
      name: "real-frontmatter-name",
      path: "/workspace/skills/folder/SKILL.md",
      description: "Review code"
    },
    { name: "other", path: "/other/skills/SKILL.md", description: "not enabled" }
  ]
}

describe("buildFunctionSessionContextSources", () => {
  it("uses loaded memory and skill metadata, registered MCP identity and current request tools", () => {
    const result = buildFunctionSessionContextSources(config, {
      state,
      tools: [{ name: "provider_search" }, { type: "function", function: { name: "task" } }]
    })
    expect(result.memoryFiles).toEqual([
      { path: "/workspace/MEMORY.md", type: "memory", tokens: 4 }
    ])
    expect(result.mcpTools).toEqual([
      expect.objectContaining({ name: "provider_read", serverName: "docs", isLoaded: false }),
      expect.objectContaining({ name: "provider_search", serverName: "docs", isLoaded: true })
    ])
    expect(result.agents).toEqual([
      expect.objectContaining({ agentType: "Explore", source: "built-in" })
    ])
    expect(result.skills).toMatchObject({
      totalSkills: 1,
      includedSkills: 1,
      skillFrontmatter: [
        {
          name: "real-frontmatter-name",
          source: "/workspace/skills/folder/SKILL.md",
          pluginName: "review-plugin"
        }
      ]
    })
    expect(result.autoCompactThreshold).toBe(8000)
  })

  it("omits disabled memory and skills even when recovered graph state retains them", () => {
    const result = buildFunctionSessionContextSources(
      { ...config, memorySources: undefined, skillSources: undefined },
      {
        state,
        tools: []
      }
    )
    expect(result.memoryFiles).toEqual([])
    expect(result.skills).toBeUndefined()
    expect(result.agents).toEqual([])
    expect(result.mcpTools?.every((tool) => !tool.isLoaded)).toBe(true)
  })

  it("uses the latest request snapshot without rereading files or retaining loaded tool flags", () => {
    const first = buildFunctionSessionContextSources(config, {
      state,
      tools: [{ name: "provider_read" }]
    })
    const next = buildFunctionSessionContextSources(config, {
      state: { memoryContents: { "/workspace/MEMORY.md": "new" }, skillsMetadata: [] },
      tools: []
    })
    expect(first.mcpTools?.[0].isLoaded).toBe(true)
    expect(next.mcpTools?.[0].isLoaded).toBe(false)
    expect(next.memoryFiles?.[0].tokens).toBe(1)
    expect(next.skills?.includedSkills).toBe(0)
  })

  it("cannot break a model request when a tool contains opaque provider metadata", () => {
    const tool: Record<string, unknown> = { name: "provider_read" }
    tool.metadata = tool
    const result = buildFunctionSessionContextSources(config, { state, tools: [tool] })
    expect(result.mcpTools?.[0]).toMatchObject({ isLoaded: true, tokens: 0 })
  })
})
