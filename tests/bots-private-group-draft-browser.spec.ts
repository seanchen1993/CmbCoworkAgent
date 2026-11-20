/** Real mention picker, queue controls, draft sender and SQLite admission. No real model or IM. */
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { BotStore } from "../src/main/bots/store"
import { botImScopeId } from "../src/main/bots/im-gateway-store"
import { parseSendBotMessage } from "../src/shared/bots/validation"

async function main() {
  const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
  const store = new BotStore(db)
  const create = (name: string) =>
    store.create({ name, instructions: "Help", modelRef: null, color: "#188e87" })
  const bot = create("私人助手"),
    service = create("群协作助手")
  const groupId = botImScopeId("local-test", "owner", "group")
  store.imGateway.register("local-test", "owner", {
    id: "group",
    botId: service.id,
    kind: "group",
    label: "产品协作群",
    peerLabel: "产品协作群",
    state: "active",
    version: 1,
    conversationKey: "channel-group",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  })
  store.im.importImBinding({
    id: groupId,
    botId: service.id,
    kind: "group",
    label: "产品协作群",
    channelKey: "channel-group",
    version: 1
  })
  store.im.setOnline(service.id, groupId, true)
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."),
      loader: "tsx",
      contents: `
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BotPrivateMentionInput} from './src/renderer/src/components/bots/BotGroupMentionInput';
import {QueuedMessageActions} from './src/renderer/src/components/chat/QueuedMessageActions';
import {BotDraftSender} from './src/renderer/src/lib/bot-draft-sender';
window.electron={process:{platform:'darwin'}};
const restore=()=>{const raw=localStorage.getItem('draft');if(!raw)return;const d=JSON.parse(raw);return {...d,created_at:new Date(d.created_at),updated_at:new Date(d.updated_at),...(d.handoffRequestedAt?{handoffRequestedAt:new Date(d.handoffRequestedAt)}:{})}};
const state=window.fixture={draft:restore(),editor:{text:'',mentions:[]},error:null,publish:()=>{}};
const persist=()=>{if(state.draft)localStorage.setItem('draft',JSON.stringify(state.draft));else localStorage.removeItem('draft');state.publish()};
const queue={getQueuedMessage:()=>state.draft,updateQueuedMessage:(id,patch,done)=>{state.draft={...state.draft,...patch,updated_at:new Date()};persist();done?.(null)},deleteQueuedMessage:(id,done)=>{state.draft=undefined;persist();done?.(null)}};
const sender=new BotDraftSender({send:input=>window.sendBotDraft(input),requestReceipts:(id,checks)=>window.botDraftReceipts(id,checks)},${JSON.stringify(bot.id)},queue,error=>{state.error=error;state.publish()},()=>state.publish());
const groups=[{id:${JSON.stringify(groupId)},source:'zhaohu',name:'产品协作群',description:'服务 Bot · 群协作助手',available:true}];
function Fixture(){const [,render]=useState(0),ref=useRef(null);state.publish=()=>render(n=>n+1);const draft=state.draft;
return <main className="bots-workspace" style={{display:'block',height:'100vh'}}><section style={{width:720,margin:'auto',padding:'50px 24px'}}>
 <header style={{textAlign:'center',marginBottom:50}}>私人助手 · 本地发送验收</header>
 {state.error&&<div role="alert" style={{padding:16,background:'var(--bot-hover)',borderRadius:12,marginBottom:30}}>{state.error}</div>}
 {draft&&<div data-testid="queued" style={{marginBottom:24}}><div style={{fontSize:12,color:'var(--bot-muted)',marginBottom:8}}>待确认 1 条</div><div style={{display:'flex',alignItems:'center',gap:8,padding:12,border:'1px solid var(--bot-line)',borderRadius:12}}>
  <span style={{flex:1}}>{draft.text}<small style={{display:'block'}}>📎 brief.md</small></span>
  <button type="button" disabled={sender.sending.has(draft.id)} onClick={()=>sender.send(draft)}>重试发送</button>
  <QueuedMessageActions botState={sender.sending.has(draft.id)?'sending':draft.handoffRequestedAt?'unconfirmed':'queued'} onEdit={()=>{throw Error('Pending payload must remain immutable')}} onDelete={()=>sender.discard(draft)}/>
 </div></div>}
 <div style={{padding:18,border:'1px solid var(--bot-line)',borderRadius:24}}>
  <BotPrivateMentionInput {...state.editor} members={[]} inputRef={ref} onEdit={next=>{state.editor=next;state.publish()}} onCancelReply={()=>false} onPasteFiles={()=>{}} placeholder="给私人助手发消息…" privateChat={{groups,files:[],disabled:false,onSelectFile:()=>{},onKeyDown:()=>{},onCaret:()=>{}}}/>
 </div>
 <button style={{marginTop:16}} disabled={!!draft} onClick={()=>{const now=new Date();state.draft={id:crypto.randomUUID(),text:state.editor.text,botMentions:state.editor.mentions,attachmentModelBlocks:'\\n<file path="shared/brief.md">Review brief</file>',attachmentDisplayPrefix:'📎 brief.md',created_at:now,updated_at:now};persist();sender.send(state.draft)}}>发送消息</button>
</section></main>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const files = [
    "components/bots/BotGroupMentionInput.tsx",
    "components/bots/BotMentionLabel.tsx",
    "components/chat/QueuedMessageActions.tsx",
    "components/ui/popover.tsx"
  ]
  const stylesheet = await compile(await readFile("src/renderer/src/index.css", "utf8"), {
    base: resolve("src/renderer/src"),
    onDependency: () => {}
  })
  const css =
    stylesheet.build(
      new Scanner({}).scanFiles(
        await Promise.all(
          files.map(async (file) => ({
            content: await readFile(`src/renderer/src/${file}`, "utf8"),
            extension: "tsx"
          }))
        )
      )
    ) + (await readFile("src/renderer/src/components/bots/bots.css", "utf8"))
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(
      req.url === "/entry.js"
        ? bundle.outputFiles[0].text
        : `<meta charset="utf-8"><style>${css}</style><div id="root"></div><script type="module" src="/entry.js"></script>`
    )
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" })
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    page.setDefaultTimeout(5000)
    const errors: string[] = [],
      sends: string[] = []
    let hold: Promise<void> | undefined, release: (() => void) | undefined
    let loseReceipt = false
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("sendBotDraft", async (raw) => {
      const input = parseSendBotMessage(raw)
      sends.push(input.requestId)
      await hold
      const task = store.enqueue(input)
      if (loseReceipt) throw new Error("Response lost after acceptance")
      return task
    })
    await page.exposeFunction("botDraftReceipts", (id, checks) => {
      if (loseReceipt) throw new Error("Receipt transport unavailable")
      return store.requestReceipts(id, checks)
    })
    const url = `http://127.0.0.1:${address.port}`
    await page.goto(url)
    const editor = page.getByRole("textbox", { name: "私聊消息" })
    const compose = async () => {
      await editor.fill("@")
      await page.getByRole("option").filter({ hasText: "产品协作群" }).click()
      await page.keyboard.type("把这个结论给他")
    }
    await compose()
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.waitForFunction(() => !(window as any).fixture.draft)
    assert.equal(store.recentTasks().length, 1)
    assert.equal(await page.getByRole("alert").count(), 0)
    const accepted = store.recentTasks()[0]
    assert.equal(accepted.origin?.kind, "user")
    if (accepted.origin?.kind === "user")
      assert.equal((accepted.origin.mentions?.[0] as any).groupSource, "zhaohu")
    assert(accepted.message.includes("Review brief"))

    // Real rejected destination, matching the user's retained failure (not a synthetic queue state).
    store.im.setOnline(service.id, groupId, false)
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "离线" }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "删除待发消息", exact: true }).isEnabled(),
      true
    )
    await page.getByRole("button", { name: "更多", exact: true }).click()
    await page.getByRole("button", { name: "编辑消息", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "编辑消息", exact: true }).isDisabled(),
      true
    )
    await mkdir("/tmp/bot-group-handoff-ui", { recursive: true })
    await page.screenshot({ path: "/tmp/bot-group-handoff-ui/failed-draft-actions.png" })
    await page
      .locator('[data-slot="popover-content"]')
      .getByRole("button", { name: "删除待发消息" })
      .click()
    await page.waitForFunction(
      () => !(window as any).fixture.draft && !(window as any).fixture.error
    )
    const sentBeforeReload = sends.length
    await page.reload()
    assert.equal(await page.getByTestId("queued").count(), 0)
    assert.equal(sends.length, sentBeforeReload)

    // Direct trash also works after reopening a failed send; no repeat dispatch or agent cancel.
    await compose()
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByRole("alert").waitFor()
    await page.reload()
    await page.getByRole("button", { name: "删除待发消息", exact: true }).click()
    await page.waitForFunction(() => !(window as any).fixture.draft)

    // Menu remains responsive during IPC; deletion is locked only until the call settles.
    await compose()
    hold = new Promise<void>((done) => {
      release = done
    })
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.waitForFunction(() => !!(window as any).fixture.draft?.handoffRequestedAt)
    assert.equal(
      await page.getByRole("button", { name: "删除待发消息", exact: true }).isDisabled(),
      true
    )
    await page.getByRole("button", { name: "更多", exact: true }).click()
    await page.getByText("正在发送，请稍候。", { exact: true }).waitFor()
    release!()
    hold = undefined
    await page.getByRole("alert").waitFor()
    await page.keyboard.press("Escape")
    const originalRequest = await page.evaluate(() => (window as any).fixture.draft.id)
    await page.reload()
    store.im.setOnline(service.id, groupId, true)
    await page.getByRole("button", { name: "重试发送" }).click()
    await page.waitForFunction(() => !(window as any).fixture.draft)
    assert.equal(sends.at(-1), originalRequest)
    assert.equal(store.recentTasks().filter((task) => task.requestId === originalRequest).length, 1)
    assert.equal(store.recentTasks().length, 2)

    // Removing an uncertain record is not a cancellation, even if main accepted it before a lost response.
    loseReceipt = true
    await compose()
    await page.getByRole("button", { name: "发送消息", exact: true }).click()
    await page.getByRole("alert").waitFor()
    const uncertainRequest = await page.evaluate(() => (window as any).fixture.draft.id)
    const received = store.recentTasks().find((task) => task.requestId === uncertainRequest)!
    assert.equal(received.state, "queued")
    await page.getByRole("button", { name: "删除待发消息", exact: true }).click()
    await page.waitForFunction(() => !(window as any).fixture.draft)
    assert.equal(store.getTask(received.id).state, "queued")
    await page.reload()
    assert.equal(await page.getByTestId("queued").count(), 0)
    assert.equal(sends.filter((id) => id === uncertainRequest).length, 1)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: real Zhaohu selection -> SQLite send, failed send menu/trash, persistence after reload, in-flight lock, same-nonce retry without duplicates"
    )
  } finally {
    await browser.close()
    await new Promise<void>((done) => server.close(() => done()))
    db.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
