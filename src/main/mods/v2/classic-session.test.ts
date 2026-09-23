import { expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModObject } from "../../../shared/mods/types"

async function fixture(body: string) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${body}}}`)
  return new FunctionSession(
    [
      {
        name: "classic-contract",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/workspace",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
}

it("skips malformed classic results from the real guest and runs core once", async () => {
  const session = await fixture(
    `on("classic.PreToolUse", () => ({decision:"deny",reason:"legacy alias"}))`
  )
  let calls = 0
  try {
    await expect(
      session.classicEvent(
        "classic.PreToolUse",
        {
          tool: "write_file",
          tool_use_id: "call-1",
          path: "a.txt"
        },
        undefined,
        async () => {
          calls++
          return { deny: "core policy" }
        }
      )
    ).resolves.toEqual({ deny: "core policy" })
    expect(calls).toBe(1)
  } finally {
    await session.close()
  }
})

it("keeps a successful next result when a real classic guest returns bad fields", async () => {
  const session = await fixture(
    `on("classic.Stop", async ($,e,next) => {await next(e);return {block:true}})`
  )
  let calls = 0
  try {
    await expect(
      session.classicEvent(
        "classic.Stop",
        {
          hook_event_name: "Stop",
          session_id: "thread",
          cwd: "/workspace",
          transcript_path: "",
          stop_hook_active: false
        },
        undefined,
        async () => {
          calls++
          return { block: "core block" }
        }
      )
    ).resolves.toEqual({ block: "core block" })
    expect(calls).toBe(1)
  } finally {
    await session.close()
  }
})

it("passes official classic result shapes through a real guest/session", async () => {
  const session = await fixture(`
    on("classic.PreToolUse", {tool:"write_file"}, () => ({deny:"read only",additionalContext:["explain"]}));
    on("classic.SessionStart", () => ({additionalContext:["ready"],sessionTitle:"Review",watchPaths:["/workspace"],reloadSkills:true}));
  `)
  try {
    await expect(
      session.classicEvent("classic.PreToolUse", {
        tool: "write_file",
        tool_use_id: "call-1",
        path: "a.txt"
      })
    ).resolves.toEqual({ deny: "read only", additionalContext: ["explain"] })
    const input: ModObject = {
      hook_event_name: "SessionStart",
      session_id: "thread",
      cwd: "/workspace",
      transcript_path: "",
      source: "startup"
    }
    await expect(session.classicEvent("classic.SessionStart", input)).resolves.toEqual({
      additionalContext: ["ready"],
      sessionTitle: "Review",
      watchPaths: ["/workspace"],
      reloadSkills: true
    })
  } finally {
    await session.close()
  }
})

it("refuses classic identity rewrites before the host core receives them", async () => {
  const session = await fixture(`
    on("classic.PreToolUse", async ($,e,next) => next({...e,tool_use_id:"forged"}));
    on("classic.Stop", async ($,e,next) => next({...e,session_id:"another-thread"}));
  `)
  const seen: ModObject[] = []
  try {
    const core = async (input: ModObject) => {
      seen.push(input)
      return {}
    }
    const tool = { tool: "write_file", tool_use_id: "call-1", path: "a.txt" }
    const stop = {
      hook_event_name: "Stop",
      session_id: "thread",
      cwd: "/workspace",
      transcript_path: ""
    }
    await expect(
      session.classicEvent("classic.PreToolUse", tool, undefined, core)
    ).resolves.toEqual({})
    await expect(session.classicEvent("classic.Stop", stop, undefined, core)).resolves.toEqual({})
    expect(seen).toEqual([tool, stop])
  } finally {
    await session.close()
  }
})
