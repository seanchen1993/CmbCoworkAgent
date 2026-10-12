/** Actual workspace menu + original-record owner and SQLite; transport failures and storage faults are controlled. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { guardBotRpcMutationEpoch } from "../src/main/bots/rpc-mutation-epoch"
import { BotDomainError } from "../src/shared/bot-types"

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/recovery-records")
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
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotRecoveryRecords}from'./src/renderer/src/components/bots/BotRecoveryRecords';import{BotWorkspaceMenu}from'./src/renderer/src/components/bots/BotWorkspaceMenu';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:{recover:input=>window.fixtureCall(input).finally(()=>window.fixtureDelivered++)}};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureDelivered=0;window.fixtureCloses=0;window.fixtureRemoveFails=false;const read=Storage.prototype.getItem,remove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(window.fixtureRemoveFails&&key.startsWith('cmb:bot-recovery:pending:'))throw Error('denied');return remove.call(this,key)};window.fixtureRaw=key=>read.call(localStorage,key);Object.defineProperty(navigator,'clipboard',{value:{writeText:async raw=>window.fixtureCopied=raw}});window.fixtureTheme=applyThemePreference;applyThemePreference('codex-dark');
function Fixture(){const[open,setOpen]=useState(false);window.fixtureSetup=input=>{flushSync(()=>setOpen(false));useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot,refresh:async()=>{const snapshot=await window.fixtureRefresh();useBotWorkspaceStore.setState({snapshot})}})};window.fixtureUnmount=()=>flushSync(()=>setOpen(false));return <main className='bot-workspace bg-background text-foreground' style={{height:'100vh',padding:24}}><BotWorkspaceMenu group={()=>{}} canGroup={false} hidden={()=>{}} showHidden={false} keyboard={()=>{}} recoveryRecords={()=>setOpen(true)}/>{open&&<div data-testid='records-owner'><BotRecoveryRecords close={()=>{window.fixtureCloses++;setOpen(false)}}/></div>}</main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    preserveSymlinks: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  let store: BotStore | undefined,
    lose = false,
    held = false,
    failRefresh = false,
    release: (() => void) | undefined,
    mutations = 0,
    refreshes = 0
  const requests: unknown[] = [],
    journeys: string[] = [],
    errors: string[] = []
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 980, height: 820 } })
  page.setDefaultTimeout(8000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureRefresh", () => {
      refreshes++
      if (failRefresh) {
        failRefresh = false
        throw Error("状态读取失败")
      }
      return store!.snapshot()
    })
    await page.exposeFunction("fixtureCall", async (input: Parameters<BotStore["recover"]>[0]) => {
      mutations++
      requests.push(input)
      let result: unknown
      try {
        result = await guardBotRpcMutationEpoch(
          "recover",
          input,
          () => store!.dataEpoch(),
          async () => {
            const receipt = store!.recover(input)
            if (held) await new Promise<void>((done) => (release = done))
            return receipt
          }
        )
        if (lose) {
          lose = false
          throw Error("回执丢失")
        }
      } catch (error) {
        result = {
          botFailure: {
            code: error instanceof BotDomainError ? error.code : "transport_error",
            message: error instanceof Error ? error.message : "失败"
          }
        }
      }
      return result
    })
    await page.route("http://127.0.0.1:43152/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43152/")
    const reset = async (decision: "resume" | "cancel" = "resume", accepted = false) => {
      store?.close()
      store = new BotStore(":memory:")
      lose = held = failRefresh = false
      release = undefined
      const { conversationId } = store.createBot({ nonce: "owner", name: "Review Bot" })
      store.send({ nonce: "task", conversationId, text: "Verify project changes" })
      const { run: started } = store.claim("host")!
      store.recoverAbandonedAtStartup()
      const run = store.getRun(started.id),
        input = {
          id: run.id,
          revision: run.revision,
          nonce: "original-recovery",
          dataEpoch: store.dataEpoch(),
          decision,
          note: "已核对项目修改，无需重复执行",
          effects: []
        },
        key = `cmb:bot-recovery:pending:${run.id}`
      if (accepted) store.recover(input)
      const host = await createBotAPI(new BotHost(store)).status(),
        snapshot = store.snapshot()
      await page.evaluate(
        (f) => {
          window.fixtureUnmount()
          localStorage.clear()
          window.fixtureRemoveFails = false
          window.fixtureCloses = 0
          localStorage.setItem(f.key, JSON.stringify(f.input))
          window.fixtureSetup(f)
        },
        { input, key, host, snapshot }
      )
      return { input, key, host, snapshot }
    }
    const open = async () => {
      await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
      assert.equal(
        await page.getByRole("menuitem", { name: "待确认的任务恢复", exact: true }).count(),
        1,
        "original recovery remains reachable after the active task has changed status"
      )
      await page.getByRole("menuitem", { name: "待确认的任务恢复", exact: true }).click()
      await page.getByRole("heading", { name: "待确认的任务恢复", exact: true }).waitFor()
    }
    const submit = () =>
      page.getByRole("button", { name: /确认上次提交|同步已确认任务/, exact: true }).click()
    const cleared = () =>
      page.getByRole("status").filter({ hasText: "没有待确认的任务恢复" }).waitFor()
    const waitRelease = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
      assert.ok(release)
    }
    for (const decision of ["resume", "cancel"] as const) {
      const f = await reset(decision, true),
        before = mutations,
        cursor = store!.snapshot().cursor
      assert.equal(
        f.snapshot.runs.some((run) => run.status === "needs_review"),
        false
      )
      if (decision === "cancel") assert.equal(f.snapshot.runs.length, 0)
      await open()
      await submit()
      await cleared()
      assert.equal(mutations, before + 1)
      assert.deepEqual(requests.at(-1), f.input)
      assert.equal(store!.snapshot().cursor, cursor)
      assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
      journeys.push(`accepted-${decision}-original-receipt-reachable`)
    }
    {
      const f = await reset(),
        before = mutations
      await open()
      lose = true
      await submit()
      await page.getByRole("alert").filter({ hasText: "回执丢失" }).waitFor()
      const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key),
        cursor = store!.snapshot().cursor
      await page.getByRole("button", { name: "关闭", exact: true }).click()
      await page.getByTestId("records-owner").waitFor({ state: "detached" })
      await open()
      await submit()
      await cleared()
      assert.ok(raw)
      assert.equal(mutations, before + 2)
      assert.deepEqual(requests.at(-1), f.input)
      assert.equal(store!.snapshot().cursor, cursor)
      journeys.push("lost-ack-close-reopen-exact-original")
    }
    {
      const f = await reset("resume", true),
        before = mutations
      await open()
      await page.evaluate(() => (window.fixtureRemoveFails = true))
      await submit()
      await page.getByRole("alert").filter({ hasText: "本机记录尚未清除" }).waitFor()
      await page.evaluate(() => (window.fixtureRemoveFails = false))
      await submit()
      await cleared()
      assert.equal(mutations, before + 1)
      assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
      journeys.push("confirmed-cleanup-only")
    }
    {
      await reset("cancel", true)
      const before = mutations
      await open()
      failRefresh = true
      await submit()
      await page.getByRole("alert").filter({ hasText: "当前状态读取失败" }).waitFor()
      await submit()
      await cleared()
      assert.equal(mutations, before + 1)
      journeys.push("confirmed-readonly-sync")
    }
    {
      const f = await reset("resume", true),
        before = mutations
      f.host.capabilities = f.host.capabilities?.filter((cap) => cap !== "mutation-data-epoch-v2")
      await page.evaluate((f) => window.fixtureSetup(f), f)
      await open()
      assert.equal(
        await page.getByRole("button", { name: "确认上次提交", exact: true }).isDisabled(),
        true
      )
      assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
      assert.equal(mutations, before)
      journeys.push("old-host-readonly")
    }
    {
      const f = await reset(),
        before = mutations
      await page.evaluate((key) => localStorage.setItem(key, "{"), f.key)
      await open()
      const recovery = page.getByRole("alert", { name: "待确认核对记录", exact: true })
      await recovery.waitFor()
      await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
      await recovery.getByRole("checkbox").check()
      await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
      await cleared()
      assert.equal(mutations, before)
      journeys.push("corrupt-record-explicit-archive-without-task")
    }
    {
      const f = await reset(),
        before = mutations
      await open()
      held = true
      await submit()
      await waitRelease()
      const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
      store!.db.run("INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)", [
        "workspace.restored",
        "replacement",
        "{}",
        1
      ])
      await page.evaluate(
        (snapshot) => window.fixtureStore.setState({ snapshot }),
        store!.snapshot()
      )
      const delivered = await page.evaluate(() => window.fixtureDelivered)
      release!()
      release = undefined
      await page.waitForFunction((before) => window.fixtureDelivered > before, delivered)
      await page.getByRole("alert", { name: "待确认核对记录", exact: true }).waitFor()
      assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
      assert.equal(mutations, before + 1)
      journeys.push("restored-original-preserved")
    }
    {
      const f = await reset(),
        before = refreshes
      await open()
      held = true
      await submit()
      await waitRelease()
      const delivered = await page.evaluate(() => window.fixtureDelivered)
      await page.evaluate(() => window.fixtureUnmount())
      await page.getByTestId("records-owner").waitFor({ state: "detached" })
      release!()
      release = undefined
      await page.waitForFunction((before) => window.fixtureDelivered > before, delivered)
      await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
      assert.equal(refreshes, before)
      journeys.push("detached-ack-no-workspace-followup")
    }
    await reset("resume", true)
    await open()
    await page.screenshot({
      path: join(output, "recovery-records-dark.png"),
      animations: "disabled"
    })
    await page.evaluate(() => window.fixtureTheme("codex-light"))
    await page.screenshot({
      path: join(output, "recovery-records-light.png"),
      animations: "disabled"
    })
    assert.deepEqual(errors, [])
    const result = { passed: true, journeys, errors }
    await writeFile(join(output, "checks.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    release?.()
    await page.close()
    await browser.close()
    store?.close()
    console.log(JSON.stringify({ physicallyClosedAt: new Date().toISOString() }))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
