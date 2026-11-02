/** Exercise the real IM history component/effect in React, with a paginated IPC substitute. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: { resolveDir: resolve("."), loader: "tsx", contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BotImConversation} from './src/renderer/src/components/bots/BotImConversation';
import {useBotViewStore} from './src/renderer/src/components/bots/view-store';
const root=createRoot(document.getElementById('root'));
const state=window.fixture={revision:0,hidden:false,calls:[],oldState:'completed',hold:false,release:null};
Object.defineProperty(document,'hidden',{configurable:true,get:()=>state.hidden});
const entry=(id,createdAt,status)=>({id,createdAt,kind:'user',text:id,state:status});
const client={hostId:'local',im:{conversationHistory:async (_bot,_conversation,before)=>{
 state.calls.push(before??'latest');
 if(state.hold){state.hold=false;await new Promise(done=>state.release=done)}
 return before==='older'?{items:[entry('old',1,state.oldState)],before:'oldest'}:
   {items:[entry('new',2,'completed')],before:'older'};
}}};
const conversation={id:'im-fixture',botId:'bot',threadId:'im-thread',title:'Fixture',state:'active',connected:true,activity:{unread:false,preview:''}};
const bot={id:'bot',name:'Bot',color:'#ea2845',shape:'circle'};
state.render=()=>root.render(<BotImConversation conversation={conversation} bot={bot} client={client} revision={state.revision} detailOpen={false} onDetails={()=>{}} onManage={()=>{}} onMain={()=>{}} onWork={()=>{}}/>);
state.bump=()=>{state.revision++;state.render()};
state.visibility=hidden=>{state.hidden=hidden;document.dispatchEvent(new Event('visibilitychange'))};
state.details=value=>useBotViewStore.getState().update('local',{showExecutionDetails:value});
state.unmount=()=>root.unmount();
state.render();`
    },
    bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [{ name: "unrelated-surfaces", setup(build) {
      build.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "css" }))
      build.onResolve({ filter: /(?:BotAvatar|BotWorkPanel|BotBrowserPanel|BotSchedulePanel|BotMemoryPanel|BotConversationTools|BotMessageFilePreview|BotExecutionDetailsToggle|use-bot-read-state|ChatContainer)$/ }, args => ({ path: args.path, namespace: "fixture" }))
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ loader: "tsx", contents: `
export const BotAvatar=()=>null, BotWorkPanel=()=>null, BotBrowserPanel=()=>null, BotSchedulePanel=()=>null,
BotMemoryPanel=()=>null,BotMessageFilePreview=()=>null,BotExecutionDetailsToggle=()=>null,ChatContainer=()=>null;
export const BotConversationTools=({children})=>children; export const useBotReadState=()=>{};` }))
    } }],
    outdir: "/virtual"
  })
  const script = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(req.url === "/entry.js" ? script : '<meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({ headless: true,
    ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }) })
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
    const count = () => page.evaluate(() => (window as any).fixture.calls.length)
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.locator('[data-im-message="new"]').waitFor()
    await page.getByRole("button", { name: "查看更早消息" }).click()
    await page.locator('[data-im-message="old"]').waitFor()
    assert.equal(await count(), 2)
    await page.evaluate(() => (window as any).fixture.visibility(true))
    await settle()
    for (let i=0;i<5;i++) {
      await page.evaluate(() => (window as any).fixture.bump())
      await settle()
    }
    assert.equal(await count(), 2, "hidden revisions must not read history")
    await page.evaluate(() => { const s=(window as any).fixture;s.oldState='cancelled';s.visibility(false) })
    await page.waitForFunction(() => document.querySelector('[data-im-message="old"]')?.textContent?.includes('已停止'))
    assert.equal(await count(), 4, "return refreshes latest and already loaded mutable history")
    assert.equal(await page.getByRole("button", { name: "查看更早消息" }).count(), 1, "cursor survives hiding")
    await page.evaluate(() => (window as any).fixture.details(true))
    await settle()
    const beforeDetails = await count()
    await page.evaluate(() => (window as any).fixture.bump())
    await settle()
    assert.equal(await count(), beforeDetails, "execution view must not refresh hidden transcript")
    await page.evaluate(() => (window as any).fixture.details(false))
    await page.waitForFunction(n => (window as any).fixture.calls.length === n+2, beforeDetails)
    // An in-flight page may finish after hiding; it must not continue scanning older pages.
    await page.evaluate(() => {const s=(window as any).fixture;s.hold=true;s.release=null;s.bump()})
    await page.waitForFunction(() => typeof (window as any).fixture.release==='function')
    const pendingCount = await count()
    await page.evaluate(() => {const s=(window as any).fixture;s.visibility(true);s.release()})
    await settle()
    assert.equal(await count(), pendingCount, "hide invalidates pending pagination")
    await page.evaluate(() => (window as any).fixture.visibility(false))
    await page.waitForFunction(n => (window as any).fixture.calls.length===n+2, pendingCount)
    await page.evaluate(() => {const s=(window as any).fixture;s.hold=true;s.release=null;s.bump()})
    await page.waitForFunction(() => typeof (window as any).fixture.release==='function')
    const unmountCount=await count()
    await page.evaluate(() => {const s=(window as any).fixture;s.unmount();s.release();s.visibility(true);s.visibility(false)})
    await settle()
    assert.equal(await count(), unmountCount, "unmount removes listener and stops pagination")
    assert.deepEqual(errors, [])
    console.log("PASS: hidden/detail revisions skip IPC; restore refreshes old statuses and cursor; in-flight hide/unmount stops pagination")
  } finally {
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
  }
}
main().catch(error => { console.error(error); process.exitCode=1 })
