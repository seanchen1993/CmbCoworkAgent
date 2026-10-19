import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { readProjectCompositionCatalog } from "./project-composition-catalog"

vi.mock("../storage", () => ({ parsePluginHooks: () => [], parseMcpJsonFile: () => null }))

describe("project composition author examples", () => {
  it("offers independent skills and full flows from two actual packages with an optional handoff", async () => {
    const names = ["project-docs-lite", "project-harness-data"]
    const catalog = await readProjectCompositionCatalog(
      names.map((name) => ({
        id: name,
        name,
        path: resolve("examples", name),
        version: JSON.parse(readFileSync(resolve("examples", name, "plugin.json"), "utf8")).version,
        enabled: true,
        description: "",
        author: "",
        skillCount: 2,
        mcpServerCount: 0,
        createdAt: "fixture",
        updatedAt: "fixture"
      }))
    )
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.sources).toHaveLength(4)
    expect(catalog.sources.every((item) => item.entry.available)).toBe(true)
    expect(catalog.sources.filter((item) => item.entry.kind === "capability")).toHaveLength(2)
    const writer = catalog.sources.find((item) => item.capability.id === "document-flow")!
    const consumer = catalog.sources.find((item) => item.capability.id === "data-flow")!
    expect(writer.entry.outputs).toContainEqual({ id: "draft", title: "draft", path: "draft.md" })
    expect(consumer.entry.inputs).toEqual([
      { id: "requirements", title: "前一套流程的需求文档", required: false }
    ])
    expect(consumer.capability.inputs?.[0].path).toBe("incoming/requirements.md")
  })
})
