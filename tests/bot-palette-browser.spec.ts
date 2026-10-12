/** Real React, native Chrome and domain search. No model or personal data. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotSearch } from "../src/main/bots/search"
import { botSearchInput } from "../src/shared/bot-search"

async function main() {
  const store = new BotStore(":memory:"),
    search = new BotSearch(store)
  const bot = store.createBot({ nonce: "palette", name: "支付研发" })
  const oldest = store.send({
    nonce: "oldest",
    conversationId: bot.conversationId,
    text: "完整历史最早标记"
  })
  for (let i = 0; i < 300; i++)
    store.send({ nonce: `message-${i}`, conversationId: bot.conversationId, text: `常规信息 ${i}` })
  const latest = store.send({
    nonce: "latest",
    conversationId: bot.conversationId,
    text: "最新任务定位"
  })
  store.send({ nonce: "hidden-match", conversationId: bot.conversationId, text: "隐藏助手的消息" })
  const renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-palette")
  await mkdir(output, { recursive: true })
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
      contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotCommandPalette}from'./src/renderer/src/components/bots/BotCommandPalette';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
    applyThemePreference('codex-light');window.fixtureTheme=applyThemePreference;window.api={bots:{search:input=>window.fixtureSearch(input)}};
    const conversations=Array.from({length:500},(_,i)=>({id:'bot-'+i,name:'研发 Bot '+i,detail:'持续跟进项目工作',group:false,hidden:false}));conversations.push({id:'hidden',name:'隐藏助手',detail:'归档的职责',group:false,hidden:true});
    window.opened=[];window.fixtureOpenContexts=[];window.fixtureOpenSettled=0;window.fixtureCloseCount=0;const commands=[{id:'settings',label:'当前 Bot 工具',keywords:['tools'],run(){},children:[{id:'memory',label:'查看记忆',keywords:['memory'],run(){window.opened.push('memory')}}]}];
    function Fixture(){const[open,setOpen]=useState(true);return <><button onClick={()=>setOpen(true)}>打开面板</button>{open&&<BotCommandPalette conversations={conversations} commands={commands} searchEnabled={true} openConversation={id=>window.opened.push(id)} openMatch={async(match,context)=>{window.opened.push(match.id);window.fixtureOpenContexts.push(context);try{await window.fixtureOpenResult({id:match.id})}finally{window.fixtureOpenSettled++}}} close={()=>{window.fixtureCloseCount++;setOpen(false)}}/>}</>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } }),
    errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  let release: (() => void) | undefined,
    held = false
  let releaseHidden: (() => void) | undefined
  let deferNextOpen = false
  let pendingOpen: { resolve(): void; reject(error: Error): void } | undefined
  const pendingOpens = new Set<{ resolve(): void; reject(error: Error): void }>()
  const calls: string[] = []
  try {
    await page.exposeFunction("fixtureSearch", async (raw: unknown) => {
      const input = botSearchInput.parse(raw)
      calls.push(input.query)
      if (input.query === "隐藏助手" && input.kind === "message")
        await new Promise<void>((resolve) => {
          releaseHidden = resolve
        })
      if (input.query === "迟到请求") {
        held = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      return search.search(input)
    })
    await page.exposeFunction("fixtureOpenResult", async () => {
      if (!deferNextOpen) return
      deferNextOpen = false
      await new Promise<void>((resolve, reject) => {
        const pending = {
          resolve() {
            pendingOpens.delete(pending)
            resolve()
          },
          reject(error: Error) {
            pendingOpens.delete(pending)
            reject(error)
          }
        }
        pendingOpen = pending
        pendingOpens.add(pending)
      })
    })
    await page.route("http://127.0.0.1:39179/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<html><head><style>${css.build(scanner.scan())}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text.replaceAll("</script", "<\\/script")}</script></body></html>`
      })
    )
    await page.goto("http://127.0.0.1:39179")
    const palette = page.getByRole("dialog", { name: "快速查找与操作" }),
      input = palette.getByRole("combobox")
    await palette.getByRole("option").first().waitFor()
    for (const key of ["Enter", "Escape"])
      await input.evaluate(
        (element, key) =>
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key,
              isComposing: true,
              bubbles: true,
              cancelable: true
            })
          ),
        key
      )
    assert.deepEqual(await page.evaluate("window.opened"), [])
    await palette.waitFor()
    assert.ok((await palette.getByRole("option").count()) < 25)
    assert.equal(await palette.getByRole("option").filter({ hasText: "隐藏助手" }).count(), 0)
    await input.press("Control+2")
    await palette.waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate("window.opened"), ["bot-1"])
    await page.getByRole("button", { name: "打开面板", exact: true }).click()
    for (let i = 0; i < 26; i++) await input.press("ArrowDown")
    assert.equal(
      await palette.getByRole("option", { selected: true }).getAttribute("aria-posinset"),
      "27"
    )
    assert.ok((await palette.getByRole("listbox").evaluate((element) => element.scrollTop)) > 0)
    await input.fill("隐藏助手")
    await palette.getByRole("option").filter({ hasText: "隐藏助手" }).waitFor()
    await input.press("ArrowDown")
    for (let i = 0; !releaseHidden && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(releaseHidden)
    releaseHidden()
    await palette.getByRole("option").filter({ hasText: "隐藏助手的消息" }).waitFor()
    assert.equal(
      await palette.getByRole("option", { selected: true }).getAttribute("aria-posinset"),
      "2"
    )
    assert.match(await palette.getByRole("option", { selected: true }).innerText(), /归档的职责/)
    await input.fill("tools")
    await input.press("Enter")
    await palette.getByRole("option").filter({ hasText: "查看记忆" }).waitFor()
    await input.press("Escape")
    await palette.getByRole("tab", { name: "全部", exact: true }).waitFor()
    await input.fill("tools")
    await input.press("Enter")
    await input.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.deepEqual(await page.evaluate("window.opened"), ["bot-1", "memory"])
    await page.getByRole("button", { name: "打开面板", exact: true }).click()
    await palette.getByRole("tab", { name: "消息", exact: true }).click()
    await input.fill("最早标记")
    await palette.getByRole("button", { name: "继续搜索", exact: true }).waitFor()
    assert.equal(await palette.getByRole("option").count(), 0)
    await palette.getByRole("button", { name: "继续搜索", exact: true }).click()
    await palette.getByRole("option").filter({ hasText: "完整历史最早标记" }).waitFor()
    await page.screenshot({ path: join(output, "palette-light.png"), animations: "disabled" })
    await page.evaluate("window.fixtureTheme('codex-dark')")
    await page.screenshot({ path: join(output, "palette-dark.png"), animations: "disabled" })
    await input.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.equal(((await page.evaluate("window.opened")) as string[]).at(-1), oldest.messageId)
    await page.getByRole("button", { name: "打开面板", exact: true }).click()
    await palette.getByRole("tab", { name: "消息", exact: true }).click()
    await input.fill("迟到请求")
    for (let i = 0; !held && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(held, true)
    await palette.getByRole("button", { name: "暂停", exact: true }).click()
    await palette.getByRole("button", { name: "继续搜索", exact: true }).waitFor()
    await input.fill("最新任务")
    await palette.getByRole("option").filter({ hasText: "最新任务定位" }).waitFor()
    release?.()
    await input.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.equal(((await page.evaluate("window.opened")) as string[]).at(-1), latest.messageId)
    const deferResult = async () => {
      const settled = await page.evaluate(
        () => (window as unknown as { fixtureOpenSettled: number }).fixtureOpenSettled
      )
      deferNextOpen = true
      await input.press("Enter")
      for (let index = 0; index < 100 && !pendingOpen; index++) await page.waitForTimeout(10)
      assert.ok(pendingOpen, "match activation must reach the deferred parent navigation")
      return { ...pendingOpen, settled }
    }
    const waitForOpenSettlement = async (count: number) => {
      await page.waitForFunction(
        (expected) =>
          (window as unknown as { fixtureOpenSettled: number }).fixtureOpenSettled >= expected,
        count
      )
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
    }
    const openLatestPalette = async () => {
      await page.getByRole("button", { name: "打开面板", exact: true }).click()
      await palette.getByRole("tab", { name: "消息", exact: true }).click()
      await input.fill("最新任务")
      await palette.getByRole("option").filter({ hasText: "最新任务定位" }).waitFor()
    }
    const closedBefore = await page.evaluate(
      () => (window as unknown as { fixtureCloseCount: number }).fixtureCloseCount
    )
    await openLatestPalette()
    const firstOpen = await deferResult()
    await page.keyboard.press("Escape")
    await palette.waitFor({ state: "hidden" })
    await openLatestPalette()
    firstOpen.resolve()
    pendingOpen = undefined
    await waitForOpenSettlement(firstOpen.settled + 1)
    assert.equal(await palette.count(), 1, "a late P1 match success must not close P2")
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureCloseCount: number }).fixtureCloseCount
      ),
      closedBefore + 1
    )
    assert.equal(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              fixtureOpenContexts: { signal: AbortSignal; isCurrent(): boolean }[]
            }
          ).fixtureOpenContexts.at(-1)?.signal.aborted
      ),
      true
    )
    assert.equal(
      await page.evaluate(() =>
        (
          window as unknown as {
            fixtureOpenContexts: { signal: AbortSignal; isCurrent(): boolean }[]
          }
        ).fixtureOpenContexts
          .at(-1)
          ?.isCurrent()
      ),
      false
    )
    const tabOpen = await deferResult()
    await palette.getByRole("tab", { name: "Bot", exact: true }).click()
    await palette.getByText("没有找到匹配内容", { exact: true }).waitFor()
    tabOpen.reject(new Error("旧分类目标打开失败"))
    pendingOpen = undefined
    await waitForOpenSettlement(tabOpen.settled + 1)
    assert.equal(await palette.getByRole("alert").count(), 0)
    assert.equal(await input.isEnabled(), true)
    await palette.getByRole("tab", { name: "消息", exact: true }).click()
    await palette.getByRole("option").filter({ hasText: "最新任务定位" }).waitFor()
    const queryOpen = await deferResult()
    await input.fill("不存在的查询")
    await palette.getByText("没有找到匹配内容", { exact: true }).waitFor()
    queryOpen.reject(new Error("旧查询目标打开失败"))
    pendingOpen = undefined
    await waitForOpenSettlement(queryOpen.settled + 1)
    assert.equal(await palette.getByRole("alert").count(), 0)
    assert.equal(await palette.count(), 1)
    assert.equal(await input.isEnabled(), true)
    await input.fill("最新任务")
    await palette.getByRole("option").filter({ hasText: "最新任务定位" }).waitFor()
    const supersededOpen = await deferResult()
    pendingOpen = undefined
    await input.fill("不存在的查询")
    await palette.getByText("没有找到匹配内容", { exact: true }).waitFor()
    await input.fill("最新任务")
    await palette.getByRole("option").filter({ hasText: "最新任务定位" }).waitFor()
    const currentOpen = await deferResult()
    const attempts = await page.evaluate(
      () => (window as unknown as { fixtureOpenContexts: unknown[] }).fixtureOpenContexts.length
    )
    supersededOpen.resolve()
    await waitForOpenSettlement(supersededOpen.settled + 1)
    assert.equal(await palette.count(), 1, "an old query success must not close the current action")
    assert.equal(await palette.getByRole("alert").count(), 0)
    assert.equal(await palette.getByRole("option").first().isDisabled(), true)
    await palette.getByRole("status").getByText("正在打开…", { exact: true }).waitFor()
    await input.press("Enter")
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureOpenContexts: unknown[] }).fixtureOpenContexts.length
      ),
      attempts,
      "the old finally must not unlock a newer pending action"
    )
    currentOpen.reject(new Error("当前目标打开失败"))
    pendingOpen = undefined
    await waitForOpenSettlement(currentOpen.settled + 2)
    assert.equal(await palette.getByRole("alert").innerText(), "当前目标打开失败")
    assert.equal(await palette.getByRole("option").first().isEnabled(), true)
    await input.press("Enter")
    await palette.waitFor({ state: "hidden" })
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureCloseCount: number }).fixtureCloseCount
      ),
      closedBefore + 2
    )
    assert.deepEqual(errors, [])
    assert.ok(calls.includes("最早标记"))
    console.log(
      "PASS palette real domain paging, stale response/pause, hidden Bots, virtualization, keyboard/nested actions, light/dark, deferred navigation instance/query/tab ownership and current-error retry"
    )
  } finally {
    release?.()
    releaseHidden?.()
    for (const pending of pendingOpens) pending.resolve()
    await browser.close()
    store.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
