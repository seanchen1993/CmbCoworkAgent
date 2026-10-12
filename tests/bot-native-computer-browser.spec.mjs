import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets.ts"
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { resolve, join } from "node:path"
const require = createRequire(import.meta.url)
const { build } = require("esbuild")
const { chromium } = require("playwright")
const { compile } = require("@tailwindcss/node")
const { Scanner } = require("@tailwindcss/oxide")
const source = resolve(".")
const renderer = join(source, "src/renderer/src")
const output = resolve(process.env.CMB_NATIVE_UI_EVIDENCE ?? "output/bot-native-computer")
await mkdir(output, { recursive: true })
const bot = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "工作助手",
  modelRef: null,
  role: "",
  revision: 1,
  deletedAt: null,
  avatarColor: "red",
  avatarShape: "circle",
  workspacePath: null
}
const conv = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "direct",
  name: "工作助手",
  members: [bot.id],
  revision: 1
}
const generation = "11111111-1111-4111-8111-111111111111"
const view = "22222222-2222-4222-8222-222222222222"
const capabilities = {
  capture: true,
  semanticInput: true,
  pointerInput: false,
  keyboardInput: false,
  messagePointer: true,
  messageDrag: true,
  messageKeyboard: true,
  independentDesktopVerified: false
}
const otherView = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const windows = [
  { viewId: view, title: "本机工作窗口" },
  { viewId: otherView, title: "另一个工作窗口" }
]
const desktopWindow = {
  hwnd: "101",
  pid: 123,
  startTicks: "123456",
  sessionId: 1,
  desktop: "controlled-desktop"
}
const image =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAoAAAAFoCAIAAABIUN0GAAAFj0lEQVR4nO3VMQEAMAyAsEqaf3V1MY4mCviYBwB8N3UAAFxkwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAgAEDQMCAASBgwAAQMGAACBgwAAQMGAACBgwAAQMGgIABA0DAgAEgYMAAEDBgAAgYMAAEDBgAAgYMAAEDBoCAAQNAwIABIGDAABAwYAAIGDAABAwYAAIGDAABAwaAwAK//l2n4Si5lwAAAABJRU5ErkJggg=="
const frameBase = {
  backend: "windows-native",
  botId: bot.id,
  generation,
  controlEpoch: 1,
  control: "bot",
  viewId: "55555555-5555-4555-8555-555555555555",
  controlOwner: undefined,
  controlOwnerConnected: undefined
}
const snapshot = {
  dataEpoch: "initial",
  bots: [bot],
  conversations: [conv],
  runs: [],
  interactions: [],
  messages: [],
  skills: [],
  routines: [],
  events: [],
  effects: [],
  memory: [],
  artifacts: [],
  cursor: 0
}
const entry = `import'./src/renderer/src/components/bots/bot-workspace.css';import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{nativeDesktopImage,nativeDesktopCapabilities,botNativeDesktopTarget,botNativeDesktopHumanInput}from'./src/shared/bot-native-desktop';window.api={bots:new Proxy({},{get:(_,method)=>async input=>{if(method==='nativeComputerInput'){botNativeDesktopTarget.parse(input.target);botNativeDesktopHumanInput.parse(input.input);}const value=await window.fixtureCall(method,input);if(method==='nativeComputerFrame'&&value&&!value.botFailure){const{window:desktopWindow,title,width,height,image,sourceWidth,sourceHeight,inputTicketIssued,messageGeometryReady,captureId,frameVersion}=value;nativeDesktopImage.parse({window:desktopWindow,title,width,height,image,sourceWidth,sourceHeight,inputTicketIssued,messageGeometryReady,captureId,frameVersion});nativeDesktopCapabilities.parse(value.capabilities);botNativeDesktopTarget.parse(value);}return value;}})};const bot=${JSON.stringify(bot)};const conv=${JSON.stringify(conv)};applyThemePreference('codex-dark');useBotWorkspaceStore.setState({snapshot:${JSON.stringify(snapshot)},selected:conv.id,host:{hostId:'controlled-host',dataEpoch:'initial',protocol:1,platform:'win32',runtimeReady:true,error:null,capabilities:['windows-native-computer']}});window.fixtureTheme=applyThemePreference;function Fixture(){const[active,setActive]=useState(true);const[tab,setTab]=useState("computer");const[arm,setArm]=useState(null);const backend=useRef('browser');window.fixtureActive=setActive;window.fixturePrepare=()=>setArm({backend:backend.current,botId:bot.id,conversationId:conv.id,conversationRevision:1,viewId:conv.id,dataEpoch:'initial'});return <div style={{height:'100vh',display:'flex'}}><BotInspector bot={bot} conversationId={conv.id} tab={tab} onTabChange={setTab} covered={!active} teachArm={arm} onTeachPrepared={()=>setArm(null)} cancelTeachPreparation={()=>setArm(null)} onComputerBackendChange={value=>backend.current=value} close={()=>setActive(false)} settings={()=>{}} resource={()=>{}} /></div>};createRoot(document.getElementById('root')).render(<Fixture/>);`
console.log("stage compiling original highlight worker")
const highlight = await build({
  entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  outfile: join(output, "highlight-worker.js")
})
console.log("stage compiling production renderer")
const bundle = await build({
  stdin: { loader: "tsx", resolveDir: source, contents: entry },
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  outfile: join(output, "fixture.js"),
  jsx: "automatic",
  alias: { "@": renderer },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  plugins: [
    viteUrlAssetsFixture(),
    {
      name: "original-workspace-highlight-worker",
      setup(builder) {
        builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
          path: "highlight-worker",
          namespace: "original-worker"
        }))
        builder.onLoad({ filter: /.*/, namespace: "original-worker" }, () => ({
          loader: "js",
          contents: `export default class extends Worker{constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles.find((f) => f.path.endsWith(".js")).text)}],{type:'text/javascript'}));try{super(url,options)}finally{URL.revokeObjectURL(url)}}}`
        }))
      }
    },
    {
      name: "desktop-app-config-only",
      setup(builder) {
        builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) => {
          if (args.path === "./store" && !args.importer.startsWith(join(renderer, "lib"))) return
          return { path: "app-store", namespace: "fixture" }
        })
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
          loader: "js",
          resolveDir: source,
          contents: `import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));`
        }))
      }
    }
  ]
})
const css = await compile(
  (await readFile(join(renderer, "index.css"), "utf8")).replace(
    /^@import "@fontsource[^\n]+\n/gm,
    ""
  ),
  { base: renderer, onDependency: () => {} }
)
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const stylesheet =
  css.build(scanner.scan()) +
  bundle.outputFiles
    .filter((f) => f.path.endsWith(".css"))
    .map((f) => f.text)
    .join("\n")
const script = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text
console.log("stage starting controlled transport UI")
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : "chrome",
  headless: true
})
const errors = []
const checks = []
const calls = []
const browserFrame = {
  botId: bot.id,
  generation,
  controlEpoch: 1,
  control: "bot",
  viewId: "66666666-6666-4666-8666-666666666666",
  frameSeq: 1,
  width: 640,
  height: 360,
  url: "https://example.invalid/",
  title: "浏览器",
  image,
  tabs: []
}
let selected = { ...frameBase }
let frameSeq = 0
let session = null
let loss = false
const nativeFrame = () => ({
  ...selected,
  frameSeq: ++frameSeq,
  width: 640,
  height: 360,
  sourceWidth: 1280,
  sourceHeight: 720,
  inputTicketIssued: selected.control === "human",
  messageGeometryReady: true,
  title: "工作窗口",
  image,
  captureId: "88888888-8888-4888-8888-" + String(frameSeq).padStart(12, "0"),
  frameVersion: String(frameSeq),
  window: desktopWindow,
  capabilities
})
const protectedId = "99999999-9999-4999-8999-999999999999"
const secretTicket = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const page = await browser.newPage({ viewport: { width: 1280, height: 850 } })
page.setDefaultTimeout(5000)
page.on("pageerror", (e) => errors.push(e.message))
await page.exposeFunction("fixtureCall", async (method, input) => {
  calls.push({ method, input: structuredClone(input) })
  switch (method) {
    case "nativeComputerOpen":
      return { ...selected }
    case "nativeComputerWindows":
      return windows
    case "nativeComputerTake":
      selected = {
        ...selected,
        control: "human",
        controlOwner: "self",
        controlOwnerConnected: true,
        controlEpoch: selected.controlEpoch + 1
      }
      return { ...selected }
    case "nativeComputerSelect":
      assert.equal(input.target.control, "human")
      selected = { ...selected, viewId: input.viewId }
      return { ...selected }
    case "nativeComputerObserve":
      return {
        window: desktopWindow,
        title: "工作窗口",
        truncated: false,
        elements: [
          {
            id: protectedId,
            name: "密码",
            controlType: "Edit",
            password: true,
            enabled: true,
            offscreen: false,
            depth: 1,
            valueTruncated: false,
            supportedActions: []
          }
        ]
      }
    case "nativeComputerPrepareSecret":
      assert.equal(input.target.control, "human")
      assert.equal(input.elementId, protectedId)
      return { token: secretTicket, windowTitle: "工作窗口", field: "密码" }
    case "nativeComputerProvideSecret":
      return assert.fail("Closing or covering an unsent secret must not submit it")
    case "nativeComputerFrame":
      return nativeFrame()
    case "nativeComputerInput":
      assert.equal(input.target.backend, "windows-native")
      assert.equal(input.target.control, "human")
      assert.equal(input.target.controlOwner, "self")
      assert.equal(input.input.frameSeq, input.target.frameSeq)
      assert.equal(input.target.viewId, selected.viewId)
      assert.equal(input.target.controlEpoch, selected.controlEpoch)
      assert.equal(input.target.frameSeq, frameSeq)
      return undefined
    case "computerOpen":
    case "computerFrame":
      return browserFrame
    case "teachStatus":
      return session
    case "teachStart":
      assert.equal(input.target.backend, "windows-native")
      assert.equal(input.target.botId, bot.id)
      assert.equal(input.conversationId, conv.id)
      assert.equal(input.target.viewId, view)
      assert.equal(input.target.control, "human")
      assert.match(input.nonce, /^[0-9a-f-]{36}$/)
      session = {
        backend: "windows-native",
        id: "77777777-7777-4777-8777-777777777777",
        botId: bot.id,
        conversationId: conv.id,
        startNonce: input.nonce,
        phase: "recording",
        revision: 1,
        startedAt: Date.now(),
        endedAt: null,
        frameCount: 1,
        eventCount: 0,
        bytes: 12,
        error: null,
        learningRunId: null,
        skillId: null,
        video: null,
        attempt: 1
      }
      if (loss) {
        loss = false
        return { botFailure: { code: "uncertain_ack", message: "受控传输丢失已接受回执" } }
      }
      return session
    case "teachPause":
      session = {
        ...session,
        phase: input.paused ? "paused" : "recording",
        revision: session.revision + 1
      }
      return session
    case "teachStop":
      session = {
        ...session,
        phase: input.save ? "queued" : "discarded",
        revision: session.revision + 1,
        learningRunId: input.save ? "controlled-learning-run" : null
      }
      return session
    case "routines":
      return []
    default:
      return null
  }
})
await page.route("http://127.0.0.1:43831/**", (route) =>
  route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><meta charset="utf-8"><style>${stylesheet}</style><div id="root"></div><script>${script}</script>`
  })
)
try {
  await page.goto("http://127.0.0.1:43831/")
  await page.getByRole("button", { name: "工作应用", exact: true }).click()
  await page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.method === "teachStart").length, 0)
  await page.getByRole("button", { name: "接管操作", exact: true }).click()
  await page.getByRole("button", { name: "选择工作应用", exact: true }).click()
  await page.getByRole("button", { name: "本机工作窗口", exact: true }).click()
  await page.getByRole("button", { name: "展开 工作助手 的工作应用画面", exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.method === "nativeComputerInput").length, 0)
  await page.getByRole("button", { name: "展开 工作助手 的工作应用画面", exact: true }).click()
  await page.getByRole("application", { name: "工作助手 的工作应用画面", exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.method === "nativeComputerInput").length, 0)
  checks.push("preview expands production Inspector without remote input")
  const img = page
    .getByRole("application", { name: "工作助手 的工作应用画面", exact: true })
    .locator("img")
  await img.click({ position: { x: 160, y: 90 } })
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="工作应用文字"]')?.hasAttribute("disabled") === false
  )
  assert.equal(calls.filter((x) => x.method === "nativeComputerInput").length, 1)
  assert.equal(
    calls.at(-1)?.method === "nativeComputerFrame" || calls.at(-1)?.method === "teachStatus",
    true
  )
  const pointer = calls.find((x) => x.method === "nativeComputerInput").input
  assert.deepEqual(pointer.input.action.kind, "click")
  assert.ok(pointer.input.action.x > 0 && pointer.input.action.x < 1280)
  checks.push("expanded self input binds displayed native target and frame sequence")
  const ready = () =>
    page.waitForFunction(
      () => document.querySelector('input[aria-label="工作应用文字"]')?.disabled === false
    )
  const inputs = () => calls.filter((call) => call.method === "nativeComputerInput")
  let box = await img.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25)
  await page.mouse.down()
  assert.equal(inputs().length, 1)
  const heldFrames = calls.filter((call) => call.method === "nativeComputerFrame").length
  await page.waitForTimeout(1600)
  assert.equal(
    calls.filter((call) => call.method === "nativeComputerFrame").length,
    heldFrames,
    "holding a drag must retain its published input ticket"
  )
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.waitForTimeout(90)
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.65)
  assert.equal(inputs().length, 1)
  await page.mouse.up()
  await ready()
  assert.equal(inputs().length, 2)
  const drag = inputs()[1].input
  assert.equal(drag.input.action.kind, "drag")
  assert.equal(drag.input.action.op, "message_pointer")
  assert.equal(drag.target.controlOwner, "self")
  assert.equal(drag.input.frameSeq, drag.target.frameSeq)
  assert.ok(drag.input.action.path.length >= 2 && drag.input.action.path.length <= 32)
  assert.deepEqual(drag.input.action.path[0], {
    x: drag.input.action.x,
    y: drag.input.action.y
  })
  for (const [point, expected] of [
    [drag.input.action.path[0], { x: 320, y: 180 }],
    [drag.input.action.path.at(-1), { x: 832, y: 468 }]
  ]) {
    assert.ok(Math.abs(point.x - expected.x) <= 1, JSON.stringify({ point, expected }))
    assert.ok(Math.abs(point.y - expected.y) <= 1, JSON.stringify({ point, expected }))
  }
  checks.push("scaled drag submits one complete path; long hold retains the displayed ticket")
  await img.click({ position: { x: 160, y: 90 } })
  await page.waitForTimeout(400)
  await ready()
  assert.equal(inputs().length, 3)
  assert.equal(inputs()[2].input.input.action.kind, "click")
  await img.dblclick({ position: { x: 160, y: 90 } })
  await page.waitForTimeout(350)
  await ready()
  assert.equal(inputs().length, 4)
  assert.equal(inputs()[3].input.input.action.kind, "double_click")
  checks.push("single and double click each remain one action after a drag")
  box = await img.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
  await page.mouse.down()
  await page.waitForTimeout(90)
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.evaluate(() => window.fixtureActive(false))
  await page.mouse.up()
  await page.waitForTimeout(350)
  assert.equal(inputs().length, 4)
  assert.equal(calls.filter((call) => call.method === "nativeComputerRelease").length, 0)
  await page.evaluate(() => window.fixtureActive(true))
  await ready()
  checks.push("covering the viewer cancels an unsent drag without input or control transfer")
  const message = page.getByLabel("工作应用文字", { exact: true })
  const messageDraft = "尚未发送的工作应用文字"
  const beforeDraftInputs = inputs().length
  const beforeDraftFrame = frameSeq
  await message.fill(messageDraft)
  await page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
  await page.getByRole("tab", { name: "详情", exact: true }).click()
  assert.equal(
    await page.getByRole("application", { name: "工作助手 的工作应用画面", exact: true }).count(),
    0
  )
  assert.equal(inputs().length, beforeDraftInputs)
  await page.getByRole("tab", { name: "电脑", exact: true }).click()
  await page.getByRole("button", { name: "展开 工作助手 的工作应用画面", exact: true }).click()
  await ready()
  assert.equal(await message.inputValue(), messageDraft)
  assert.ok(frameSeq > beforeDraftFrame, "returning to the viewer must acquire a new frame ticket")
  await page.evaluate(() => window.fixtureActive(false))
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="工作应用文字"]')?.disabled === true
  )
  await page.evaluate(() => document.querySelector(".bot-native-message-input").requestSubmit())
  await page.evaluate(() => window.fixtureActive(true))
  await ready()
  assert.equal(await message.inputValue(), messageDraft)
  assert.equal(inputs().length, beforeDraftInputs)
  checks.push("ordinary message draft survives Inspector tabs and covering without replaying input")

  await page.getByRole("button", { name: "本机工作窗口", exact: true }).click()
  await page.getByRole("button", { name: "另一个工作窗口", exact: true }).click()
  await ready()
  assert.equal(selected.viewId, otherView)
  assert.equal(await message.inputValue(), "")
  assert.equal(inputs().length, beforeDraftInputs)
  await page.getByRole("button", { name: "另一个工作窗口", exact: true }).click()
  await page.getByRole("button", { name: "本机工作窗口", exact: true }).click()
  await ready()
  await message.fill(messageDraft)
  await page.evaluate(() => window.fixtureActive(false))
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="工作应用文字"]')?.disabled === true
  )
  selected = { ...selected, controlEpoch: selected.controlEpoch + 1, controlOwner: "other" }
  await page.evaluate(() => window.fixtureActive(true))
  await page.getByText("另一客户端正在操作", { exact: true }).waitFor()
  assert.equal(await message.count(), 0)
  assert.equal(inputs().length, beforeDraftInputs)
  selected = { ...selected, controlEpoch: selected.controlEpoch + 1, controlOwner: "self" }
  await page.getByRole("button", { name: "刷新工作应用画面", exact: true }).click()
  await ready()
  assert.equal(await message.inputValue(), "")
  assert.equal(inputs().length, beforeDraftInputs)
  assert.equal(
    inputs().some((call) => call.input.target.frameSeq === beforeDraftFrame),
    false,
    "the draft's old displayed ticket must not become an input"
  )
  checks.push("window and control identity changes clear drafts without using the old frame ticket")

  await message.fill(messageDraft)
  const password = page.getByPlaceholder("输入或粘贴密码", { exact: true })
  const openSecret = async () => {
    await page.getByRole("button", { name: "应用控件", exact: true }).click()
    await page.getByRole("button", { name: /^密码/ }).click()
    await page.getByRole("button", { name: "安全输入密码", exact: true }).click()
    await password.waitFor()
  }
  await openSecret()
  await password.fill("unsent-secret-fixture")
  await page
    .getByRole("dialog", { name: "安全输入密码", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click()
  await password.waitFor({ state: "hidden" })
  await openSecret()
  assert.equal(await password.inputValue(), "")
  await password.fill("unsent-secret-fixture")
  await page.evaluate(() => window.fixtureActive(false))
  await password.waitFor({ state: "hidden" })
  await page.evaluate(() => window.fixtureActive(true))
  await ready()
  assert.equal(await password.count(), 0)
  assert.equal(await message.inputValue(), messageDraft)
  await openSecret()
  assert.equal(await password.inputValue(), "")
  await page
    .getByRole("dialog", { name: "安全输入密码", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click()
  await password.waitFor({ state: "hidden" })
  assert.equal(calls.filter((call) => call.method === "nativeComputerProvideSecret").length, 0)
  assert.equal(inputs().length, beforeDraftInputs)
  checks.push(
    "closing and covering clears masked secret drafts while retaining ordinary message text"
  )
  await page.evaluate(() => window.fixturePrepare())
  const start = page.getByRole("button", { name: "开始录制", exact: true })
  await start.waitFor()
  loss = true
  await start.click()
  await page
    .locator(".bot-native-computer")
    .getByRole("status")
    .filter({ hasText: /^正在录制示范/ })
    .waitFor()
  const begins = calls.filter((x) => x.method === "teachStart")
  assert.equal(begins.length, 1)
  assert.equal(begins[0].input.target.backend, "windows-native")
  assert.equal(begins[0].input.conversationId, conv.id)
  assert.equal(await page.getByRole("button", { name: "浏览器", exact: true }).isDisabled(), true)
  assert.equal(
    await page.getByRole("button", { name: "工作应用", exact: true }).getAttribute("aria-pressed"),
    "true"
  )
  await page.locator('.bot-native-computer[data-recording-phase="recording"]').waitFor()
  await page.getByText("受控传输丢失已接受回执", { exact: true }).waitFor({ state: "hidden" })
  await page.screenshot({ path: join(output, "native-recording-dark.png") })
  await page.getByRole("button", { name: "暂停录制", exact: true }).click()
  await page
    .locator(".bot-native-computer")
    .getByRole("status")
    .filter({ hasText: /^录制已暂停/ })
    .waitFor()
  await page.locator('.bot-native-computer[data-recording-phase="paused"]').waitFor()
  await page.getByRole("button", { name: "保存并学习", exact: true }).click()
  await page.getByText("正在理解示范并整理技能，可回到对话查看进展", { exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.method === "teachStart").length, 1)
  assert.equal(calls.filter((x) => x.method === "teachStop").length, 1)
  assert.deepEqual(calls.find((x) => x.method === "teachStop").input, {
    id: session.id,
    save: true
  })
  checks.push(
    "native Teach original nonce survives lost ACK; mode locks; pause/save uses same controller"
  )
  await page.evaluate(() => window.fixtureActive(false))
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="工作应用文字"]')?.disabled === true
  )
  const before = calls.length
  await page.waitForTimeout(1650)
  assert.equal(calls.length, before)
  assert.equal(calls.filter((x) => x.method === "nativeComputerRelease").length, 0)
  session = { ...session, phase: "ready", skillId: "controlled-skill" }
  await page.evaluate(() => window.fixtureActive(true))
  await page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
  await page.getByRole("button", { name: "示范给 Bot", exact: true }).click()
  await page
    .locator(".bot-native-computer")
    .getByRole("status")
    .filter({ hasText: /^正在录制示范/ })
    .waitFor()
  await page.getByRole("button", { name: "丢弃录制", exact: true }).click()
  await page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
  assert.equal(calls.filter((x) => x.method === "teachStop").length, 2)
  assert.deepEqual(calls.filter((x) => x.method === "teachStop").at(-1).input, {
    id: session.id,
    save: false
  })
  checks.push(
    "hidden Inspector stops reads, retains control, then discards through original Teach API"
  )
  assert.deepEqual(errors, [])
} catch (failure) {
  await writeFile(join(output, "failure.html"), await page.content())
  await page.screenshot({ path: join(output, "failure.png") })
  throw failure
} finally {
  await page.close()
  await browser.close()
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        checks,
        errors,
        calls,
        boundary:
          "actual React and production renderer; controlled native transport, no Windows execution",
        closedAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n"
  )
}
assert.equal(checks.length, 10)
console.log(JSON.stringify({ checks, errors, closed: true }))
