import { beforeEach, describe, expect, it, vi } from "vitest"

const fixture = vi.hoisted(() => ({
  docs: new Map<string, string>(),
  contexts: new Map<string, { usedSkills?: string[]; skillSource?: string[] }>(),
  sources: [] as Array<{
    sourceDir: string
    pluginRoot: string
    pluginId: string
    pluginName: string
    maxDepth?: number
  }>
}))
vi.mock("../../services/market-content", () => ({
  readContentFileSync: (path: string) => {
    const key = path.replace(/\\/g, "/").toLowerCase()
    const doc = fixture.docs.get(key)
    if (!doc) throw new Error("missing skill document")
    return doc
  }
}))
vi.mock("../../storage", () => ({
  getEnabledPluginSkillSourceMetadata: () => fixture.sources
}))
vi.mock("../../services/adoption-index", () => ({
  getThreadActiveSkillsRow: () => null,
  upsertThreadActiveSkills: () => undefined
}))
vi.mock("../../services/adoption-tracker", () => ({
  setAdoptionContext: (id: string, value: object) =>
    fixture.contexts.set(id, structuredClone(value))
}))

const root = "C:/Users/Tester/.cmbcoworkagent/plugins/demo"
const skillPath = `${root}/skills/autodev-code/SKILL.md`
const skillName = "autodev-code-v1.2.0"

beforeEach(() => {
  vi.resetModules()
  fixture.docs.clear()
  fixture.contexts.clear()
  fixture.sources = [
    { sourceDir: `${root}/skills`, pluginRoot: root, pluginId: "demo", pluginName: "demo" }
  ]
  fixture.docs.set(
    skillPath.toLowerCase(),
    "---\nname: autodev-code\nversion: 1.2.0\n---\nGenerate code"
  )
})

async function readAndDelegate(path: string, withMetadata: boolean) {
  const { SkillUsageDetector } = await import("./usage-detector")
  const { TurnAttributionRecorder, createSubagentSkillAttribution } =
    await import("../turn-attribution")
  const detector = new SkillUsageDetector()
  if (withMetadata) {
    detector.onSkillsMetadata([{ name: "autodev-code", path: skillPath }])
    // Do not let direct-read fallback hide a failure to match registered paths.
    fixture.docs.clear()
  }
  const tracer = { setUsedSkills: vi.fn(), setSkillSource: vi.fn(), setEvolvedSkills: vi.fn() }
  const recorder = new TurnAttributionRecorder({ threadId: "main", tracer, detector })
  recorder.onStreamChunk("values", {
    messages: [
      {
        id: ["langchain_core", "messages", "AIMessage"],
        kwargs: {
          id: "read-skill",
          type: "ai",
          tool_calls: [{ name: "read_file", args: { path } }]
        }
      }
    ]
  })
  createSubagentSkillAttribution({ threadId: "workflow-child", parentThreadId: "main" })({
    usedSkills: [],
    skillSource: []
  })
  return { detector, tracer }
}

describe("actual Skill reads reach parent and child code attribution", () => {
  it("matches Windows case and separator differences before taking the child snapshot", async () => {
    const { tracer } = await readAndDelegate(
      skillPath.toLowerCase().replace("/skills/", "/skills/../skills/").replace(/\//g, "\\"),
      true
    )
    expect(tracer.setUsedSkills).toHaveBeenLastCalledWith([skillName])
    expect(fixture.contexts.get("workflow-child")).toMatchObject({ usedSkills: [skillName] })
  })

  it("recognizes a direct enabled-plugin SKILL.md read before catalogue metadata arrives", async () => {
    const { tracer } = await readAndDelegate(skillPath, false)
    expect(tracer.setUsedSkills).toHaveBeenLastCalledWith([skillName])
    expect(fixture.contexts.get("workflow-child")).toMatchObject({
      usedSkills: [skillName],
      skillSource: ["plugin:demo/autodev-code-v1.2.0?name=demo"]
    })
  })

  it("does not turn an unrelated SKILL.md or a plugin's ordinary file into Skill usage", async () => {
    await readAndDelegate(`${root}/hooks/README.md`, false)
    expect(fixture.contexts.get("workflow-child")?.usedSkills).toEqual([])
    await readAndDelegate("C:/other/SKILL.md", false)
    expect(fixture.contexts.get("workflow-child")?.usedSkills).toEqual([])
  })

  it("does not count catalogue loading as a Skill read", async () => {
    const { SkillUsageDetector } = await import("./usage-detector")
    const detector = new SkillUsageDetector()
    detector.onSkillsMetadata([{ name: "autodev-code", path: skillPath }])
    expect(detector.getUsedSkillNames()).toEqual([])
  })

  it("does not attribute unreadable documents or disabled plugin sources", async () => {
    fixture.sources = []
    await readAndDelegate(skillPath, false)
    expect(fixture.contexts.get("workflow-child")?.usedSkills).toEqual([])
    fixture.sources = [
      { sourceDir: `${root}/skills`, pluginRoot: root, pluginId: "demo", pluginName: "demo" }
    ]
    fixture.docs.clear()
    await readAndDelegate(skillPath, false)
    expect(fixture.contexts.get("workflow-child")?.usedSkills).toEqual([])
  })

  it("honors root-only plugin Skill sources", async () => {
    fixture.sources[0].maxDepth = 0
    await readAndDelegate(skillPath, false)
    expect(fixture.contexts.get("workflow-child")?.usedSkills).toEqual([])
  })

  it.skipIf(process.platform === "win32")(
    "preserves case-sensitive POSIX path matching",
    async () => {
      const { SkillUsageDetector } = await import("./usage-detector")
      const detector = new SkillUsageDetector()
      detector.onSkillsMetadata([
        { name: "CaseSensitive", path: "/repo/skills/CaseSensitive/SKILL.md" }
      ])
      expect(detector.onReadFilePath("/repo/skills/casesensitive/SKILL.md")).toBe(false)
      expect(detector.onReadFilePath("/repo/skills/CaseSensitive/./SKILL.md")).toBe(true)
    }
  )
})
