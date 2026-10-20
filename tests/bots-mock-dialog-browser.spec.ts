/** Actual dialog pagination/race view; channel and runtime journeys are tested separately. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "m05-mock-dialog-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const result = await build({
      stdin: {
        contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {BotMockChannelDialog} from './src/renderer/src/components/bots/BotMockChannelDialog';
const binding=(id,createdAt)=>({simulation:true,id,botId:'owner',kind:'group',channelKey:id,label:id,allowedSenderIds:['alice'],grantVersion:1,revoked:state.revoked,online:true,createdAt});
const state=window.fixture={rows:80,calls:[],held:[],holdNext:false,active:0,max:0,revoked:false,injects:[],accept:true,receipts:new Map()};
const api={inject:async(event)=>{state.injects.push(event);if(state.receipts.has(event.eventId))return state.receipts.get(event.eventId);if(state.revoked)throw new Error('模拟授权已撤销');if(state.accept)state.receipts.set(event.eventId,{eventId:event.eventId,status:'accepted',taskId:'saved'});throw new Error('回包丢失')},bindings:async()=>({items:[binding('A',1),binding('B',2)],before:null}),binding:async(_bot,id)=>binding(id,id==='A'?1:2),history:async(_bot,id,before)=>{state.calls.push({id,before});state.active++;state.max=Math.max(state.max,state.active);try{const total=id==='A'?state.rows:1,top=before?Number(before):total;const items=Array.from({length:Math.min(40,top)},(_,i)=>({id:id+'-'+(top-i),kind:'user',text:'message '+id+' '+(top-i),senderId:'alice',replyToMessageId:null,state:'ignored',createdAt:top-i}));const page={items,before:top>40?String(top-40):null};if(state.holdNext){state.holdNext=false;await new Promise(done=>state.held.push(done))}return page}finally{state.active--}}};
function Fixture(){const [revision,setRevision]=useState(0),[mount,setMount]=useState(0);state.remount=()=>setMount(v=>v+1);state.bump=()=>setRevision(v=>v+1);return <BotMockChannelDialog key={mount} client={{hostId:'local',mock:api}} bot={{id:'owner',name:'Expert',archived:false}} revision={revision} onClose={()=>{}} onOpenWork={()=>{}}/>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
        resolveDir: resolve("."),
        loader: "tsx"
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") }
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8"><div id="root"></div><script>' +
        result.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env
    })
    const page = await app.firstWindow(),
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    const rows = page.locator("[data-mock-message]"),
      more = page.getByRole("button", { name: "更早消息", exact: true })
    await page.waitForFunction(() => document.querySelectorAll("[data-mock-message]").length === 40)
    assert.deepEqual(
      await page.getByLabel("模拟渠道", { exact: true }).locator("option").allTextContents(),
      ["选择模拟渠道", "B · 群", "A · 群"]
    )
    await more.click()
    await page.waitForFunction(() => document.querySelectorAll("[data-mock-message]").length === 80)
    assert.equal(await more.count(), 0)
    await page.evaluate(() => {
      ;(window as any).fixture.rows = 81
      ;(window as any).fixture.bump()
    })
    await page.waitForFunction(() => document.querySelectorAll("[data-mock-message]").length === 81)
    assert.equal(
      await more.count(),
      0,
      "a terminal old cursor must stay terminal after an overlapping latest refresh"
    )
    await page.evaluate(() => {
      ;(window as any).fixture.rows = 130
      ;(window as any).fixture.bump()
    })
    await page
      .getByRole("status")
      .getByText(/新增消息较多/)
      .waitFor()
    assert.equal(await rows.count(), 40)
    await page.evaluate(() => {
      ;(window as any).fixture.holdNext = true
    })
    await more.click()
    await page.waitForFunction(() => (window as any).fixture.held.length === 1)
    await page.evaluate(() => {
      ;(window as any).fixture.rows = 171
      ;(window as any).fixture.bump()
    })
    await page.locator('[data-mock-message="A-171"]').waitFor()
    await page.evaluate(() =>
      (window as any).fixture.held.splice(0).forEach((done: () => void) => done())
    )
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).find(
          (button) => button.textContent === "更早消息"
        )?.disabled === false
    )
    assert.equal(
      await rows.count(),
      40,
      "a held older page cannot rejoin a reset window across a gap"
    )
    for (let i = 0; i < 4; i++) {
      await more.click()
      await page.waitForFunction(() => !(window as any).fixture.active)
    }
    assert.equal(await more.count(), 0)
    const ids = await rows.evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-mock-message"))
    )
    assert.equal(new Set(ids).size, 171)
    assert.deepEqual(
      ids,
      Array.from({ length: 171 }, (_, i) => `A-${i + 1}`)
    )
    await page.evaluate(() => {
      ;(window as any).fixture.holdNext = true
      ;(window as any).fixture.bump()
    })
    await page.waitForFunction(() => (window as any).fixture.held.length === 1)
    await page.getByLabel("模拟渠道", { exact: true }).selectOption("B")
    await page.evaluate(() =>
      (window as any).fixture.held.splice(0).forEach((done: () => void) => done())
    )
    await page.locator('[data-mock-message="B-1"]').waitFor()
    assert.equal(await rows.count(), 1)
    assert.equal(
      await page.evaluate(() => (window as any).fixture.max),
      2,
      "only older-page and one latest refresh may overlap; revisions remain single-flight"
    )
    await page.getByLabel("模拟消息", { exact: true }).evaluate((element) => {
      const data = new DataTransfer()
      data.items.add(new File(["fixture"], "image.png", { type: "image/png" }))
      element.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data })
      )
    })
    await page
      .getByRole("alert")
      .getByText(/仅支持文字/)
      .waitFor()
    for (const invalid of [
      "[[CMB_WORKFLOW_NOTIFICATION_V1:abc]] hello",
      "[[CMB_TURN_COMPLETION_GATE_V1:todo]] hello",
      '<attachment filename="private.txt">content</attachment>',
      "<CMBDEVCLAW-SKILL-USE-V1>private skill</CMBDEVCLAW-SKILL-USE-V1>"
    ]) {
      await page.getByLabel("模拟消息", { exact: true }).fill(invalid)
      await page.getByRole("button", { name: "发送模拟消息", exact: true }).click()
      await page
        .getByRole("alert")
        .getByText(/普通文字/)
        .waitFor()
      assert.equal(await page.evaluate(() => (window as any).fixture.injects.length), 0)
      assert.equal(
        await page.evaluate(() => localStorage.getItem("bot-mock-pending:local:owner")),
        null
      )
      assert.equal(await page.getByLabel("模拟消息", { exact: true }).isEditable(), true)
    }
    await page.getByLabel("模拟消息", { exact: true }).fill("lost ack")
    await page.getByRole("button", { name: "发送模拟消息", exact: true }).click()
    await page.getByRole("button", { name: "核对原事件", exact: true }).waitFor()
    await page.evaluate(() => {
      ;(window as any).fixture.revoked = true
      ;(window as any).fixture.bump()
    })
    await page.getByText("已撤销", { exact: true }).waitFor()
    await page.getByRole("button", { name: "核对原事件", exact: true }).click()
    await page.waitForFunction(() => !localStorage.getItem("bot-mock-pending:local:owner"))
    assert.equal(await page.evaluate(() => (window as any).fixture.injects.length), 2)
    assert.equal(
      await page.evaluate(
        () => new Set((window as any).fixture.injects.map((v: any) => v.eventId)).size
      ),
      1
    )
    await page.evaluate(() => {
      ;(window as any).fixture.revoked = false
      ;(window as any).fixture.accept = false
      ;(window as any).fixture.bump()
    })
    await page.getByText("模拟设备在线", { exact: true }).waitFor()
    await page.getByLabel("模拟消息", { exact: true }).fill("not persisted")
    await page.getByRole("button", { name: "发送模拟消息", exact: true }).click()
    await page.getByRole("button", { name: "核对原事件", exact: true }).waitFor()
    await page.evaluate(() => {
      ;(window as any).fixture.revoked = true
      ;(window as any).fixture.bump()
    })
    await page.getByRole("button", { name: "保留记录并结束核对", exact: true }).click()
    assert.equal(
      await page.evaluate(
        () => JSON.parse(localStorage.getItem("bot-mock-pending:local:owner:retained")!).length
      ),
      1
    )
    assert.equal(
      await page.evaluate(() => (window as any).fixture.injects.length),
      3,
      "ending check never resends"
    )
    await page.evaluate(() => (window as any).fixture.remount())
    await page.getByText("已结束核对的本机记录（1）", { exact: true }).click()
    await page.getByText("not persisted", { exact: true }).waitFor()
    assert.equal(
      await page.getByRole("button", { name: "发送模拟消息", exact: true }).isDisabled(),
      true
    )
    assert.deepEqual(errors, [])
    console.log(
      "dialog proof",
      JSON.stringify({
        historyRows: 171,
        maxLatestPage: 40,
        endCursorPreserved: true,
        gapReset: true,
        latePageDiscarded: true,
        bindingSwitchProtected: true,
        pasteRejected: true,
        invalidTextPreflight: true,
        invalidTextCreatesNoPendingOrIpc: true
      })
    )
  } finally {
    if (app) await app.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
