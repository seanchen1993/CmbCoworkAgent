import { expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

it("routes settings/env through operations and protects values in the real guest", async () => {
  const snapshot = vi.fn(async () => ({ cmbdevclaw: { application: { version: "test" } } }))
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"read",description:"read"});return next(e)
    });
    on("settings.read",async($,e,next)=>{const result=await next(e);
      return {value:{...result.value,hooked:true}}});
    on("command.run",async($)=>{
      let secret;try{await $.env.get("API_SECRET")}catch(e){secret=e.code}
      return {settings:await $.settings.read(),path:await $.env.get("PATH"),secret}
    });
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "read",
        root: "/plugin",
        tier: "user",
        guest,
        environment: { read: ["PATH", "API_SECRET"], write: [] },
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "read",
      assertLive() {
        /* This fixture retains its grant until teardown. */
      },
      readSettings: snapshot,
      publish: async (value) => (typeof value === "string" ? "protected path" : value)
    }
  )
  try {
    expect(await session.run("read", "")).toEqual({
      settings: { cmbdevclaw: { application: { version: "test" } }, hooked: true },
      path: "protected path",
      secret: "MODS_ENV_READ_DENIED"
    })
    expect(snapshot).toHaveBeenCalledOnce()
  } finally {
    await session.close()
  }
})
