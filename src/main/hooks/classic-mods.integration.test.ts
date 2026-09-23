import { beforeEach, describe, expect, vi, it } from "vitest"

const classicEvent = vi.fn()
const legacyCall = vi.fn()
vi.mock("./http-runner", () => ({ executeHttpHook: (...args: unknown[]) => legacyCall(...args) }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ classicEvent })
}))

import { clearOnceStateForSession, runHooks } from "./runner"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ModError } from "../mods/errors"

beforeEach(() => {
  classicEvent.mockReset()
  legacyCall.mockReset()
})

describe("classic Function Mods bridge", () => {
  it("awaits PreCompact's legacy gate even when imported settings request async", async () => {
    classicEvent.mockImplementation(async (_workspace, _thread, _event, input, signal, core) =>
      core(input, signal)
    )
    legacyCall.mockResolvedValue({
      exitCode: 2,
      stdout: "preserve history",
      stderr: "",
      blocked: true
    })
    const result = await runHooks(
      [
        {
          id: "compact-policy",
          event: "PreCompact",
          type: "http",
          url: "https://example.invalid/policy",
          enabled: true,
          matcher: "manual",
          async: true,
          createdAt: "2026-09-23T00:00:00.000Z",
          updatedAt: "2026-09-23T00:00:00.000Z"
        }
      ],
      "PreCompact",
      {
        workspacePath: "/workspace",
        sessionId: "thread",
        compactionTrigger: "manual",
        compactionInstructions: "Keep paths"
      }
    )
    expect(result).toMatchObject({ blocked: true })
    expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({
      trigger: "manual",
      custom_instructions: "Keep paths"
    })
  })

  it("projects real compaction fields for manual Pre and automatic Post", async () => {
    classicEvent.mockResolvedValue({ block: "keep history" })
    expect(
      await runHooks([], "PreCompact", {
        sessionId: "thread",
        workspacePath: "/workspace",
        compactionTrigger: "manual",
        compactionInstructions: "Preserve paths"
      })
    ).toMatchObject({ blocked: true, reason: "keep history" })
    expect(classicEvent.mock.calls[0][3]).toMatchObject({
      hook_event_name: "PreCompact",
      trigger: "manual",
      custom_instructions: "Preserve paths"
    })
    await runHooks([], "PostCompact", {
      sessionId: "thread",
      workspacePath: "/workspace",
      compactionTrigger: "auto",
      compactionSummary: "durable summary"
    })
    expect(classicEvent.mock.calls[1][3]).toMatchObject({
      hook_event_name: "PostCompact",
      trigger: "auto",
      compact_summary: "durable summary"
    })
  })

  it("dispatches classic.PreToolUse even when no legacy hook is configured", async () => {
    classicEvent.mockResolvedValue({ deny: "mod policy" })
    const result = await runHooks([], "PreToolUse", {
      sessionId: "thread",
      workspacePath: "/workspace",
      toolName: "write_file",
      toolCallId: "host-call",
      toolArgs: { path: "a.txt" }
    })
    expect(classicEvent).toHaveBeenCalledWith(
      "/workspace",
      "thread",
      "classic.PreToolUse",
      expect.objectContaining({
        tool: "write_file",
        tool_use_id: "host-call",
        path: "a.txt"
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(classicEvent.mock.calls[0][3]).not.toHaveProperty("hook_event_name")
    expect(classicEvent.mock.calls[0][3]).not.toHaveProperty("toolName")
    expect(result).toMatchObject({ blocked: true, reason: "mod policy" })
  })

  it("projects allow and block results plus additional context without leaking camelCase input", async () => {
    classicEvent.mockResolvedValueOnce({ allow: true })
    await expect(
      runHooks([], "PreToolUse", {
        sessionId: "thread",
        workspacePath: "/workspace",
        toolName: "read_file",
        toolArgs: { path: "a.txt" }
      })
    ).resolves.toBeNull()

    classicEvent.mockResolvedValueOnce({
      deny: "policy",
      additionalContext: ["Use the approved path"]
    })
    await expect(
      runHooks([], "PreToolUse", {
        sessionId: "thread",
        workspacePath: "/workspace",
        toolName: "write_file",
        toolArgs: { path: "a.txt" }
      })
    ).resolves.toMatchObject({
      blocked: true,
      decision: "block",
      reason: "policy",
      additionalContext: "Use the approved path"
    })
  })

  it("projects the official deny and string block result shapes", async () => {
    classicEvent.mockResolvedValueOnce({ deny: "do not write" })
    await expect(
      runHooks([], "PreToolUse", {
        sessionId: "thread",
        workspacePath: "/workspace",
        toolName: "write_file",
        toolArgs: { path: "a.txt" }
      })
    ).resolves.toMatchObject({ blocked: true, decision: "block", reason: "do not write" })

    classicEvent.mockResolvedValueOnce({ block: "stop this", additionalContext: ["a", "b"] })
    await expect(
      runHooks([], "Stop", {
        sessionId: "thread",
        workspacePath: "/workspace"
      })
    ).resolves.toMatchObject({ blocked: true, reason: "stop this", additionalContext: "a\nb" })
  })

  it("treats classic ask as a pre-tool denial with its reason preserved", async () => {
    classicEvent.mockResolvedValue({ ask: "confirm first" })
    await expect(
      runHooks([], "PreToolUse", {
        sessionId: "thread",
        workspacePath: "/workspace",
        toolName: "execute",
        toolArgs: { command: "rm -rf ." }
      })
    ).resolves.toMatchObject({ blocked: true, decision: "block", reason: "confirm first" })
  })

  it("projects SubagentStart into the classic task envelope", async () => {
    classicEvent.mockResolvedValue({})
    await runHooks([], "SubagentStart", {
      sessionId: "thread",
      workspacePath: "/workspace",
      subagent: { id: "task-1", name: "Explore", status: "running" }
    })
    expect(classicEvent).toHaveBeenCalledWith(
      "/workspace",
      "thread",
      "classic.SubagentStart",
      expect.objectContaining({
        hook_event_name: "SubagentStart",
        agent_id: "task-1",
        agent_type: "Explore",
        session_id: "thread",
        transcript_path: ""
      }),
      expect.any(AbortSignal),
      expect.any(Function)
    )
  })

  it("pins host tool identity and maps post-tool output without argument collisions", async () => {
    classicEvent.mockResolvedValue({})
    const context = {
      sessionId: "thread",
      workspacePath: "/workspace",
      toolName: "read_file",
      toolCallId: "host-call",
      toolArgs: { tool: "forged", tool_use_id: "forged", path: "a" },
      toolResult: '{"content":"ok"}'
    }
    await runHooks([], "PreToolUse", context)
    expect(classicEvent.mock.calls[0][3]).toEqual({
      tool: "read_file",
      tool_use_id: "host-call",
      path: "a"
    })
    await runHooks([], "PostToolUse", context)
    expect(classicEvent.mock.calls[1][3]).toMatchObject({
      hook_event_name: "PostToolUse",
      tool_name: "read_file",
      tool_use_id: "host-call",
      tool_input: context.toolArgs,
      tool_response: { content: "ok" }
    })
  })

  it("does not accept a late classic result after caller cancellation", async () => {
    const controller = new AbortController()
    classicEvent.mockImplementation(async (_w, _t, _e, _i, signal) => {
      expect(signal).toBe(controller.signal)
      controller.abort(Error("cancelled"))
      return { additionalContext: ["late"] }
    })
    await expect(
      runHooks([], "Stop", {
        sessionId: "thread",
        workspacePath: "/workspace",
        signal: controller.signal
      })
    ).rejects.toThrow("cancelled")
  })

  it("preserves native arguments colliding with reserved envelope fields for legacy hooks", async () => {
    legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
    classicEvent.mockImplementation(async (_w, _t, _e, input, signal, core) =>
      core({ ...input, path: "rewritten" }, signal)
    )
    await runHooks([{
      id: "legacy-collision", event: "PreToolUse", enabled: true, type: "http", url: "http://localhost/hook",
      createdAt: "", updatedAt: ""
    }], "PreToolUse", {
      workspacePath: "/workspace", sessionId: "collision", toolName: "custom", toolCallId: "host-call",
      toolArgs: { tool: "native-tool-argument", tool_use_id: "native-id-argument", path: "original" }
    })
    expect(JSON.parse(legacyCall.mock.calls[0][1]).tool_input).toMatchObject({
      tool: "native-tool-argument", tool_use_id: "native-id-argument", path: "rewritten"
    })
  })

  it("runs legacy hooks as next's core exactly once and lets the module append context", async () => {
    legacyCall.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      additionalContext: "legacy"
    })
    classicEvent.mockImplementation(async (_w, _t, _e, input, signal, core) => {
      const lower = await core(input, signal)
      expect(lower).toEqual({ additionalContext: ["legacy"] })
      return { ...lower, additionalContext: [...lower.additionalContext, "module"] }
    })
    const result = await runHooks(
      [
        {
          id: "legacy",
          event: "PreToolUse",
          enabled: true,
          type: "http",
          url: "http://localhost/hook",
          createdAt: "",
          updatedAt: ""
        }
      ],
      "PreToolUse",
      { workspacePath: "/workspace", sessionId: "thread", toolName: "read_file", toolArgs: {} }
    )
    expect(legacyCall).toHaveBeenCalledTimes(1)
    expect(result?.additionalContext).toBe("legacy\nmodule")
  })

  it.each([
    new ModFunctionError("MODS_SCOPE_CHANGED"),
    new ModError("MODS_CALL_SCOPE_CHANGED"),
    new ModFunctionError("MODS_CANCELLED", "MODS_CANCELLED", true)
  ])("does not run legacy hooks after a host scope failure: %s", async (failure) => {
    classicEvent.mockRejectedValue(failure)
    legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
    await expect(
      runHooks(
        [
          {
            id: "legacy-scope",
            event: "PreToolUse",
            enabled: true,
            type: "http",
            url: "http://localhost/hook",
            createdAt: "",
            updatedAt: ""
          }
        ],
        "PreToolUse",
        {
          workspacePath: "/workspace",
          sessionId: "scope-thread",
          toolName: "read_file",
          toolArgs: {}
        }
      )
    ).rejects.toThrow(failure.message)
    expect(legacyCall).not.toHaveBeenCalled()
  })

  it("rejects a short-circuit result from a terminated session generation", async () => {
    classicEvent.mockImplementation(async () => {
      clearOnceStateForSession("recreated-thread")
      return { additionalContext: ["stale"] }
    })
    await expect(
      runHooks([], "Stop", {
        workspacePath: "/workspace",
        sessionId: "recreated-thread"
      })
    ).rejects.toThrow("HOOK_SESSION_CHANGED")
  })

  it("memoizes legacy core even when the module calls next twice then fails", async () => {
    legacyCall.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      blocked: false,
      additionalContext: "legacy"
    })
    classicEvent.mockImplementation(async (_w, _t, _e, input, signal, core) => {
      await core(input, signal)
      await core({ ...input, path: "different" }, signal)
      throw Error("optional module failed")
    })
    const result = await runHooks(
      [
        {
          id: "legacy-once",
          event: "PreToolUse",
          enabled: true,
          type: "http",
          url: "http://localhost/hook",
          createdAt: "",
          updatedAt: ""
        }
      ],
      "PreToolUse",
      {
        workspacePath: "/workspace",
        sessionId: "multiple-core",
        toolName: "read_file",
        toolArgs: { path: "a" }
      }
    )
    expect(legacyCall).toHaveBeenCalledTimes(1)
    expect(result?.additionalContext).toBe("legacy")
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
