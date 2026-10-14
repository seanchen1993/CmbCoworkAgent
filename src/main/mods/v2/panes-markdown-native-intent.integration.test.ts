import { randomUUID } from "node:crypto"
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ModJson } from "../../../shared/mods/types"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { FunctionMarkdownLinkAction } from "../../../shared/mods/v2/markdown-links"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"
import type { UserInputRequest } from "../../types"
import { ModControlStore } from "../control-store"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionModsManager } from "./manager"
import { withFunctionMarkdownDisplay } from "./markdown-display-scope"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionSessionActivity } from "./session-activity"
import { trackFunctionSession } from "./session-facade"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const href = "https://example.test/native-intent"
const questions = [{ id: "plan", header: "Plan", question: "Proceed?",
  options: [{ label: "Yes", description: "Proceed" }, { label: "No", description: "Stop" }] }]
const request = (requestId: string): Readonly<UserInputRequest> => ({
  requestId, threadId: "thread", createdAt: "2026-10-05T00:00:00.000Z",
  questions: structuredClone(questions)
})

function action(pane: FunctionPaneSnapshot, owner?: string): FunctionMarkdownLinkAction {
  if (pane.markdownLinks?.length !== 1) throw Error("Actual Markdown sidecar missing")
  return {
    address: owner ? { kind: "site", owner, pane: pane.key, generation: pane.generation }
      : { kind: "pane", pane: pane.key, generation: pane.generation },
    nonce: pane.markdownLinks[0].nonce, href, intentId: randomUUID()
  }
}

async function sessionFixture(callback: string, ask = false) {
  let alive = true
  let senderAlive = true
  let pendingQuestion: Readonly<UserInputRequest> | null = request("R1")
  const state = new Map<string, ModJson>()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",($,e)=>{
      const {Box,Markdown}=$.ui.resolve(e);
      const md=Markdown({key:"md",text:"[Native link](${href})",async onLinkPress(){${callback}}});
      return e.component==="AskUserQuestion"?Box({children:[md,{type:"engine",ref:0}]}):md
    })
  }}`)
  const session = new FunctionSession([{
    name: "Q", root: "/actual/Q", tier: "user", guest, capabilities: [...SESSION_CAPABILITIES]
  }], {
    workspace: "/actual-project", threadId: "thread",
    assertLive() { if (!alive) throw new ModFunctionError("MODS_TEST_REVOKED") },
    publish: async value => value,
    pendingQuestion: () => pendingQuestion,
    state: () => ({
      async get(key) {
        if (key === "barrier") { entered.resolve(); await release.promise }
        return state.get(key)
      },
      keys: async () => [...state.keys()],
      async set(key, value) { state.set(key, value) },
      delete(key) { state.delete(key) }
    })
  })
  cleanups.push(async () => { release.resolve(); await session.close() })
  await session.start()
  const display = { epoch: {}, assertCurrent() {
    if (!senderAlive) throw new ModFunctionError("MODS_TEST_DISPLAY_CLOSED")
  } }
  const owner = ask ? await session.sites.mount("AskUserQuestion", undefined, "R1") : undefined
  if (!ask) session.panes.open("Q", { id: "report", title: "Native links" })
  const snapshot = () => withFunctionMarkdownDisplay(display, async () => {
    if (owner) return session.sites.render(owner, { tool: "request_user_input", questions })
    const [pane] = await session.panes.snapshot()
    if (!pane) throw Error("Actual Pane missing")
    return pane
  })
  const open = vi.fn(async () => ({ state: "opened" as const }))
  // This is the same recursive base-fence shape used by actual manager.markdownLink.
  const click = (input: FunctionMarkdownLinkAction, boundary = session) => {
    const originalGuard = () => { display.assertCurrent(); boundary.assertTransportLive() }
    return session.markdownLinks.invoke(input, originalGuard, open,
      run => boundary.nativeMarkdownCallback(originalGuard, run))
  }
  return { session, guest, state, owner, snapshot, click, open, entered: entered.promise,
    release: () => release.resolve(), replaceQuestion: () => { pendingQuestion = request("R2") },
    closeSender: () => { senderAlive = false }, revoke: () => { alive = false }
  }
}

async function managerFixture() {
  const workspace = await mkdtemp(join(tmpdir(), "markdown-native-manager-"))
  const plugin = join(workspace, "plugin")
  await cp(resolve("resources/mods/function-commands"), plugin, { recursive: true })
  await writeFile(join(plugin, "hooks/hooks.json"), JSON.stringify({ modules: ["./register.ts"] }))
  await writeFile(join(plugin, "hooks/register.ts"), `export function register(on){
    on("session.start",async($,e,next)=>{
      await $.ui.open({id:"report",title:"Native links"});return next(e)
    });
    on("ui.render",($,e)=>$.ui.resolve(e).Markdown({key:"md",text:"[Link](${href})",
      async onLinkPress(){await $.store.set("count",(await $.store.get("count")||0)+1)}}))
  }`)
  const store = new ModControlStore(join(workspace, "control.sqlite"))
  const guests = new Set<FunctionGuestRuntime>()
  const manager = new FunctionModsManager(store, {
    plugins: () => [{ id: "source", name: "function-commands", path: plugin, enabled: true }],
    enabled: () => true, publish: async (_workspace, value) => value,
    changed: () => undefined
  }, () => ({
    async load(code, options) {
      const guest = await FunctionGuestRuntime.create(code, options)
      guests.add(guest)
      return guest
    },
    stop() { for (const guest of guests) guest.dispose() }
  }))
  cleanups.push(async () => {
    manager.close()
    for (const guest of guests) guest.dispose()
    store.close()
    await rm(workspace, { recursive: true, force: true })
  })
  const status = await manager.status(workspace)
  const digest = status[0]?.digest
  if (!digest) throw Error("Actual compiled digest missing")
  await manager.approve(workspace, "source", digest)
  await manager.commands(workspace, "thread")
  const display = { epoch: {}, assertCurrent() { /* This native display remains live in this test. */ } }
  const [pane] = await withFunctionMarkdownDisplay(display, () => manager.panes(workspace, "thread"))
  if (!pane) throw Error("Actual manager Pane missing")
  const open = vi.fn(async () => ({ state: "opened" as const }))
  const click = (input: FunctionMarkdownLinkAction) => withFunctionMarkdownDisplay(display,
    () => manager.markdownLink(workspace, "thread", input, display.assertCurrent, open, run => run()))
  return { manager, store, workspace, pane, click, open }
}

describe("native Markdown callback guards", () => {
  it("runs actual Main manager and QuickJS callback once without recursive base-fence entry", async () => {
    const f = await managerFixture()
    const input = action(f.pane)
    await expect(f.click(input)).resolves.toEqual({ state: "handled" })
    await expect(f.click(input)).resolves.toEqual({ state: "handled" })
    expect(f.store.functionState.get(JSON.stringify([f.workspace, "function-commands"]), "count"))
      .toBe(1)
    expect(f.open).not.toHaveBeenCalled()
  })

  it.each([false, true])("keeps the same native owner through intentional redraw, Ask=%s", async ask => {
    const f = await sessionFixture(`await $.ui.invalidate("ui.render");
      await $.store.get("barrier");await $.store.set("after-redraw",true)`, ask)
    const old = await f.snapshot()
    const result = f.click(action(old, f.owner))
    await f.entered
    const next = await f.snapshot()
    expect(next.generation).not.toBe(old.generation)
    f.release()
    await expect(result).resolves.toEqual({ state: "handled" })
    expect(f.state.get("after-redraw")).toBe(true)
    expect(f.open).not.toHaveBeenCalled()
  })

  it("retains the real facade activity until the entered Guest callback and host work settle", async () => {
    const f = await sessionFixture(`await $.store.get("barrier");
      await $.store.set("after-wait",true)`)
    const activity = new FunctionSessionActivity()
    const boundary = trackFunctionSession(f.session, activity)
    const pane = await f.snapshot()
    const result = f.click(action(pane), boundary)
    await f.entered
    expect(activity.size).toBeGreaterThan(0)
    expect(activity.pauseIfIdle()).toBe(false)
    expect(f.state.has("after-wait")).toBe(false)
    f.release()
    await expect(result).resolves.toEqual({ state: "handled" })
    expect(f.state.get("after-wait")).toBe(true)
    expect(activity.size).toBe(0)
  })

  it("denies late Ask R1 SDK effects after the actual pending request becomes R2", async () => {
    const f = await sessionFixture(`await $.store.get("barrier");
      await $.store.set("old-request-effect",true)`, true)
    const pane = await f.snapshot()
    const result = f.click(action(pane, f.owner))
    const rejected = expect(result).rejects.toMatchObject({
      code: "MODS_HOOK_FAILED", message: "MODS_UI_QUESTION_STALE"
    })
    await f.entered
    f.replaceQuestion()
    f.release()
    await rejected
    expect(f.state.has("old-request-effect")).toBe(false)
    expect(f.open).not.toHaveBeenCalled()
  })

  it.each(["sender", "source"])("preserves the parent %s fence through nested native scopes", async change => {
    const f = await sessionFixture(`await $.store.get("barrier");
      await $.store.set("late-effect",true)`)
    const pane = await f.snapshot()
    const result = f.click(action(pane))
    const rejected = expect(result).rejects.toMatchObject({
      code: "MODS_HOOK_FAILED",
      message: change === "sender" ? "MODS_TEST_DISPLAY_CLOSED" : "MODS_TEST_REVOKED"
    })
    await f.entered
    if (change === "sender") f.closeSender()
    else f.revoke()
    f.release()
    await rejected
    expect(f.state.has("late-effect")).toBe(false)
    expect(f.open).not.toHaveBeenCalled()
  })
})
