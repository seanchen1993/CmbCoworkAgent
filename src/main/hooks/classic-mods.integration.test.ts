import { beforeEach, describe, expect, vi, it } from "vitest"

const classicEvent = vi.fn()
const legacyCall = vi.fn()
const modsEnabled = vi.fn()
vi.mock("./http-runner", () => ({ executeHttpHook: (...args: unknown[]) => legacyCall(...args) }))
vi.mock("../mods/manager", () => ({
  getModsManager: () => ({ classicEvent, isEnabled: modsEnabled })
}))

import { clearOnceStateForSession, runHooks } from "./runner"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ModError } from "../mods/errors"

beforeEach(() => {
  classicEvent.mockReset()
  legacyCall.mockReset()
  modsEnabled.mockReset().mockReturnValue(true)
})

describe("classic Function Mods bridge", () => {
  it("carries a real guest output effect through the production classic bridge and publication", async () => {
    const { FunctionGuestRuntime } = await import("../mods/v2/guest-runtime")
    const { FunctionSession, SESSION_CAPABILITIES } = await import("../mods/v2/session")
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("classic.PostToolUse",async($,e,next)=>{
        await next(e);return {updatedToolOutput:"SECRET",additionalContext:["review"]}
      })
    }}`)
    const session = new FunctionSession([{name:"outputs",root:"/outputs",tier:"user",guest,
      capabilities:[...SESSION_CAPABILITIES]}],{workspace:"/workspace",threadId:"thread",
      assertLive:()=>undefined,publish:async(value)=>JSON.parse(JSON.stringify(value).replaceAll("SECRET","FILTERED"))})
    classicEvent.mockImplementation((_workspace,_thread,event,input,signal,core)=>
      session.classicEvent(event,input,signal,core))
    try {
      const result = await runHooks([], "PostToolUse", {workspacePath:"/workspace",sessionId:"thread",
        toolName:"read_file",toolArgs:{file_path:"/real"},toolResult:"original"})
      expect(result).toMatchObject({updatedToolOutput:"FILTERED",additionalContext:"review"})
    } finally { await session.close() }
  })

  it("projects explicit PostToolUse outputs while ignoring output fields on other events", async () => {
    classicEvent.mockResolvedValue({ updatedToolOutput: null, updatedMCPToolOutput: { content: [] } })
    expect(await runHooks([], "PostToolUse", {
      workspacePath:"/workspace",sessionId:"thread",toolName:"read_file",toolArgs:{},toolResult:"original"
    })).toMatchObject({ updatedToolOutput: null, updatedMCPToolOutput: { content: [] } })
    classicEvent.mockResolvedValue({ updatedToolOutput: "ignored" })
    expect(await runHooks([], "Stop", {workspacePath:"/workspace",sessionId:"thread"})).toBeNull()
  })

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


it("sends one host-owned full tool batch to classic hooks and awaits its context", async () => {
  const calls = [
    {
      tool_name: "read_file",
      tool_input: { file_path: "a" },
      tool_use_id: "one",
      tool_response: "read"
    },
    {
      tool_name: "execute",
      tool_input: { command: "test" },
      tool_use_id: "two",
      tool_response: { exitCode: 1 }
    }
  ]
  classicEvent.mockResolvedValue({ additionalContext: ["repair failed tests"] })
  const result = await runHooks([], "PostToolBatch", {
    workspacePath: "/workspace",
    sessionId: "thread",
    toolBatch: calls
  })
  expect(classicEvent.mock.calls[0][3]).toMatchObject({
    hook_event_name: "PostToolBatch",
    tool_calls: calls
  })
  expect(result?.additionalContext).toBe("repair failed tests")
})

it("waits for a legacy PostToolBatch gate once even when declared async and next is repeated", async () => {
  const calls = [
    {
      tool_name: "read_file",
      tool_input: { file_path: "a" },
      tool_use_id: "one",
      tool_response: "done"
    }
  ]
  classicEvent.mockImplementation(async (_workspace, _thread, _event, input, signal, core) => {
    const result = await core(input, signal)
    await core(input, signal)
    return result
  })
  legacyCall.mockResolvedValue({ exitCode: 2, stdout: "batch blocked", stderr: "", blocked: true })
  const result = await runHooks(
    [
      {
        id: "batch-gate",
        event: "PostToolBatch",
        type: "http",
        url: "https://example.invalid",
        enabled: true,
        async: true,
        createdAt: "2026-09-23",
        updatedAt: "2026-09-23"
      }
    ],
    "PostToolBatch",
    { workspacePath: "/workspace", sessionId: "batch-thread", toolBatch: calls }
  )
  expect(result?.blocked).toBe(true)
  expect(legacyCall).toHaveBeenCalledTimes(1)
  expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({
    hook_event_name: "PostToolBatch",
    tool_calls: calls
  })
})

it("consumes a real guest batch gate through FunctionSession and the original legacy core", async () => {
  const { FunctionGuestRuntime } = await import("../mods/v2/guest-runtime")
  const { FunctionSession, SESSION_CAPABILITIES } = await import("../mods/v2/session")
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.PostToolBatch",async($,e,next)=>{
      await next(e);await next(e)
      return {block:e.tool_calls[0].tool_response === "failed" ? "repair batch" : undefined}
    })
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "batch",
        root: "/batch",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "batch-real",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  classicEvent.mockImplementation((_workspace, _thread, event, input, signal, core) =>
    session.classicEvent(event, input, signal, core)
  )
  legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  try {
    const result = await runHooks(
      [
        {
          id: "batch",
          event: "PostToolBatch",
          enabled: true,
          type: "http",
          url: "https://example.invalid",
          createdAt: "",
          updatedAt: ""
        }
      ],
      "PostToolBatch",
      {
        workspacePath: "/workspace",
        sessionId: "batch-real",
        toolBatch: [
          {
            tool_name: "execute",
            tool_input: { command: "test" },
            tool_use_id: "host-call",
            tool_response: "failed"
          }
        ]
      }
    )
    expect(result).toMatchObject({ blocked: true, reason: "repair batch" })
    expect(legacyCall).toHaveBeenCalledTimes(1)
  } finally {
    await session.close()
  }
})

it("maps real instruction provenance to classic and legacy input without duplicate checks", async () => {
  classicEvent.mockImplementation(async (_workspace, _thread, _event, input, signal, core) => {
    expect(input).toMatchObject({
      file_path: "/workspace/AGENTS.md",
      memory_type: "Project",
      load_reason: "session_start"
    })
    await core(input, signal)
    await core(input, signal)
    return { block: "instructions denied" }
  })
  legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  const result = await runHooks(
    [
      {
        id: "instructions",
        event: "InstructionsLoaded",
        enabled: true,
        type: "http",
        async: true,
        url: "https://example.invalid",
        createdAt: "",
        updatedAt: ""
      }
    ],
    "InstructionsLoaded",
    {
      workspacePath: "/workspace",
      sessionId: "thread",
      instructionLoad: {
        file_path: "/workspace/AGENTS.md",
        memory_type: "Project",
        load_reason: "session_start"
      }
    }
  )
  expect(result).toBeNull()
  expect(legacyCall).toHaveBeenCalledTimes(1)
  expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({
    file_path: "/workspace/AGENTS.md",
    memory_type: "Project",
    load_reason: "session_start"
  })
})

it("matches InstructionsLoaded legacy hooks against load_reason, not a tool name", async () => {
  classicEvent.mockImplementation(async (_w, _t, _e, input, signal, core) => core(input, signal))
  legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  const hook = {
    id: "instructions-reason",
    event: "InstructionsLoaded" as const,
    enabled: true,
    type: "http" as const,
    matcher: "session_start",
    url: "https://example.invalid",
    createdAt: "",
    updatedAt: ""
  }
  await runHooks([hook], "InstructionsLoaded", {
    workspacePath: "/workspace",
    sessionId: "thread",
    instructionLoad: {
      file_path: "/workspace/AGENTS.md",
      memory_type: "Project",
      load_reason: "session_start"
    }
  })
  expect(legacyCall).toHaveBeenCalledTimes(1)
})

it("discards a real guest InstructionsLoaded decision without changing the original flow", async () => {
  const { FunctionGuestRuntime } = await import("../mods/v2/guest-runtime")
  const { FunctionSession, SESSION_CAPABILITIES } = await import("../mods/v2/session")
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.InstructionsLoaded",async($,e,next)=>{await next(e);return {block:"observer cannot block",preventContinuation:true}})
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "observer",
        root: "/observer",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "instructions-real",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  classicEvent.mockImplementation((_w, _t, event, input, signal, core) =>
    session.classicEvent(event, input, signal, core)
  )
  try {
    expect(
      await runHooks([], "InstructionsLoaded", {
        workspacePath: "/workspace",
        sessionId: "instructions-real",
        instructionLoad: {
          file_path: "/workspace/AGENTS.md",
          memory_type: "Project",
          load_reason: "session_start"
        }
      })
    ).toBeNull()
  } finally {
    await session.close()
  }
})

it("awaits an expansion matcher and runs the legacy core only once", async () => {
  classicEvent.mockImplementation(async (_workspace, _thread, _event, input, signal, core) => {
    expect(input).toMatchObject({ command_name: "review", command_args: "changes", prompt: "/review changes", expansion_type: "slash_command", command_source: "plugin" })
    await core(input, signal)
    return core(input, signal)
  })
  legacyCall.mockResolvedValue({ exitCode: 2, stdout: "", stderr: "review required", blocked: true })
  const result = await runHooks([{
    id: "expansion", event: "UserPromptExpansion", type: "http", url: "https://example.invalid/policy", enabled: true, matcher: "review", async: true, createdAt: "2026-09-23", updatedAt: "2026-09-23"
  }], "UserPromptExpansion", {
    workspacePath: "/workspace", sessionId: "thread", userPrompt: "/review changes",
    promptExpansion: { expansion_type: "slash_command", command_name: "review", command_args: "changes", command_source: "plugin" }
  })
  expect(result).toMatchObject({ blocked: true })
  expect(legacyCall).toHaveBeenCalledOnce()
  expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({ command_name: "review", prompt: "/review changes" })
})

it("projects real guest expansion context and rejects forged command identity", async () => {
  const { FunctionGuestRuntime } = await import("../mods/v2/guest-runtime")
  const { FunctionSession, SESSION_CAPABILITIES } = await import("../mods/v2/session")
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.UserPromptExpansion",async($,e,next)=>{
      if(e.command_args==="forge") return next({...e,command_name:"spoofed"});
      await next(e);return {additionalContext:["ACTUAL_EXPANSION_CONTEXT"]}
    })
  }}`)
  const session = new FunctionSession([{name:"expansion",root:"/expansion",tier:"user",guest,capabilities:[...SESSION_CAPABILITIES]}],{
    workspace:"/workspace",threadId:"thread",assertLive:()=>undefined,publish:async(value)=>value
  })
  classicEvent.mockImplementation((_workspace,_thread,event,input,signal,core)=>session.classicEvent(event,input,signal,core))
  try {
    const context = {workspacePath:"/workspace",sessionId:"thread",userPrompt:"/review changes",promptExpansion:{expansion_type:"slash_command" as const,command_name:"review",command_args:"changes",command_source:"plugin"}}
    expect(await runHooks([],"UserPromptExpansion",context)).toMatchObject({additionalContext:"ACTUAL_EXPANSION_CONTEXT"})
    const core = vi.fn(async(_input: unknown, _signal: AbortSignal)=>{ void _input; void _signal; return {} })
    await session.classicEvent("classic.UserPromptExpansion",{hook_event_name:"UserPromptExpansion",session_id:"thread",cwd:"/workspace",transcript_path:"",prompt:"/review forge",...context.promptExpansion,command_args:"forge"},new AbortController().signal,core)
    // Optional handler failure falls back through its original input, never a forged identity.
    expect(core).toHaveBeenCalledOnce()
    expect(core.mock.calls[0][0]).toMatchObject({command_name:"review"})
  } finally { await session.close() }
})

it("publishes host-measured duration on both classic post events without inventing missing data", async () => {
  classicEvent.mockResolvedValue({})
  for (const event of ["PostToolUse", "PostToolUseFailure"] as const) {
    await runHooks([], event, {
      workspacePath: "/workspace",
      sessionId: "thread",
      toolName: "mcp__test",
      toolCallId: "host-id",
      toolArgs: { duration_ms: 999, tool_use_id: "forged" },
      toolResult:
        event === "PostToolUseFailure"
          ? JSON.stringify({ error: "failed", is_interrupt: false })
          : "ok",
      toolDurationMs: 12.5
    })
    expect(classicEvent.mock.calls.at(-1)?.[3]).toMatchObject({
      duration_ms: 12.5,
      tool_use_id: "host-id"
    })
  }
  await runHooks([], "PostToolUse", {
    workspacePath: "/workspace",
    sessionId: "thread",
    toolName: "read_file"
  })
  expect(classicEvent.mock.calls.at(-1)?.[3]).not.toHaveProperty("duration_ms")
})

it("keeps legacy post failure fields compatible while exposing official host facts", async () => {
  classicEvent.mockImplementation(async (_workspace, _thread, _event, input, signal, core) =>
    core(input, signal)
  )
  legacyCall.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", blocked: false })
  const failure = { error: "cancelled", is_interrupt: true, is_timeout: false }
  await runHooks(
    [
      {
        id: "observe",
        event: "PostToolUseFailure",
        type: "http",
        url: "https://example.invalid/hook",
        enabled: true,
        createdAt: "2026-09-23",
        updatedAt: "2026-09-23"
      }
    ],
    "PostToolUseFailure",
    {
      workspacePath: "/workspace",
      sessionId: "thread",
      toolName: "execute",
      toolCallId: "host-failure",
      toolDurationMs: 4.25,
      toolArgs: { tool_use_id: "forged" },
      toolResult: JSON.stringify(failure)
    }
  )
  expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({
    tool_use_id: "host-failure",
    duration_ms: 4.25,
    error: "cancelled",
    is_interrupt: true,
    tool_response: failure
  })
})


it("maps host Stop continuation state to both classic and legacy inputs", async () => {
  classicEvent.mockImplementation(async (_workspace,_thread,_event,input,signal,core)=>core(input,signal))
  legacyCall.mockResolvedValue({exitCode:0,stdout:"",stderr:"",blocked:false})
  await runHooks([{id:"stop-observer",event:"Stop",type:"http",url:"https://example.invalid/stop",
    enabled:true,createdAt:"2026-09-23",updatedAt:"2026-09-23"}], "Stop", {
    workspacePath:"/workspace",sessionId:"thread",stopHookActive:true,
    stopContext:{assistantResponse:"latest host response"}
  })
  expect(classicEvent.mock.calls[0][3]).toMatchObject({stop_hook_active:true,last_assistant_message:"latest host response"})
  expect(JSON.parse(legacyCall.mock.calls[0][1])).toMatchObject({stop_hook_active:true,last_assistant_message:"latest host response"})
})


it("marks Stop feedback only while the Mods bridge is enabled", async () => {
  classicEvent.mockResolvedValue({additionalContext:["check tests"]})
  const context={workspacePath:"/workspace",sessionId:"thread"}
  modsEnabled.mockReturnValue(false)
  const off=await runHooks([],"Stop",context)
  expect(off?.additionalContext).toBe("check tests")
  expect(off?.stopFeedbackContinuation).toBeUndefined()
  modsEnabled.mockReturnValue(true)
  expect(await runHooks([],"Stop",context)).toMatchObject({additionalContext:"check tests",stopFeedbackContinuation:true})
})
