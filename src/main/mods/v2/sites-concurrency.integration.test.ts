import { afterEach, expect, it } from "vitest"
import { randomUUID } from "node:crypto"
import { FunctionGuestRuntime } from "./guest-runtime"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import type { ModJson } from "../../../shared/mods/types"
import type { FunctionPaneSnapshot, FunctionUiAction } from "../../../shared/mods/v2/ui"

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

const above = { isWorking: true, bodyColumns: 80, maxRows: 8 }
const message = { text: "RAW_BODY protected message", isFirstOfReply: true }
async function fixture(extra = "") {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<ModJson>()
  const state = new Map<string, ModJson>()
  let live = true
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    on("ui.render",{},async($,e,next)=>{
      await $.store.set("entered:"+e.component+":"+String(e.props.isWorking),true);
      if(e.component==="AbovePrompt"&&e.props.isWorking)await $.store.get("gate");
      return next(e)
    });${extra}
  }}`)
  const session = new FunctionSession(
    [
      {
        name: "concurrent-sites",
        root: "/concurrent-sites",
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      workspace: "/project",
      threadId: "thread",
      uiChanged: () => undefined,
      assertLive() {
        if (!live) throw Error("source or grant revoked")
      },
      // Actual publication still runs for both branches; the guest never gets raw fallback authority.
      publish: async (value) =>
        JSON.parse(JSON.stringify(value).replaceAll("RAW_BODY", "SAFE_BODY")),
      state: () => ({
        get: async (key) => {
          if (key === "gate") {
            entered.resolve()
            return release.promise
          }
          return state.get(key)
        },
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
  await session.start()
  cleanup.push(async () => {
    release.resolve(null)
    await session.close()
  })
  return {
    session,
    state,
    entered: entered.promise,
    release: () => release.resolve(null),
    revoke: () => {
      live = false
    }
  }
}

function assertSafe(snapshot: FunctionPaneSnapshot) {
  expect(JSON.stringify(snapshot)).toContain("SAFE_BODY")
  expect(JSON.stringify(snapshot)).not.toContain("RAW_BODY")
}

it("renders actual protected User/Assistant guests while another component awaits native work", async () => {
  const f = await fixture()
  const slow = await f.session.sites.mount("AbovePrompt")
  let completed = false
  const rendering = f.session.sites.render(slow, above).then((value) => {
    completed = true
    return value
  })
  await f.entered
  const [assistant, user] = await Promise.all([
    f.session.sites.mount("AssistantMessage"),
    f.session.sites.mount("UserMessage", "durable-user")
  ])
  assertSafe(await f.session.sites.render(assistant, message))
  assertSafe(await f.session.sites.render(user, { text: message.text, isExpanded: false }))
  expect(completed).toBe(false)
  f.release()
  await rendering
})

it("orders two renders of the same owner without blocking another cold owner", async () => {
  const f = await fixture()
  const owner = await f.session.sites.mount("AbovePrompt")
  const first = f.session.sites.render(owner, above)
  await f.entered
  const second = f.session.sites.render(owner, { ...above, isWorking: false })
  const other = await f.session.sites.mount("AssistantMessage")
  assertSafe(await f.session.sites.render(other, message))
  expect(f.state.has("entered:AbovePrompt:false")).toBe(false)
  f.release()
  await first
  await second
  expect(f.state.get("entered:AbovePrompt:false")).toBe(true)
})

it.each(["unmount", "retire", "close", "revoke"] as const)(
  "rejects suspended and queued old owner results after %s",
  async (change) => {
    const f = await fixture()
    const owner = await f.session.sites.mount("AbovePrompt")
    const first = f.session.sites.render(owner, above)
    const rejectedFirst = expect(first).rejects.toThrow()
    await f.entered
    const queued = f.session.sites.render(owner, { ...above, isWorking: false })
    const rejectedQueued = expect(queued).rejects.toThrow()
    if (change === "unmount") await f.session.sites.unmount(owner)
    if (change === "retire") f.session.sites.retire(owner)
    if (change === "close") f.session.sites.close()
    if (change === "revoke") f.revoke()
    f.release()
    await rejectedFirst
    await rejectedQueued
    expect(f.state.has("entered:AbovePrompt:false")).toBe(false)
    if (change === "close")
      await expect(f.session.sites.mount("AssistantMessage")).rejects.toThrow("MODS_UI_SITE_CLOSED")
  }
)

it("keeps singleton replacement ordered while independent message mounts remain live", async () => {
  const f = await fixture()
  const original = await f.session.sites.mount("AbovePrompt")
  const rendering = f.session.sites.render(original, above)
  const rejected = expect(rendering).rejects.toThrow()
  await f.entered
  const [first, second, assistant] = await Promise.all([
    f.session.sites.mount("AbovePrompt"),
    f.session.sites.mount("AbovePrompt"),
    f.session.sites.mount("AssistantMessage")
  ])
  await expect(f.session.sites.render(first, { ...above, isWorking: false })).rejects.toThrow(
    "MODS_UI_SITE_CLOSED"
  )
  assertSafe(await f.session.sites.render(assistant, message))
  await f.session.sites.render(second, { ...above, isWorking: false })
  f.release()
  await rejected
})

it("a callback awaiting native work cannot block protected drawing in another owner", async () => {
  const f = await fixture(`
    on("ui.render",{component:"PromptHint"},($,e)=>$.ui.resolve(e).Button({key:"hold",label:"Wait",
      async onPress(){await $.store.get("gate")}}));
  `)
  const owner = await f.session.sites.mount("PromptHint")
  const drawing = await f.session.sites.render(owner, {
    isDraft: false,
    isWorking: false,
    hint: "send"
  })
  const find = (node: unknown): { plugin: string; handle: number } | undefined => {
    if (!node || typeof node !== "object") return
    const item = node as { press?: { plugin: string; handle: number }; children?: unknown[] }
    return item.press ?? item.children?.map(find).find(Boolean)
  }
  const handle = find(drawing.tree)!
  const action: FunctionUiAction = {
    pane: drawing.key,
    generation: drawing.generation,
    kind: "press",
    plugin: handle.plugin,
    handle: handle.handle,
    intentId: randomUUID()
  }
  expect(action.handle).toBeTruthy()
  const acting = f.session.sites.act(owner, action)
  await f.entered
  const assistant = await f.session.sites.mount("AssistantMessage")
  assertSafe(await f.session.sites.render(assistant, message))
  f.release()
  await acting
})

it("bounds pending owner work and drops only physically settled exact queue tails", async () => {
  const f = await fixture()
  const owner = await f.session.sites.mount("AbovePrompt")
  const running = [f.session.sites.render(owner, above)]
  await f.entered
  for (let index = 0; index < 511; index++)
    running.push(f.session.sites.render(owner, { ...above, isWorking: false }))
  await expect(f.session.sites.render(owner, above)).rejects.toThrow("MODS_UI_SITE_QUEUE_LIMIT")
  const internals = f.session.sites as unknown as {
    queues: Map<string, Promise<void>>
    pending: number
  }
  expect(internals.queues.size).toBe(1)
  expect(internals.pending).toBe(512)
  f.release()
  await Promise.all(running)
  expect(internals.queues.size).toBe(0)
  expect(internals.pending).toBe(0)
  await f.session.sites.render(owner, { ...above, isWorking: false })
})
