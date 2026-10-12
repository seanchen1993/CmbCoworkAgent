/** Real Chrome widgets + actual SQLite create/update receipts. Native IPC and connector discovery are fixture seams. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
async function main() {
  const draft = resolve(import.meta.dirname, ".."),
    renderer = join(draft, "src/renderer/src"),
    output = join(draft, "output/profile-creation")
  await mkdir(output, { recursive: true })
  const store = new BotStore(":memory:")
  const a = store.createBot({ nonce: "a", name: "Alpha" }),
    b = store.createBot({ nonce: "b", name: "Beta" })
  let holdNext = false,
    loseNext = false,
    loseUpdateNext = false,
    failSnapshotNext = false,
    held: (() => void) | undefined
  const calls: { method: string; input: unknown }[] = []
  const status = () => ({
    protocol: 1,
    hostId: "fixture-host",
    platform: "darwin",
    runtimeReady: true,
    error: null,
    dataEpoch: store.dataEpoch(),
    limits: { bots: 50 },
    capabilities: [
      "mutation-data-epoch-v2",
      "scoped-bot-create",
      "bot-profile-title",
      "bot-update-receipts"
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
  const initial = { snapshot: store.snapshot(), host: status() }
  const bundle = await build({
    stdin: {
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotEditor}from'./src/renderer/src/components/bots/BotEditor';import{BotAvatar}from'./src/renderer/src/components/bots/BotAvatar';import{BotConversationRowActions}from'./src/renderer/src/components/bots/BotConversationRowActions';import{BotQuickCreateFeedback}from'./src/renderer/src/components/bots/BotQuickCreateFeedback';import{useBotQuickCreate}from'./src/renderer/src/lib/use-bot-quick-create';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{botApi}from'./src/renderer/src/lib/bot-api';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
 window.api={bots:Object.fromEntries(['create','update','snapshot','status','messages','connectors','setReadState'].map(method=>[method,async input=>window.fixtureCall(method,input)]))};window.electron={process:{platform:'darwin'}};
 const base=${JSON.stringify(initial)};useBotWorkspaceStore.setState(base);useBotWorkspaceStore.getState().select(${JSON.stringify(a.conversationId)});window.fixtureStore=useBotWorkspaceStore;window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.fixtureSelectionCallbacks=[];window.fixtureClipboard=[];window.fixtureClipboardFails=false;window.fixtureCleanupFails=false;const originalRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails&&key.startsWith('bot-editor-pending:'))throw new Error('local cleanup denied');return originalRemove.call(this,key)};Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>{if(window.fixtureClipboardFails)throw new Error('复制失败，可以手动复制会话 ID。');window.fixtureClipboard.push(value)}}});
 function Fixture(){const state=useBotWorkspaceStore(),quick=useBotQuickCreate(id=>window.fixtureSelectionCallbacks.push(id)),[show,setShow]=useState(false),[editing,setEditing]=useState(null);window.fixtureQuick=quick;window.fixtureSelected=()=>state.selected;const selected=state.snapshot?.bots.find(bot=>state.snapshot?.conversations.find(c=>c.id===state.selected)?.members[0]===bot.id);return <main className='bot-workspace' style={{display:'flex',minHeight:'100vh'}}><aside className='bot-sidebar'><header style={{padding:16,display:'flex',justifyContent:'space-between'}}><strong>Bots</strong><button aria-label='创建 Bot' disabled={quick.state.busy} onClick={()=>{setShow(true);void quick.start()}}>＋</button></header><nav className='bot-conversation-list' style={{padding:12}}>{(state.snapshot?.conversations??[]).map(conversation=>{const bot=state.snapshot.bots.find(bot=>bot.id===conversation.members[0]);return <BotConversationRowActions key={conversation.id} conversationId={conversation.id} dataEpoch={state.snapshot.dataEpoch} name={conversation.name} pinned={bot.pinned} hidden={bot.hidden} pinnedCard={bot.pinned} unread={!!conversation.readState.unreadCount} onSettings={()=>setEditing(bot)} onDelete={()=>window.fixtureDeleteTarget=bot.id} onPin={async pinned=>{await botApi.update({id:bot.id,revision:bot.revision,nonce:crypto.randomUUID(),pinned});await state.refresh()}} onHidden={async hidden=>{await botApi.update({id:bot.id,revision:bot.revision,nonce:crypto.randomUUID(),hidden});await state.refresh()}} onRead={async()=>{await state.markRead(conversation.id,conversation.readState.latestSequence,true,!conversation.readState.unreadCount)}}><button className='bot-list-row' data-pinned={bot.pinned||undefined} aria-label={conversation.name} aria-current={state.selected===conversation.id?'page':undefined} onClick={()=>state.select(conversation.id)}><span className='bot-list-persona'><BotAvatar agentId={bot.id} size='lg'/></span><span className='bot-list-row-copy'><span>{conversation.name}</span><span className='text-xs text-muted-foreground'>{bot.title||'随时可以交办工作'}</span></span></button></BotConversationRowActions>})}</nav></aside><section style={{padding:48}}><h1 data-selected-title>{selected?.name}</h1><p data-selected-id>{state.selected}</p><p>给 Bot 交办工作，模型和职责可稍后配置。</p></section><BotQuickCreateFeedback state={quick.state} dataEpoch={state.snapshot?.dataEpoch??'initial'} open={show} close={()=>setShow(false)} retry={quick.start} repair={quick.repair}/>{editing&&<BotEditor key={editing.id} bot={editing} close={()=>setEditing(null)} created={state.select}/>}</main>};function Host(){const epoch=useBotWorkspaceStore(state=>state.snapshot?.dataEpoch);return <Fixture key={epoch??'loading'}/>};createRoot(document.getElementById('root')).render(<Host/>);`,
      loader: "tsx",
      resolveDir: draft
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "profile.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        switch (method) {
          case "create": {
            const receipt = store.createBot(input as Parameters<BotStore["createBot"]>[0])
            if (holdNext) {
              holdNext = false
              await new Promise<void>((release) => (held = release))
            }
            if (loseNext) {
              loseNext = false
              return { botFailure: { code: "transport_error", message: "连接中断" } }
            }
            return receipt
          }
          case "update": {
            const result = store.updateBot(input as Parameters<BotStore["updateBot"]>[0])
            if (loseUpdateNext) {
              loseUpdateNext = false
              return { botFailure: { code: "transport_error", message: "保存响应丢失" } }
            }
            return result
          }
          case "snapshot":
            if (failSnapshotNext) {
              failSnapshotNext = false
              return { botFailure: { code: "transport_error", message: "列表暂时无法读取" } }
            }
            return store.snapshot()
          case "status":
            return status()
          case "messages": {
            const pageInput = input as {
              conversationId: string
              before?: number
              after?: number
              limit?: number
              threadRootId?: string
            }
            return store.messages(
              pageInput.conversationId,
              pageInput.before,
              pageInput.limit,
              pageInput.after,
              pageInput.threadRootId
            )
          }
          case "connectors":
            return []
          case "setReadState":
            return store.setReadState(input as Parameters<BotStore["setReadState"]>[0])
          default:
            throw new Error("unexpected fixture method " + method)
        }
      } catch (error) {
        return {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_error",
            message: error instanceof Error ? error.message : "未知错误"
          }
        }
      }
    })
    await page.exposeFunction("fixtureEpochChange", () => {
      store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
        "workspace.restored",
        "epoch-restored",
        "{}",
        Date.now()
      ])
    })
    await page.route("http://127.0.0.1:43123/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles
          .filter((file) => file.path.endsWith(".css"))
          .map((file) => file.text)
          .join("\n")}</style><div id='root'></div><script>${bundle.outputFiles[0].text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43123/")
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector("[data-selected-title]")?.textContent === "新 Bot"
    )
    assert.equal(store.listBots().length, 3)
    assert.equal(store.snapshot().runs.length, 0)
    assert.equal(await page.evaluate(() => window.fixtureSelectionCallbacks.length), 1)
    assert.equal(await page.getByRole("dialog").count(), 0)
    loseNext = true
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.getByRole("button", { name: "核对原请求", exact: true }).waitFor()
    const first = calls.filter((call) => call.method === "create").at(-1)!.input
    assert.equal(store.listBots().length, 4)
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.waitForFunction(() => window.fixtureQuick.state.phase === "idle")
    assert.equal(store.listBots().length, 4)
    assert.deepEqual(calls.filter((call) => call.method === "create").at(-1)!.input, first)
    const callbacksBeforeLateAck = await page.evaluate(
      () => window.fixtureSelectionCallbacks.length
    )
    holdNext = true
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.waitForFunction(() => window.fixtureQuick.state.busy)
    const deadline = Date.now() + 10000
    while (!held && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(held)
    await page.getByRole("button", { name: "Beta", exact: true }).click()
    await page.getByRole("button", { name: "Alpha", exact: true }).click()
    held!()
    held = undefined
    await page.waitForFunction(() => !window.fixtureQuick.state.busy)
    assert.equal(await page.locator("[data-selected-id]").textContent(), a.conversationId)
    assert.equal(
      await page.evaluate(() => window.fixtureSelectionCallbacks.length),
      callbacksBeforeLateAck
    )
    const row = page.getByRole("button", { name: "Beta", exact: true })
    await row.focus()
    await row.press("Shift+F10")
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).waitFor()
    assert.equal(await page.locator("[data-selected-id]").textContent(), a.conversationId)
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    await page.getByRole("dialog").waitFor()
    await page.getByPlaceholder("例如：项目评审助手").fill("项目质量助手")
    await page.screenshot({ path: join(output, "profile-editor-light.png") })
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector("[role=dialog]"))
    assert.equal(store.getBot(b.bot.id).title, "项目质量助手")
    assert.equal(store.getBot(b.bot.id).instructions, "")
    assert.equal(await page.locator("[data-selected-id]").textContent(), a.conversationId)
    loseUpdateNext = true
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    await page.getByPlaceholder("例如：项目评审助手").fill("重新核对的标签")
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    const lostUpdate = calls.filter((call) => call.method === "update").at(-1)!.input
    const revisionAfterUpdate = store.getBot(b.bot.id).revision
    await page.getByRole("button", { name: "稍后核对", exact: true }).click()
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.deepEqual(calls.filter((call) => call.method === "update").at(-1)!.input, lostUpdate)
    assert.equal(store.getBot(b.bot.id).revision, revisionAfterUpdate)
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    await page.getByPlaceholder("例如：项目评审助手").fill("清理后显示的标签")
    await page.evaluate(() => (window.fixtureCleanupFails = true))
    await page.getByRole("button", { name: "保存", exact: true }).click()
    await page.getByRole("button", { name: "核对已完成操作记录", exact: true }).waitFor()
    const acknowledgedUpdates = calls.filter((call) => call.method === "update").length
    await page.evaluate(() => (window.fixtureCleanupFails = false))
    failSnapshotNext = true
    await page.getByRole("button", { name: "核对已完成操作记录", exact: true }).click()
    await page
      .getByText("Bot 已保存，列表同步失败。重试只重新读取列表。", { exact: true })
      .waitFor()
    await page.getByRole("button", { name: "核对已完成操作记录", exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    assert.equal(calls.filter((call) => call.method === "update").length, acknowledgedUpdates)
    assert.equal(store.getBot(b.bot.id).title, "清理后显示的标签")
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "复制会话 ID", exact: true }).click()
    await page.waitForFunction(() => window.fixtureClipboard.length === 1)
    assert.equal(await page.evaluate(() => window.fixtureClipboard[0]), b.conversationId)
    await page.evaluate(() => (window.fixtureClipboardFails = true))
    await row.click({ button: "right" })
    await page.getByRole("menuitem", { name: "复制会话 ID", exact: true }).click()
    await page.getByRole("textbox", { name: "会话 ID", exact: true }).waitFor()
    assert.equal(
      await page.getByRole("textbox", { name: "会话 ID", exact: true }).inputValue(),
      b.conversationId
    )
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await row.hover()
    await page.getByRole("button", { name: "Beta的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click()
    await page.waitForFunction(() => document.querySelector(".bot-conversation-row[data-pinned]"))
    assert.equal(store.getBot(b.bot.id).pinned, true)
    assert.equal(await page.locator("[data-selected-id]").textContent(), a.conversationId)
    await page.screenshot({ path: join(output, "profile-creation-light.png") })
    await page.evaluate(() => window.fixtureTheme("codex-dark"))
    await row.click({ button: "right" })
    await page.screenshot({ path: join(output, "profile-creation-dark.png") })
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Beta")
    assert.equal(await row.evaluate((element) => document.activeElement === element), true)
    holdNext = true
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.waitForFunction(() => window.fixtureQuick.state.busy)
    const restoreDeadline = Date.now() + 10000
    while (!held && Date.now() < restoreDeadline)
      await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(held)
    await page.evaluate(async () => {
      await window.fixtureEpochChange()
      await window.fixtureStore.getState().refresh()
    })
    const createCallsBeforeRelease = calls.filter((call) => call.method === "create").length
    held!()
    held = undefined
    await page.getByRole("button", { name: "创建 Bot", exact: true }).click()
    await page.getByRole("button", { name: "复制原记录", exact: true }).waitFor()
    assert.equal(calls.filter((call) => call.method === "create").length, createCallsBeforeRelease)
    await page.evaluate(() => (window.fixtureClipboardFails = false))
    await page.getByRole("button", { name: "复制原记录", exact: true }).click()
    const confirmed = page.getByRole("checkbox")
    await confirmed.waitFor({ state: "visible" })
    await confirmed.check()
    await page.getByRole("button", { name: "清除此条记录", exact: true }).click()
    await page.waitForFunction(() => !localStorage.getItem("bot-editor-pending:new"))
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify({
        pass: true,
        journeys: [
          "quick-create-no-model",
          "lost-ACK-exact-nonce",
          "late-receipt-lease",
          "row-keyboard-menu",
          "profile-title-target",
          "profile-lost-ACK-reopen",
          "profile-cleanup-and-refresh-no-replay",
          "context-copy-id",
          "clipboard-fallback",
          "hover-pin-target",
          "theme-and-focus",
          "restore-epoch-no-replay",
          "exact-obsolete-record-repair"
        ],
        actual: "Chrome/React/shared IPC unwrapping/SQLite receipts/Store selection",
        fixture: "preload transport + empty connector discovery",
        errors: 0
      })
    )
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") })
    await writeFile(join(output, "failure.html"), await page.content())
    console.error("page errors", errors)
    throw error
  } finally {
    await browser.close()
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
