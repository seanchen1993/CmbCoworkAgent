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
import {applyThemePreference} from './src/renderer/src/lib/theme-preference';
window.setFixtureTheme=applyThemePreference;applyThemePreference('cmbdevclaw-white');
const state=window.fixture={connected:false,available:false,settingsOpened:0,attempts:[],bindings:[],opened:[],mainOpened:0,close:0,lost:true,targets:[],replacements:[],scope:'test-environment'};
const api={status:async()=>({connected:state.connected,available:state.available,scope:state.scope}),replacementTargets:async(kind)=>state.targets.filter(b=>b.kind===kind),list:async()=>({items:state.bindings,before:null}),
create:async(botId,kind,operationId,replace)=>{state.attempts.push(operationId);state.replacements.push(replace);if(state.lost){state.lost=false;throw new Error('回包丢失，请重试')}const target=replace??(kind==='dm'?state.targets.find(t=>t.kind==='dm'):undefined);const b={id:'binding-one',botId,kind,label:'测试 Bot',state:'pending',version:1,conversationKey:null,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),instruction:'/绑定Bot abcdefghijklmnopqrstuvwx',...(target?{replacedBindingId:target.bindingId??target.id}:{})};state.bindings=[b];if(target)state.targets=state.targets.filter(t=>t.id!==b.replacedBindingId);return b},
revoke:async()=>{state.bindings=[{...state.bindings[0],state:'revoked',version:2,instruction:undefined}];return state.bindings[0]},
history:async()=>({items:state.bindings[0]?.state==='active'?[{id:'reply',kind:'bot',text:'这是群内通知的回复',senderId:'Bot',state:'accepted',replyToMessageId:null,createdAt:1,workId:'work-one'}]:[],before:null})};
createRoot(document.getElementById('root')).render(<BotImChannelDialog client={{hostId:'local',im:api}} bot={{id:'bot',name:'测试 Bot',archived:false}} onOpenSettings={()=>state.settingsOpened++} onClose={()=>state.close++} onOpenWork={id=>state.opened.push(id)} onOpenMain={()=>state.mainOpened++}/>);`
      },
      bundle: true,
      format: "iife",
      platform: "browser",
      jsx: "automatic",
      write: false,
      outfile: join(dir, "fixture.js"),
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
        result.outputFiles.find((file) => file.path.endsWith(".js"))!.text +
        "</script><style>" +
        result.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join("\n") +
        "</style>"
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
    const screenshot = async (name: string) => {
      if (process.env.BOT_TEST_APP_OUT)
        await page.screenshot({
          path: join(process.env.BOT_TEST_APP_OUT, "artifacts", name),
          animations: "disabled"
        })
    }
    await page.getByText("尚未连接招乎", { exact: true }).waitFor()
    assert(await page.getByRole("button", { name: "生成绑定指令" }).isDisabled())
    await screenshot("bot-im-connect-offline.png")
    await page.getByRole("button", { name: "去设置", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.settingsOpened), 1)
    await page.evaluate(() => {
      ;(window as any).fixture.connected = true
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page
      .getByText("当前网关尚未开启 Bot 接入，请升级并启用后重试。", { exact: true })
      .waitFor()
    assert(await page.getByRole("button", { name: "生成绑定指令" }).isDisabled())
    await page.evaluate(() => {
      ;(window as any).fixture.available = true
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByRole("radio", { name: "群聊", exact: true }).check()
    assert(await page.getByRole("radio", { name: "群聊", exact: true }).isChecked())
    await screenshot("bot-im-connect-ready.png")
    await page.getByRole("button", { name: "生成绑定指令" }).click()
    await page.getByRole("alert").getByText("回包丢失，请重试").waitFor()
    await page.getByRole("button", { name: "生成绑定指令" }).click()
    await page.getByText("/绑定Bot abcdefghijklmnopqrstuvwx", { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => new Set((window as any).fixture.attempts).size), 1)
    await page.getByRole("button", { name: "复制绑定指令", exact: true }).click()
    await page.getByRole("button", { name: "已复制", exact: true }).waitFor()
    await screenshot("bot-im-connect-pending.png")
    await page.evaluate(() => (window as any).setFixtureTheme("codex-dark"))
    await screenshot("bot-im-connect-pending-dark.png")
    await page.setViewportSize({ width: 420, height: 760 })
    await screenshot("bot-im-connect-compact.png")
    assert.equal(
      await page.locator("[role=dialog]").evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    )
    assert.equal(
      await page.locator(".bot-im-connect-body").evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    )
    await page.setViewportSize({ width: 1100, height: 950 })
    await page.evaluate(() => (window as any).setFixtureTheme("cmbdevclaw-white"))
    await page.evaluate(() => {
      const b = (window as any).fixture.bindings[0]
      b.state = "active"
      b.conversationKey = "group"
      delete b.instruction
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByText("接入记录", { exact: true }).click()
    await page.getByText("这是群内通知的回复", { exact: true }).waitFor()
    await page.getByText("网关已接收", { exact: true }).waitFor()
    if (process.env.BOT_TEST_APP_OUT)
      await page.screenshot({
        path: join(process.env.BOT_TEST_APP_OUT, "artifacts/bot-im-dialog.png"),
        fullPage: true
      })
    await page.getByRole("button", { name: "打开独立任务" }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.opened), ["work-one"])
    await page.getByRole("button", { name: "撤销", exact: true }).click()
    await page.getByText("已撤销", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "撤销", exact: true }).count(), 0)
    await page.evaluate(() => {
      ;(window as any).fixture.bindings = [
        {
          id: "owner-dm",
          botId: "bot",
          kind: "dm",
          label: "本人",
          state: "active",
          version: 1,
          conversationKey: "dm",
          createdAt: new Date().toISOString()
        }
      ]
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByRole("button", { name: /^本人私聊/ }).click()
    await page.getByText("已关联个人主对话 · 回复同步到招乎", { exact: true }).waitFor()
    if (process.env.BOT_TEST_APP_OUT)
      await page.screenshot({
        path: join(process.env.BOT_TEST_APP_OUT, "artifacts/bot-personal-im-dialog.png"),
        fullPage: true
      })
    const closedBeforeMain = await page.evaluate(() => (window as any).fixture.close)
    await page.getByRole("button", { name: "打开主对话", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.mainOpened), 1)
    assert.equal(await page.evaluate(() => (window as any).fixture.close), closedBeforeMain + 1)
    // Private binding keeps the original generate-and-send path, with no
    // replacement selector. Retry keeps the exact old target.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.targets = [
        {
          id: "previous-dm",
          botId: "old-bot",
          kind: "dm",
          label: "原服务 Bot",
          state: "active",
          version: 1
        },
        {
          id: "previous-group",
          botId: "old-bot",
          kind: "group",
          peerLabel: "产品协作群",
          label: "原服务 Bot",
          state: "active",
          version: 1
        }
      ]
      f.lost = true
    })
    await page.getByRole("radio", { name: "本人私聊", exact: true }).check()
    await page.getByRole("button", { name: "生成绑定指令", exact: true }).waitFor()
    await page
      .getByText("生成新指令会自动解除原私聊绑定；发送后连接此 Bot，历史消息与任务保留。", {
        exact: true
      })
      .waitFor()
    assert.equal(await page.getByRole("combobox", { name: "换绑目标" }).count(), 0)
    // Private target resolution belongs to the main process, not renderer metadata.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.targets = f.targets.map((binding: any) =>
        binding.kind === "dm" ? { ...binding, version: 2 } : binding
      )
    })
    await screenshot("bot-im-replace-dm.png")
    await page.getByRole("button", { name: "生成绑定指令", exact: true }).click()
    await page.getByRole("alert").getByText("回包丢失，请重试").waitFor()
    await page.getByRole("button", { name: "生成绑定指令", exact: true }).click()
    await page
      .getByText("原私聊绑定已解除。发送下方指令后连接此 Bot，历史消息与任务保留。", {
        exact: true
      })
      .waitFor()
    const attempts = await page.evaluate(() => (window as any).fixture.attempts.slice(-2))
    assert.equal(attempts[0], attempts[1])
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.replacements.slice(-2)), [
      undefined,
      undefined
    ])
    await page.getByRole("radio", { name: "群聊", exact: true }).check()
    await page.getByRole("combobox", { name: "换绑目标" }).waitFor()
    assert.equal(await page.getByRole("combobox", { name: "换绑目标" }).inputValue(), "")
    await page.getByRole("combobox", { name: "换绑目标" }).selectOption("previous-group")
    await screenshot("bot-im-replace-group.png")
    await page.evaluate(() => (window as any).setFixtureTheme("codex-dark"))
    await screenshot("bot-im-replace-group-dark.png")
    await page.setViewportSize({ width: 420, height: 760 })
    await screenshot("bot-im-replace-compact.png")
    assert.equal(
      await page.locator(".bot-im-connect-body").evaluate((el) => el.scrollWidth > el.clientWidth),
      false
    )
    await page.getByRole("button", { name: "换绑并生成指令", exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.replacements.at(-1)), {
      botId: "old-bot",
      bindingId: "previous-group",
      version: 1
    })
    await page
      .getByText("原接入已解除。发送下方指令后完成换绑，原会话记录会保留。", { exact: true })
      .waitFor()
    // An in-place gateway switch must discard old history and retry operations.
    await page.evaluate(() => {
      const f = (window as any).fixture
      f.scope = "production-environment"
      f.bindings = []
      f.targets = []
    })
    await page.getByRole("button", { name: "刷新", exact: true }).click()
    await page.getByRole("region", { name: "已有接入" }).waitFor({ state: "detached" })
    assert.equal(await page.getByRole("button", { name: "换绑并生成指令", exact: true }).count(), 0)
    await page.getByRole("button", { name: "生成绑定指令", exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).fixture.replacements.at(-1)), undefined)
    await page.getByText("/绑定Bot abcdefghijklmnopqrstuvwx", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    console.log(
      "PASS: IM dialog capability fallback, stable replacement retry, selected group replacement, environment isolation, reply status and navigation"
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
