/** Real mention editors: restoring a draft or toggling availability must not invent an edit. */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"

async function main() {
  const bundle = await build({
    stdin: {
      resolveDir: resolve("."), loader: "tsx", contents: `
import React,{useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {BotGroupMentionInput,BotPrivateMentionInput} from './src/renderer/src/components/bots/BotGroupMentionInput';
window.electron={process:{platform:'darwin'}};
const state=window.fixture={edits:[],disabled:false,mode:'group',generation:0};
const root=createRoot(document.getElementById('root'));
function Fixture(){
 const ref=useRef(null);
 const [value,setValue]=useState({text:'@Peer saved draft',mentions:[{start:0,end:5,botId:'peer',label:'Peer'}]});
 const props={...value,members:[],inputRef:ref,onEdit:next=>{state.edits.push(next);setValue(next)},onCancelReply:()=>false,onPasteFiles:()=>{}};
 return state.mode==='group'?<BotGroupMentionInput {...props}/>:<BotPrivateMentionInput {...props} privateChat={{groups:[],files:[],disabled:state.disabled,onSelectFile:()=>{},onKeyDown:()=>{},onCaret:()=>{}}}/>;
}
state.render=()=>root.render(<Fixture key={state.mode+state.generation}/>);
state.render();`
    },
    bundle: true, write: false, format: "esm", platform: "browser", jsx: "automatic",
    alias: { "@": resolve("src/renderer/src") },
    define: { "process.env.NODE_ENV": '"production"' }
  })
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/entry.js" ? "text/javascript" : "text/html")
    res.end(req.url === "/entry.js" ? bundle.outputFiles[0].text
      : '<meta charset="utf-8"><div id="root"></div><script type="module" src="/entry.js"></script>')
  })
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address !== "string")
  const browser = await chromium.launch({
    ...(existsSync(chromium.executablePath()) ? {} : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
    headless: true
  })
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(5000)
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(`http://127.0.0.1:${address.port}`)
    for (const mode of ["group", "private"]) {
      await page.evaluate(mode => {
        const state = (window as any).fixture
        state.mode = mode; state.edits = []; state.disabled = false; state.render()
      }, mode)
      const editor = page.getByRole("textbox", { name: mode === "group" ? "群聊消息" : "私聊消息" })
      await editor.waitFor()
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      assert.equal(await page.evaluate(() => (window as any).fixture.edits.length), 0, `${mode}: mount is not an edit`)
      if (mode === "private") {
        for (const disabled of [true, false]) {
          await page.evaluate(disabled => {
            const state = (window as any).fixture
            state.disabled = disabled; state.render()
          }, disabled)
          await page.waitForFunction(disabled => document.querySelector('[role="textbox"]')?.getAttribute("contenteditable") === String(!disabled), disabled)
          assert.equal(await page.evaluate(() => (window as any).fixture.edits.length), 0, "availability is not an edit")
        }
      }
      await editor.click()
      await page.keyboard.press("ControlOrMeta+End")
      await page.keyboard.type("X")
      await page.waitForFunction(() => (window as any).fixture.edits.length > 0)
      const edits = await page.evaluate(() => (window as any).fixture.edits)
      assert.match(edits.at(-1).text, /X/)
      assert.equal(edits.at(-1).mentions[0].botId, "peer", "real edits retain mention identity")
      await page.evaluate(() => {
        const state = (window as any).fixture
        state.edits = []; state.generation++; state.render()
      })
      await editor.waitFor()
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
      assert.equal(await page.evaluate(() => (window as any).fixture.edits.length), 0, `${mode}: reopening is not an edit`)
    }
    assert.deepEqual(errors, [])
    console.log("PASS: group/private restored mention drafts, disabled/enabled transitions, real typing and remount")
  } finally {
    await browser.close()
    await new Promise<void>(done => server.close(() => done()))
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
