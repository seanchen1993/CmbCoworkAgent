import { expect, it, vi } from "vitest"

const reads = vi.hoisted(() =>
  vi.fn((id: string) => ({
    skills: [`skill-${id}`],
    skillSource: []
  }))
)
const writes = vi.hoisted(() => vi.fn())
vi.mock("../../services/adoption-index", () => ({
  getThreadActiveSkillsRow: reads,
  upsertThreadActiveSkills: writes
}))

it("bounds database-restored Skill entries without rewriting or losing persisted attribution", async () => {
  const { getThreadActiveSkills } = await import("./proposal-window")
  for (let i = 0; i < 300; i++) {
    expect(getThreadActiveSkills(`restored-${i}`)).toEqual([`skill-restored-${i}`])
  }
  expect(reads).toHaveBeenCalledTimes(300)
  expect(getThreadActiveSkills("restored-299")).toEqual(["skill-restored-299"])
  expect(reads).toHaveBeenCalledTimes(300)
  expect(getThreadActiveSkills("restored-0")).toEqual(["skill-restored-0"])
  expect(reads).toHaveBeenCalledTimes(301)
  expect(writes).not.toHaveBeenCalled()
})
