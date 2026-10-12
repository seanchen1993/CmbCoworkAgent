/** Real React, Chrome and domain search; no model, credentials or personal files. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotSearch } from "../src/main/bots/search"
import { botSearchInput } from "../src/shared/bot-search"

async function main() {
  const store = new BotStore(":memory:")
  const search = new BotSearch(store)
  const bot = store.createBot({ nonce: "bounded-search", name: "搜索分页验证" })
  for (let index = 0; index < 2000; index++) {
    const sent = store.send({
      nonce: `search-${index}`,
      conversationId: bot.conversationId,
      text: `查找标记 ${index}`
    })
    for (const id of sent.runIds) store.cancel(id)
  }
  const renderer = resolve("src/renderer/src")
  const output = resolve("output/bot-search-pagination")
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
      contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BotSearchDialog}from'./src/renderer/src/components/bots/BotSearch';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
      applyThemePreference('codex-dark');window.api={bots:{search:input=>window.fixtureSearch(input)}};
      window.fixtureOpenContexts=[];window.fixtureCloseCount=0;window.fixtureOpenSettled=0;
      function Fixture(){const[visible,setVisible]=useState(true),[instance,setInstance]=useState(1);
        window.fixtureReopen=()=>{setInstance(value=>value+1);setVisible(true)};
        return visible?<BotSearchDialog key={instance} close={()=>{window.fixtureCloseCount++;setVisible(false)}} open={async(match,context)=>{window.fixtureOpenContexts.push(context);try{await window.fixtureOpenResult({id:match.id,kind:match.kind,instance});}finally{window.fixtureOpenSettled++;}}}/>:<button onClick={()=>window.fixtureReopen()}>打开搜索</button>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "search.js"),
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
  const errors: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  let failNext = false
  let release: (() => void) | undefined
  let held = false
  let deferNextOpen = false
  let pendingOpen:
    | { resolve(): void; reject(error: Error): void; instance: number; id: string }
    | undefined
  try {
    await page.exposeFunction("fixtureSearch", async (raw: unknown) => {
      const input = botSearchInput.parse(raw)
      if (input.query === "等待") {
        held = true
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (failNext) {
        failNext = false
        throw new Error("搜索读取暂时失败")
      }
      return search.search(input)
    })
    await page.exposeFunction(
      "fixtureOpenResult",
      async (input: { instance: number; id: string }) => {
        if (!deferNextOpen) return
        deferNextOpen = false
        await new Promise<void>((resolve, reject) => {
          pendingOpen = { ...input, resolve, reject }
        })
      }
    )
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
    await page.addStyleTag({ content: css.build(scanner.scan()) })
    for (const file of bundle.outputFiles) {
      if (file.path.endsWith(".css")) await page.addStyleTag({ content: file.text })
      else await page.addScriptTag({ content: file.text })
    }
    const dialog = page.getByRole("dialog", { name: "搜索 Bot 工作区", exact: true })
    const input = dialog.getByRole("textbox", { name: "搜索内容", exact: true })
    const matches = dialog.getByLabel("搜索结果", { exact: true }).locator("button")
    await input.fill("查找标记")
    const checkPage = async (number: number) => {
      await page.waitForFunction((pageNumber) => {
        const status = document.querySelector('footer[role="status"]')
        return (
          status?.textContent?.includes(`第 ${pageNumber} 页 · 64 条结果`) &&
          document.querySelector('[aria-label="搜索结果"]')?.getAttribute("aria-busy") === "false"
        )
      }, number)
      const snippets = await matches.locator(".bot-search-snippet").allTextContents()
      const expected = Array.from(
        { length: 64 },
        (_, offset) => `查找标记 ${1999 - (number - 1) * 64 - offset}`
      )
      assert.deepEqual(snippets, expected)
      assert.equal(await matches.count(), 64)
    }
    for (let number = 1; number <= 20; number++) {
      await checkPage(number)
      if (number < 20) await dialog.getByRole("button", { name: "继续搜索", exact: true }).click()
    }
    await dialog.getByRole("button", { name: "上一页", exact: true }).click()
    await checkPage(19)
    await dialog.getByRole("button", { name: "继续搜索", exact: true }).click()
    await checkPage(20)
    failNext = true
    await dialog.getByRole("button", { name: "继续搜索", exact: true }).click()
    await dialog.getByRole("alert").getByText("搜索读取暂时失败", { exact: true }).waitFor()
    await dialog.getByRole("button", { name: "重试", exact: true }).click()
    await checkPage(21)
    await page.screenshot({ animations: "disabled", path: join(output, "paged-search.png") })
    await input.fill("等待")
    for (let index = 0; index < 100 && !held; index++) await page.waitForTimeout(20)
    assert.equal(held, true)
    await input.fill("查找标记")
    release!()
    release = undefined
    await checkPage(1)
    assert.equal(await dialog.getByRole("button", { name: "上一页", exact: true }).count(), 0)
    const deferResult = async () => {
      deferNextOpen = true
      await matches.first().click()
      for (let index = 0; index < 100 && !pendingOpen; index++) await page.waitForTimeout(10)
      assert.ok(pendingOpen, "opening a result must reach the deferred parent action")
      return pendingOpen
    }
    const waitForOpenSettlement = async (count: number) => {
      await page.waitForFunction(
        (expected) =>
          (window as unknown as { fixtureOpenSettled: number }).fixtureOpenSettled >= expected,
        count
      )
      // The parent has settled. Let React commit the child's continuation before
      // checking that its stale close/error handler has no visible effect.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          })
      )
    }
    // The first dialog owns its own pending result. Closing it must not give
    // that old callback permission to close a newly mounted search dialog.
    const firstOpen = await deferResult()
    await page.keyboard.press("Escape")
    await dialog.waitFor({ state: "detached" })
    await page.getByRole("button", { name: "打开搜索", exact: true }).click()
    await dialog.waitFor()
    await input.fill("查找标记")
    await checkPage(1)
    firstOpen.resolve()
    pendingOpen = undefined
    await waitForOpenSettlement(1)
    assert.equal(await dialog.count(), 1, "a late S1 success must not close S2")
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureCloseCount: number }).fixtureCloseCount
      ),
      1
    )
    assert.equal(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              fixtureOpenContexts: { signal: AbortSignal; isCurrent(): boolean }[]
            }
          ).fixtureOpenContexts[0]?.signal.aborted
      ),
      true
    )
    assert.equal(
      await page.evaluate(() =>
        (
          window as unknown as {
            fixtureOpenContexts: { signal: AbortSignal; isCurrent(): boolean }[]
          }
        ).fixtureOpenContexts[0]?.isCurrent()
      ),
      false
    )
    // New search criteria revoke the previous navigation without replacing
    // its error feedback or leaving all new result buttons disabled.
    const queryOpen = await deferResult()
    await input.fill("不存在的查询")
    await dialog.getByText("没有找到匹配内容", { exact: true }).waitFor()
    queryOpen.reject(new Error("旧查询目标打开失败"))
    pendingOpen = undefined
    await waitForOpenSettlement(2)
    assert.equal(await dialog.getByRole("alert").count(), 0)
    assert.equal(await dialog.count(), 1)
    await input.fill("查找标记")
    await checkPage(1)
    assert.equal(await matches.first().isEnabled(), true)
    const kindOpen = await deferResult()
    await dialog.getByRole("button", { name: "Bot", exact: true }).click()
    await dialog.getByText("没有找到匹配内容", { exact: true }).waitFor()
    kindOpen.reject(new Error("旧类型目标打开失败"))
    pendingOpen = undefined
    await waitForOpenSettlement(3)
    assert.equal(await dialog.getByRole("alert").count(), 0)
    assert.equal(await dialog.count(), 1)
    await dialog.getByRole("button", { name: "消息", exact: true }).click()
    await checkPage(1)
    assert.equal(await matches.first().isEnabled(), true)
    // A current result still closes its own dialog once.
    await matches.first().click()
    await dialog.waitFor({ state: "detached" })
    assert.equal(
      await page.evaluate(
        () => (window as unknown as { fixtureCloseCount: number }).fixtureCloseCount
      ),
      2
    )
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          passed: [
            "bounded-current-page",
            "previous-page-refetch",
            "same-cursor-retry",
            "stale-query-reply",
            "old-dialog-navigation-cannot-close-new-dialog",
            "query-change-revokes-pending-navigation",
            "kind-change-revokes-pending-navigation",
            "current-navigation-closes-own-dialog"
          ]
        },
        null,
        2
      )
    )
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    throw error
  } finally {
    release?.()
    pendingOpen?.resolve()
    await browser.close()
    store.close()
  }
  console.log("PASS bounded Bot search pagination and cancellation")
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
