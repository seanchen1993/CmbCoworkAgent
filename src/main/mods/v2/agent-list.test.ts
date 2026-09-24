import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

async function fixture(hooks = "") {
  const listAgents = vi.fn(async () => [
    {
      id: "task-1",
      description: "Inspect files",
      type: "Explore",
      status: "running",
      parentId: "task-parent"
    }
  ])
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{await $.command.register({name:"agents",description:"List real agents",immediate:true});return next(e)});
    on("command.run",{command:"agents"},async($,e)=>{
      try{return {text:JSON.stringify(await $.agent.list(...JSON.parse(e.args)))}}
      catch(error){return {text:"ERROR:"+(error.code||error.message)}}
    });${hooks}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "reader",
        root: "/project",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => {
        if (!live) throw Error("revoked")
      },
      publish: async (value) => value,
      listAgents
    }
  )
  return {
    session,
    listAgents,
    revoke: () => {
      live = false
    },
    run: (args: unknown[] = []) => session.run("agents", JSON.stringify(args))
  }
}

it("queries actual host agent instances through a real guest SDK operation", async () => {
  const f = await fixture()
  try {
    const result = await f.run()
    expect(JSON.parse(String(result.text))).toEqual([
      {
        id: "task-1",
        description: "Inspect files",
        type: "Explore",
        status: "running",
        parentId: "task-parent"
      }
    ])
    expect(f.listAgents).toHaveBeenCalledOnce()
  } finally {
    await f.session.close()
  }
})
it("keeps an empty agent.list deny without querying the host", async () => {
  const f = await fixture('on("agent.list",()=>({deny:""}));')
  try {
    expect(await f.run()).toEqual({ text: "ERROR:MODS_OPERATION_DENIED" })
    expect(f.listAgents).not.toHaveBeenCalled()
  } finally {
    await f.session.close()
  }
})
it("rejects arguments to the no-argument instance list before reaching the host", async () => {
  const f = await fixture()
  try {
    expect(await f.run([{}])).toEqual({ text: "ERROR:MODS_AGENT_LIST_ARGUMENTS" })
    expect(f.listAgents).not.toHaveBeenCalled()
  } finally {
    await f.session.close()
  }
})

it("rejects a late native list when the session loses authority", async () => {
  const f = await fixture()
  f.listAgents.mockImplementationOnce(async () => {
    f.revoke()
    return []
  })
  try {
    await expect(f.run()).rejects.toThrow("revoked")
  } finally {
    await f.session.close()
  }
})
it("does not convert a failed native query into a successful empty list", async () => {
  const f = await fixture()
  f.listAgents.mockRejectedValueOnce(Error("native unavailable"))
  try {
    expect(await f.run()).toEqual({ text: "ERROR:MODS_DOWNSTREAM_REJECTED" })
  } finally {
    await f.session.close()
  }
})
