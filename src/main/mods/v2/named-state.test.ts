import { afterEach, describe, expect, it } from "vitest"
import { FunctionNamedState, namedStateInput } from "./named-state"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { randomUUID } from "node:crypto"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionPlugin } from "./dispatcher"
import { ordinaryFunctionNode } from "../../../../tests/support/function-ui-node"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})

async function fixture(
  code: string,
  extra = "",
  state?: FunctionNamedState,
  publish: (value: ModJson) => Promise<ModJson> = async (value) => value
) {
  const plugins: FunctionPlugin[] = []
  for (const [name, body] of [
    ["counter", code],
    ["observer", extra]
  ]) {
    if (!body) continue
    const setup =
      name === "counter"
        ? `on("session.start",async($,e,next)=>{
      await $.command.register({name:"increment",description:"Increment"});
      await $.command.register({name:"foreign",description:"Foreign"});return next(e)});`
        : ""
    const guest = await FunctionGuestRuntime.create(
      `var __cmbFunctionMod={register(on){${setup}${body}}}`
    )
    plugins.push({
      name,
      root: "/plugin",
      tier: "user",
      guest,
      capabilities: [...SESSION_CAPABILITIES]
    })
  }
  let live = true
  const session = new FunctionSession(plugins, {
    workspace: "/project",
    threadId: "state-test",
    namedState: state,
    publish,
    assertLive() {
      if (!live) throw Error("revoked")
    }
  })
  sessions.push(session)
  return {
    session,
    revoke: () => {
      live = false
    }
  }
}

const ref = { plugin: "counter", key: "count" }
const command = `on("command.run", async ($) => {
  const ref={plugin:"counter",key:"count"};
  const a=await $.state.get(ref);
  const wrote=await $.state.set(ref,(a.value??0)+1,{ifVersion:a.version});
  const b=await $.state.get(ref);
  return {text:JSON.stringify({a,wrote,b})};
});`

describe("versioned session state", () => {
  it("holds a read snapshot until set or a missed compare-and-set refreshes it", () => {
    const state = new FunctionNamedState()
    const reader = {}
    expect(state.read(ref, reader)).toEqual({ version: 0 })
    state.write({ ...ref, value: 1 }, {})
    expect(state.read(ref, reader)).toEqual({ version: 0 })
    expect(state.write({ ...ref, value: 2, ifVersion: 0 }, reader)).toEqual({
      isSet: false,
      version: 1
    })
    expect(state.read(ref, reader)).toEqual({ value: 1, version: 1 })
    expect(state.write({ ...ref, value: 2, ifVersion: 1 }, reader)).toEqual({
      isSet: true,
      version: 2
    })
    expect(state.read(ref, reader)).toEqual({ value: 2, version: 2 })
  })

  it("notifies only readers, never on missed CAS, and removes released drawings", () => {
    const state = new FunctionNamedState()
    const calls: string[] = []
    state.listen((generation) => calls.push(generation))
    state.read(ref, { drawing: "reader" })
    state.read({ ...ref, key: "other" }, { drawing: "other" })
    state.write({ ...ref, value: 1 }, {})
    state.write({ ...ref, value: 2, ifVersion: 0 }, {})
    expect(calls).toEqual(["reader"])
    state.release("reader")
    state.write({ ...ref, value: 3 }, {})
    expect(calls).toEqual(["reader"])
  })

  it("keeps family addresses distinct and protects values from external mutation", () => {
    const state = new FunctionNamedState()
    state.write({ ...ref, value: { count: 1 } }, {})
    state.write({ ...ref, id: "", value: 2 }, {})
    const read = state.read(ref, {})
    ;(read.value as { count: number }).count = 99
    expect(state.read(ref, {})).toEqual({ value: { count: 1 }, version: 1 })
    expect(state.read({ ...ref, id: "" }, {})).toEqual({ value: 2, version: 1 })
  })

  it("bounds absent-key subscriptions by drawing, total count and bytes, and reclaims on release", () => {
    const state = new FunctionNamedState()
    for (let drawing = 0; drawing < 8; drawing++)
      for (let key = 0; key < 1024; key++)
        state.read({ ...ref, key: String(key) }, { drawing: String(drawing) })
    expect(() => state.read({ ...ref, key: "excess" }, { drawing: "0" })).toThrow(
      "MODS_STATE_SUBSCRIPTION_QUOTA"
    )
    expect(() => state.read(ref, { drawing: "new" })).toThrow("MODS_STATE_SUBSCRIPTION_QUOTA")
    state.release("0")
    expect(() => state.read(ref, { drawing: "new" })).not.toThrow()
    for (let i = 0; i < 8; i++) state.release(String(i))
    state.release("new")
    const key = "x".repeat(4090)
    for (let i = 0; i < 600; i++) state.read({ ...ref, key: key + i }, { drawing: "large" })
    expect(() => {
      for (let i = 0; i < 600; i++) state.read({ ...ref, key: key + i }, { drawing: "large2" })
    }).toThrow("MODS_STATE_SUBSCRIPTION_QUOTA")
    state.release("large")
    state.release("large2")
    expect(() => state.read(ref, { drawing: "fresh" })).not.toThrow()
  })

  it("rejects over-quota writes before mutation or retained-session allocation", () => {
    let retained = 0
    const state = new FunctionNamedState(() => {
      retained++
    })
    const value = "x".repeat(900000)
    for (let i = 0; i < 4; i++) state.write({ ...ref, key: String(i), value }, {})
    expect(() => state.write({ ...ref, value }, {})).toThrow("MODS_STATE_QUOTA")
    expect(state.read(ref, {})).toEqual({ version: 0 })
    expect(retained).toBe(4)
  })

  it("rejects invalid reference and CAS arguments", () => {
    for (const bad of [
      { ...ref, x: 1 },
      { ...ref, key: "" },
      { ...ref, id: "\0" }
    ])
      expect(() => namedStateInput("state.get", [bad])).toThrow("MODS_STATE_REFERENCE")
    for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => namedStateInput("state.set", [ref, 1, { ifVersion: version }])).toThrow(
        "MODS_STATE_VERSION"
      )
  })

  it("runs versioned get/set through the guest and owner checks", async () => {
    const f = await fixture(command)
    expect(JSON.parse((await f.session.run("increment", "")).text as string)).toEqual({
      a: { version: 0 },
      wrote: { isSet: true, version: 1 },
      b: { value: 1, version: 1 }
    })
    expect(JSON.parse((await f.session.run("increment", "")).text as string).b).toEqual({
      value: 2,
      version: 2
    })
  })

  it("allows cross-plugin reads and owner value rewrites but denies foreign writes", async () => {
    const f = await fixture(
      command,
      `
      on("state.set", ($,e,next)=>next({...e,value:e.value*2}));
      on("command.run", {command:"foreign"}, async($)=>{
        const ref={plugin:"counter",key:"count"};
        const read=await $.state.get(ref);
        let denied=false;try{await $.state.set(ref,99)}catch{denied=true}
        return {text:JSON.stringify({read,denied})};
      });`
    )
    expect(JSON.parse((await f.session.run("increment", "")).text as string).b.value).toBe(2)
    // Counter handles all commands, so invoke the observer independently against the same registry.
    const other = await fixture(`on("command.run", async($)=>{let ok=false;
      try { await $.state.set({plugin:"observer",key:"x"},1) } catch { ok=true }
      return {text:String(ok)} })`)
    expect((await other.session.run("foreign", "")).text).toBe("true")
  })

  it("preserves values across runtime recreation and isolates fresh sessions", async () => {
    const state = new FunctionNamedState()
    const first = await fixture(command, "", state)
    await first.session.run("increment", "")
    await first.session.close()
    const reloaded = await fixture(command, "", state)
    expect(JSON.parse((await reloaded.session.run("increment", "")).text as string).b.value).toBe(2)
    const isolated = await fixture(command)
    expect(JSON.parse((await isolated.session.run("increment", "")).text as string).b.value).toBe(1)
  })

  it("does not commit a write revoked during content publication", async () => {
    const state = new FunctionNamedState()
    let revoke = () => {}
    const f = await fixture(command, "", state, async (value) => {
      if (value === 1) revoke()
      return value
    })
    revoke = f.revoke
    await expect(f.session.run("increment", "")).rejects.toThrow("revoked")
    expect(state.read(ref, {})).toEqual({ version: 0 })
  })

  it("pins the owner, key, member, expected version and previous value through hooks", async () => {
    for (const field of ["plugin", "key", "id", "ifVersion", "previous"]) {
      const state = new FunctionNamedState()
      const f = await fixture(
        command,
        `on("state.set",($,e,next)=>next({...e,[${JSON.stringify(field)}]:"changed"}));`,
        state
      )
      await f.session.run("increment", "")
      // Optional hook failure falls through to the original write, never the rewritten identity.
      expect(state.read(ref, {})).toEqual({ value: 1, version: 1 })
    }
  })

  it("automatically redraws a subscribed pane after a button write without invalidate", async () => {
    const f = await fixture(`
      on("command.run",async($)=>{await $.ui.open({id:"counter",title:"Counter"});return {text:"opened"}});
      on("ui.render",{component:"Pane"},async($,e)=>{
        const {Box,Text,Button}=$.ui.resolve(e);
        const ref={plugin:"counter",key:"count"};
        const read=await $.state.get(ref);
        return h(Box,null,h(Text,null,String(read.value??0)),h(Button,{key:"increment",label:"Increment",
          onPress:async()=>{const n=await $.state.get(ref);await $.state.set(ref,(n.value??0)+1)}}));
      });`)
    await f.session.run("increment", "")
    const [before] = await f.session.panes.snapshot()
    expect(JSON.stringify(before.tree)).toContain('"0"')
    const button = ordinaryFunctionNode(before.tree).children!.find(
      (node) => typeof node !== "string" && node.type === "Button"
    )
    if (!button || typeof button === "string" || button.type === "engine" || button.type === "fragment" || !button.press) throw Error("button missing")
    await f.session.panes.act({
      pane: before.key,
      generation: before.generation,
      intentId: randomUUID(),
      plugin: button.press.plugin,
      handle: button.press.handle,
      kind: "press"
    })
    const [after] = await f.session.panes.snapshot()
    expect(after.generation).not.toBe(before.generation)
    expect(JSON.stringify(after.tree)).toContain('"1"')
  })

  it("blocks writes from render and nested operation hooks while allowing reads", async () => {
    const state = new FunctionNamedState()
    const f = await fixture(
      `
      on("command.run",async($)=>{await $.ui.open({id:"counter",title:"Counter"});return {text:"opened"}});
      on("ui.render",{component:"Pane"},async($,e)=>{
        const {Text}=$.ui.resolve(e);
        let direct=false;try{await $.state.set({plugin:"counter",key:"count"},7)}catch{direct=true}
        let nested=false;try{await $.state.get({plugin:"counter",key:"count"})}catch{nested=true}
        return h(Text,null,JSON.stringify({direct,nested}));
      });
      on("state.get",async($,e,next)=>{await $.state.set({plugin:"counter",key:"count"},8);return next(e)});
    `,
      "",
      state
    )
    await f.session.run("increment", "")
    const [pane] = await f.session.panes.snapshot()
    expect(JSON.stringify(pane.tree)).toContain("direct")
    // A failed optional get hook falls through to the original read, but its write never lands.
    expect(ordinaryFunctionNode(pane.tree).children).toEqual(['{"direct":true,"nested":false}'])
    expect(state.read(ref, {})).toEqual({ version: 0 })
  })
})
