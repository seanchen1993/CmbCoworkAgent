/** Actual Chrome/React + Node SQLite receipts; preload, clipboard and lost replies are controlled seams. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { getThemeDefinition } from "../src/renderer/src/lib/theme-registry"

async function main() {
  const root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/profile-inline")
  await mkdir(output, { recursive: true })
  const store = new BotStore(":memory:")
  const alpha = store.createBot({ nonce: "alpha", name: "Alpha" })
  const beta = store.createBot({
    nonce: "beta",
    name: "Beta",
    title: "质量助手",
    instructions: "保留职责"
  })
  let loseUpdate = false,
    failSnapshot = false,
    holdUpdate = false,
    release: (() => void) | undefined
  const calls: { method: string; input: unknown }[] = []
  const status = () => ({
    protocol: 1,
    hostId: "fixture",
    platform: "darwin",
    runtimeReady: true,
    error: null,
    dataEpoch: store.dataEpoch(),
    capabilities: ["mutation-data-epoch-v2", "bot-update-receipts", "bot-profile-title"]
  })
  const initial = { snapshot: store.snapshot(), host: status(), selected: alpha.conversationId }
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
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotProfileInlineField}from'./src/renderer/src/components/bots/BotProfileInlineEditor';import{BotConversationRowActions}from'./src/renderer/src/components/bots/BotConversationRowActions';import{BotAvatar}from'./src/renderer/src/components/bots/BotAvatar';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{botApi}from'./src/renderer/src/lib/bot-api';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['update','snapshot','status','messages'].map(method=>[method,async input=>window.fixtureCall(method,input)]))};window.electron={process:{platform:'darwin'}};useBotWorkspaceStore.setState(${JSON.stringify(initial)});window.fixtureStore=useBotWorkspaceStore;window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.fixtureSelected=[];window.fixturePins=[];window.fixtureSettings=[];window.fixtureCleanupFails=false;const remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails&&key.startsWith('bot-editor-pending:'))throw new Error('cleanup denied');return remove.call(this,key)};Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>window.fixtureCopied=value}});
function Fixture(){const state=useBotWorkspaceStore(),[compact,setCompact]=useState(false),[visible,setVisible]=useState(true);window.fixtureCompact=setCompact;window.fixtureVisible=setVisible;const bot=state.snapshot.bots.find(bot=>bot.id==='${beta.bot.id}'),epoch=state.snapshot.dataEpoch;return <main className='bot-workspace' style={{display:'flex',height:'100vh'}}><aside className='bot-sidebar' style={{width:280}}><header style={{padding:20}}>Bots</header><nav className='bot-conversation-list' style={{padding:10}}>{visible&&<BotConversationRowActions bot={bot} conversationId='${beta.conversationId}' dataEpoch={epoch} name={bot.name} pinnedCard={bot.pinned} pinned={bot.pinned} compact={compact} unread={false} onSettings={()=>window.fixtureSettings.push(bot.id)} onPin={async pinned=>{window.fixturePins.push({id:bot.id,pinned});await botApi.update({id:bot.id,revision:bot.revision,pinned,nonce:crypto.randomUUID()});await state.refresh()}} onRead={async()=>{}} onHidden={async()=>{}} onDelete={()=>{}}>{(name,editing)=>{const content=<><span className='bot-list-persona'><BotAvatar agentId={bot.id} size='lg'/></span><span className='bot-list-row-copy'><span className='block truncate text-sm font-medium'>{name}</span><span className='block truncate text-xs text-muted-foreground'>{bot.title||'随时可以交办工作'}</span></span></>;return editing?<div className='bot-list-row' data-pinned={bot.pinned||undefined}>{content}</div>:<button aria-label={bot.name} className='bot-list-row' data-pinned={bot.pinned||undefined} draggable={!!bot.pinned} onClick={()=>window.fixtureSelected.push(bot.id)}>{content}</button>}}</BotConversationRowActions>}</nav></aside><section style={{padding:40,width:420}}><h2>资料</h2>{visible&&<div className='bot-computer-profile' key={bot.id+':'+epoch}><BotAvatar agentId={bot.id} size='xl'/><h3><BotProfileInlineField bot={bot} dataEpoch={epoch} field='name'/></h3><BotProfileInlineField bot={bot} dataEpoch={epoch} field='title'/></div>}<input aria-label='任务草稿' defaultValue='保留项目草稿'/><p data-selected>${alpha.conversationId}</p></section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
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
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 740 } })
  page.setDefaultTimeout(10000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const updates = () => calls.filter((call) => call.method === "update")
  const current = () => store.listBots().find((bot) => bot.id === beta.bot.id)!
  const publish = () =>
    page.evaluate((snapshot) => window.fixtureStore.setState({ snapshot }), store.snapshot())
  const pending = () =>
    page.evaluate(
      (id) => JSON.parse(localStorage.getItem("bot-editor-pending:" + id) || "null"),
      beta.bot.id
    )
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        if (method === "update") {
          const result = store.updateBot(input as Parameters<BotStore["updateBot"]>[0])
          if (holdUpdate) {
            holdUpdate = false
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          if (loseUpdate) {
            loseUpdate = false
            return { botFailure: { code: "transport_error", message: "保存响应丢失" } }
          }
          return result
        }
        if (method === "snapshot") {
          if (failSnapshot) {
            failSnapshot = false
            return { botFailure: { code: "transport_error", message: "列表同步失败" } }
          }
          return store.snapshot()
        }
        if (method === "status") return status()
        if (method === "messages") return []
        throw new Error("unexpected method " + method)
      } catch (error) {
        return {
          botFailure: {
            code: (error as { code?: string }).code || "transport_error",
            message: error instanceof Error ? error.message : "读取失败"
          }
        }
      }
    })
    await page.route("http://127.0.0.1:43127/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text || ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43127/")
    const nameButton = () => page.locator(".bot-computer-profile h3").getByRole("button")
    await nameButton().click()
    const nameInput = page.getByRole("textbox", { name: "编辑 Bot 名称", exact: true })
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "编辑 Bot 名称"
    )
    await nameInput.fill("输入中文")
    await nameInput.evaluate((input) =>
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true
        })
      )
    )
    assert.equal(updates().length, 0)
    assert.equal(await nameInput.evaluate((input) => document.activeElement === input), true)
    await nameInput.fill("Discarded")
    await nameInput.press("Escape")
    await nameButton().waitFor()
    assert.equal(updates().length, 0)
    assert.equal(current().name, "Beta")
    await nameButton().click()
    await nameInput.fill("  Renamed  ")
    await nameInput.press("Enter")
    await page.getByRole("button", { name: "修改 Renamed 的名称", exact: true }).waitFor()
    assert.equal(current().instructions, "保留职责")
    assert.equal(current().title, "质量助手")
    assert.equal(await pending(), null)
    assert.equal(await page.getByRole("textbox", { name: "任务草稿" }).inputValue(), "保留项目草稿")
    await page.getByRole("button", { name: "修改 Bot 标签", exact: true }).click()
    const titleInput = page.getByRole("textbox", { name: "编辑 Bot 标签", exact: true })
    await titleInput.fill("  发布检查  ")
    await page.getByRole("textbox", { name: "任务草稿" }).click()
    await page.getByRole("button", { name: "修改 Bot 标签", exact: true }).waitFor()
    assert.equal(current().title, "发布检查")
    assert.equal(
      await page
        .getByRole("textbox", { name: "任务草稿" })
        .evaluate((input) => document.activeElement === input),
      true
    )
    await page.getByRole("button", { name: "修改 Bot 标签", exact: true }).click()
    await titleInput.fill("")
    await titleInput.press("Enter")
    await page.getByRole("button", { name: "修改 Bot 标签", exact: true }).waitFor()
    assert.equal(current().title, undefined)
    // Poll a newer revision while editing: the original CAS must fail, never silently overwrite it.
    await nameButton().click()
    await nameInput.fill("Stale overwrite")
    store.updateBot({ id: beta.bot.id, revision: current().revision, title: "Concurrent" })
    await publish()
    await nameInput.press("Enter")
    await page.getByRole("dialog").waitFor()
    await page.getByText("Bot 已被修改，请刷新后重试", { exact: true }).waitFor()
    assert.equal(current().name, "Renamed")
    assert.equal(await pending(), null)
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await publish()
    // Lost ACK closes/reopens the same exact stored request and never repeats the mutation.
    loseUpdate = true
    await nameButton().click()
    await nameInput.fill("Lost ACK")
    await nameInput.press("Enter")
    await page.getByRole("dialog").waitFor()
    await page.getByText(/保存结果尚未确认/).waitFor()
    const lost = updates().at(-1)!.input,
      revision = current().revision
    assert.deepEqual((await pending()).input, lost)
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    await nameButton().click()
    await page.getByRole("button", { name: "核对原请求", exact: true }).click()
    await page.getByRole("button", { name: "修改 Lost ACK 的名称", exact: true }).waitFor()
    assert.deepEqual(updates().at(-1)!.input, lost)
    assert.equal(current().revision, revision)
    assert.equal(await pending(), null)
    // Known ACK + denied local cleanup then failed list sync retry neither RPC nor new nonce.
    await page.evaluate(() => (window.fixtureCleanupFails = true))
    await nameButton().click()
    await nameInput.fill("Acknowledged")
    await nameInput.press("Enter")
    await page.getByText(/后台已确认原请求/).waitFor()
    const acknowledgedCount = updates().length
    await page.evaluate(() => (window.fixtureCleanupFails = false))
    failSnapshot = true
    await page.getByRole("button", { name: "核对原请求", exact: true }).click()
    await page.getByText(/Bot 已保存，列表同步失败/).waitFor()
    assert.equal(updates().length, acknowledgedCount)
    assert.equal(await pending(), null)
    await page.getByRole("button", { name: "核对原请求", exact: true }).click()
    await page.getByRole("button", { name: "修改 Acknowledged 的名称", exact: true }).waitFor()
    assert.equal(updates().length, acknowledgedCount)
    // Hover menu shares keyboard/right-click compact geometry and renamed entity ownership.
    await page.getByRole("button", { name: "Acknowledged", exact: true }).hover()
    await page.getByRole("button", { name: "Acknowledged的更多操作", exact: true }).click()
    await page.getByRole("menu").waitFor()
    assert.equal(
      await page.locator(".bot-row-menu").evaluate((menu) => getComputedStyle(menu).animationName),
      "bot-menu-enter"
    )
    await page.locator(".bot-row-menu").evaluate(async (menu) => {
      await Promise.all(menu.getAnimations().map((animation) => animation.finished.catch(() => {})))
    })
    const geometry = await page.locator(".bot-row-menu").evaluate((menu) => ({
      width: menu.getBoundingClientRect().width,
      height: menu.querySelector("[role=menuitem]")!.getBoundingClientRect().height,
      separators: menu.querySelectorAll("[role=separator]").length
    }))
    assert.equal(geometry.width, 204)
    assert.equal(geometry.height, 32)
    assert.equal(geometry.separators, 3)
    await page.screenshot({ path: join(output, "inline-menu-light.png") })
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click()
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "编辑 Bot 名称"
    )
    assert.equal(await page.locator("button input").count(), 0)
    await nameInput.fill("Sidebar name")
    await nameInput.press("Enter")
    await page.getByRole("button", { name: "Sidebar name", exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.fixtureSelected.length), 0)
    // Pinned geometry + keyboard invocation remain accessible, with no row selection.
    await page.getByRole("button", { name: "Sidebar name", exact: true }).focus()
    await page.keyboard.press("Shift+F10")
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click()
    await page.waitForFunction(
      () => document.querySelector(".bot-conversation-row")?.getAttribute("data-pinned") === "true"
    )
    assert.equal(
      await page
        .getByRole("button", { name: "Sidebar name", exact: true })
        .getAttribute("draggable"),
      "true"
    )
    await page.evaluate(() => window.fixtureTheme("codex-dark"))
    await page.getByRole("button", { name: "Sidebar name", exact: true }).click({ button: "right" })
    const menuBackground = await page.evaluate((color) => {
      const sample = document.createElement("span")
      sample.style.backgroundColor = color
      document.body.append(sample)
      const normalized = getComputedStyle(sample).backgroundColor
      sample.remove()
      return normalized
    }, getThemeDefinition("codex-dark").palette.popover)
    assert.equal(
      await page
        .locator(".bot-row-menu")
        .evaluate((menu) => getComputedStyle(menu).backgroundColor),
      menuBackground
    )
    await page.screenshot({ path: join(output, "inline-menu-dark.png") })
    await page.keyboard.press("Escape")
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.evaluate(() => window.fixtureCompact(true))
    await page.getByRole("button", { name: "Sidebar name", exact: true }).click({ button: "right" })
    assert.equal(await page.getByRole("menuitem", { name: "重命名", exact: true }).count(), 0)
    assert.equal(
      await page.locator(".bot-row-menu").evaluate((menu) => getComputedStyle(menu).animationName),
      "none"
    )
    await page.getByRole("menuitem", { name: "名称与设置", exact: true }).click()
    assert.equal(await page.evaluate(() => window.fixtureSettings.length), 1)
    await page.evaluate(() => window.fixtureCompact(false))
    // Epoch changes retire UI callbacks but preserve the old unconfirmed request for review.
    holdUpdate = true
    loseUpdate = true
    await nameButton().click()
    await nameInput.fill("Old generation")
    await nameInput.press("Enter")
    await page.waitForFunction(
      (id) => localStorage.getItem("bot-editor-pending:" + id) !== null,
      beta.bot.id
    )
    store.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
      "workspace.restored",
      "replacement",
      "{}",
      1
    ])
    await publish()
    await page.waitForFunction(
      () => window.fixtureStore.getState().snapshot.dataEpoch === "replacement"
    )
    const heldDeadline = Date.now() + 2000
    while (!release && Date.now() < heldDeadline)
      await new Promise((resolve) => setTimeout(resolve, 10))
    assert.ok(release)
    release!()
    release = undefined
    await page.waitForTimeout(40)
    assert.ok(await pending())
    await nameButton().click()
    await page.getByText("有恢复前的保存记录", { exact: true }).waitFor()
    assert.equal(await page.getByRole("button", { name: "核对原请求", exact: true }).count(), 0)
    await page.getByRole("button", { name: "关闭", exact: true }).click()
    assert.equal(errors.length, 0)
    const result = {
      pass: true,
      journeys: [
        "inspector-focus-escape",
        "IME-keeps-draft",
        "name-enter-preserves-fields",
        "title-blur-and-clear",
        "concurrent-CAS-rejection",
        "lost-ACK-exact-reopen",
        "ACK-cleanup-sync-no-resend",
        "hover-menu-geometry",
        "row-inline-rename-owner",
        "pinned-keyboard-drag",
        "dark-context-menu",
        "compact-settings",
        "epoch-retirement"
      ],
      errors,
      actual: "Chrome React and real SQLite receipts",
      seams: "preload, clipboard, controlled lost/held replies"
    }
    await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    await writeFile(join(output, "failure.html"), await page.content()).catch(() => {})
    await writeFile(
      join(output, "failure-state.json"),
      JSON.stringify(
        await page.evaluate(() => ({
          active: document.activeElement?.outerHTML,
          inputs: [...document.querySelectorAll("input")].map((input) => ({
            label: input.getAttribute("aria-label"),
            value: input.value,
            disabled: input.disabled
          })),
          dialogs: document.querySelectorAll("[role=dialog]").length
        })),
        null,
        2
      )
    ).catch(() => {})
    throw error
  } finally {
    await browser.close()
    store.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
