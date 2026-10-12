import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets.ts"
/** Actual Bot/group library recovery using production components and a controlled read-only IPC bridge. */
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
const root = process.cwd(),
  require = createRequire(join(root, "package.json"))
const { build } = require("esbuild"),
  { compile } = require("@tailwindcss/node"),
  { Scanner } = require("@tailwindcss/oxide"),
  { chromium } = require("playwright")
const renderer = join(root, "src/renderer/src"),
  output = join(root, "output/bot-library-read")
await mkdir(output, { recursive: true })
await rm(join(output, "results.json"), { force: true })
const sheet = await compile(
  (await readFile(join(renderer, "index.css"), "utf8")).replace(
    /^@import "@fontsource[^\n]+\n/gm,
    ""
  ),
  { base: renderer, onDependency: () => {} }
)
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const highlight = await build({
  entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  logLevel: "silent"
})
const bundle = await build({
  stdin: {
    loader: "tsx",
    resolveDir: root,
    contents: `import'./src/renderer/src/components/bots/bot-workspace.css';import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{BotGroupInspector}from'./src/renderer/src/components/bots/BotGroupInspector';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
const a={id:'bot-a',name:'第一位 Bot',revision:1,status:'active',instructions:''},b={...a,id:'bot-b',name:'第二位 Bot'},group={id:'group-a',name:'评审群聊',kind:'group',members:['bot-a','bot-b'],revision:1};const conversations=[{id:'direct-a',name:'第一位 Bot',kind:'direct',members:['bot-a'],revision:1},{id:'direct-b',name:'第二位 Bot',kind:'direct',members:['bot-b'],revision:1},group];
window.api={bots:new Proxy({routines:id=>window.fixtureRoutines(id),artifacts:id=>window.fixtureRead(id)}, {get:(target,name)=>name in target?target[name]:(...args)=>window.fixtureUnexpected(name,args)})};useBotWorkspaceStore.setState({host:{capabilities:[]},snapshot:{cursor:1,bots:[a,b],conversations,runs:[],interactions:[],dataEpoch:'initial'},selected:'direct-a',drafts:{'direct-a':{prompt:'保留 Bot A 草稿',attachments:[]},'direct-b':{prompt:'保留 Bot B 草稿',attachments:[]},'group-a':{prompt:'保留群聊草稿',attachments:[]}}});window.fixtureDrafts=()=>useBotWorkspaceStore.getState().drafts;window.fixtureCursor=()=>useBotWorkspaceStore.setState(state=>({snapshot:{...state.snapshot,cursor:state.snapshot.cursor+1}}));
function Fixture(){const[view,setView]=useState(window.fixtureKind==='group'?'group-a':'direct-a'),[tab,setTab]=useState('details');return <main className='bot-workspace flex bg-background text-foreground' style={{width:1000,height:720}}><div className='p-6'><input aria-label='聊天草稿' defaultValue='保持现有消息正文'/><button onClick={()=>{setView('direct-b');setTab('details')}}>切换至第二个 Bot</button></div>{view==='group-a'?<BotGroupInspector key={view} group={group} bots={[a,b]} settings={()=>{}} openBot={()=>{}} close={()=>{}}/>:<BotInspector key={view} bot={view==='direct-a'?a:b} conversationId={view} tab={tab} onTabChange={setTab} settings={()=>{}} resource={()=>{}} close={()=>{}}/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
  },
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
      name: "preview-worker",
      setup(builder) {
        builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
          path: "highlight-worker",
          namespace: "preview-worker"
        }))
        builder.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
          loader: "js",
          contents: `export default class extends Worker{constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url)}}`
        }))
      }
    }
  ]
})
const css =
    sheet.build(scanner.scan()) +
    (bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text || ""),
  js = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text
const browser = await chromium.launch({
  channel: process.platform === "win32" ? "msedge" : "chrome",
  headless: true,
  args: ["--disable-updater-scheduler"]
})
const checks = [],
  failures = [],
  observations = [],
  pageErrors = []
const file = (conversationId, name) => ({
  id: `file-${conversationId}`,
  conversationId,
  runId: null,
  name,
  mime: "text/plain",
  size: 20,
  sha256: "a".repeat(64),
  createdAt: Date.now(),
  origin: "upload"
})
async function run(name, kind, read, test) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } }),
    calls = [],
    unexpected = [],
    routineReads = [],
    pending = []
  page.on("pageerror", (error) => pageErrors.push(`${name}: ${error.message}`))
  await page.exposeFunction("fixtureRead", async (id) => {
    calls.push(id)
    return read(id, calls, pending)
  })
  await page.exposeFunction("fixtureRoutines", (id) => {
    routineReads.push(id)
    return []
  })
  await page.exposeFunction("fixtureUnexpected", (method, args) => {
    unexpected.push({ method, args })
    throw new Error(`Unexpected RPC ${method}`)
  })
  await page.addInitScript((kind) => {
    window.fixtureKind = kind
    window.electron = { process: { platform: "darwin" } }
  }, kind)
  await page.route("http://127.0.0.1:43937/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><meta charset='utf-8'><style>${css}</style><div id='root'></div><script>${js}</script>`
    })
  )
  const result = { name, kind }
  try {
    await page.goto("http://127.0.0.1:43937/")
    const panel = page.getByRole("complementary", {
      name: kind === "group" ? "评审群聊 的详情" : "第一位 Bot 的详情",
      exact: true
    })
    await panel.getByRole("tab", { name: "资料库", exact: true }).click()
    const drafts = await page.evaluate(() => window.fixtureDrafts())
    await test(page, panel, calls, pending)
    assert.deepEqual(
      routineReads,
      kind === "group" ? [] : calls.includes("direct-b") ? ["bot-a", "bot-b"] : ["bot-a"],
      "Only the initially visible details summary may read routines; library recovery adds no reads"
    )
    assert.deepEqual(unexpected, [], "Local library recovery must not invoke other RPCs")
    assert.deepEqual(
      await page.evaluate(() => window.fixtureDrafts()),
      drafts,
      "Recovery changed persisted drafts"
    )
    assert.equal(
      await page.getByLabel("聊天草稿", { exact: true }).inputValue(),
      "保持现有消息正文"
    )
    checks.push(name)
    result.passed = true
    console.log(`PASS ${name}`)
  } catch (error) {
    result.passed = false
    result.error = error.message
    failures.push({ name, error: error.message })
    console.log(`FAIL ${name}: ${error.message.split("\n")[0]}`)
  } finally {
    result.artifactReads = [...calls]
    result.routineReads = [...routineReads]
    result.otherRPCs = [...unexpected]
    observations.push(result)
    pending.splice(0).forEach((done) => done())
    await page.close()
  }
}
const retry = (panel) => panel.getByRole("button", { name: "重试读取文件", exact: true })
const failed = async (panel) => {
  await panel.getByRole("alert").getByText("列表读取连接中断", { exact: true }).waitFor()
  assert.equal(await panel.getByText("暂无文件", { exact: true }).count(), 0)
  assert.equal(await retry(panel).count(), 1, "Read failure must offer a direct retry")
}
try {
  await run(
    "Bot library read failure retries the original conversation",
    "direct",
    (id, calls) => {
      if (calls.length === 1) throw new Error("列表读取连接中断")
      return [file(id, "Bot A 交付.txt")]
    },
    async (page, panel, calls) => {
      await failed(panel)
      await retry(panel).click()
      await panel.getByRole("button", { name: "预览 Bot A 交付.txt", exact: true }).waitFor()
      assert.deepEqual(calls, ["direct-a", "direct-a"])
      assert.equal(await panel.getByRole("alert").count(), 0)
    }
  )
  await run(
    "Group library uses the same recovery and retains group ownership",
    "group",
    (id, calls) => {
      if (calls.length === 1) throw new Error("列表读取连接中断")
      return [file(id, "群聊交付.txt")]
    },
    async (page, panel, calls) => {
      await failed(panel)
      await retry(panel).click()
      await panel.getByRole("button", { name: "预览 群聊交付.txt", exact: true }).waitFor()
      assert.deepEqual(calls, ["group-a", "group-a"])
      assert.equal(
        await panel.getByRole("button", { name: "预览 Bot A 交付.txt", exact: true }).count(),
        0
      )
    }
  )
  await run(
    "Repeated failure remains recoverable; a pending retry rejects duplicate clicks",
    "direct",
    (id, calls, pending) => {
      if (calls.length === 1) throw new Error("列表读取连接中断")
      if (calls.length === 2) throw new Error("服务暂时不可用")
      return new Promise((resolve) => pending.push(() => resolve([file(id, "重试成功.txt")])))
    },
    async (page, panel, calls, pending) => {
      await failed(panel)
      await retry(panel).click()
      await panel.getByRole("alert").getByText("服务暂时不可用", { exact: true }).waitFor()
      assert.equal(await retry(panel).isEnabled(), true)
      await retry(panel).click()
      await page.waitForFunction(
        () => document.querySelector('button[aria-label="重试读取文件"]')?.disabled
      )
      await retry(panel).click({ force: true })
      assert.deepEqual(calls, ["direct-a", "direct-a", "direct-a"])
      assert.equal(await panel.getByText("正在重试…", { exact: true }).count(), 1)
      pending.splice(0).forEach((done) => done())
      await panel.getByRole("button", { name: "预览 重试成功.txt", exact: true }).waitFor()
      assert.equal(await panel.getByRole("alert").count(), 0)
    }
  )
  await run(
    "A late retry result cannot populate another Bot; cursor updates still refresh it",
    "direct",
    (id, calls, pending) => {
      if (id === "direct-a" && calls.length === 1) throw new Error("列表读取连接中断")
      if (id === "direct-a")
        return new Promise((resolve) =>
          pending.push(() => resolve([file(id, "旧 Bot 迟到文件.txt")]))
        )
      return [file(id, calls.length === 3 ? "Bot B 原文件.txt" : "Bot B 新文件.txt")]
    },
    async (page, panel, calls, pending) => {
      await failed(panel)
      await retry(panel).click()
      await page.waitForFunction(
        () => document.querySelector('button[aria-label="重试读取文件"]')?.disabled
      )
      await page.getByRole("button", { name: "切换至第二个 Bot", exact: true }).click()
      const second = page.getByRole("complementary", { name: "第二位 Bot 的详情", exact: true })
      await second.getByRole("tab", { name: "资料库", exact: true }).click()
      await second.getByRole("button", { name: "预览 Bot B 原文件.txt", exact: true }).waitFor()
      pending.splice(0).forEach((done) => done())
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      )
      assert.equal(
        await second.getByRole("button", { name: "预览 旧 Bot 迟到文件.txt", exact: true }).count(),
        0
      )
      await page.evaluate(() => window.fixtureCursor())
      await second.getByRole("button", { name: "预览 Bot B 新文件.txt", exact: true }).waitFor()
      assert.deepEqual(calls, ["direct-a", "direct-a", "direct-b", "direct-b"])
    }
  )
} finally {
  await browser.close()
}
await writeFile(
  join(output, "results.json"),
  JSON.stringify({ checks, failures, pageErrors, observations }, null, 2) + "\n"
)
assert.equal(pageErrors.length, 0)
assert.equal(checks.length + failures.length, 4)
assert.equal(failures.length, 0)
console.log("4 library recovery checks passed; no page errors or other RPCs")
