import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

it("keeps real SDK feedback, notices and logs observable without revoking drawings", async () => {
  const changed = vi.fn()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"probe",description:"Probe"});return next(e)});
    on("command.run",{command:"probe"},async $=>{
      await $.ui.status("status");await $.ui.toast("toast");
      await $.ui.notice("call","notice");await $.ui.log("log");
      return {text:"done"}
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "probe",
        root: "/probe",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive: vi.fn(),
      publish: async (value) => value,
      uiChanged: changed,
      debugLog: vi.fn(),
      dialogs: {
        lookup: (id) =>
          id === "call"
            ? {
                toolUseId: "call",
                requestId: "request",
                owner: "function:probe"
              }
            : undefined,
        subscribeClosed: () => () => {}
      }
    }
  )
  try {
    expect(await session.run("probe", "")).toEqual({ text: "done" })
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith("records"))
    expect(changed).toHaveBeenCalledWith("feedback")
    expect(changed.mock.calls.every(([scope]) => scope === "records" || scope === "feedback")).toBe(
      true
    )
    expect(JSON.stringify(await session.feedbackSnapshot())).toContain("notice")
    expect(JSON.stringify(await session.feedbackSnapshot())).toContain("status")
    expect(JSON.stringify(await session.logSnapshot())).toContain("log")
  } finally {
    await session.close()
  }
})
