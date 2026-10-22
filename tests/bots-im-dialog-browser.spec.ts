import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-im-dialog-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  try {
    const result = await build({
      stdin: {
        resolveDir: resolve("."),
        loader: "tsx",
        contents: `
import React from 'react';import {createRoot} from 'react-dom/client';import {BotImChannelDialog} from './src/renderer/src/components/bots/BotImChannelDialog';
const state=window.fixture={available:false,attempts:[],bindings:[],opened:[],close:0,lost:true};
const api={status:async()=>({connected:true,available:state.available}),list:async()=>({items:state.bindings,before:null}),
create:async(botId,kind,operationId)=>{state.attempts.push(operationId);if(state.lost){state.lost=false;throw new Error('回包丢失，请重试')}const b={id:'binding-one',botId,kind,label:'测试 Bot',state:'pending',version:1,conversationKey:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),instruction:'/绑定Bot abcdefghijklmnopqrstuvwx'};state.bindings=[b];return b},
revoke:async()=>{state.bindings=[{...state.bindings[0],state:'revoked',version:2,instruction:undefined}];return state.bindings[0]},
history:async()=>({items:state.bindings[0]?.state==='active'?[{id:'reply',kind:'bot',text:'这是群内通知的回复',senderId:'Bot',state:'accepted',replyToMessageId:null,createdAt:1,workId:'work-one'}]:[],before:null})};
createRoot(document.getElementById('root')).render(<BotImChannelDialog client={{hostId:'local',im:api}} bot={{id:'bot',name:'测试 Bot',archived:false}} onClose={()=>state.close++} onOpenWork={id=>state.opened.push(id)}/>);`
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      define: { "process.env.NODE_ENV": '"production"' },
      alias: { "@": resolve("src/renderer/src") }
    })
    const assets = process.env.BOT_TEST_APP_OUT
      ? join(process.env.BOT_TEST_APP_OUT, "renderer/assets")
      : undefined
    const css = assets
      ? (await readdir(assets)).filter((name) => name.startsWith("index-") && name.endsWith(".css"))
      : []
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="UTF-8">' +
        css
          .map((name) => `<link rel="stylesheet" href="${pathToFileURL(join(assets!, name))}">`)
          .join("") +
        '<div id="root"></div><script>' +
        result.outputFiles[0].text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow,session}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>{session.defaultSession.webRequest.onBeforeRequest((request,done)=>done({cancel:!request.url.startsWith('file:')&&!request.url.startsWith('data:')}));new BrowserWindow({show:false,width:1100,height:950,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))})})`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron"),
      args: [join(dir, "main.cjs")],
      env,
      timeout: 15000
    })
    const page = await app.firstWindow({ timeout: 15000 }),
      errors: string[] = []
    page.setDefaultTimeout(15000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page
      .getByText("当前网关尚未开启 Bot 接入，请升级并启用后重试。", { exact: true })
      .waitFor()
    assert(await page.getByRole("button", { name: "生成绑定指令" }).isDisabled())
    await page.evaluate(() => {
      ;(window as any).fixture.available = true
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByLabel("IM 绑定类型").selectOption("group")
    await page.getByRole("button", { name: "生成绑定指令" }).click()
    await page.getByRole("alert").getByText("回包丢失，请重试").waitFor()
    await page.getByRole("button", { name: "生成绑定指令" }).click()
    await page.getByText("/绑定Bot abcdefghijklmnopqrstuvwx", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => new Set((window as any).fixture.attempts).size), 1)
    await page.evaluate(() => {
      const b = (window as any).fixture.bindings[0]
      b.state = "active"
      b.conversationKey = "group"
      delete b.instruction
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByText("这是群内通知的回复", { exact: true }).waitFor()
    await page.getByText("网关已接收", { exact: true }).waitFor()
    if (process.env.BOT_TEST_APP_OUT)
      await page.screenshot({
        path: join(process.env.BOT_TEST_APP_OUT, "artifacts/bot-im-dialog.png"),
        fullPage: true
      })
    await page.getByRole("button", { name: "打开独立任务 →" }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.opened), ["work-one"])
    await page.getByRole("button", { name: "撤销", exact: true }).click()
    await page.getByText("群聊 · 已撤销", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 0)
    assert.deepEqual(errors, [])
    console.log(
      "PASS: IM dialog capability fallback, stable create retry, group proof, reply status, task navigation and revoke"
    )
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
