import { afterEach, expect, it } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionScrollAck } from "../../../shared/mods/v2/ui-scroll"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function fixture(hook = "") {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{
      await $.command.register({name:"scroll-open",description:"Open"});
      await $.command.register({name:"scroll",description:"Scroll"});return next(e)
    });
    on("command.run",{command:"scroll-open"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"scroll"},async($,e)=>{try{return {text:JSON.stringify(await $.ui.scroll(JSON.parse(e.args)))}}catch(error){return {text:"SCROLL_ERROR:"+error.code}}});
    on("ui.render",{component:"Pane"},($,e)=>$.ui.resolve(e).Button({key:"last",label:"Last",onPress(){}}));
    ${hook}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "scroll",
        root: "/scroll",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: () => undefined,
      publish: async (value) => value
    }
  )
  sessions.push(session)
  await session.run("scroll-open", "")
  const [pane] = await session.panes.snapshot()
  const run = (args: unknown) => session.run("scroll", JSON.stringify(args))
  const ack = (allowed = true) => {
    const request = session.panes.scroll.current(pane.key)!
    const reply: FunctionScrollAck = {
      pane: pane.key,
      generation: request.generation,
      id: request.id,
      phase: request.phase,
      allowed,
      ...(request.phase === "probe" && allowed
        ? {
            geometry: {
              height: 100,
              content: 1000,
              top: 0,
              row: 20,
              width: 500,
              target: { top: 800, height: 20 }
            }
          }
        : {})
    }
    session.panes.scroll.ack(reply)
  }
  return { session, pane, run, ack }
}
it("runs the real guest SDK through original middleware before the actual renderer result", async () => {
  const f = await fixture('on("ui.scroll",($,e,next)=>next({...e,offset:3}));')
  const pending = f.run({ to: "end", in: "board" })
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("probe")
  expect((await f.session.panes.snapshot())[0].imperativeScroll?.generation).toBe(f.pane.generation)
  f.ack()
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("apply")
  expect(f.session.panes.scroll.current(f.pane.key)?.offset).toBe(3)
  f.ack()
  expect(await pending).toMatchObject({ text: "{}" })
})
it("refuses unknown targets before asking the renderer or treating a command as success", async () => {
  const f = await fixture()
  for (const args of [
    { to: "end", in: "foreign" },
    { to: { key: "missing" }, in: "board" },
    { to: { requestId: "transcript" } }
  ]) {
    const result = await f.run(args)
    expect(JSON.parse(String(result.text))).toEqual({ deny: expect.any(String) })
    expect(f.session.panes.scroll.current(f.pane.key)).toBeUndefined()
  }
})
it("retains a late deny and cancels a measured request when the drawing changes", async () => {
  const f = await fixture('on("ui.scroll",async($,e,next)=>{await next(e);return {deny:""}});')
  const pending = f.run({ to: { key: "last" } })
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("probe")
  f.ack()
  expect(await pending).toMatchObject({ text: '{"deny":""}' })
  const stale = f.run({ to: "start", in: "board" })
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("probe")
  f.session.panes.invalidate()
  expect(await stale).toMatchObject({ text: "SCROLL_ERROR:MODS_UI_SCROLL_STALE" })
})

it("retains an end-follow token through redraw and clears it after a successful later move", async () => {
  const f = await fixture()
  const pending = f.run({ to: "end", in: "board" })
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("probe")
  f.ack()
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("apply")
  const id = f.session.panes.scroll.current(f.pane.key)!.id
  f.ack()
  expect(await pending).toMatchObject({ text: "{}" })
  expect((await f.session.panes.snapshot())[0].scrollFollowToken).toBe(id)
  f.session.panes.invalidate()
  expect((await f.session.panes.snapshot())[0].scrollFollowToken).toBe(id)
  const moved = f.run({ to: "start", in: "board" })
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("probe")
  f.ack()
  await expect.poll(() => f.session.panes.scroll.current(f.pane.key)?.phase).toBe("apply")
  f.ack()
  await moved
  expect((await f.session.panes.snapshot())[0].scrollFollowToken).toBeUndefined()
})
