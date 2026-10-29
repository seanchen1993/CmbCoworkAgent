import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  rows: new Map<string, { skills: string[]; skillSource: string[] }>(),
  contexts: new Map<string, { usedSkills?: string[]; skillSource?: string[] }>(),
  persist: vi.fn()
}))
vi.mock("../services/adoption-index", () => ({
  getThreadActiveSkillsRow: (id: string) => state.rows.get(id) ?? null,
  upsertThreadActiveSkills: (id: string, skills: string[], skillSource: string[]) => {
    state.persist(id, skills, skillSource)
    state.rows.set(id, structuredClone({ skills, skillSource }))
  }
}))
vi.mock("../services/adoption-tracker", () => ({
  setAdoptionContext: (id: string, context: object) =>
    state.contexts.set(id, structuredClone(context))
}))

const none = { usedSkills: [], skillSource: [] }
const skill = (name: string) => ({ usedSkills: [name], skillSource: [`plugin:p/${name}`] })

beforeEach(() => {
  vi.resetModules()
  state.rows.clear()
  state.contexts.clear()
  state.persist.mockClear()
})

describe("task-start Skill inheritance and upward contribution", () => {
  it("shares a reader's Skill with the parent and future workers, not an already-running sibling", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const reader = createSubagentSkillAttribution({ threadId: "reader", parentThreadId: "root" })
    const running = createSubagentSkillAttribution({ threadId: "running", parentThreadId: "root" })
    running(none)
    const before = structuredClone(state.contexts.get("running"))
    reader(skill("code-v1"))
    expect(state.contexts.get("root")).toEqual(skill("code-v1"))
    running(none)
    expect(state.contexts.get("running")).toEqual(none)
    expect(before).toEqual(none)
    const later = createSubagentSkillAttribution({ threadId: "later", parentThreadId: "root" })
    later(none)
    expect(state.contexts.get("later")).toEqual(skill("code-v1"))
    expect(state.rows.has("later")).toBe(false)
  })

  it("does not reread a changed parent while the task is running", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const { setThreadActiveSkills } = await import("./skill-evolution/proposal-window")
    setThreadActiveSkills("root", ["initial"], ["plugin:p/initial"])
    const sync = createSubagentSkillAttribution({ threadId: "worker", parentThreadId: "root" })
    setThreadActiveSkills("root", ["changed"], ["plugin:p/changed"])
    sync(none)
    expect(state.contexts.get("worker")).toEqual(skill("initial"))
  })

  it("does not carry an old worker Skill into a new task whose parent has no active Skills", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const { setThreadActiveSkills } = await import("./skill-evolution/proposal-window")
    setThreadActiveSkills("worker", ["old"], ["plugin:p/old"], { persist: false })
    createSubagentSkillAttribution({ threadId: "worker", parentThreadId: "root" })(none)
    expect(state.contexts.get("worker")).toEqual(none)
  })

  it("captures again on a continuation, even when the worker previously read a different Skill", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const first = createSubagentSkillAttribution({ threadId: "worker", parentThreadId: "root" })
    first(skill("old"))
    const { setThreadActiveSkills } = await import("./skill-evolution/proposal-window")
    setThreadActiveSkills("root", ["new"], ["plugin:p/new"])
    const continuation = createSubagentSkillAttribution({
      threadId: "worker",
      parentThreadId: "root"
    })
    continuation(none)
    expect(state.contexts.get("worker")).toEqual(skill("new"))
  })

  it("prefers its own new Skill and does not retroactively change earlier generation snapshots", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const { setThreadActiveSkills } = await import("./skill-evolution/proposal-window")
    setThreadActiveSkills("root", ["inherited"], ["plugin:p/inherited"])
    const sync = createSubagentSkillAttribution({ threadId: "worker", parentThreadId: "root" })
    sync(none)
    const earlier = state.contexts.get("worker")
    sync(skill("own"))
    expect(earlier).toEqual(skill("inherited"))
    expect(state.contexts.get("worker")).toEqual(skill("own"))
    expect(state.contexts.get("root")).toEqual({
      usedSkills: ["inherited", "own"],
      skillSource: ["plugin:p/inherited", "plugin:p/own"]
    })
  })

  it("persists only changes to the parent, and isolates unrelated root threads", async () => {
    const { createSubagentSkillAttribution } = await import("./turn-attribution")
    const sync = createSubagentSkillAttribution({ threadId: "reader", parentThreadId: "root" })
    for (let i = 0; i < 100; i++) sync(skill("code-v1"))
    expect(state.persist).toHaveBeenCalledTimes(1)
    expect(state.rows.get("root")).toEqual({
      skills: ["code-v1"],
      skillSource: ["plugin:p/code-v1"]
    })
    createSubagentSkillAttribution({ threadId: "unrelated", parentThreadId: "other-root" })(none)
    expect(state.contexts.get("unrelated")).toEqual(none)
  })

  it("restores the shared parent set after restart without inventing Trace Skill invocations", async () => {
    let api = await import("./turn-attribution")
    api.createSubagentSkillAttribution({ threadId: "reader", parentThreadId: "root" })(
      skill("code-v1")
    )
    state.contexts.clear()
    vi.resetModules()
    api = await import("./turn-attribution")
    api.createSubagentSkillAttribution({ threadId: "restored", parentThreadId: "root" })(none)
    expect(state.contexts.get("restored")).toEqual(skill("code-v1"))
    const tracer = { setUsedSkills: vi.fn(), setSkillSource: vi.fn(), setEvolvedSkills: vi.fn() }
    new api.TurnAttributionRecorder({ threadId: "root", tracer })
    expect(state.contexts.get("root")).toEqual(skill("code-v1"))
    expect(tracer.setUsedSkills).toHaveBeenLastCalledWith([])
    expect(tracer.setSkillSource).toHaveBeenLastCalledWith([])
  })
})
