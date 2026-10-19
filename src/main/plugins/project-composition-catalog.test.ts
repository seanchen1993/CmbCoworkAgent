import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { readProjectCompositionCatalog } from "./project-composition-catalog"
import { hostProjectFixture } from "../harness-board/project-runtime/host-fixtures.test-helper"
vi.mock("../storage", () => ({ parsePluginHooks: () => [], parseMcpJsonFile: () => null }))
vi.mock("./capability-catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capability-catalog")>()
  return { ...actual, readNativeCapabilityCatalog: vi.fn(actual.readNativeCapabilityCatalog) }
})
import { readNativeCapabilityCatalog } from "./capability-catalog"

const base = resolve("output/project-composition-fixtures")
const roots: string[] = []
afterEach(() => {
  vi.clearAllMocks()
  for (const root of roots.splice(0)) {
    if (!root.startsWith(base + "/") && !root.startsWith(base + "\\"))
      throw Error("Unsafe fixture cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(join(base, "catalog-"))
  roots.push(root)
  const put = (path: string, value: unknown) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), typeof value === "string" ? value : JSON.stringify(value))
  }
  const runtime = hostProjectFixture(root).manifest
  const flow = {
    id: "delivery",
    title: "Delivery",
    kind: "flow",
    usage: "project",
    entry: "devclaw.project-runtime.json"
  }
  put("plugin.json", { name: "docs", version: "1.0.0" })
  put(flow.entry, runtime)
  for (const stage of runtime.stages) put(stage.skill!, "Stage instructions")
  const declare = (capabilities: unknown[]) =>
    put("devclaw.capabilities.json", { apiVersion: "devclaw.capabilities/v1", capabilities })
  declare([flow])
  return {
    root,
    put,
    declare,
    flow,
    runtime,
    plugin: {
      id: "installed",
      name: "docs",
      version: "1.0.0",
      path: root,
      enabled: true,
      description: "",
      author: "",
      skillCount: 2,
      mcpServerCount: 0,
      createdAt: "fixture",
      updatedAt: "fixture"
    }
  }
}
describe("project composition execution catalog", () => {
  it("does not publish a partial catalog when a package scan times out", async () => {
    const f = fixture()
    vi.mocked(readNativeCapabilityCatalog).mockResolvedValueOnce({
      pluginId: f.plugin.id,
      status: "invalid",
      packageDigest: null,
      capabilities: [],
      reasons: ["CAPABILITY_PACKAGE_TIMEOUT"]
    })
    await expect(readProjectCompositionCatalog([f.plugin])).rejects.toThrow(
      "COMPOSITION_CATALOG_BUSY"
    )
    expect((await readProjectCompositionCatalog([f.plugin])).sources).toHaveLength(1)
  })
  it("records a bounded two-package catalog responsiveness benchmark", async () => {
    const packages = [fixture(), fixture()]
    for (const [index, f] of packages.entries()) {
      f.plugin.id = `benchmark-${index}`
      for (let file = 0; file < 500; file++) f.put(`benchmark/file-${file}.txt`, "x".repeat(1024))
    }
    const bytes = packages.map((f) =>
      (readdirSync(f.root, { recursive: true }) as string[])
        .map((path) => statSync(join(f.root, path)))
        .filter((stat) => stat.isFile())
        .reduce((total, stat) => total + stat.size, 0)
    )
    const intervals: number[] = []
    let previous = performance.now()
    const timer = setInterval(() => {
      const now = performance.now()
      intervals.push(now - previous)
      previous = now
    }, 5)
    const started = performance.now()
    let count = 0
    try {
      const result = await readProjectCompositionCatalog(packages.map((f) => f.plugin))
      count = result.sources.length
      expect(count).toBe(2)
      expect(result.sources.every((source) => source.entry.available)).toBe(true)
    } finally {
      clearInterval(timer)
      const ended = performance.now()
      intervals.push(ended - previous)
      const sorted = [...intervals].sort((a, b) => a - b)
      const report = {
        node: process.version,
        packages: 2,
        additionalFilesPerPackage: 500,
        additionalBytesPerFile: 1024,
        bytesPerPackage: bytes,
        totalBytes: bytes.reduce((a, b) => a + b, 0),
        scanMs: Number((ended - started).toFixed(2)),
        timerIntervalMs: 5,
        timerSamples: intervals.length,
        maxEventLoopIntervalMs: Number(Math.max(...intervals).toFixed(2)),
        p95EventLoopIntervalMs: Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)),
        admittedFlows: count
      }
      writeFileSync(join(base, "catalog-performance-report.json"), JSON.stringify(report, null, 2))
      console.log("COMPOSITION_CATALOG_BENCHMARK", JSON.stringify(report))
    }
    expect(intervals.length).toBeGreaterThan(1)
    expect(readNativeCapabilityCatalog).toHaveBeenCalledTimes(2)
  }, 20_000)
  it("does not satisfy isolated flow dependencies with parent-chat skills and propagates this", async () => {
    const f = fixture()
    const skill = {
      id: "summary",
      title: "Summary",
      kind: "skill",
      usage: "project",
      entry: "skills/summary/SKILL.md"
    }
    f.put(skill.entry, "Standalone instructions")
    f.declare([
      { ...f.flow, id: "outer", dependsOn: [f.flow.id] },
      { ...f.flow, dependsOn: [skill.id] },
      skill
    ])
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources.map((source) => source.entry.available)).toEqual([false, false, true])
    expect(result.sources[0].entry.reasons.join()).toContain("封装完整流程")
  })
  it("admits exact standalone skill dependency closures with one safe package scan", async () => {
    const f = fixture()
    const skills = ["base", "summary"].map((id) => ({
      id,
      title: id,
      kind: "skill",
      usage: "project",
      entry: `skills/${id}/SKILL.md`,
      dependsOn: id === "summary" ? ["base"] : []
    }))
    for (const skill of skills) f.put(skill.entry, "Standalone instructions")
    f.declare(skills)
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources.map((source) => source.entry.available)).toEqual([true, true])
    expect(readNativeCapabilityCatalog).toHaveBeenCalledTimes(1)
    // Legacy dynamic context must still be retained; an explicit Host's same-named
    // ordinary resource no longer opts it into this compatibility protocol.
    f.put(f.flow.entry, { ...f.runtime, mode: "legacy", stateOwner: "plugin" })
    f.put("board_core/board_config.json", {})
    expect(
      (await readProjectCompositionCatalog([f.plugin])).sources.every(
        (source) => !source.entry.available
      )
    ).toBe(true)
  })
  it("retains standalone Host skill dependency closures with an unrelated board resource", async () => {
    const f = fixture()
    const skills = ["base", "summary"].map((id) => ({
      id,
      title: id,
      kind: "skill",
      usage: "project",
      entry: `skills/${id}/SKILL.md`,
      dependsOn: id === "summary" ? ["base"] : []
    }))
    for (const skill of skills) f.put(skill.entry, "Standalone instructions")
    f.declare(skills)
    f.put("board_core/board_config.json", { workflow: "Unrelated business data" })
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources.map((source) => source.entry.available)).toEqual([true, true])
    expect(readNativeCapabilityCatalog).toHaveBeenCalledTimes(1)
  })
  it("rejects a standalone skill when its dependency requires a flow or unavailable MCP", async () => {
    const f = fixture()
    const skill = {
      id: "summary",
      title: "Summary",
      kind: "skill",
      usage: "project",
      entry: "skills/summary/SKILL.md"
    }
    f.put(skill.entry, "Standalone instructions")
    f.declare([f.flow, { ...skill, dependsOn: [f.flow.id] }])
    expect((await readProjectCompositionCatalog([f.plugin])).sources[1].entry.available).toBe(false)
    f.declare([{ ...skill, requiredMcpServers: ["missing"] }])
    expect((await readProjectCompositionCatalog([f.plugin])).sources[0].entry.available).toBe(false)
  })
  it("limits every selected dependency closure to sixteen capabilities", async () => {
    const f = fixture()
    const skills = Array.from({ length: 17 }, (_, index) => ({
      id: `skill${index}`,
      title: `Skill ${index}`,
      kind: "skill",
      usage: "project",
      entry: `skills/skill${index}/SKILL.md`,
      dependsOn: index ? [`skill${index - 1}`] : []
    }))
    for (const skill of skills) f.put(skill.entry, "Standalone instructions")
    f.declare(skills)
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources.slice(0, 16).every((source) => source.entry.available)).toBe(true)
    expect(result.sources[16].entry.available).toBe(false)
    expect(result.sources[16].entry.reasons.join()).toContain("16")
    expect(readNativeCapabilityCatalog).toHaveBeenCalledTimes(1)
  })
  it("admits a supported real host package and exposes its declared outputs", async () => {
    const f = fixture()
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0].entry).toMatchObject({
      available: true,
      kind: "flow",
      title: "Delivery"
    })
    expect(result.sources[0].entry.outputs).toEqual(
      f.runtime.artifacts.map(({ id, path }) => ({ id, title: id, path }))
    )
    expect(result.sources[0].entry.source.packageDigest).toMatch(/^[a-f0-9]{64}$/)
    f.put("notes.txt", "source changed")
    expect((await readProjectCompositionCatalog([f.plugin])).revision).not.toBe(result.revision)
  })
  it("exposes flow handoff titles and requirements while retaining destination paths only in the frozen source", async () => {
    const f = fixture()
    f.declare([
      {
        ...f.flow,
        inputs: [
          { id: "document", title: "待审核报告", path: "inputs/document.md", required: true }
        ]
      }
    ])
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources[0].entry.inputs).toEqual([
      { id: "document", title: "待审核报告", required: true }
    ])
    expect(result.sources[0].capability.inputs?.[0].path).toBe("inputs/document.md")
    expect(result.sources[0].entry.available).toBe(true)
  })
  it("does not admit disabled, chat-only, or unsupported original hooks/MCP flows", async () => {
    const f = fixture()
    expect(
      (await readProjectCompositionCatalog([{ ...f.plugin, enabled: false }])).sources[0].entry
        .available
    ).toBe(false)
    f.declare([{ ...f.flow, usage: "chat" }])
    const chatOnly = await readProjectCompositionCatalog([f.plugin])
    expect(chatOnly.sources).toEqual([])
    expect(chatOnly.diagnostics.length).toBeGreaterThan(0)
    f.declare([f.flow])
    f.put(".mcp.json", {})
    const rejected = await readProjectCompositionCatalog([f.plugin])
    expect(rejected.sources[0].entry.available).toBe(false)
    expect(rejected.sources[0].entry.reasons.join()).toContain("MCP")
  })
  it("keeps stage skills out of standalone execution and legacy flows isolated", async () => {
    const f = fixture()
    f.declare([
      {
        id: "draft",
        title: "Draft",
        kind: "skill",
        usage: "project",
        entry: f.runtime.stages[0].skill
      },
      f.flow
    ])
    let result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources[0].entry.available).toBe(false)
    expect(result.sources[0].entry.reasons.join()).toContain("阶段")
    f.put(f.flow.entry, { ...f.runtime, mode: "legacy", stateOwner: "plugin" })
    result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources[1].entry.available).toBe(false)
    expect(result.sources[1].entry.reasons.join()).toContain("原项目入口")
  })
  it("preserves undeclared packages through diagnostics without inventing options", async () => {
    const f = fixture()
    rmSync(join(f.root, "devclaw.capabilities.json"))
    const result = await readProjectCompositionCatalog([f.plugin])
    expect(result.sources).toEqual([])
    expect(result.diagnostics.join()).toContain("原有单插件项目入口")
  })
  it("bounds the registry and propagates cancellation before scanning", async () => {
    const f = fixture()
    await expect(
      readProjectCompositionCatalog(Array.from({ length: 257 }, () => f.plugin))
    ).rejects.toThrow("COMPOSITION_CATALOG_LIMIT")
    const controller = new AbortController()
    controller.abort(Error("catalog stopped"))
    await expect(readProjectCompositionCatalog([f.plugin], controller.signal)).rejects.toThrow(
      "catalog stopped"
    )
  })
})
