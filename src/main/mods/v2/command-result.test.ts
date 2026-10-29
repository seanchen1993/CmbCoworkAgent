import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => { for (const session of sessions.splice(0)) await session.close() })

async function fixture() {
  const guest = await FunctionGuestRuntime.create(`globalThis.__cmbFunctionMod={register(on){
    let calls=0;
    on("session.start",async($,event,next)=>{
      for(const name of ["broken","unhandled","good","count","caught","empty"])
        await $.command.register({name,description:name});
      return next(event)
    });
    on("command.run",{command:"broken"},()=>{calls++;throw Error("provider failure")});
    on("command.run",{command:"good"},()=>({text:"actual output"}));
    on("command.run",{command:"count"},()=>({text:String(calls)}));
    on("command.run",{command:"caught"},()=>{throw Error("caught failure")})
      .catch(()=>({text:"explicit recovery"}));
    on("command.run",{command:"empty"},()=>({}));
  }}`)
  const session = new FunctionSession([{ name: "command-owner", root: "/commands", tier: "user",
    guest, capabilities: [...SESSION_CAPABILITIES] }], {
    workspace: "/workspace", threadId: "commands", assertLive: () => {},
    publish: async (value) => value
  })
  sessions.push(session)
  return session
}

it("fails an unhandled registered command instead of recording empty success", async () => {
  const session = await fixture()
  await expect(session.run("unhandled", "")).rejects.toThrow("MODS_COMMAND_UNHANDLED")
  await expect(session.run("broken", "")).rejects.toThrow("MODS_COMMAND_UNHANDLED")
  expect(await session.run("count", "")).toEqual({ text: "1" })
})

it("preserves explicit results, intentional empty UI results and hook recovery", async () => {
  const session = await fixture()
  expect(await session.run("good", "")).toEqual({ text: "actual output" })
  expect(await session.run("caught", "")).toEqual({ text: "explicit recovery" })
  expect(await session.run("empty", "")).toEqual({})
})
