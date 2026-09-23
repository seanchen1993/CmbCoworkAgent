import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import type {
  FunctionPaneSnapshot,
  FunctionUiAction,
  FunctionUiElement
} from "../../../shared/mods/v2/ui"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"
import { compileFunctionPlugin } from "./loader"

const sessions: FunctionSession[] = []
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()))
})
async function fixture(
  hooks: string,
  compiled?: { code: string; name: string; root: string },
  publish = async (value: ModJson): Promise<ModJson> => value,
  changed = () => {}
) {
  let live = true
  const state = new Map<string, ModJson>()
  const guest = await FunctionGuestRuntime.create(
    compiled?.code ?? `var __cmbFunctionMod={register(on){${hooks}}}`
  )
  const session = new FunctionSession(
    [
      {
        name: compiled?.name ?? "sites",
        root: compiled?.root ?? "/sites",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      uiChanged: changed,
      publish,
      assertLive() {
        if (!live) throw Error("revoked")
      },
      state: () => ({
        get: async (key) => state.get(key),
        keys: async () => [...state.keys()],
        set: async (key, value) => {
          state.set(key, value)
        },
        delete: (key) => {
          state.delete(key)
        }
      })
    }
  )
  sessions.push(session)
  await session.start()
  return {
    session,
    state,
    revoke() {
      live = false
    }
  }
}
const hint = { isDraft: false, isWorking: false, hint: "Enter to send" }
function button(tree: FunctionUiElement): FunctionUiElement {
  if (tree.type === "Button") return tree
  for (const node of tree.children ?? []) {
    if (typeof node !== "string") {
      try {
        return button(node)
      } catch {
        /* Continue through sibling controls. */
      }
    }
  }
  throw Error("button missing")
}
function press(pane: FunctionPaneSnapshot): FunctionUiAction {
  const node = button(pane.tree)
  return {
    pane: pane.key,
    generation: pane.generation,
    intentId: randomUUID(),
    plugin: node.press!.plugin,
    handle: node.press!.handle,
    kind: "press"
  }
}

function drawnText(tree: FunctionUiElement | string): string {
  return typeof tree === "string" ? tree : (tree.children ?? []).map(drawnText).join("")
}

it("does not broadcast host-driven site mounting, rendering and unmounting back to every renderer owner", async () => {
  const changed = vi.fn()
  const { session } = await fixture("", undefined, async (v) => v, changed)
  const owners = await Promise.all(
    Array.from({ length: 20 }, () => session.sites.mount("AssistantMessage"))
  )
  for (const owner of owners)
    await session.sites.render(owner, { text: "message", isFirstOfReply: true })
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(changed).not.toHaveBeenCalled()
  for (const owner of owners) await session.sites.unmount(owner)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(changed).not.toHaveBeenCalled()
})

it("rewrites CommandOutput presentation while retaining command identity and error facts", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"CommandOutput"},($,e,next)=>
      next({...e,props:{...e.props,text:"visible:"+e.props.text}}))
  `)
  const owner = await session.sites.mount("CommandOutput" as FunctionUiSite)
  const facts = { command: "echo", args: "***", text: "original", isErrored: false }
  expect(drawnText((await session.sites.render(owner, facts)).tree)).toBe("visible:original")
  expect(facts.text).toBe("original")
  const second = await session.sites.mount("CommandOutput" as FunctionUiSite)
  await session.sites.render(second, { ...facts, text: "second" })
  expect(drawnText((await session.sites.render(owner, facts)).tree)).toBe("visible:original")
})

it.each(["command", "args", "isErrored", "onScreen"])(
  "rejects forged CommandOutput %s facts",
  async (field) => {
    const { session } = await fixture(`
    on("ui.render",{component:"CommandOutput"},($,e,next)=>
      next({...e,props:{...e.props,text:"forged",${field}:${field === "isErrored" ? "false" : '"forged"'}}}))
  `)
    const owner = await session.sites.mount("CommandOutput" as FunctionUiSite)
    expect(
      (
        await session.sites.render(owner, {
          command: "echo",
          args: "***",
          text: "error",
          isErrored: true
        })
      ).nativeFallback
    ).toBe(true)
  }
)

it("redraws cached message owners when the installed message fixture changes preference", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/message-sites"))
  const { session } = await fixture("", compiled)
  const owner = await session.sites.mount("AssistantMessage")
  const facts = { text: "original", isFirstOfReply: true }
  expect((await session.sites.render(owner, facts)).nativeFallback).toBe(true)
  await session.run("message-style", "custom")
  const custom = await session.sites.render(owner, facts)
  expect(drawnText(custom.tree)).toBe("DISPLAY_ONLY_AssistantMessage: original")
  await session.run("message-style", "native")
  expect((await session.sites.render(owner, facts)).nativeFallback).toBe(true)
})

it("keeps the host-owned assistant header when a guest tries to rewrite first-of-reply", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"AssistantMessage"},($,e,next)=>
      next({...e,props:{...e.props,text:"forged",isFirstOfReply:false}}))
  `)
  const owner = await session.sites.mount("AssistantMessage")
  expect(
    (
      await session.sites.render(owner, {
        text: "original",
        isFirstOfReply: true
      })
    ).nativeFallback
  ).toBe(true)
})

it.each(["UserMessage", "AssistantMessage"])(
  "renders multiple %s text owners without changing the source facts",
  async (name) => {
    const component = name as FunctionUiSite
    const { session } = await fixture(`
    on("ui.render", {component:"${name}"}, async ($,e,next) => {
      return next({...e,props:{...e.props,text:"visible:"+e.props.text}})
    })
  `)
    const first = await session.sites.mount(component)
    const second = await session.sites.mount(component)
    const facts: ModObject =
      name === "UserMessage"
        ? { text: "original", origin: { kind: "unclassified" }, isExpanded: true }
        : { text: "original", isFirstOfReply: true }
    const before = JSON.stringify(facts)
    expect(drawnText((await session.sites.render(first, facts)).tree)).toBe("visible:original")
    expect(drawnText((await session.sites.render(second, { ...facts, text: "second" })).tree)).toBe(
      "visible:second"
    )
    expect(JSON.stringify(facts)).toBe(before)
    await session.sites.unmount(first)
    expect(
      drawnText((await session.sites.render(second, { ...facts, text: "updated" })).tree)
    ).toBe("visible:updated")
    await expect(session.sites.render(first, facts)).rejects.toThrow("MODS_UI_SITE_CLOSED")
  }
)

it.each(["origin", "isExpanded", "onScreen"])(
  "rejects forged UserMessage %s facts in a real guest",
  async (field) => {
    const { session } = await fixture(`
    on("ui.render",{component:"UserMessage"},async($,e,next)=>{
      const props={...e.props,text:"forged"}; props["${field}"]=${field === "origin" ? '{kind:"composer"}' : field === "isExpanded" ? "false" : "null"};
      return next({...e,props})
    })
  `)
    const owner = await session.sites.mount("UserMessage" as FunctionUiSite)
    const result = await session.sites.render(owner, {
      text: "original",
      origin: { kind: "unclassified" },
      isExpanded: true
    })
    expect(drawnText(result.tree)).toBe("original")
    expect(result.nativeFallback).toBe(true)
  }
)

it("bounds message owners and rejects oversized text without truncating it into a false complete row", async () => {
  const { session } = await fixture("")
  const component = "AssistantMessage" as FunctionUiSite
  const owners: string[] = []
  for (let index = 0; index < 32; index++) owners.push(await session.sites.mount(component))
  await expect(session.sites.mount(component)).rejects.toThrow("MODS_UI_SITE_LIMIT")
  await expect(
    session.sites.render(owners[0], { text: "x".repeat(10001), isFirstOfReply: true })
  ).rejects.toThrow("MODS_UI_SITE_PROPS")
  await session.sites.unmount(owners[0])
  expect(await session.sites.mount(component)).not.toBe(owners[0])
})

it("draws default content through next, preserves read-only site props and caches unchanged draws", async () => {
  const { session } = await fixture(`
    let draws=0;
    on("ui.render",{component:"PromptHint"},($,e,next)=>{
      draws++; return next({...e,props:{...e.props,hint:e.props.hint+":"+draws}})
    });
    on("ui.render",{component:"InfoNotice"},($,e,next)=>next({...e,props:{...e.props,text:"notice rewritten"}}));
  `)
  const owner = await session.sites.mount("PromptHint")
  const first = await session.sites.render(owner, hint)
  expect(JSON.stringify(first.tree)).toContain("Enter to send:1")
  expect((await session.sites.render(owner, hint)).generation).toBe(first.generation)
  for (let index = 0; index < 100; index++) {
    const cached = await session.sites.render(owner, hint)
    expect(cached.generation).toBe(first.generation)
    expect(drawnText(cached.tree)).toBe("Enter to send:1")
  }
  const notice = await session.sites.mount("InfoNotice")
  expect(
    JSON.stringify(
      (await session.sites.render(notice, { text: "model source", command: "/model" })).tree
    )
  ).toContain("notice rewritten /model")
})

it("invokes only drawn plugin callbacks once, invalidates old generations and keeps the site in events", async () => {
  const { session } = await fixture(`
    let count=0;
    on("ui.render",{component:"AbovePrompt"},($,e)=>{
      const {Box,Text,Button}=$.ui.resolve(e);
      return Box({children:[Text({children:"count:"+count}),Button({key:"increment",label:"Increment",onPress(){count++;$.ui.invalidate("ui.render")}})]})
    });
    on("ui.press",($,e,next)=>{if(e.component!=="AbovePrompt")throw Error("wrong site");return next(e)});
  `)
  const owner = await session.sites.mount("AbovePrompt")
  const first = await session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8 })
  const action = press(first)
  await session.sites.act(owner, action)
  await session.sites.act(owner, action)
  const fresh = await session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8 })
  expect(JSON.stringify(fresh.tree)).toContain("count:1")
  await expect(session.sites.act(owner, { ...action, intentId: randomUUID() })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  await expect(session.sites.act(owner, { ...press(fresh), plugin: "forged" })).rejects.toThrow(
    "MODS_UI_STALE_ACTION"
  )
  await session.sites.unmount(owner)
  await expect(session.sites.act(owner, press(fresh))).rejects.toThrow("MODS_UI_SITE_CLOSED")
})

it("rejects replaced owners and revoked sessions, and explicitly rejects Client trees", async () => {
  const { session, revoke } = await fixture(`
    on("ui.render",{component:"AbovePrompt"},($,e)=>$.ui.resolve(e).Client({key:"local",module:"surface.tsx",props:{}}));
  `)
  const previous = await session.sites.mount("PromptHint")
  const current = await session.sites.mount("PromptHint")
  await expect(session.sites.render(previous, hint)).rejects.toThrow("MODS_UI_SITE_CLOSED")
  const owner = await session.sites.mount("AbovePrompt")
  await expect(
    session.sites.render(owner, { isWorking: false, bodyColumns: 80, maxRows: 8 })
  ).rejects.toThrow("MODS_UI_SITE_CLIENT_UNSUPPORTED")
  revoke()
  await expect(session.sites.render(current, hint)).rejects.toThrow("revoked")
})

it("refuses rewritten host facts while allowing hint rewrites", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"PromptHint"},($,e,next)=>next({...e,props:{...e.props,isWorking:true,hint:"forged"}}));
  `)
  const owner = await session.sites.mount("PromptHint")
  expect(JSON.stringify((await session.sites.render(owner, hint)).tree)).toContain("Enter to send")
  expect(JSON.stringify((await session.sites.render(owner, hint)).tree)).not.toContain("forged")
})

it("rejects malformed mutable site props and keeps the original host text", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"PromptHint"},($,e,next)=>next({...e,props:{...e.props,hint:123}}));
    on("ui.render",{component:"InfoNotice"},($,e,next)=>next({...e,props:{...e.props,command:{forged:true}}}));
  `)
  const owner = await session.sites.mount("PromptHint")
  expect(drawnText((await session.sites.render(owner, hint)).tree)).toBe("Enter to send")
  const notice = await session.sites.mount("InfoNotice")
  expect(
    drawnText((await session.sites.render(notice, { text: "Actual notice", command: null })).tree)
  ).toBe("Actual notice")
})

it("rejects a forged render component before allocating constructors", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"PromptHint"},($,e)=>{
      try { return $.ui.resolve({...e,component:"Pane"}).Text({children:"forged component"}) }
      catch { return $.ui.resolve(e).Text({children:"component refused"}) }
    });
  `)
  const owner = await session.sites.mount("PromptHint")
  expect(JSON.stringify((await session.sites.render(owner, hint)).tree)).toContain(
    "component refused"
  )
})

it("aborts an in-flight action on unmount and prevents its deferred write", async () => {
  const { session, state } = await fixture(`
    on("ui.render",{component:"PromptHint"},($,e)=>$.ui.resolve(e).Button({
      key:"wait",label:"Wait",async onPress(){await $.store.set("entered",true);await $.clock.sleep(200);await $.store.set("completed",true)}
    }));
  `)
  const owner = await session.sites.mount("PromptHint")
  const drawing = await session.sites.render(owner, hint)
  const action = session.sites.act(owner, press(drawing))
  const rejected = expect(action).rejects.toThrow()
  await expect.poll(() => state.get("entered")).toBe(true)
  await session.sites.unmount(owner)
  await rejected
  await new Promise((resolve) => setTimeout(resolve, 220))
  expect(state.has("completed")).toBe(false)
})

it("routes AbovePrompt focus to the first autoFocus and scroll through the proper site", async () => {
  const { session, state } = await fixture(`
    on("ui.render",{component:"AbovePrompt"},($,e)=>$.ui.resolve(e).Button({key:"first",label:"Focus",autoFocus:true,onPress(){}}));
    on("ui.focus",async($,e,next)=>{await $.store.set("focus",e.component);return next(e)});
    on("ui.scroll",async($,e,next)=>{await $.store.set("scroll",e.component);return next(e)});
  `)
  const owner = await session.sites.mount("AbovePrompt")
  const drawing = await session.sites.render(owner, {
    isWorking: false,
    bodyColumns: 80,
    maxRows: 8
  })
  const act = { ...press(drawing), plugin: "engine", handle: 0 }
  expect(
    await session.sites.act(owner, { ...act, kind: "focus", value: { focused: true } })
  ).toEqual({ focused: true, target: { plugin: "sites", element: "first" } })
  await session.sites.act(owner, {
    ...act,
    intentId: randomUUID(),
    kind: "scroll",
    value: { deltaX: 0, deltaY: 10, top: 0, left: 0 }
  })
  expect(state.get("focus")).toBe("AbovePrompt")
  expect(state.get("scroll")).toBe("AbovePrompt")
})

it("loads the installation fixture and runs its real AbovePrompt controls, hint rewrite and notice", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/site-board"))
  const { session } = await fixture("", compiled)
  const owner = await session.sites.mount("AbovePrompt")
  const props = { isWorking: false, bodyColumns: 80, maxRows: 8 }
  const drawing = await session.sites.render(owner, props)
  expect(drawnText(drawing.tree)).toContain("SITE_ABOVE count:0")
  await session.sites.act(owner, press(drawing))
  expect(drawnText((await session.sites.render(owner, props)).tree)).toContain("SITE_ABOVE count:1")
  const hintOwner = await session.sites.mount("PromptHint")
  expect(JSON.stringify((await session.sites.render(hintOwner, hint)).tree)).toContain("SITE_HINT")
  const noticeOwner = await session.sites.mount("InfoNotice")
  expect(
    JSON.stringify(
      (await session.sites.render(noticeOwner, { text: "SITE_HOST_BLOCK", command: null })).tree
    )
  ).toContain("SITE_NOTICE SITE_HOST_BLOCK")
})

it("preserves native rich status UI through unrelated and pass-through guest hooks", async () => {
  const { session } = await fixture(`on("ui.render",($,e,next)=>next(e));`)
  for (const [component, props] of [
    ["Spinner", { word: "Working", message: null, suffix: "…", mode: "requesting" }],
    ["TurnDuration", { word: "Took", durationMs: 2400 }],
    ["SessionMode", { modes: ["Solo"] }]
  ] as Array<[FunctionUiSite, ModObject]>) {
    const owner = await session.sites.mount(component)
    const drawing = await session.sites.render(owner, { ...props })
    expect(drawing.nativeFallback).toBe(true)
  }
})

it("renders validated status rewrites while preserving renderer-owned viewport facts", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"Spinner"},($,e,next)=>next({...e,props:{...e.props,word:"Baking",suffix:" ~"}}));
    on("ui.render",{component:"TurnDuration"},($,e,next)=>next({...e,props:{...e.props,word:"Baked",durationMs:6000}}));
    on("ui.render",{component:"SessionMode"},($,e,next)=>next({...e,props:{modes:[...e.props.modes,"Review"]}}));
  `)
  const spinner = await session.sites.mount("Spinner")
  const spin = await session.sites.render(spinner, {
    word: "Working",
    message: null,
    suffix: "…",
    mode: "requesting"
  })
  expect(drawnText(spin.tree)).toBe("Baking ~")
  expect(spin.nativeFallback).toBe(false)
  const duration = await session.sites.mount("TurnDuration")
  expect(
    drawnText((await session.sites.render(duration, { word: "Took", durationMs: 2000 })).tree)
  ).toBe("Baked 6s")
  const mode = await session.sites.mount("SessionMode")
  expect(drawnText((await session.sites.render(mode, { modes: ["Solo"] })).tree)).toBe(
    "Solo & Review"
  )
})

it("keeps independently mounted duration callbacks alive and refuses cross-owner/stale actions", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"TurnDuration"},($,e)=>$.ui.resolve(e).Button({key:"duration",label:e.props.word,onPress(){}}));
  `)
  const one = await session.sites.mount("TurnDuration")
  const first = await session.sites.render(one, { word: "First", durationMs: 1000 })
  const two = await session.sites.mount("TurnDuration")
  const second = await session.sites.render(two, { word: "Second", durationMs: 2000 })
  await session.sites.act(one, press(first))
  await session.sites.act(two, press(second))
  await expect(session.sites.act(two, press(first))).rejects.toThrow("MODS_UI_ACTION_INVALID")
  await session.sites.unmount(one)
  await expect(session.sites.act(one, press(first))).rejects.toThrow("MODS_UI_SITE_CLOSED")
  expect((await session.sites.render(two, { word: "Second", durationMs: 2000 })).generation).toBe(
    second.generation
  )
  const recycled = await session.sites.mount("TurnDuration")
  await session.sites.render(recycled, { word: "First", durationMs: 1000 })
  await expect(session.sites.act(recycled, press(first))).rejects.toThrow("MODS_UI_ACTION_INVALID")
})

it("bounds duration owners without evicting visible messages and frees capacity on unmount", async () => {
  const { session } = await fixture("")
  const owners: string[] = []
  for (let index = 0; index < 32; index++) {
    const owner = await session.sites.mount("TurnDuration")
    owners.push(owner)
    await session.sites.render(owner, { word: "Took", durationMs: index + 1 })
  }
  await expect(session.sites.mount("TurnDuration")).rejects.toThrow("MODS_UI_SITE_LIMIT")
  const spinner = await session.sites.mount("Spinner")
  await session.sites.render(spinner, {
    word: "Working",
    message: null,
    suffix: "…",
    mode: "requesting"
  })
  expect(
    (await session.sites.render(owners[0], { word: "Took", durationMs: 1 })).nativeFallback
  ).toBe(true)
  await session.sites.unmount(owners[0])
  expect(await session.sites.mount("TurnDuration")).toBeTypeOf("string")
})

it("rejects malformed status props and forged onScreen facts instead of publishing rewrites", async () => {
  const { session } = await fixture(`
    on("ui.render",{component:"Spinner"},($,e,next)=>next({...e,props:{...e.props,mode:"invented"}}));
    on("ui.render",{component:"TurnDuration"},($,e,next)=>next({...e,props:{...e.props,onScreen:{start:0,end:1},word:"forged"}}));
    on("ui.render",{component:"SessionMode"},($,e,next)=>next({...e,props:{modes:[{forged:true}]}}));
  `)
  for (const [component, props] of [
    ["Spinner", { word: "Working", message: null, suffix: "…", mode: "requesting" }],
    ["TurnDuration", { word: "Took", durationMs: 2000 }],
    ["SessionMode", { modes: ["Solo"] }]
  ] as Array<[FunctionUiSite, ModObject]>) {
    const owner = await session.sites.mount(component)
    const result = await session.sites.render(owner, { ...props })
    expect(result.nativeFallback).toBe(true)
    expect(JSON.stringify(result.tree)).not.toContain("forged")
  }
})

it("derives native fallback after publication and refuses plugin assertions of native ownership", async () => {
  const { session } = await fixture(
    `
    on("ui.render",{component:"SessionMode"},($,e)=>$.ui.resolve(e).Text({children:"custom label"}));
  `,
    undefined,
    async (value) =>
      Array.isArray(value)
        ? value.map((entry) =>
            typeof entry === "object" && entry !== null && !Array.isArray(entry)
              ? { ...entry, nativeFallback: true }
              : entry
          )
        : value
  )
  const owner = await session.sites.mount("SessionMode")
  const drawing = await session.sites.render(owner, { modes: ["Solo"] })
  expect(drawing.nativeFallback).toBe(false)
  expect(drawnText(drawing.tree)).toBe("custom label")
})

it("runs the installed status fixture across native, custom and restored drawings", async () => {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/status-sites"))
  const { session } = await fixture("", compiled)
  const owner = await session.sites.mount("SessionMode")
  expect((await session.sites.render(owner, { modes: ["Solo"] })).nativeFallback).toBe(true)
  expect(await session.run("status-sites-style", "custom")).toEqual({ text: '{"custom":true}' })
  const custom = await session.sites.render(owner, { modes: ["Solo"] })
  expect(custom.nativeFallback).toBe(false)
  expect(drawnText(custom.tree)).toBe("STATUS_MODE & Solo")
  const spinner = await session.sites.mount("Spinner")
  expect(
    drawnText(
      (
        await session.sites.render(spinner, {
          word: "Working",
          message: null,
          suffix: "",
          mode: "requesting"
        })
      ).tree
    )
  ).toBe("STATUS_SPINNER ~")
  const duration = await session.sites.mount("TurnDuration")
  expect(
    drawnText((await session.sites.render(duration, { word: "Took", durationMs: 2000 })).tree)
  ).toBe("STATUS_DURATION 2s")
  await session.run("status-sites-style", "native")
  expect((await session.sites.render(owner, { modes: ["Solo"] })).nativeFallback).toBe(true)
})

it("cancels only the recycled duration owner while keeping another visible row actionable", async () => {
  const { session, state } = await fixture(`
    on("ui.render",{component:"TurnDuration"},($,e)=>$.ui.resolve(e).Button({key:"row",label:e.props.word,async onPress(){
      await $.store.set("entered:"+e.props.word,true);
      await $.clock.sleep(150);
      await $.store.set("completed:"+e.props.word,true)
    }}));
  `)
  const stale = await session.sites.mount("TurnDuration")
  const visible = await session.sites.mount("TurnDuration")
  const first = await session.sites.render(stale, { word: "old", durationMs: 1000 })
  const second = await session.sites.render(visible, { word: "live", durationMs: 2000 })
  const pending = session.sites.act(stale, press(first))
  const rejected = expect(pending).rejects.toThrow()
  await expect.poll(() => state.get("entered:old")).toBe(true)
  await session.sites.unmount(stale)
  await rejected
  await session.sites.act(visible, press(second))
  expect(state.get("completed:live")).toBe(true)
  expect(state.has("completed:old")).toBe(false)
})
