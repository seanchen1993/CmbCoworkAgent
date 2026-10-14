import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionMarkdownLinkAction } from "../../../shared/mods/v2/markdown-links"
import type { FunctionPaneSnapshot, FunctionUiElement } from "../../../shared/mods/v2/ui"
import { FunctionGuestRuntime } from "./guest-runtime"
import { withFunctionMarkdownDisplay } from "./markdown-display-scope"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})

const original = "https://original.test/link"
const accepted = "https://accepted.test/link"
const defaultHref = "https://accepted.test/docs"

function markdown(tree: FunctionUiElement): Extract<FunctionUiElement, { type: "Markdown" }> {
  if (tree.type === "Markdown") return tree
  if (tree.type !== "engine") for (const child of tree.children ?? []) {
    if (typeof child !== "string") {
      try { return markdown(child) } catch { /* Search the next real child. */ }
    }
  }
  throw Error("Actual published Markdown missing")
}

/** Actual QuickJS/Session/Panes/publication. Foreign constructor transport is tested separately. */
async function fixture() {
  let alive = true
  let senderAlive = true
  let publicationFailure = false
  let safeText = `[Accepted](${accepted}) [Docs](${defaultHref})\n<context>literal</context>`
  const state = new Map<string, Map<string, ModJson>>()
  const writes: Array<{ plugin: string; key: string; value: ModJson }> = []
  const sources = [
    { name: "P", code: `on("ui.press",async($,e,next)=>{
      const mode=await $.store.get("mode");
      if(!e.link)return mode==="add"?next({...e,link:{href:"${accepted}"}}):next(e);
      if(mode==="remove"){const input={...e};delete input.link;return next(input)}
      return next({...e,link:{href:"callback-business-data"}})
    });` },
    { name: "R", code: `on("ui.press",async($,e,next)=>{
      if(e.link)await $.store.set("observed",e.link);return next(e)
    });` },
    { name: "Q", code: `on("ui.render",($,e)=>{
      const {Box,Markdown,Button}=$.ui.resolve(e);
      return Box({children:[Markdown({key:"md",text:"[Original](${original})",
        pressableLinks:["${original}"],onLinkPress:async(link,event)=>{
          await $.store.set("clicked",{link,event:event.link,plugin:event.plugin,
            element:event.element,requestId:event.requestId,component:event.component});
          await $.store.set("count",(await $.store.get("count")||0)+1)
        }}),Button({key:"button",label:"Original button",onPress:()=>$.store.set("button",1)})]})
    });` }
  ]
  for (const source of sources) state.set(source.name, new Map())
  const plugins = await Promise.all(sources.map(async source => ({
    name: source.name, root: `/actual/${source.name}`, tier: "user" as const,
    capabilities: [...SESSION_CAPABILITIES],
    guest: await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){${source.code}}}`)
  })))
  const check = () => { if (!alive) throw new ModFunctionError("MODS_TEST_REVOKED") }
  const display = { epoch: {}, assertCurrent: () => {
    check()
    if (!senderAlive) throw new ModFunctionError("MODS_TEST_DISPLAY_CLOSED")
  } }
  const protect = (tree: ModJson): ModJson => {
    if (!isModObject(tree)) return tree
    if (tree.type === "Markdown") return { ...tree, props: {
      ...(tree.props as ModObject), text: safeText, pressableLinks: [accepted]
    }, ...(publicationFailure ? { unexpected: true } : {}) }
    return { ...tree, ...(Array.isArray(tree.children)
      ? { children: tree.children.map(protect) } : {}) }
  }
  const session = new FunctionSession(plugins, {
    workspace: "/actual-project", threadId: "actual-thread", assertLive: check,
    async publish(value) {
      if (Array.isArray(value)) return value.map(row => isModObject(row) && row.tree
        ? { ...row, tree: protect(row.tree) } : row)
      return value
    },
    state: plugin => {
      let values = state.get(plugin.name)
      if (!values) { values = new Map(); state.set(plugin.name, values) }
      const current = values
      return {
        get: async key => current.get(key), keys: async () => [...current.keys()],
        async set(key, value) {
          writes.push({ plugin: plugin.name, key, value })
          current.set(key, value)
        },
        delete: key => { current.delete(key) }
      }
    }
  })
  sessions.push(session)
  await session.start()
  session.panes.open("Q", { id: "report", title: "Actual Markdown" })
  const snapshot = async () => {
    const [pane] = await withFunctionMarkdownDisplay(display, () => session.panes.snapshot())
    if (!pane) throw Error("Actual Pane missing")
    return pane
  }
  const action = (pane: FunctionPaneSnapshot, href = accepted): FunctionMarkdownLinkAction => {
    if (pane.markdownLinks?.length !== 1) throw Error("Native protected sidecar missing")
    return { address: { kind: "pane", pane: pane.key, generation: pane.generation },
      nonce: pane.markdownLinks[0].nonce, href, intentId: randomUUID() }
  }
  const sender = () => display.assertCurrent()
  const opener = vi.fn(async () => ({ state: "opened" as const }))
  const click = (input: FunctionMarkdownLinkAction) => session.markdownLinks.invoke(
    input, sender, opener, run => session.nativeMarkdownCallback(sender, run))
  return { session, state, writes, snapshot, action, click, opener,
    failPublication(value: boolean) { publicationFailure = value },
    changeSafeText(value: string) { safeText = value },
    closeDisplay() { senderAlive = false }, revoke() { alive = false }
  }
}

describe("actual Markdown Session and native Panes", () => {
  it("admits only final protected targets/list and keeps P/R/Q SDK namespaces separate", async () => {
    const f = await fixture()
    const pane = await f.snapshot()
    expect(markdown(pane.tree).props).toMatchObject({
      text: `[Accepted](${accepted}) [Docs](${defaultHref})\n<context>literal</context>`,
      pressableLinks: [accepted]
    })
    expect(() => f.click(f.action(pane, original))).toThrow("MODS_UI_MARKDOWN_STALE")
    await expect(f.click(f.action(pane))).resolves.toEqual({ state: "handled" })
    expect(f.state.get("R")?.get("observed")).toEqual({ href: "callback-business-data" })
    expect(f.state.get("Q")?.get("clicked")).toEqual({
      link: { href: "callback-business-data" }, event: { href: "callback-business-data" },
      plugin: "Q", element: "md", requestId: "report", component: "Pane"
    })
    expect(f.state.get("Q")?.get("count")).toBe(1)
    expect(f.state.get("P")?.has("clicked")).toBe(false)
    expect(f.state.get("R")?.has("clicked")).toBe(false)
    expect(f.opener).not.toHaveBeenCalled()
  })

  it("does not let a public pane action fabricate a Markdown link gesture", async () => {
    const f = await fixture()
    const pane = await f.snapshot()
    const node = markdown(pane.tree)
    if (!node.press) throw Error("Actual private Q callback missing")
    const action = { pane: pane.key, generation: pane.generation, plugin: node.press.plugin,
      handle: node.press.handle, intentId: randomUUID(), kind: "press" as const }
    await expect(f.session.panes.act({ ...action, link: { href: accepted } }))
      .rejects.toThrow("MODS_UI_MARKDOWN_ACTION_INVALID")
    await expect(f.session.panes.act({ ...action, intentId: randomUUID() })).rejects.toThrow()
    expect(f.writes).toHaveLength(0)
  })

  it("takes the default path only for a published link outside the final takeover list", async () => {
    const f = await fixture()
    const pane = await f.snapshot()
    await expect(f.click(f.action(pane, defaultHref))).resolves.toEqual({ state: "opened" })
    expect(f.opener).toHaveBeenCalledExactlyOnceWith(defaultHref, expect.any(Function))
    expect(f.writes).toHaveLength(0)
  })

  it("keeps identical snapshots and completed native intents stable without replay", async () => {
    const f = await fixture()
    const first = await f.snapshot()
    const action = f.action(first)
    const result = f.click(action)
    await result
    const same = await f.snapshot()
    expect(same.markdownLinks).toEqual(first.markdownLinks)
    expect(f.click(action)).toBe(result)
    expect(f.state.get("Q")?.get("count")).toBe(1)
    expect(f.opener).not.toHaveBeenCalled()
  })

  it("retains old native publication and Q action when a protected candidate fails", async () => {
    const f = await fixture()
    const old = await f.snapshot()
    f.failPublication(true)
    await expect(f.snapshot()).rejects.toThrow()
    f.failPublication(false)
    const same = await f.snapshot()
    expect(same.generation).toBe(old.generation)
    expect(same.markdownLinks).toEqual(old.markdownLinks)
    await expect(f.click(f.action(old))).resolves.toEqual({ state: "handled" })
    expect(f.state.get("Q")?.get("count")).toBe(1)
  })

  it("rejects an old nonce when same-generation protected content changes", async () => {
    const f = await fixture()
    const old = await f.snapshot()
    f.changeSafeText(`[Changed](${accepted}) [Docs](${defaultHref})`)
    const changed = await f.snapshot()
    expect(changed.generation).toBe(old.generation)
    expect(changed.markdownLinks).not.toEqual(old.markdownLinks)
    expect(() => f.click(f.action(old))).toThrow("MODS_UI_MARKDOWN_STALE")
    expect(f.writes).toHaveLength(0)
    await expect(f.click(f.action(changed))).resolves.toEqual({ state: "handled" })
  })

  it("recovers an illegal link-presence rewrite without deleting the native gesture", async () => {
    const f = await fixture()
    const pane = await f.snapshot()
    f.state.get("P")?.set("mode", "remove")
    await expect(f.click(f.action(pane))).resolves.toEqual({ state: "handled" })
    expect(f.state.get("Q")?.get("clicked")).toMatchObject({ link: { href: accepted } })
    expect(f.state.get("Q")?.get("count")).toBe(1)
    expect(f.opener).not.toHaveBeenCalled()
  })

  it("keeps an ordinary Button real and recovers an illegal Hook link addition", async () => {
    const f = await fixture()
    const pane = await f.snapshot()
    if (pane.tree.type !== "Box") throw Error("Actual parent Box missing")
    const button = pane.tree.children?.find(node => typeof node !== "string" && node.type === "Button")
    if (!button || typeof button === "string" || button.type !== "Button" || !button.press)
      throw Error("Actual Button missing")
    const action = { pane: pane.key, generation: pane.generation, plugin: button.press.plugin,
      handle: button.press.handle, intentId: randomUUID(), kind: "press" as const }
    await expect(f.session.panes.act({ ...action, link: { href: accepted } })).rejects.toThrow()
    f.state.get("P")!.set("mode", "add")
    await f.session.panes.act({ ...action, intentId: randomUUID() })
    expect(f.state.get("Q")?.get("button")).toBe(1)
    expect(f.state.get("Q")?.has("clicked")).toBe(false)
  })

  it.each(["display", "source", "close"])("denies a retired %s before any callback/default work", async mode => {
    const f = await fixture()
    const pane = await f.snapshot()
    if (mode === "display") f.closeDisplay()
    else if (mode === "source") f.revoke()
    else await f.session.panes.closePane("Q", "report")
    expect(() => f.click(f.action(pane))).toThrow()
    expect(f.writes).toHaveLength(0)
    expect(f.opener).not.toHaveBeenCalled()
  })
})
