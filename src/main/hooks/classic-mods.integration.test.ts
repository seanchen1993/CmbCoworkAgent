import { beforeEach, describe, expect, vi, it } from "vitest"

const classicEvent = vi.fn()
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ classicEvent })
}))

import { runHooks } from "./runner"

beforeEach(() => classicEvent.mockReset())

describe("classic Function Mods bridge", () => {
  it("dispatches classic.PreToolUse even when no legacy hook is configured", async () => {
    classicEvent.mockResolvedValue({ decision: "deny", reason: "mod policy" })
    const result = await runHooks([], "PreToolUse", {
      sessionId: "thread",
      workspacePath: "/workspace",
      toolName: "write_file",
      toolArgs: { path: "a.txt" }
    })
    expect(classicEvent).toHaveBeenCalledWith(
      "/workspace",
      "thread",
      "classic.PreToolUse",
      expect.objectContaining({ toolName: "write_file" }),
      expect.any(AbortSignal)
    )
    expect(result).toMatchObject({ blocked: true, reason: "mod policy" })
  })

  it("does not call a classic bridge for HookEvent names without an upstream classic event", async () => {
    const result = await runHooks([], "PreSkillUse", {
      sessionId: "thread",
      workspacePath: "/workspace"
    })
    expect(classicEvent).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })
})
