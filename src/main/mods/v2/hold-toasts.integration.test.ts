import { afterEach, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionPresentationPublisher } from "./presentation-broker"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionPresentationReport } from "../../../shared/mods/v2/presentation"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
async function fixture(publish: (v: ModJson) => Promise<ModJson> = async (v) => v, neighbor = "") {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",async($,e,next)=>{for(const name of ["hold","release","close"])await $.command.register({name,description:name});return next(e)});
    on("command.run",{command:"hold"},async($)=>{await $.ui.open({id:"board",holdToasts:true});return {}});
    on("command.run",{command:"release"},async($)=>{await $.ui.open({id:"board"});return {}});
    on("command.run",{command:"close"},async($)=>{await $.ui.close({id:"board"});return {}});
    on("ui.render",{component:"Pane"},($,e)=>{const {Text}=$.ui.resolve(e);return Text({children:"Read panel"})});
  }}`)
  const other = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("session.start",($,e,next)=>{ $.ui.toast("other waiting",{timeoutMs:100});$.ui.status("persistent");return next(e)});
    ${neighbor}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "author",
        root: "/author",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      },
      {
        name: "other",
        root: "/other",
        tier: "user",
        guest: other,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/workspace",
      threadId: "thread",
      assertLive() {
        /* Fixture session stays live. */
      },
      publish
    }
  )
  sessions.push(session)
  await session.start()
  return session
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function report(
  receipt: string,
  panes: FunctionPresentationReport["panes"],
  ids: string[],
  sequence = 1
): FunctionPresentationReport {
  return {
    threadId: "thread",
    owner: "owner",
    receipt,
    panes,
    shown: ids,
    hovered: [],
    dismissed: [],
    sequence,
    present: true
  }
}
it("actual ui.open holds another mod toast beyond duration; omission releases and starts its clock", async () => {
  const session = await fixture()
  await session.run("hold", "")
  const [pane] = await session.panes.snapshot()
  expect(pane.holdToasts).toBe(true)
  const publisher = new FunctionPresentationPublisher()
  const initial = await publisher.publish(async () =>
    session.presentationBinding(await session.feedbackSnapshot())
  )
  const toast = initial.entries.find((row) => row.kind === "toast")!
  publisher.report(
    report(
      initial.receipt!,
      [
        {
          key: pane.key,
          generation: pane.generation,
          isPlaced: true,
          isShown: true,
          isFocused: false
        }
      ],
      [toast.id]
    )
  )
  await wait(150)
  expect((await session.feedbackSnapshot()).map((row) => row.text)).toContain("other waiting")
  await session.run("release", "")
  const [released] = await session.panes.snapshot()
  expect(released.holdToasts).toBeUndefined()
  const next = await publisher.publish(async () =>
    session.presentationBinding(await session.feedbackSnapshot())
  )
  publisher.report(
    report(
      next.receipt!,
      [
        {
          key: released.key,
          generation: released.generation,
          isPlaced: true,
          isShown: true,
          isFocused: false
        }
      ],
      [toast.id]
    )
  )
  await wait(150)
  expect((await session.feedbackSnapshot()).map((row) => row.text)).toEqual(["persistent"])
  publisher.close()
})
it("undrawn, old-generation and closed panes never cause a lasting hold", async () => {
  const session = await fixture()
  await session.run("hold", "")
  const [pane] = await session.panes.snapshot()
  expect(
    session.panes.holdsToasts([
      {
        key: pane.key,
        generation: pane.generation,
        isPlaced: true,
        isShown: false,
        isFocused: false
      }
    ])
  ).toBe(false)
  expect(
    session.panes.holdsToasts([
      { key: pane.key, generation: "old", isPlaced: true, isShown: true, isFocused: false }
    ])
  ).toBe(false)
  expect(
    session.panes.holdsToasts([
      {
        key: pane.key,
        generation: pane.generation,
        isPlaced: true,
        isShown: true,
        isFocused: false
      }
    ])
  ).toBe(true)
  await session.run("close", "")
  expect(
    session.panes.holdsToasts([
      {
        key: pane.key,
        generation: pane.generation,
        isPlaced: true,
        isShown: true,
        isFocused: false
      }
    ])
  ).toBe(false)
})
it("another hook can delete holdToasts from the actual ui.open chain", async () => {
  const session = await fixture(
    undefined,
    `on("ui.open",($,e,next)=>{const {holdToasts,...rest}=e;return next(rest)})`
  )
  await session.run("hold", "")
  expect((await session.panes.snapshot())[0].holdToasts).toBeUndefined()
})
it("protection cannot forge native hold metadata or toast duration", async () => {
  let mode = "hold"
  const session = await fixture(async (value) => {
    if (!Array.isArray(value)) return value
    return value.map((row) =>
      row && typeof row === "object" && !Array.isArray(row)
        ? mode === "hold" && row.generation
          ? { ...row, holdToasts: false }
          : mode === "duration" && row.kind === "toast"
            ? { ...row, timeoutMs: 60000 }
            : row
        : row
    )
  })
  await session.run("hold", "")
  await expect(session.panes.snapshot()).rejects.toThrow("PUBLICATION")
  mode = "duration"
  await expect(session.feedbackSnapshot()).rejects.toThrow("SNAPSHOT")
})
it("retirement aborts the bound receipt and immediately pauses the original actual session", async () => {
  const session = await fixture()
  const publisher = new FunctionPresentationPublisher()
  const publication = await publisher.publish(async () =>
    session.presentationBinding(await session.feedbackSnapshot())
  )
  const binding = session.presentationBinding(publication.entries)
  await session.close()
  expect(binding.signal.aborted).toBe(true)
  publisher.report(report(publication.receipt!, [], []))
  publisher.close()
})
