import { afterEach, describe, expect, it } from "vitest"
import { FunctionGuestRuntime } from "./guest-runtime"
import type { FunctionInvocation } from "../../../shared/mods/v2/contracts"
import type { ModObject } from "../../../shared/mods/types"

const guests: FunctionGuestRuntime[] = []
const metadata: FunctionInvocation = {
  event: "ui.render",
  origin: { plugin: "engine", tier: "core" },
  plugin: { name: "buttons", root: "/plugin" },
  capabilities: ["ui.resolve", "ui.invalidate", "session.id"],
  uiGeneration: "drawing-1"
}
const render = { surface: "desktop", component: "Pane", requestId: "board", props: {} }
const press = { ...render, plugin: "buttons", element: "button" }

async function prepare(body: string) {
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    ${body}
  }}`)
  guests.push(guest)
  const result = await guest.invoke("0", render, async () => ({}), metadata)
  const handle = ((result.value as ModObject).press as ModObject).handle as number
  return {
    guest,
    invoke: (host: Parameters<FunctionGuestRuntime["invoke"]>[2], signal?: AbortSignal) =>
      guest.invoke("callback", press, host, {
        ...metadata,
        event: "ui.press",
        signal,
        callback: { handle, generation: "drawing-1", kind: "onPress" }
      })
  }
}

afterEach(() => guests.splice(0).forEach((guest) => guest.dispose()))

describe("function UI callback lifecycle", () => {
  it("refuses fabricated callback provenance", async () => {
    const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
      on("ui.render",()=>({type:"Button",props:{key:"stolen",label:"Stolen"},press:{plugin:"other",handle:1}}));
    }}`)
    guests.push(guest)
    await expect(guest.invoke("0", render, async () => ({}), metadata)).rejects.toThrow(
      "MODS_UI_ACTION_OWNER"
    )
  })
  it("uses a captured SDK repeatedly, after rendering has finished", async () => {
    const { guest, invoke } = await prepare(`
      on("ui.render", ($,e) => $.ui.resolve(e).Button({key:"button",label:"Count",onPress:async()=>{
        await Promise.resolve();await $.session.id();$.ui.invalidate("ui.render");
      }}));
    `)
    const calls: string[] = []
    for (const name of ["first", "second"])
      await invoke(async (method) => {
        calls.push(name + ":" + method)
        return { value: name }
      })
    expect(calls).toEqual([
      "first:session.id",
      "first:ui.invalidate",
      "second:session.id",
      "second:ui.invalidate"
    ])
    expect(guest.stats).toMatchObject({ frames: 0, replies: 0 })
  })

  it("keeps concurrent callbacks on their own host frame", async () => {
    const { invoke } = await prepare(`
      on("ui.render", ($,e) => $.ui.resolve(e).Button({key:"button",label:"Run",onPress:async()=>{
        await $.session.id();await Promise.resolve();await $.session.id();
      }}));
    `)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const calls: string[] = []
    const first = invoke(async () => {
      calls.push("A")
      await gate
      return { value: "A" }
    })
    await invoke(async () => {
      calls.push("B")
      return { value: "B" }
    })
    release()
    await first
    expect(calls).toEqual(["A", "B", "B", "A"])
  })

  it("does not lend a new callback's authority to a detached stale continuation", async () => {
    const { invoke } = await prepare(`let release;let seen;
      on("ui.render", ($,e) => $.ui.resolve(e).Button({key:"button",label:"Run",onPress:async()=>{
        if (!release) {
          const wait = new Promise(resolve=>release=resolve);
          seen = wait.then(async()=>{try{await $.session.id();return "escaped"}catch{return "blocked"}});
          return;
        }
        release();if(await seen!=="blocked")throw Error("stale callback escaped");
        await $.session.id();
      }}));
    `)
    const calls: string[] = []
    await invoke(async () => {
      calls.push("old")
      return { value: "old" }
    })
    await invoke(async () => {
      calls.push("new")
      return { value: "new" }
    })
    expect(calls).toEqual(["new"])
  })

  it("revokes a cancelled callback while another callback remains usable", async () => {
    const { invoke } = await prepare(`
      on("ui.render", ($,e) => $.ui.resolve(e).Button({key:"button",label:"Run",onPress:async()=>{
        await $.session.id();await $.session.id();
      }}));
    `)
    const controller = new AbortController()
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let oldCalls = 0
    const old = invoke(async () => {
      oldCalls++
      started()
      await gate
      return { value: "old" }
    }, controller.signal)
    await entered
    controller.abort()
    await expect(old).rejects.toThrow("MODS_CANCELLED")
    let currentCalls = 0
    await invoke(async () => {
      currentCalls++
      release()
      return { value: "new" }
    })
    expect(oldCalls).toBe(1)
    expect(currentCalls).toBe(2)
  })

  it("rejects actions after their drawing is released", async () => {
    const { guest, invoke } = await prepare(`
      on("ui.render", ($,e) => $.ui.resolve(e).Button({key:"button",label:"Run",onPress:()=>{}}));
    `)
    guest.releaseUi("drawing-1")
    await expect(invoke(async () => ({}))).rejects.toThrow("MODS_UI_STALE_ACTION")
  })
})
