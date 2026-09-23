import { describe, expect, it } from "vitest"
import { validateClassicInput, validateClassicResult } from "./classic"

describe("Claude v2.1.278 classic event contracts", () => {
  it("requires actual compaction trigger and event-specific evidence", () => {
    const base = { session_id: "thread", cwd: "/workspace", transcript_path: "" }
    for (const name of ["PreCompact", "PostCompact"]) {
      expect(() =>
        validateClassicInput(`classic.${name}`, { ...base, hook_event_name: name })
      ).toThrow("MODS_CLASSIC_INPUT")
      expect(() =>
        validateClassicInput(`classic.${name}`, {
          ...base,
          hook_event_name: name,
          trigger: "beforeModel"
        })
      ).toThrow("MODS_CLASSIC_INPUT")
    }
    expect(() =>
      validateClassicInput("classic.PreCompact", {
        ...base,
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: null
      })
    ).not.toThrow()
    expect(() =>
      validateClassicInput("classic.PostCompact", {
        ...base,
        hook_event_name: "PostCompact",
        trigger: "auto",
        compact_summary: "committed summary"
      })
    ).not.toThrow()
  })

  it("uses the PreToolUse tool envelope and typed decisions", () => {
    expect(() =>
      validateClassicInput("classic.PreToolUse", {
        tool: "write_file",
        tool_use_id: "call-1",
        path: "README.md"
      })
    ).not.toThrow()
    expect(() =>
      validateClassicInput("classic.PreToolUse", {
        toolName: "write_file",
        toolArgs: { path: "README.md" }
      })
    ).toThrow("MODS_CLASSIC_INPUT")
    for (const value of [
      {},
      { allow: true },
      { ask: "confirm" },
      { deny: "read only" },
      { updatedInput: { path: "safe.md" }, additionalContext: ["check one", "check two"] }
    ])
      expect(() => validateClassicResult("classic.PreToolUse", value)).not.toThrow()
    for (const value of [
      { allow: false },
      { allow: true, deny: "no" },
      { ask: "ask", deny: "no" },
      { decision: "deny", reason: "no" },
      { block: "no" },
      { additionalContext: "note" },
      { additionalContext: [1] },
      { updatedInput: [] }
    ])
      expect(() => validateClassicResult("classic.PreToolUse", value)).toThrow(
        "MODS_CLASSIC_RESULT"
      )
  })

  it("allows only each classic event's declared result fields", () => {
    expect(() =>
      validateClassicResult("classic.Stop", {
        block: "repair this",
        preventContinuation: true,
        stopReason: "cancelled",
        additionalContext: ["note"]
      })
    ).not.toThrow()
    expect(() =>
      validateClassicResult("classic.SessionStart", {
        additionalContext: ["context"],
        initialUserMessage: "hello",
        sessionTitle: "title",
        watchPaths: ["/workspace/a"],
        reloadSkills: true
      })
    ).not.toThrow()
    expect(() =>
      validateClassicResult("classic.PostToolUse", {
        updatedToolOutput: { content: ["ok"] },
        updatedMCPToolOutput: null
      })
    ).not.toThrow()
    expect(() => validateClassicResult("classic.PermissionDenied", { retry: true })).not.toThrow()
    expect(() =>
      validateClassicResult("classic.MessageDisplay", { displayContent: "visible" })
    ).not.toThrow()
    for (const [event, result] of [
      ["classic.Stop", { block: true }],
      ["classic.Stop", { decision: "block" }],
      ["classic.Stop", { preventContinuation: false }],
      ["classic.Stop", { displayContent: "no" }],
      ["classic.Notification", { additionalContext: ["no"] }],
      ["classic.SessionStart", { watchPaths: [1] }],
      ["classic.SessionStart", { reloadSkills: false }],
      ["classic.PermissionDenied", { retry: false }]
    ] as const)
      expect(() => validateClassicResult(event, result)).toThrow("MODS_CLASSIC_RESULT")
  })

  it("validates PermissionRequest decision variants and bounded permission updates", () => {
    expect(() =>
      validateClassicResult("classic.PermissionRequest", {
        decision: {
          behavior: "allow",
          updatedInput: { command: "pwd" },
          updatedPermissions: [
            {
              type: "addRules",
              rules: [{ toolName: "Bash", ruleContent: "pwd" }],
              behavior: "allow",
              destination: "session"
            },
            { type: "setMode", mode: "plan", destination: "session" },
            { type: "addDirectories", directories: ["/workspace"], destination: "session" }
          ]
        }
      })
    ).not.toThrow()
    expect(() =>
      validateClassicResult("classic.PermissionRequest", {
        decision: { behavior: "deny", message: "no", interrupt: true }
      })
    ).not.toThrow()
    for (const decision of [
      { behavior: "ask" },
      { behavior: "deny", updatedInput: {} },
      {
        behavior: "allow",
        updatedPermissions: [{ type: "setMode", mode: "root", destination: "session" }]
      },
      {
        behavior: "allow",
        updatedPermissions: [
          {
            type: "addRules",
            rules: [{ toolName: "Bash" }],
            behavior: "allow",
            destination: "machine"
          }
        ]
      },
      { behavior: "deny", interrupt: false }
    ])
      expect(() => validateClassicResult("classic.PermissionRequest", { decision })).toThrow(
        "MODS_CLASSIC_RESULT"
      )
  })

  it("rejects unknown events, malformed base inputs and unbounded values", () => {
    expect(() => validateClassicResult("classic.Unknown", {})).toThrow("MODS_CLASSIC_EVENT_INVALID")
    expect(() => validateClassicResult("classic.Stop", { block: "x".repeat(32001) })).toThrow(
      "MODS_CLASSIC_RESULT"
    )
    expect(() =>
      validateClassicResult("classic.Stop", { additionalContext: Array(257).fill("note") })
    ).toThrow("MODS_CLASSIC_RESULT")
    let deep: unknown = "leaf"
    for (let index = 0; index < 34; index++) deep = { child: deep }
    expect(() => validateClassicResult("classic.PostToolUse", { updatedToolOutput: deep })).toThrow(
      "MODS_CLASSIC_RESULT"
    )
    expect(() =>
      validateClassicResult("classic.PostToolUse", { updatedToolOutput: Array(20001).fill(0) })
    ).toThrow("MODS_CLASSIC_RESULT")
    expect(() =>
      validateClassicInput("classic.Stop", {
        hook_event_name: "Stop",
        session_id: "thread",
        cwd: "/workspace",
        transcript_path: ""
      })
    ).not.toThrow()
    expect(() =>
      validateClassicInput("classic.Stop", {
        hook_event_name: "PreToolUse",
        session_id: "thread",
        cwd: "/workspace",
        transcript_path: ""
      })
    ).toThrow("MODS_CLASSIC_INPUT")
  })
})

it("requires a bounded complete PostToolBatch inventory with unique host IDs", () => {
  const base = {
    hook_event_name: "PostToolBatch",
    session_id: "t",
    cwd: "/project",
    transcript_path: ""
  }
  const call = {
    tool_name: "read_file",
    tool_use_id: "one",
    tool_input: { file_path: "a" },
    tool_response: "done"
  }
  expect(() =>
    validateClassicInput("classic.PostToolBatch", { ...base, tool_calls: [call] })
  ).not.toThrow()
  for (const calls of [
    undefined,
    [],
    [call, call],
    [{ ...call, tool_use_id: "" }],
    [{ ...call, tool_name: 3 }],
    Array.from({ length: 129 }, (_, i) => ({ ...call, tool_use_id: String(i) }))
  ])
    expect(() =>
      validateClassicInput("classic.PostToolBatch", {
        ...base,
        ...(calls === undefined ? {} : { tool_calls: calls })
      })
    ).toThrow("MODS_CLASSIC_INPUT")
})

it("requires valid InstructionsLoaded file provenance", () => {
  const base = {
    hook_event_name: "InstructionsLoaded",
    session_id: "thread",
    cwd: "/workspace",
    transcript_path: ""
  }
  expect(() => validateClassicInput("classic.InstructionsLoaded", base)).toThrow(
    "MODS_CLASSIC_INPUT"
  )
  const input = {
    ...base,
    file_path: "/workspace/AGENTS.md",
    memory_type: "Project",
    load_reason: "session_start"
  }
  expect(() => validateClassicInput("classic.InstructionsLoaded", input)).not.toThrow()
  for (const change of [
    { file_path: "" },
    { memory_type: "Unknown" },
    { load_reason: "model" },
    { globs: [1] }
  ])
    expect(() =>
      validateClassicInput("classic.InstructionsLoaded", { ...input, ...change })
    ).toThrow("MODS_CLASSIC_INPUT")
})

it("requires resolved prompt expansion facts and bounded original text", () => {
  const input = { hook_event_name: "UserPromptExpansion", session_id: "thread", cwd: "/workspace", transcript_path: "", expansion_type: "slash_command", command_name: "review", command_args: "changes", command_source: "plugin", prompt: "/review changes" }
  expect(() => validateClassicInput("classic.UserPromptExpansion", input)).not.toThrow()
  for (const [key, value] of [["expansion_type", "tool"], ["command_name", ""], ["command_args", 5], ["command_source", null], ["prompt", "x".repeat(32001)]]) {
    expect(() => validateClassicInput("classic.UserPromptExpansion", { ...input, [key as string]: value })).toThrow("MODS_CLASSIC_INPUT")
  }
})

it.each(["PostToolUse", "PostToolUseFailure"])(
  "rejects invalid optional execution facts for %s",
  (event) => {
    const input = {
      hook_event_name: event,
      session_id: "thread",
      cwd: "/workspace",
      transcript_path: ""
    }
    for (const duration_ms of [-1, "12", null]) {
      expect(() => validateClassicInput(`classic.${event}`, { ...input, duration_ms })).toThrow(
        "MODS_CLASSIC_INPUT"
      )
    }
    expect(() =>
      validateClassicInput(`classic.${event}`, { ...input, duration_ms: 0 })
    ).not.toThrow()
    if (event === "PostToolUseFailure")
      expect(() =>
        validateClassicInput(`classic.${event}`, { ...input, is_interrupt: "false" })
      ).toThrow("MODS_CLASSIC_INPUT")
  }
)
