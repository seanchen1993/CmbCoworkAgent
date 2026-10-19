import { afterEach, describe, expect, it, vi } from "vitest"
vi.mock("../../shared/agent-runtime-limits", () => ({
  getAgentToolStrategy: vi.fn(() => "standard")
}))
import { getAgentToolStrategy } from "../../shared/agent-runtime-limits"
import { readPathsForToolCall } from "./tool-call-read-paths"
afterEach(() => {
  vi.mocked(getAgentToolStrategy).mockReturnValue("standard")
})

describe("shared Skill read-path observation", () => {
  it("keeps existing read_file behavior in standard mode", () => {
    expect(readPathsForToolCall("read_file", { file_path: "skills/demo/SKILL.md" })).toEqual([
      "skills/demo/SKILL.md"
    ])
    expect(readPathsForToolCall("read_file", { path: "skills/demo/SKILL.md" })).toEqual([
      "skills/demo/SKILL.md"
    ])
    expect(readPathsForToolCall("execute", { command: "cat skills/demo/SKILL.md" })).toEqual([])
  })
  it.each(["shell-first", "shell-first-relaxed"] as const)(
    "recognizes Shell reads in %s without treating writes as reads",
    (strategy) => {
      vi.mocked(getAgentToolStrategy).mockReturnValue(strategy)
      expect(
        readPathsForToolCall("execute", { command: "cd skills; cat demo/SKILL.md", cwd: "/ws" })
      ).toEqual(["/ws/skills/demo/SKILL.md"])
      expect(
        readPathsForToolCall("execute", { command: "printf text > demo/SKILL.md", cwd: "/ws" })
      ).toEqual([])
    }
  )
  it("ignores other tools and malformed arguments", () => {
    for (const args of [null, undefined, {}, { command: 1 }])
      expect(readPathsForToolCall("execute", args)).toEqual([])
    expect(readPathsForToolCall("write_file", { path: "SKILL.md" })).toEqual([])
  })
})
