/** Actual workspace menu/dialog, Chrome, SQLite and original pending receipts. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"

async function main() {
  const root = process.cwd(),
    renderer = join(root, "src/renderer/src"),
    output = resolve("output/bot-menu-handoff"),
    directory = await mkdtemp(join(tmpdir(), "cmb-menu-handoff-"))
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(directory, "bots.sqlite"))
  store.createBot({ nonce: "alpha", name: "Alpha" })
  store.createBot({ nonce: "beta", name: "Beta" })
  const host = {
    protocol: 1,
    hostId: "menu-fixture",
    platform: process.platform,
    runtimeReady: true,
    error: null,
    dataEpoch: store.dataEpoch(),
    capabilities: ["mutation-data-epoch-v2", "group-update-receipts"]
  }
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
import React,{useState}from'react';import{createRoot}from'react-dom/client';
import{BotWorkspaceMenu}from'./src/renderer/src/components/bots/BotWorkspaceMenu';
import{BotGroupEditor}from'./src/renderer/src/components/bots/BotGroupEditor';
import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';
import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['createGroup','snapshot','status'].map(method=>[method,async input=>window.fixtureCall(method,input)]))};
window.electron={process:{platform:'${process.platform}'}};
useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},host:${JSON.stringify(host)},selected:null});
window.fixtureNavigations=0;window.fixtureSends=0;
function Fixture(){const[editor,setEditor]=useState(false),[group,setGroup]=useState(''),state=useBotWorkspaceStore();
return <main className='bot-workspace' style={{padding:32,minHeight:'100vh'}}>
<BotWorkspaceMenu group={()=>setEditor(true)} canGroup hidden={()=>{}} showHidden={false} keyboard={()=>setEditor(true)}/>
<button aria-label='返回当前会话' onClick={()=>window.fixtureNavigations++}>当前会话</button>
<h2>{group}</h2><input aria-label='任务草稿' defaultValue='保留原任务草稿'/>
<button onClick={()=>window.fixtureSends++}>发送</button>
{editor&&<BotGroupEditor bots={state.snapshot.bots} close={()=>setEditor(false)} created={id=>setGroup(id)}/>}
</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "menu.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1000, height: 820 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = [],
    cases: string[] = [],
    saves: unknown[] = []
  let loseSave = true
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (method === "snapshot") return store.snapshot()
      if (method === "status") return host
      if (method === "createGroup") {
        saves.push(input)
        const saved = store.createGroup(input as Parameters<BotStore["createGroup"]>[0])
        if (loseSave) {
          loseSave = false
          return { botFailure: { code: "transport_error", message: "原请求提交后回复丢失" } }
        }
        return saved
      }
      throw new Error("Unexpected method " + method)
    })
    await page.route("http://127.0.0.1:43135/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><body><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:43135/")
    const menu = page.getByRole("button", { name: "工作区菜单", exact: true }),
      dialog = page.getByRole("dialog"),
      draft = page.getByRole("textbox", { name: "任务草稿", exact: true })
    const navigation = (await page
      .getByRole("button", { name: "返回当前会话", exact: true })
      .boundingBox())!
    await menu.click()
    await page.getByRole("menu").waitFor()
    // A real first outside click should dismiss the action menu and reach navigation.
    await page.mouse.click(
      navigation.x + navigation.width / 2,
      navigation.y + navigation.height / 2
    )
    await page.getByRole("menu").waitFor({ state: "hidden" })
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureNavigations: number }).fixtureNavigations
      ),
      1
    )
    assert.equal(await draft.inputValue(), "保留原任务草稿")
    assert.equal(saves.length, 0)
    cases.push("outside-first-click-navigation")

    await menu.focus()
    await menu.press("ArrowDown")
    await page.getByRole("menu").waitFor()
    await page.keyboard.press("Escape")
    await page.getByRole("menu").waitFor({ state: "hidden" })
    // Radix returns focus in the next task after the menu unmounts.
    await page.waitForFunction(
      () => document.activeElement?.getAttribute("aria-label") === "工作区菜单"
    )
    assert.equal(await menu.evaluate((node) => document.activeElement === node), true)
    cases.push("keyboard-escape-focus")

    await menu.click()
    await page.getByRole("menuitem", { name: "创建协作群聊", exact: true }).click()
    await dialog.getByLabel("群聊名称", { exact: true }).fill("研发评审组")
    await dialog.getByRole("checkbox").nth(0).check()
    await dialog.getByRole("checkbox").nth(1).check()
    await dialog.getByRole("button", { name: "创建群聊", exact: true }).click()
    await dialog.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
    await dialog.getByRole("button", { name: "稍后核对", exact: true }).click()
    await menu.click()
    await page.getByRole("menuitem", { name: "创建协作群聊", exact: true }).click()
    assert.equal(await dialog.getByLabel("群聊名称", { exact: true }).inputValue(), "研发评审组")
    await dialog.getByRole("button", { name: "重试核对保存", exact: true }).click()
    await dialog.waitFor({ state: "hidden" })
    assert.equal(store.snapshot().conversations.filter((item) => item.kind === "group").length, 1)
    assert.equal(saves.length, 2)
    assert.deepEqual(saves[1], saves[0])
    await page.getByRole("button", { name: "发送", exact: true }).click()
    assert.equal(
      await page.evaluate(() => (window as unknown as { fixtureSends: number }).fixtureSends),
      1
    )
    assert.equal(await draft.inputValue(), "保留原任务草稿")
    cases.push("dialog-lost-ack-exact-receipt-and-send")

    await page.emulateMedia({ reducedMotion: "reduce" })
    await menu.focus()
    await menu.press("ArrowDown")
    await page.getByRole("menuitem", { name: "创建协作群聊", exact: true }).press("Enter")
    await dialog.waitFor()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "发送", exact: true }).click()
    assert.equal(
      await page.evaluate(() => (window as unknown as { fixtureSends: number }).fixtureSends),
      2
    )
    assert.equal(saves.length, 2)
    assert.deepEqual(errors, [])
    cases.push("reduced-motion-keyboard-dialog-cancel")
    await writeFile(
      join(output, "results.json"),
      JSON.stringify({ cases, errors, groupCount: 1 }, null, 2)
    )
    console.log("PASS " + cases.join(", "))
  } catch (error) {
    await writeFile(join(output, "failure.html"), await page.content())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    await browser.close()
    store.close()
    await rm(directory, { recursive: true, force: true })
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
