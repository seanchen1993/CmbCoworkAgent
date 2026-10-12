import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets.ts"
/** Actual Bot/group deletion versus in-flight list reads, using production components and controlled IPC. */
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
  output = join(root, "output/bot-file-delete-read")
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
window.api={bots:new Proxy({routines:id=>window.fixtureRoutines(id),artifacts:id=>{const number=window.artifactReads=(window.artifactReads||0)+1;return window.fixtureRead(id).then(value=>{window.returnedReads=[...(window.returnedReads||[]),number];return value})},deleteFile:input=>window.fixtureDelete(input),snapshot:()=>window.fixtureSnapshot(),status:()=>window.fixtureStatus()}, {get:(target,name)=>name in target?target[name]:(...args)=>window.fixtureUnexpected(name,args)})};useBotWorkspaceStore.setState({host:{hostId:'fixture-host',capabilities:['file-lifecycle','file-delete-epoch']},snapshot:{cursor:1,bots:[a,b],conversations,runs:[],interactions:[],dataEpoch:'initial'},selected:'direct-a',drafts:{'direct-a':{prompt:'保留 Bot A 草稿',attachments:[]},'direct-b':{prompt:'保留 Bot B 草稿',attachments:[]},'group-a':{prompt:'保留群聊草稿',attachments:[]}}});window.fixtureDrafts=()=>useBotWorkspaceStore.getState().drafts;window.fixtureCursor=()=>useBotWorkspaceStore.setState(state=>({snapshot:{...state.snapshot,cursor:state.snapshot.cursor+1}}));
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
  const actor = { deletes: [], snapshots: 0, status: 0, confirmed: false }
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
  await page.exposeFunction("fixtureDelete", (input) => {
    actor.deletes.push(input)
    if (name.includes("rejected")) throw new Error("删除请求被拒绝")
    actor.confirmed = true
    return { id: input.id, deletedAt: Date.now() }
  })
  await page.exposeFunction("fixtureSnapshot", () => {
    actor.snapshots++
    throw new Error("删除后的快照同步断线")
  })
  await page.exposeFunction("fixtureStatus", () => {
    actor.status++
    return { hostId: "fixture-host", capabilities: ["file-lifecycle", "file-delete-epoch"] }
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
    await test(page, panel, calls, pending, actor)
    assert.deepEqual(
      routineReads,
      kind === "group" ? [] : calls.includes("direct-b") ? ["bot-a", "bot-b"] : ["bot-a"],
      "Only the initially visible details summary may read routines; library recovery adds no reads"
    )
    assert.deepEqual(unexpected, [], "File deletion must not invoke other RPCs")
    assert.deepEqual(
      await page.evaluate(() => window.fixtureDrafts()),
      drafts,
      "File deletion changed unrelated persisted drafts"
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
    result.mockRPC = actor
    result.artifactReads = [...calls]
    result.routineReads = [...routineReads]
    result.otherRPCs = [...unexpected]
    observations.push(result)
    pending.splice(0).forEach((done) => done())
    await page.close()
  }
}
try {
  for (const kind of ["direct", "group"]) {
    await run(
      `${kind}: confirmed deletion survives a pre-delete list response`,
      kind,
      (id, calls, pending) => {
        if (calls.length === 1) return [file(id, "待清理.txt")]
        if (calls.length === 2)
          return new Promise((resolve) => pending.push(() => resolve([file(id, "待清理.txt")])))
        return [{ ...file(id, "保留副本.txt"), id: `keep-${id}` }]
      },
      async (page, panel, calls, pending, actor) => {
        const row = panel.getByRole("button", { name: "删除文件 待清理.txt", exact: true })
        await row.waitFor()
        await page.evaluate(() => window.fixtureCursor())
        await page.waitForFunction(() => window.artifactReads === 2)
        await row.click()
        await panel.getByRole("button", { name: "确认删除文件", exact: true }).click()
        await panel.getByRole("alert").getByText("删除后的快照同步断线", { exact: true }).waitFor()
        actor.rowBeforeOldResponse = await row.count()
        assert.equal(
          actor.rowBeforeOldResponse,
          0,
          "Confirmed deletion must initially remove the row"
        )
        assert.equal(actor.confirmed, true)
        assert.equal(actor.deletes.length, 1)
        assert.equal(actor.snapshots, 1)
        assert.equal(actor.status, 1)
        pending.splice(0).forEach((done) => done())
        await page.waitForFunction(() => window.returnedReads?.includes(2))
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        )
        actor.rowAfterOldResponse = await row.count()
        assert.equal(
          actor.rowAfterOldResponse,
          0,
          "Pre-delete read must not resurrect a confirmed deleted file"
        )
        await panel.getByRole("button", { name: "删除文件 保留副本.txt", exact: true }).waitFor()
        assert.deepEqual(
          calls,
          Array(3).fill(kind === "group" ? "group-a" : "direct-a"),
          "Confirmed deletion must perform one bounded current list read"
        )
      }
    )
    await run(
      `${kind}: rejected deletion preserves the row and pending list read`,
      kind,
      (id, calls, pending) => {
        if (calls.length === 1) return [file(id, "待清理.txt")]
        return new Promise((resolve) => pending.push(() => resolve([file(id, "待清理.txt")])))
      },
      async (page, panel, calls, pending, actor) => {
        const row = panel.getByRole("button", { name: "删除文件 待清理.txt", exact: true })
        await row.waitFor()
        await page.evaluate(() => window.fixtureCursor())
        await page.waitForFunction(() => window.artifactReads === 2)
        await row.click()
        await panel.getByRole("button", { name: "确认删除文件", exact: true }).click()
        await panel.getByRole("alert").getByText("删除请求被拒绝", { exact: true }).waitFor()
        actor.rowBeforeOldResponse = await row.count()
        assert.equal(actor.rowBeforeOldResponse, 1)
        assert.equal(actor.confirmed, false)
        assert.equal(actor.deletes.length, 1)
        assert.equal(actor.snapshots, 0)
        assert.equal(actor.status, 0)
        pending.splice(0).forEach((done) => done())
        await page.waitForFunction(() => window.returnedReads?.includes(2))
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        )
        actor.rowAfterOldResponse = await row.count()
        assert.equal(
          actor.rowAfterOldResponse,
          1,
          "Rejected deletion must preserve the server-confirmed row"
        )
        assert.deepEqual(
          calls,
          Array(2).fill(kind === "group" ? "group-a" : "direct-a"),
          "Rejected deletion must not request another list"
        )
        assert.equal(
          await panel.getByRole("button", { name: "确认删除文件", exact: true }).count(),
          1
        )
      }
    )
  }
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
