import { afterEach, expect, it, vi } from "vitest"
import { FunctionPanes } from "./panes"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { randomUUID } from "node:crypto"

const panes: FunctionPanes[] = []
const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const pane of panes.splice(0)) await pane.close()
  for (const session of sessions.splice(0)) await session.close()
  vi.useRealTimers()
})
function fixture() {
  vi.useFakeTimers()
  const changed = vi.fn()
  const pane = new FunctionPanes({
    plugins: [],
    assertLive: vi.fn(),
    changed,
    publish: async (v) => v,
    dispatch: async () => ({}),
    callback: async () => {}
  })
  panes.push(pane)
  return { pane, changed }
}
it("batches Client-only frames into one scoped notification", async () => {
  const { pane, changed } = fixture()
  pane.notify()
  pane.notify()
  await vi.advanceTimersByTimeAsync(15)
  expect(changed).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(changed.mock.calls).toEqual([["panes"]])
})
it.each(["all-first", "client-first"])(
  "preserves global invalidation and the earliest deadline for %s",
  async (order) => {
    const { pane, changed } = fixture()
    if (order === "all-first") {
      pane.invalidate()
      pane.notify()
    } else {
      pane.notify()
      pane.invalidate()
    }
    await vi.advanceTimersByTimeAsync(16)
    expect(changed.mock.calls).toEqual([[undefined]])
    pane.notify()
    await vi.advanceTimersByTimeAsync(16)
    expect(changed.mock.calls).toEqual([[undefined], ["panes"]])
    await vi.advanceTimersByTimeAsync(100)
    expect(changed).toHaveBeenCalledTimes(2)
  }
)
it("does not publish a queued scoped update after closing", async () => {
  const { pane, changed } = fixture()
  pane.notify()
  await pane.close()
  changed.mockClear()
  await vi.advanceTimersByTimeAsync(100)
  expect(changed).not.toHaveBeenCalled()
})
it("carries actual Client redraw scope through FunctionSession while SDK invalidation remains global", async () => {
  const changes: unknown[] = []
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{for(const name of ["open","redraw"])await $.command.register({name,description:name});return next(e)});
    on("command.run",{command:"open"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"redraw"},($)=>{$.ui.invalidate("ui.render");return {}});
    on("ui.render",{component:"Pane"},($,e)=>$.ui.resolve(e).Client({key:"surface",module:"surface.js"}))
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "notices",
        root: "/plugin",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      assertLive: vi.fn(),
      publish: async (v) => v,
      uiChanged: (scope?: string) => {
        changes.push(scope)
      },
      loadClient: async () =>
        FunctionGuestRuntime.create(
          CLIENT_BOOTSTRAP +
            `
      globalThis.__cmbSurfaceMod={default(props,s){return s.elements.Button({key:"counter",label:String(s.state||0),onPress(){s.setState((s.state||0)+1)}})}}
    `,
          { plugin: "notices" }
        )
    }
  )
  sessions.push(session)
  await session.run("open", "")
  const [snapshot] = await session.panes.snapshot()
  await expect.poll(() => changes.length).toBeGreaterThan(0)
  changes.length = 0
  const client = snapshot.clients![0]
  await session.clients.act({
    pane: snapshot.key,
    instance: client.id,
    intentId: randomUUID(),
    kind: "press",
    handle: client.tree.press!.handle
  })
  await expect.poll(() => changes).toEqual(["panes"])
  expect((await session.panes.snapshot())[0].clients![0].tree.props.label).toBe("1")
  changes.length = 0
  await session.run("redraw", "")
  await expect.poll(() => changes).toEqual([undefined])
})
