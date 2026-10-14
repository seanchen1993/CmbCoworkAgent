import { afterEach, expect, it, vi } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModObject } from "../../../shared/mods/types"
import type { FunctionSessionHost } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})
const input: ModObject = {
  model: "fixture",
  turnId: "actual-turn",
  index: 0,
  messageCount: 1,
  agentId: "child"
}
async function fixture(code: string, host: Partial<FunctionSessionHost> = {}, modern = false) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${code}}}`)
  const session = new FunctionSession(
    [
      {
        name: "sdk",
        root: "/sdk",
        tier: "user",
        guest,
        modelProtocol: modern ? "result-v1" : "legacy-v1",
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive() {
        /* This isolated fixture has no native authority. */
      },
      publish: async (v) => v,
      version: { version: "1.5.2" },
      ...host
    }
  )
  sessions.push(session)
  return { session, guest }
}

it.each([false, true])(
  "routes actual streamed scalar/object/void model SDK values (modern=%s)",
  async (modern) => {
    const f = await fixture(
      `on("turn.step",async function*($,e,next){
    const id=await $.session.id();const version=await $.session.version();
    await $.ui.log("sdk-probe");
    const r=await $.model.complete({model:"fixture",prompt:"independent"});
    const text=typeof r==="string"?r:r.text;
    if(id!=="thread"||version.version!=="1.5.2"||text!=="answer")throw Error("wrong envelope");
    return yield* next({...e,model:"selected"})
  });`,
      {
        completeModel: async () => "answer",
        completeModelResult: async () => ({
          isAnswered: true,
          text: "answer",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0
          }
        })
      },
      modern
    )
    let model: unknown
    const stream = await f.session.turnStep(input, async function* (e) {
      model = e.model
      yield { kind: "text", text: "child answer" }
      return {}
    })
    for await (const chunk of stream) {
      expect(chunk).toHaveProperty("kind", "text")
    }
    await stream.result
    expect(model).toBe("selected")
    expect((await f.session.logSnapshot()).some((row) => row.text === "sdk-probe")).toBe(true)
    expect(f.guest.stats).toMatchObject({ frames: 0, replies: 0 })
  }
)

it("cancels an individual SDK request without cancelling the provider stream", async () => {
  const cancelled = vi.fn()
  const f = await fixture(
    `on("turn.step",async function*($,e,next){
    const c=new AbortController();
    const pending=$.model.complete({model:"fixture",prompt:"cancel"},{signal:c.signal});
    await $.clock.sleep(10);c.abort();
    try {await pending;throw Error("not cancelled")}catch(error){}
    return yield* next(e)
  });`,
    {
      completeModel: async (_plugin, _request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              cancelled()
              reject(Error("cancelled"))
            },
            { once: true }
          )
        })
    }
  )
  const core = vi.fn()
  const stream = await f.session.turnStep(input, async function* () {
    core()
    yield { kind: "text", text: "continued" }
    return {}
  })
  for await (const chunk of stream) {
    expect(chunk).toHaveProperty("kind", "text")
  }
  await stream.result
  expect(cancelled).toHaveBeenCalledTimes(1)
  expect(core).toHaveBeenCalledTimes(1)
})
