import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "../../mods/v2/guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "../../mods/v2/session"
import { runCompletionHooksWithRevision } from "./completion-hooks"
import { createHookScope } from "../../hooks/scope"

const bridge = vi.hoisted(() => vi.fn())
vi.mock("../../mods/manager", () => ({
  getModsManager: () => ({ classicEvent: bridge, isEnabled: () => true })
}))
vi.mock("../../hooks/scope", async (original) => ({
  ...(await original<typeof import("../../hooks/scope")>()),
  resolveEnabledHooksForRun: () => []
}))
vi.mock("../../services/harness-stage-attribution", () => ({
  markHarnessStageAttributionDirty: () => undefined
}))

it("real guest feedback continues through the original Stop runner and then releases to the required gate", async () => {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("classic.Stop",async($,e,next)=>{
      const base=await next(e);
      return e.stop_hook_active?base:{...base,additionalContext:["HOST_LOOP_RECHECK"]}
    })
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "stop-feedback",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  bridge
    .mockReset()
    .mockImplementation((_workspace, _thread, event, input, signal, core) =>
      session.classicEvent(event, input, signal, core)
    )
  let response = "first response"
  const revisions: string[] = []
  const gate = vi.fn().mockResolvedValue({ decision: "block", reason: "host validation failed" })
  try {
    const outcome = await runCompletionHooksWithRevision({
      threadId: "thread",
      workspacePath: "/workspace",
      abortSignal: new AbortController().signal,
      getStopContext: () => ({ assistantResponse: response }),
      hookScope: createHookScope(),
      runPostSkillUseHooks: async () => null,
      runRevision: async (prompt) => {
        revisions.push(prompt)
        response = "rechecked response"
      },
      sendNotice: () => undefined,
      sendError: () => undefined,
      maxRevisionAttempts: 2,
      revisionPromptPrefix: "test",
      completionGate: gate
    })
    expect(outcome).toBe("failed")
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toContain("HOST_LOOP_RECHECK")
    expect(bridge.mock.calls.map((call) => call[3])).toMatchObject([
      { stop_hook_active: false, last_assistant_message: "first response" },
      { stop_hook_active: true, last_assistant_message: "rechecked response" }
    ])
    expect(gate).toHaveBeenCalledTimes(1)
    expect(gate.mock.calls[0][0].revisionAttempts).toBe(1)
  } finally {
    await session.close()
  }
})
