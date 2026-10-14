import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterEach, expect, it } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { functionGuestLoad } from "./client-load-failure"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionClientSnapshot, FunctionUiElement } from "../../../shared/mods/v2/ui"
import { ordinaryFunctionNode } from "../../../../tests/support/function-ui-node"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function text(tree: FunctionUiElement): string {
  if (tree.type === "engine") return ""
  return (tree.children ?? [])
    .map((child) => (typeof child === "string" ? child : text(child)))
    .join("")
}

async function fixture(
  mode: string,
  settings: {
    newKey?: boolean
    sameKey?: boolean
    wait?: number
    forged?: boolean
    surface?: string
    unapproved?: boolean
    siblings?: boolean
    late?: "close" | "store"
    nativeRefusal?: "initial" | "parent" | "tick" | "message"
  } = {},
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value
) {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/client-board"))
  const state = new Map<string, ModJson>()
  const guests: FunctionGuestRuntime[] = []
  const guest = await FunctionGuestRuntime.create(
    compiled.code +
      `
    const original=__cmbFunctionMod.register;
    __cmbFunctionMod={register(on,options){
      let faults=0,drawings=0;
      original((event,matcher,handler)=>{
        if(event!=="ui.render")return on(event,matcher,handler);
        return on(event,matcher,($,e)=>{
          drawings++;
          const {Client,Text,Box}=$.ui.resolve(e);
          if(faults&&!${!!settings.newKey}&&!${!!settings.sameKey})return Text({children:"Fallback works"});
          const client=Client({key:faults&&${!!settings.newKey}?"replacement":"counter",module:"hooks/surface.tsx",props:{mode:${JSON.stringify(mode)}}});
          return ${!!settings.siblings}?Box({children:[client,Client({key:"sibling",module:"hooks/surface.tsx",props:{mode:${JSON.stringify(mode)}}})]}):client;
        });
      },options);
      on("ui.fault",async($,e,next)=>{
        faults++;await $.store.set("faults",[...(await $.store.get("faults")||[]),e]);
        ${settings.wait ? `await $.clock.sleep(${settings.wait});` : ""}
        ${settings.late === "close" ? 'await $.ui.close({id:"client-board"});' : settings.late === "store" ? 'await $.store.set("late-effect",true);' : ""}
        try{return await next(${settings.forged ? '{...e,phase:"load",element:"stolen"}' : "e"})}
        catch(error){await $.store.set("rewrite-denied",error.code);return {}}
      });
      on("session.start",{},async($,e,next)=>{await $.command.register({name:"fault-state",description:"Read drawings"});return next(e)});
      on("command.run",{command:"fault-state"},()=>({text:String(drawings)}));
    }};`
  )
  const other = await FunctionGuestRuntime.create(`__cmbFunctionMod={register(on){
    on("ui.fault",async($,e,next)=>{await $.store.set("other-notified",true);return next(e)});
  }}`)
  let live = true
  let loads = 0
  let refusals = 0
  let clientMessageWrites = 0
  const surface =
    settings.surface ??
    `var __cmbSurfaceMod={default(props,s){
    if(props.mode==="render"||s.state==="draw-failed")throw Error("PRIVATE\\n"+"x".repeat(250));
    const {Button,Text}=s.elements;
    if(s.state==="done")return Text({children:"Async works"});
    return Button({key:"fail",label:"Fail once",onPress:async()=>{
      await Promise.resolve();
      if(props.mode==="success"){s.setState("done");s.post({done:true});return}
      if(props.mode==="after-handler-render"){s.setState("draw-failed");return}
      throw Error("PRIVATE\\nRUN_FAILURE")
    }});
  }}`
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
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
      threadId: "thread",
      workspace: "/project",
      assertLive: () => {
        if (!live) throw Error("revoked")
      },
      publish,
      loadClient: async (plugin, module) => {
        loads++
        if (plugin !== compiled.name || !Object.hasOwn(compiled.clients, module))
          throw Error("unapproved")
        if (settings.unapproved) throw Error("unapproved")
        const code = mode === "load" ? 'throw Error("PRIVATE\\nLOAD_FAILURE")' : surface
        const client = await functionGuestLoad(() =>
          FunctionGuestRuntime.create(CLIENT_BOOTSTRAP + "\n" + code, { plugin })
        )
        if (settings.nativeRefusal) {
          const invoke = client.invoke.bind(client)
          let draws = 0,
            refusedTick = false
          client.invoke = (id, input, host, options) => {
            if (id === "1") draws++
            const refused =
              (settings.nativeRefusal === "initial" && id === "1" && draws === 1) ||
              (settings.nativeRefusal === "parent" && id === "1" && draws === 2) ||
              (settings.nativeRefusal === "message" &&
                id === "1" && input.kind === "render" &&
                typeof input.props === "object" && input.props !== null &&
                !Array.isArray(input.props) && input.props.label === "Acknowledged" &&
                refusals === 0) ||
              (settings.nativeRefusal === "tick" &&
                id === "0" &&
                input.kind === "tick" &&
                !refusedTick)
            if (refused) {
              refusals++
              refusedTick = true
              return Promise.reject(Error("native admission refused"))
            }
            return invoke(id, input, host, options)
          }
        }
        guests.push(client)
        return client
      },
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          if (key === "client-message") clientMessageWrites++
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  cleanups.push(() => session.close())
  await session.run("client-board", "")
  const snapshot = async () => (await session.panes.snapshot())[0]
  const press = (client: FunctionClientSnapshot) =>
    session.clients.act({
      pane: "client-board:client-board",
      instance: client.id,
      generation: client.generation,
      intentId: randomUUID(),
      kind: "press",
      handle: ordinaryFunctionNode(client.tree).press!.handle
    })
  const drawings = async () => Number((await session.run("fault-state", "")).text)
  return {
    session,
    guest,
    state,
    guests,
    snapshot,
    press,
    drawings,
    revoke: () => {
      live = false
    },
    loads: () => loads,
    refusals: () => refusals,
    clientMessageWrites: () => clientMessageWrites
  }
}

it.each(["load", "render", "run", "after-handler-render"])(
  "notifies only the actual owner and redraws a %s failure once",
  async (mode) => {
    const f = await fixture(mode, {}, async (value) =>
      JSON.parse(JSON.stringify(value).replaceAll("PRIVATE", "PROTECTED"))
    )
    const pane = await f.snapshot()
    if (mode === "run" || mode === "after-handler-render")
      await f.press(pane.clients![0]).catch(() => {})
    await expect.poll(() => f.state.get("faults")).toBeDefined()
    await expect.poll(async () => text((await f.snapshot()).tree)).toBe("Fallback works")
    const faults = f.state.get("faults") as ModObject[]
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({
      surface: "desktop",
      component: "Pane",
      requestId: "client-board",
      element: "counter",
      module: "hooks/surface.tsx",
      phase: mode === "after-handler-render" ? "render" : mode
    })
    if (mode !== "load") expect(faults[0].reason).toContain("PROTECTED")
    expect((faults[0].reason as string).length).toBeLessThanOrEqual(200)
    // eslint-disable-next-line no-control-regex -- Regression for untrusted control text removal.
    expect(faults[0].reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(f.state.has("other-notified")).toBe(false)
    expect(await f.drawings()).toBe(2)
    expect(f.guests.every((client) => client.stats.disposed)).toBe(true)
    expect(f.guest.stats.disposed).toBe(false)
  }
)

it("awaits an asynchronous Client listener and draws its new state", async () => {
  const f = await fixture("success")
  const pane = await f.snapshot()
  await f.press(pane.clients![0])
  expect(text((await f.snapshot()).clients![0].tree)).toBe("Async works")
  expect(f.state.has("faults")).toBe(false)
  expect(f.loads()).toBe(1)
  await expect.poll(() => f.state.get("client-message")).toEqual({ done: true })
})

it("hears a new instance born in the fault redraw without another automatic redraw", async () => {
  const f = await fixture("render", { newKey: true })
  await f.snapshot()
  await expect.poll(() => (f.state.get("faults") as ModObject[] | undefined)?.length).toBe(2)
  expect(await f.drawings()).toBe(2)
  expect(f.loads()).toBe(2)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(await f.drawings()).toBe(2)
})

it("keeps a stopped same-key instance through a parent redraw", async () => {
  const f = await fixture("render", { sameKey: true })
  const initial = await f.snapshot()
  await expect.poll(f.drawings).toBe(2)
  f.session.panes.invalidate()
  const redrawn = await f.snapshot()
  expect(redrawn.clients![0].id).toBe(initial.clients![0].id)
  expect(f.loads()).toBe(1)
  expect((f.state.get("faults") as ModObject[]).length).toBe(1)
})

it.each(["close", "invalidate", "revoke"])(
  "does not apply a delayed fault to a %s drawing",
  async (action) => {
    const f = await fixture("render", { wait: 100 })
    await f.snapshot()
    await expect.poll(() => f.state.get("faults")).toBeDefined()
    if (action === "close") await f.session.panes.closePane("client-board", "client-board")
    else if (action === "invalidate") f.session.panes.invalidate()
    else f.revoke()
    await new Promise((resolve) => setTimeout(resolve, 160))
    if (action !== "revoke") expect(await f.drawings()).toBe(1)
    expect(f.loads()).toBe(1)
    expect(f.guest.stats.frames).toBe(0)
  }
)

it("rejects fault fact rewrites while still recovering the current site", async () => {
  const f = await fixture("run", { forged: true })
  const pane = await f.snapshot()
  await f.press(pane.clients![0]).catch(() => {})
  await expect.poll(async () => text((await f.snapshot()).tree)).toBe("Fallback works")
  expect(f.state.get("rewrite-denied")).toBe("MODS_PINNED_INPUT")
})

it("does not describe host publication denial as a Client module fault", async () => {
  const f = await fixture("success", {}, async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && value.type === "Button")
      throw Error("protection denied")
    return value
  })
  await f.snapshot()
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(f.state.has("faults")).toBe(false)
})

it("does not convert pre-load source refusal into a module-load fault", async () => {
  const f = await fixture("load", { unapproved: true })
  await f.snapshot()
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(f.state.has("faults")).toBe(false)
  expect(await f.drawings()).toBe(1)
})

it("hears concurrent siblings while coalescing their parent recovery", async () => {
  const f = await fixture("render", { siblings: true, wait: 60 })
  await f.snapshot()
  await expect.poll(() => (f.state.get("faults") as ModObject[] | undefined)?.length).toBe(2)
  await expect.poll(async () => text((await f.snapshot()).tree)).toBe("Fallback works")
  expect(await f.drawings()).toBe(2)
  expect(f.loads()).toBe(2)
})

it("does not apply a fault to a replacement Pane object with the same address", async () => {
  const f = await fixture("render", { wait: 100 })
  await f.snapshot()
  await expect.poll(() => f.state.get("faults")).toBeDefined()
  f.session.panes.open("client-board", { id: "client-board", title: "Replacement" })
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(await f.drawings()).toBe(1)
})

it("checks the exact drawing again after asynchronous reason protection", async () => {
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const f = await fixture("render", {}, async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "reason" in value) {
      entered()
      await waiting
    }
    return value
  })
  await f.snapshot()
  await started
  f.session.panes.invalidate()
  release()
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(f.state.has("faults")).toBe(false)
  expect(await f.drawings()).toBe(1)
  expect(f.guest.stats.frames).toBe(0)
})

it("does not publish the raw reason after protection refuses it", async () => {
  const f = await fixture("render", {}, async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "reason" in value)
      throw Error("denied")
    return value
  })
  await f.snapshot()
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(await f.drawings()).toBe(1)
  expect(f.state.has("faults")).toBe(false)
  expect(f.loads()).toBe(1)
})

it("normalizes a protected replacement reason before fixing the notification baseline", async () => {
  const f = await fixture("render", {}, async (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && "reason" in value)
      return { reason: "FILTERED\n\u0000" + "z".repeat(300) }
    return value
  })
  await f.snapshot()
  await expect.poll(() => f.state.get("faults")).toBeDefined()
  const reason = (f.state.get("faults") as ModObject[])[0].reason as string
  expect(reason.startsWith("FILTERED ")).toBe(true)
  expect(reason.length).toBe(200)
  expect(reason.endsWith("…")).toBe(true)
  // eslint-disable-next-line no-control-regex -- Protection output must still reject controls.
  expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
})

it("keeps asynchronous drawing outside the supported listener contract", async () => {
  const f = await fixture("render", {
    surface: `var __cmbSurfaceMod={async default(_,s){return s.elements.Text({children:"invalid"})}}`
  })
  await f.snapshot()
  await expect.poll(() => f.state.get("faults")).toBeDefined()
  expect((f.state.get("faults") as ModObject[])[0].phase).toBe("render")
})

it.each(["invalidate", "replace"])(
  "fences late SDK writes after the fault receipt %s",
  async (action) => {
    const f = await fixture("render", { wait: 100, late: "store" })
    await f.snapshot()
    await expect.poll(() => f.state.get("faults")).toBeDefined()
    if (action === "invalidate") f.session.panes.invalidate()
    else f.session.panes.open("client-board", { id: "client-board" })
    await new Promise((resolve) => setTimeout(resolve, 160))
    expect(f.state.has("late-effect")).toBe(false)
    expect(f.guest.stats.frames).toBe(0)
  }
)

it("does not let an old fault handler close the replacement Pane", async () => {
  const f = await fixture("render", { wait: 100, late: "close" })
  await f.snapshot()
  await expect.poll(() => f.state.get("faults")).toBeDefined()
  f.session.panes.open("client-board", { id: "client-board", title: "Replacement" })
  await new Promise((resolve) => setTimeout(resolve, 160))
  const panes = await f.session.panes.snapshot()
  expect(panes).toHaveLength(1)
  expect(panes[0].title).toBe("Replacement")
})

it("keeps a healthy Client when the native VM refuses an unentered frame", async () => {
  const f = await fixture("run", {
    surface: `var __cmbSurfaceMod={default(_,s){return s.elements.Button({key:"fail",label:"Busy",onPress:()=>new Promise(()=>{})})}}`
  })
  const pane = await f.snapshot()
  const client = pane.clients![0]
  const controller = new AbortController()
  const guest = f.guests[0]
  const pending = Array.from({ length: 32 }, () =>
    guest
      .invoke(
        "0",
        {
          kind: "control",
          handle: ordinaryFunctionNode(client.tree).press!.handle,
          callback: "onPress",
          event: { element: "fail" }
        },
        async () => ({}),
        {
          event: "surface.update",
          signal: controller.signal,
          origin: { plugin: "engine", tier: "core" },
          capabilities: [],
          plugin: { name: "client-board", root: "" }
        }
      )
      .catch(() => {})
  )
  await expect.poll(() => guest.stats.frames).toBe(32)
  await expect(f.press(client)).rejects.toThrow("MODS_FRAME_LIMIT")
  expect((await f.snapshot()).clients![0].error).toBeUndefined()
  expect(f.state.has("faults")).toBe(false)
  controller.abort()
  await Promise.all(pending)
  expect(guest.stats.frames).toBe(0)
})

it("still reports an actual module throwing a transport-like code", async () => {
  const f = await fixture("run", {
    surface: `var __cmbSurfaceMod={default(_,s){return s.elements.Button({key:"fail",label:"Throw",onPress(){throw Object.assign(Error("transport-like"),{code:"MODS_HOST_CAPACITY",__downstream:true})}})}}`
  })
  const pane = await f.snapshot()
  await f.press(pane.clients![0]).catch(() => {})
  await expect.poll(() => f.state.get("faults")).toBeDefined()
  expect((f.state.get("faults") as ModObject[])[0].phase).toBe("run")
})

it.each(["initial", "parent"] as const)(
  "keeps a %s draw admission refusal retryable on the next native snapshot",
  async (nativeRefusal) => {
    const f = await fixture("success", { nativeRefusal })
    const initial = await f.snapshot()
    if (nativeRefusal === "parent") {
      f.session.panes.invalidate()
      await f.snapshot()
    }
    const recovered = await f.snapshot()
    expect(recovered.clients![0].id).toBe(initial.clients![0].id)
    expect(recovered.clients![0].error).toBeUndefined()
    await f.press(recovered.clients![0])
    expect(text((await f.snapshot()).clients![0].tree)).toBe("Async works")
    expect(f.state.has("faults")).toBe(false)
    expect(f.loads()).toBe(1)
  }
)

it("keeps the next real Client tick alive after a native admission refusal", async () => {
  const f = await fixture("success", {
    nativeRefusal: "tick",
    surface: `var __cmbSurfaceMod={default(_,s){
    if(s.state===undefined){s.setState(0);s.every(40,()=>s.setState(s.state+1))}
    return s.elements.Text({children:"Ticks:"+s.state})
  }}`
  })
  const initial = await f.snapshot()
  await expect.poll(async () => text((await f.snapshot()).clients![0].tree)).toMatch(/Ticks:[1-9]/)
  expect((await f.snapshot()).clients![0].id).toBe(initial.clients![0].id)
  expect(f.state.has("faults")).toBe(false)
  expect(f.loads()).toBe(1)
})

it("preserves one completed listener post across a refused draw without replaying the listener", async () => {
  const f = await fixture("success", { nativeRefusal: "parent", surface: `var __cmbSurfaceMod={default(_,s){
    return s.elements.Button({key:"fail",label:"Count:"+(s.state||0),onPress:async()=>{
      await Promise.resolve();s.setState((s.state||0)+1);s.post({count:s.state})
    }})
  }}` })
  const initial = await f.snapshot()
  await expect(f.press(initial.clients![0])).rejects.toThrow("native admission refused")
  const recovered = await f.snapshot()
  expect(recovered.clients![0].id).toBe(initial.clients![0].id)
  expect(ordinaryFunctionNode(recovered.clients![0].tree).props.label).toBe("Count:1")
  await expect.poll(() => f.state.get("client-message")).toEqual({ count: 1 })
  expect(ordinaryFunctionNode((await f.snapshot()).clients![0].tree).props.label).toBe("Count:1")
  expect(f.clientMessageWrites()).toBe(1)
  expect(f.state.has("faults")).toBe(false)
  expect(f.loads()).toBe(1)
})

it("retains accepted parent message props when only a refused draw needs retrying", async () => {
  const f = await fixture("success", {
    nativeRefusal: "message",
    surface: `var __cmbSurfaceMod={default(props,s){
      return s.elements.Button({key:"fail",label:props.label||"Original",onPress(){s.post({count:1})}})
    }}`
  })
  const initial = await f.snapshot()
  await f.press(initial.clients![0])
  await expect.poll(() => f.refusals()).toBe(1)
  const recovered = await f.snapshot()
  expect(recovered.clients![0].id).toBe(initial.clients![0].id)
  expect(ordinaryFunctionNode(recovered.clients![0].tree).props.label).toBe("Acknowledged")
  expect(ordinaryFunctionNode((await f.snapshot()).clients![0].tree).props.label).toBe("Acknowledged")
  expect(f.clientMessageWrites()).toBe(1)
  expect(f.state.has("faults")).toBe(false)
  expect(f.loads()).toBe(1)
})

it("measures actual local listener-plus-draw cost without model or IPC claims", async () => {
  const samples: Record<string, number[]> = {}
  for (const asynchronous of [false, true]) {
    const f = await fixture("success", {
      surface: `var __cmbSurfaceMod={default(_,s){
      return s.elements.Button({key:"fail",label:"Count:"+(s.state||0),onPress:${asynchronous ? "async" : ""}()=>{${asynchronous ? "await Promise.resolve();" : ""}s.setState((s.state||0)+1)}})
    }}`
    })
    let client = (await f.snapshot()).clients![0]
    const values: number[] = []
    for (let index = 0; index < 24; index++) {
      const started = performance.now()
      await f.press(client)
      if (index >= 4) values.push(performance.now() - started)
      client = (await f.snapshot()).clients![0]
    }
    expect(ordinaryFunctionNode(client.tree).props.label).toBe("Count:24")
    expect(f.state.has("faults")).toBe(false)
    samples[asynchronous ? "async" : "sync"] = values.sort((a, b) => a - b)
    await f.session.close()
    expect(
      f.guests.every(
        (guest) => guest.stats.disposed && guest.stats.frames === 0 && guest.stats.replies === 0
      )
    ).toBe(true)
  }
  const summary = Object.fromEntries(
    Object.entries(samples).map(([kind, values]) => [
      kind,
      {
        samples: values.length,
        medianMs: values[Math.floor(values.length / 2)],
        p95Ms: values[Math.ceil(values.length * 0.95) - 1]
      }
    ])
  )
  mkdirSync(resolve("output"), { recursive: true })
  writeFileSync(
    resolve("output/mods-client-fault-performance.json"),
    JSON.stringify(
      {
        scope:
          "Actual local QuickJS Client listener and synchronous draw, 24 actions each with first four excluded; no utility IPC, renderer paint, model or network claim",
        summary
      },
      null,
      2
    )
  )
})
