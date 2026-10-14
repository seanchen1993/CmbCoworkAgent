import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { mkdirSync, writeFileSync } from "node:fs"
import { afterEach, expect, it } from "vitest"
import type { ModJson, ModObject, ModUiChangeScope } from "../../../shared/mods/types"
import type { FunctionUiSite } from "../../../shared/mods/v2/sites"
import type { FunctionPaneSnapshot, FunctionUiElement, FunctionUiNode } from "../../../shared/mods/v2/ui"
import type { UserInputRequest } from "../../types"
import { FunctionSession, SESSION_CAPABILITIES } from "./session"
import { FunctionGuestRuntime } from "./guest-runtime"
import { compileFunctionPlugin } from "./loader"
import { CLIENT_BOOTSTRAP } from "./client-bootstrap"
import { functionGuestLoad } from "./client-load-failure"

const sessions: FunctionSession[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close()
})
const facts = { text: "message", isFirstOfReply: true }
const call = {
  tool_use_id: "actual",
  tool: "Read",
  input: {},
  isRunning: false,
  isErrored: false,
  isInterrupted: false
}
const siteCases: Array<[FunctionUiSite, ModObject]> = [
  ["AbovePrompt", { isWorking: false, bodyColumns: 80, maxRows: 8 }],
  ["PromptHint", { isWorking: false, isDraft: false, hint: "Enter" }],
  ["InfoNotice", { text: "info", command: null }],
  ["Spinner", { word: "Working", message: null, suffix: "", mode: "requesting" }],
  ["TurnDuration", { word: "Worked", durationMs: 100 }],
  ["SessionMode", { modes: ["plan"] }],
  ["UserMessage", { text: "original", origin: { kind: "unclassified" }, isExpanded: true }],
  ["AssistantMessage", facts],
  ["CommandOutput", { command: "cmd", args: "", text: "original", isErrored: false }],
  ["ToolUse", call],
  ["ToolResult", { tool_use_id: "actual", tool: "Read", output: "ok", isErrored: false }],
  ["ToolGroup", { calls: [call], isActive: false, isExpanded: false }],
  [
    "AskUserQuestion",
    {
      tool: "request_user_input",
      questions: [
        {
          id: "choice",
          header: "Plan",
          question: "Choose?",
          options: [
            { label: "Yes", description: "Proceed" },
            { label: "No", description: "Cancel" }
          ]
        }
      ]
    }
  ]
]
function content(tree: FunctionUiElement): string {
  if (tree.type === "engine") return ""
  return (tree.children ?? []).map((c) => (typeof c === "string" ? c : content(c))).join("")
}
async function fixture(
  options: {
    mode?: string
    hook?: string
    controlHook?: string
    renderBarrier?: boolean
    publish?: (value: ModJson) => Promise<ModJson>
  } = {}
) {
  const compiled = await compileFunctionPlugin(resolve("tests/fixtures/mods-v2/client-board"))
  const state = new Map<string, ModJson>()
  const guests: FunctionGuestRuntime[] = []
  const notices: Array<ModUiChangeScope | undefined> = []
  const effects = { model: 0, files: 0 }
  const pendingQuestion: Readonly<UserInputRequest> = {
    requestId: "site-client-question",
    threadId: "thread",
    createdAt: "2026-10-04T00:00:00.000Z",
    questions: (siteCases.find(([component]) => component === "AskUserQuestion")![1].questions as unknown as UserInputRequest["questions"])
  }
  let blockBackground = false,
    backgroundWaiting = false
  let releaseBackground: () => void = () => {}
  let blockRendering = false,
    renderingWaiting = false
  let releaseRendering: () => void = () => {}
  const guest = await FunctionGuestRuntime.create(`var __cmbFunctionMod={register(on){
    let draws=0,failed=false;
    on("ui.render",async($,e)=>{
      draws++;
      ${options.renderBarrier ? 'await $.store.get("render-barrier");' : ""}
      const {Client,Text,Box}=$.ui.resolve(e);
      const body=failed?Text({children:"Fallback works"}):Client({key:"counter",module:"hooks/surface.tsx",props:{label:"Source",mode:${JSON.stringify(options.mode ?? "success")}}});
      return e.component==="AskUserQuestion"?Box({children:[body,{type:"engine",ref:0}]}):body;
    });
    on("ui.message",async($,e)=>{
      await $.store.set("message",e);
      ${options.hook ?? ""}
      return {props:{label:"Acknowledged"}};
    });
    on("ui.fault",async($,e)=>{failed=true;await $.store.set("fault",e);return {}});
    ${options.controlHook ? `on("ui.press",async($,e,next)=>{${options.controlHook};return next(e)});` : ""}
    on("session.start",{},async($,e,next)=>{await $.command.register({name:"site-draws",description:"draws"});return next(e)});
    on("command.run",{command:"site-draws"},()=>({text:String(draws)}));
  }}`)
  const session = new FunctionSession(
    [
      {
        name: compiled.name,
        root: compiled.root,
        tier: "user",
        guest,
        capabilities: [...SESSION_CAPABILITIES]
      }
    ],
    {
      threadId: "thread",
      workspace: "/project",
      pendingQuestion: () => pendingQuestion,
      checkClientModule: (plugin, module) => {
        if (plugin !== compiled.name || !Object.hasOwn(compiled.clients, module))
          throw Error("unapproved")
      },
      assertLive: () => {},
      uiChanged: (scope) => notices.push(scope),
      publish: options.publish ?? (async (v) => v),
      freshEntry: async (run) => {
        if (blockBackground) {
          blockBackground = false
          backgroundWaiting = true
          await new Promise<void>((resolve) => {
            releaseBackground = resolve
          })
          backgroundWaiting = false
        }
        return run()
      },
      completeModelResult: async () => {
        effects.model++
        return {isAnswered:true as const,text:"answer",usage:{input_tokens:1,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}}
      },
      files: () => ({
        run: async () => {
          effects.files++
          return "file contents"
        }
      }),
      loadClient: async (plugin, module) => {
        if (plugin !== compiled.name || !Object.hasOwn(compiled.clients, module))
          throw Error("unapproved")
        const code =
          options.mode === "load"
            ? 'throw Error("load failed")'
            : `var __cmbSurfaceMod={default(props,s){
        if(props.mode==="render")throw Error("render failed");
        const {Button,Text,Box}=s.elements;
        return Box({children:[Text({children:(props.label||"Source")+" · count:"+(s.state||0)}),
          Button({key:"increment",label:"Increment",onPress:async()=>{
            await Promise.resolve();
            if(props.mode==="run")throw Error("run failed");
            s.setState((s.state||0)+1);s.post({count:s.state});
          }})]});
      }}`
        const runtime = await functionGuestLoad(() =>
          FunctionGuestRuntime.create(CLIENT_BOOTSTRAP + "\n" + code, { plugin })
        )
        guests.push(runtime)
        return runtime
      },
      state: () => ({
        get: async (k) => {
          if (k === "render-barrier" && blockRendering) {
            blockRendering = false
            renderingWaiting = true
            await new Promise<void>((resolve) => {
              releaseRendering = resolve
            })
            renderingWaiting = false
          }
          return state.get(k)
        },
        keys: async () => [...state.keys()],
        set: async (k, v) => {
          state.set(k, v)
        },
        delete: (k) => {
          state.delete(k)
        }
      })
    }
  )
  sessions.push(session)
  await session.start()
  const owner = await session.sites.mount("AssistantMessage")
  const snapshot = () => session.sites.render(owner, facts)
  const click = (pane: FunctionPaneSnapshot) => {
    const client = pane.clients![0]
    if (client.tree.type === "engine") throw Error("Client cannot draw engine")
    const button = client.tree.children![1] as FunctionUiNode
    return session.clients.act({
      pane: pane.key,
      instance: client.id,
      generation: client.generation,
      intentId: randomUUID(),
      kind: "press",
      handle: button.press!.handle
    })
  }
  return {
    session,
    owner,
    state,
    guests,
    notices,
    effects,
    snapshot,
    click,
    deferBackground: () => {
      blockBackground = true
    },
    backgroundWaiting: () => backgroundWaiting,
    releaseBackground: () => releaseBackground(),
    deferRendering: () => {
      blockRendering = true
    },
    renderingWaiting: () => renderingWaiting,
    releaseRendering: () => releaseRendering(),
    draws: async () => Number((await session.run("site-draws", "")).text)
  }
}

it("runs real site Clients independently and retains accepted props and state on parent redraw", async () => {
  const f = await fixture()
  const initial = await f.snapshot()
  await f.click(initial)
  await expect
    .poll(() => f.state.get("message"))
    .toMatchObject({
      component: "AssistantMessage",
      requestId: f.owner,
      data: { count: 1 }
    })
  await expect
    .poll(async () => content((await f.snapshot()).clients![0].tree))
    .toContain("Acknowledged")
  const before = await f.draws()
  const same = await f.snapshot()
  expect(await f.draws()).toBe(before)
  f.session.sites.invalidate()
  const redrawn = await f.snapshot()
  expect(redrawn.generation).not.toBe(initial.generation)
  expect(redrawn.clients![0].id).toBe(initial.clients![0].id)
  expect(content(redrawn.clients![0].tree)).toContain("Acknowledged · count:1")
  const otherOwner = await f.session.sites.mount("AssistantMessage")
  const other = await f.session.sites.render(otherOwner, facts)
  expect(other.clients![0].id).not.toBe(same.clients![0].id)
  expect(content(other.clients![0].tree)).toContain("Source · count:0")
  await expect.poll(() => f.notices.includes(`site:${f.owner}` as ModUiChangeScope)).toBe(true)
  expect(f.guests).toHaveLength(2)
})

it.each(["load", "render", "run"])(
  "reports a real %s failure at its fixed site and redraws once",
  async (mode) => {
    const f = await fixture({ mode })
    const pane = await f.snapshot()
    if (mode === "run") await expect(f.click(pane)).rejects.toThrow()
    await expect
      .poll(() => f.state.get("fault"))
      .toMatchObject({
        component: "AssistantMessage",
        requestId: f.owner,
        phase: mode,
        element: "counter"
      })
    await expect.poll(async () => content((await f.snapshot()).tree)).toBe("Fallback works")
    expect(f.guests.every((g) => g.stats.disposed)).toBe(true)
  }
)

it.each(["unmount", "parent"])(
  "rejects late real message SDK effects after %s without resetting a retained VM",
  async (change) => {
    const f = await fixture({
      hook: 'await $.clock.sleep(180);await $.store.set("late-effect",true);'
    })
    const pane = await f.snapshot()
    await f.click(pane)
    await expect.poll(() => f.state.has("message")).toBe(true)
    const pending =
      change === "unmount"
        ? f.session.sites.unmount(f.owner)
        : f.session.sites.render(f.owner, { ...facts, text: "new parent" })
    await pending
    await new Promise((r) => setTimeout(r, 220))
    expect(f.state.has("late-effect")).toBe(false)
    expect(f.state.has("fault")).toBe(false)
    if (change === "parent") {
      const after = await f.session.sites.render(f.owner, { ...facts, text: "new parent" })
      expect(after.clients![0].id).toBe(pane.clients![0].id)
      expect(after.clients![0].error).toBeUndefined()
      expect(content(after.clients![0].tree)).toContain("count:1")
      expect(f.guests).toHaveLength(1)
    } else expect(f.guests[0].stats.disposed).toBe(true)
  }
)

it.each(siteCases)(
  "runs the approved Client in the actual %s slot with native message identity",
  async (component, props) => {
    const f = await fixture()
    const owner = await f.session.sites.mount(component, undefined,
      component === "AskUserQuestion" ? "site-client-question" : undefined)
    const pane = await f.session.sites.render(owner, props)
    expect(pane.clients![0].error).toBeUndefined()
    await f.click(pane)
    await expect.poll(() => f.state.get("message")).toMatchObject({ component, requestId: owner })
    await expect
      .poll(async () => content((await f.session.sites.render(owner, props)).clients![0].tree))
      .toContain("Acknowledged · count:1")
  }
)

it("bounds Client capacity across real slots, never treats native capacity as a module fault, and frees removed slots", async () => {
  const f = await fixture()
  const owners = [f.owner]
  for (let i = 0; i < 8; i++) owners.push(await f.session.sites.mount("AssistantMessage"))
  const panes: FunctionPaneSnapshot[] = []
  for (const owner of owners.slice(0, 8)) panes.push(await f.session.sites.render(owner, facts))
  expect(f.guests).toHaveLength(8)
  expect(panes.slice(0, 8).every((p) => !p.clients![0].error)).toBe(true)
  await expect(f.session.sites.render(owners[8], facts)).rejects.toThrow("MODS_CLIENT_LIMIT")
  expect(f.state.has("fault")).toBe(false)
  await f.session.sites.unmount(owners[0])
  await expect.poll(() => f.guests[0].stats.disposed).toBe(true)
  expect(f.guests.slice(1).every((guest) => !guest.stats.disposed)).toBe(true)
  const newOwner = await f.session.sites.mount("AssistantMessage")
  expect((await f.session.sites.render(newOwner, facts)).clients![0].error).toBeUndefined()
  expect(f.guests).toHaveLength(9)
  await expect(
    f.session.clients.act({
      pane: `engine:${newOwner}`,
      instance: panes[1].clients![0].id,
      generation: panes[1].clients![0].generation,
      intentId: randomUUID(),
      kind: "key",
      value: { key: "up" }
    })
  ).rejects.toThrow("MODS_CLIENT_UNMOUNTED")
})

it("does not load a Client removed by actual parent content protection", async () => {
  const f = await fixture({
    publish: async (value) => {
      if (!Array.isArray(value)) return value
      return value.map((row) =>
        row && typeof row === "object" && !Array.isArray(row) && row.tree
          ? { ...row, tree: { type: "Text", props: {}, children: ["Protected"] } }
          : row
      )
    }
  })
  const pane = await f.snapshot()
  expect(content(pane.tree)).toBe("Protected")
  expect(pane.clients).toEqual([])
  expect(f.guests).toHaveLength(0)
})

it("publishes the immediate fault fallback notification without a polling snapshot masking host-open coalescing", async () => {
  const f = await fixture({ mode: "run" })
  const pane = await f.snapshot()
  await expect(f.click(pane)).rejects.toThrow()
  await expect.poll(() => f.state.has("fault")).toBe(true)
  await expect.poll(() => f.notices.includes(`site:${f.owner}`)).toBe(true)
  expect(content((await f.snapshot()).tree)).toBe("Fallback works")
  expect(await f.draws()).toBe(2)
})

it("rejects a first-arrival action from the old parent generation even when instance and handle survive", async () => {
  const f = await fixture()
  const old = await f.snapshot()
  f.session.sites.invalidate()
  const current = await f.snapshot()
  expect(current.clients![0].id).toBe(old.clients![0].id)
  const oldClientTree = old.clients![0].tree
  if (oldClientTree.type === "engine") throw Error("Client cannot draw engine")
  const oldHandle = (oldClientTree.children![1] as FunctionUiNode).press!.handle
  await expect(
    f.session.clients.act({
      pane: old.key,
      instance: old.clients![0].id,
      generation: old.generation,
      intentId: randomUUID(),
      kind: "press",
      handle: oldHandle
    })
  ).rejects.toThrow("MODS_UI_STALE_ACTION")
  expect(f.state.has("message")).toBe(false)
  expect(content((await f.snapshot()).clients![0].tree)).toContain("count:0")
  await f.click(current)
  await expect.poll(() => f.state.get("message")).toMatchObject({ data: { count: 1 } })
})

it.each(["message", "control"])(
  "fences the actual %s Hook's model, file, UI and store continuation when its parent is replaced",
  async (kind) => {
    const hook = `await $.store.set("entered",true);await $.clock.sleep(180);
    for(const effect of [()=>$.store.set("late-effect",true),
      ()=>$.model.complete({model:"fixture",prompt:"hi"}),()=>$.fs.read("file.txt"),
      ()=>$.ui.open({id:"late-pane"})])try{await effect()}catch{}`
    const f = await fixture(kind === "message" ? { hook } : { controlHook: hook })
    const pane = await f.snapshot()
    const action = f.click(pane).catch((error: unknown) => error)
    await expect.poll(() => f.state.has("entered")).toBe(true)
    await f.session.sites.render(f.owner, { ...facts, text: "new parent" })
    await action
    await new Promise((r) => setTimeout(r, 220))
    expect(f.state.has("late-effect")).toBe(false)
    expect(f.effects).toEqual({ model: 0, files: 0 })
    expect(await f.session.panes.snapshot()).toEqual([])
    expect(f.state.has("fault")).toBe(false)
    const current = await f.session.sites.render(f.owner, { ...facts, text: "new parent" })
    expect(current.clients![0].error).toBeUndefined()
    expect(current.clients![0].id).toBe(pane.clients![0].id)
    await f.click(current)
    await expect.poll(() => f.state.get("late-effect")).toBe(true)
    await expect.poll(() => f.effects).toEqual({ model: 1, files: 1 })
    await expect.poll(async () => (await f.session.panes.snapshot()).length).toBe(1)
  }
)

it("does not deliver an old queued post through a newly adopted parent drawing", async () => {
  const f = await fixture({
    hook: `await $.store.set("post-effect",true);
    await $.model.complete({model:"fixture",prompt:"hi"});await $.fs.read("file.txt");
    await $.ui.open({id:"post-pane"});`
  })
  const pane = await f.snapshot()
  f.deferBackground()
  await f.click(pane)
  await expect.poll(f.backgroundWaiting).toBe(true)
  await f.session.sites.render(f.owner, { ...facts, text: "adopted parent" })
  f.releaseBackground()
  await new Promise((r) => setTimeout(r, 100))
  expect(f.state.has("message")).toBe(false)
  expect(f.state.has("post-effect")).toBe(false)
  expect(f.effects).toEqual({ model: 0, files: 0 })
  expect(await f.session.panes.snapshot()).toEqual([])
  const current = await f.session.sites.render(f.owner, { ...facts, text: "adopted parent" })
  expect(current.clients![0].id).toBe(pane.clients![0].id)
  expect(content(current.clients![0].tree)).toContain("count:1")
  await f.click(current)
  await expect.poll(() => f.state.get("message")).toMatchObject({ data: { count: 2 } })
  await expect.poll(() => f.effects).toEqual({ model: 1, files: 1 })
})

it("does not borrow the replacement parent object while its new rendering is still pending", async () => {
  const f = await fixture({
    renderBarrier: true,
    hook: 'await $.store.set("post-effect",true);await $.model.complete({model:"fixture",prompt:"hi"});await $.fs.read("file.txt");await $.ui.open({id:"post-pane"});'
  })
  const pane = await f.snapshot()
  f.deferBackground()
  await f.click(pane)
  await expect.poll(f.backgroundWaiting).toBe(true)
  f.deferRendering()
  const replacing = f.session.sites.render(f.owner, { ...facts, text: "replacement parent" })
  await expect.poll(f.renderingWaiting).toBe(true)
  f.releaseBackground()
  await new Promise((r) => setTimeout(r, 80))
  const effectsWhilePending = {
    message: f.state.has("message"),
    post: f.state.has("post-effect"),
    model: f.effects.model,
    files: f.effects.files
  }
  f.releaseRendering()
  const current = await replacing
  await new Promise((r) => setTimeout(r, 100))
  expect(effectsWhilePending).toEqual({ message: false, post: false, model: 0, files: 0 })
  expect(f.state.has("message")).toBe(false)
  expect(f.effects).toEqual({ model: 0, files: 0 })
  expect(await f.session.panes.snapshot()).toEqual([])
  expect(current.clients![0].id).toBe(pane.clients![0].id)
  expect(current.clients![0].error).toBeUndefined()
  await f.click(current)
  await expect.poll(() => f.effects).toEqual({ model: 1, files: 1 })
})

it("shares the eight active Client budget between real Pane and site drawings", async () => {
  const f = await fixture()
  f.session.panes.open("client-board", { id: "native-pane" })
  const pane = (await f.session.panes.snapshot())[0]
  expect(pane.clients![0].error).toBeUndefined()
  const owners = [f.owner]
  for (let i = 0; i < 7; i++) owners.push(await f.session.sites.mount("AssistantMessage"))
  const sites: FunctionPaneSnapshot[] = []
  for (const owner of owners.slice(0, 7)) sites.push(await f.session.sites.render(owner, facts))
  expect(sites.slice(0, 7).every((site) => !site.clients![0].error)).toBe(true)
  await expect(f.session.sites.render(owners[7], facts)).rejects.toThrow("MODS_CLIENT_LIMIT")
  expect(f.guests).toHaveLength(8)
  expect(f.state.has("fault")).toBe(false)
  await f.session.panes.closePane("client-board", "native-pane")
  await expect.poll(() => f.guests[0].stats.disposed).toBe(true)
  expect(f.guests.slice(1).every((guest) => !guest.stats.disposed)).toBe(true)
  const nextOwner = await f.session.sites.mount("AssistantMessage")
  expect((await f.session.sites.render(nextOwner, facts)).clients![0].error).toBeUndefined()
  expect(f.guests).toHaveLength(9)
})

it("measures real site Client listener, draw and protected snapshot without rerunning its parent Hook", async () => {
  const f = await fixture()
  let pane = await f.snapshot()
  const baseline = await f.draws()
  const times: number[] = []
  for (let i = 0; i < 35; i++) {
    const before = performance.now()
    await f.click(pane)
    pane = await f.snapshot()
    const elapsed = performance.now() - before
    expect(content(pane.clients![0].tree)).toContain(`count:${i + 1}`)
    if (i >= 5) times.push(elapsed)
    await expect.poll(() => f.state.get("message")).toMatchObject({ data: { count: i + 1 } })
  }
  expect(await f.draws()).toBe(baseline)
  expect(f.guests).toHaveLength(1)
  times.sort((a, b) => a - b)
  const report = {
    warmup: 5,
    samples: 30,
    parentHookDrawings: baseline,
    medianMs: times[15],
    p95Ms: times[28],
    scope:
      "Actual local QuickJS async Client listener, draw, protection and site snapshot; no utility IPC, renderer, OS paint or model latency"
  }
  mkdirSync(resolve("output"), { recursive: true })
  writeFileSync(
    resolve("output/mods-site-clients-performance.json"),
    JSON.stringify(report, null, 2)
  )
  console.log(JSON.stringify(report))
})
