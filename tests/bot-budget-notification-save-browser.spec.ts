/** Actual React owners and SQLite receipts; the native bridge, visibility and held replies are controlled seams. */
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
import { BotDomainError } from "../src/shared/bot-types"

type Kind = "budget" | "notification"
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/budget-notification-save"),
    startedAt = new Date().toISOString()
  await mkdir(output, { recursive: true })
  const css = await compile(
      (await readFile(join(renderer, "index.css"), "utf8")).replace(
        /^@import "@fontsource[^\n]+\n/gm,
        ""
      ),
      { base: renderer, onDependency: () => {} }
    ),
    scanner = new Scanner({
      sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
    })
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import*as Menu from'@radix-ui/react-dropdown-menu';import{BotUsageBudget}from'./src/renderer/src/components/bots/BotUsageBudget';import{BotNotificationAction}from'./src/renderer/src/components/bots/BotNotificationAction';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['usageBudget','changeUsageBudget','changeNotifications'].map(method=>[method,input=>window.fixtureCall(method,input)]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureUnreadable=false;window.fixtureRemoveFails=false;window.fixtureWriteRestore=false;const read=Storage.prototype.getItem,remove=Storage.prototype.removeItem,write=Storage.prototype.setItem,owned=key=>key.startsWith('cmb:bot-budget:pending:')||key.startsWith('cmb:bot-notification:pending:');Storage.prototype.getItem=function(key){if(window.fixtureUnreadable&&owned(key))throw Error('unreadable');return read.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureRemoveFails&&owned(key))throw Error('denied');return remove.call(this,key)};Storage.prototype.setItem=function(key,raw){write.call(this,key,raw);if(window.fixtureWriteRestore&&owned(key))useBotWorkspaceStore.setState(state=>({snapshot:{...state.snapshot,dataEpoch:'after-write'}}))};window.fixtureRaw=key=>read.call(localStorage,key);Object.defineProperty(navigator,'clipboard',{value:{writeText:async raw=>window.fixtureCopied=raw}});applyThemePreference('codex-dark');
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot,refresh:async()=>{const snapshot=await window.fixtureRefresh();useBotWorkspaceStore.setState({snapshot})}});flushSync(()=>{setSetup(input);setVisible(true);setMount(value=>value+1)})};window.fixtureUnmount=()=>flushSync(()=>setVisible(false));if(!setup||!visible)return null;return <main className='bot-workspace bg-background text-foreground' style={{height:'100vh',padding:24}}><section key={mount} data-testid='settings-owner'>{setup.kind==='budget'?<BotUsageBudget bots={[setup.bot]} close={()=>setVisible(false)}/>:<Menu.Root open modal={false}><Menu.Trigger>通知</Menu.Trigger><Menu.Portal><Menu.Content className='rounded-xl bg-background text-foreground p-3'><BotNotificationAction botId={setup.bot.id} dataEpoch={setup.epoch}/></Menu.Content></Menu.Portal></Menu.Root>}</section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    plugins: [
      {
        name: "visible-seam",
        setup(ctx) {
          ctx.onResolve({ filter: /use-bot-view-visibility$/ }, () => ({
            path: "visible",
            namespace: "visible"
          }))
          ctx.onLoad({ filter: /.*/, namespace: "visible" }, () => ({
            loader: "js",
            contents: "export const useBotViewVisibility=()=>true"
          }))
        }
      }
    ],
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
    release: (() => void) | undefined,
    held = false,
    lose = false,
    readFail = false,
    malform = false,
    outcome: "success" | "rejection" | "epoch" = "success",
    mutations = 0,
    reads = 0,
    refreshes = 0
  const requests: unknown[] = [],
    errors: string[] = [],
    journeys: string[] = []
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
      if (readFail) {
        readFail = false
        throw Error("sync failed")
      }
      return store!.snapshot()
    })
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (method === "usageBudget") {
        reads++
        if (readFail) {
          readFail = false
          return { botFailure: { code: "transport_error", message: "sync failed" } }
        }
        return store!.usageBudgets.view(input)
      }
      mutations++
      requests.push(input)
      let result: unknown
      try {
        if (outcome !== "success")
          throw new BotDomainError(
            outcome === "epoch" ? "data_epoch" : "revision_conflict",
            "原操作被明确拒绝"
          )
        result =
          method === "changeUsageBudget"
            ? store!.usageBudgets.change(input)
            : store!.notifications.change(input)
      } catch (error) {
        result = {
          botFailure: {
            code: error instanceof BotDomainError ? error.code : "transport_error",
            message: error instanceof Error ? error.message : "失败"
          }
        }
      }
      if (held)
        await new Promise<void>((done) => {
          release = done
        })
      if (lose) {
        lose = false
        return { botFailure: { code: "transport_error", message: "回执丢失" } }
      }
      if (malform && result && typeof result === "object" && "botId" in result) {
        malform = false
        return { ...result, revision: -1 }
      }
      return result
    })
    await page.route("http://127.0.0.1:43151/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43151/")
    const reset = async (kind: Kind) => {
      store?.close()
      store = new BotStore(":memory:")
      held = false
      lose = false
      readFail = false
      malform = false
      outcome = "success"
      release = undefined
      const bot = store.createBot({ nonce: "owner", name: "Settings Bot" }).bot,
        epoch = store.dataEpoch(),
        input =
          kind === "budget"
            ? {
                botId: null,
                dataEpoch: epoch,
                revision: 0,
                nonce: "exact-original",
                outputLimit: 250
              }
            : {
                botId: bot.id,
                dataEpoch: epoch,
                revision: 0,
                nonce: "exact-original",
                enabled: false
              },
        key =
          kind === "budget"
            ? "cmb:bot-budget:pending:user"
            : `cmb:bot-notification:pending:${bot.id}`
      await page.evaluate(() => {
        window.fixtureUnmount()
        localStorage.clear()
        window.fixtureUnreadable = false
        window.fixtureRemoveFails = false
        window.fixtureWriteRestore = false
      })
      return {
        kind,
        bot,
        epoch,
        input,
        key,
        host: await createBotAPI(new BotHost(store)).status(),
        snapshot: store.snapshot()
      }
    }
    const mount = async (f: Awaited<ReturnType<typeof reset>>) => {
      await page.evaluate((f) => window.fixtureSetup(f), f)
      await page.getByTestId("settings-owner").waitFor({ state: "attached" })
      if (f.kind === "budget") await page.getByRole("switch", { name: "限制输出用量" }).waitFor()
      else await page.getByRole("menuitem", { name: "关闭 Bot 通知", exact: true }).waitFor()
    }
    const trigger = (kind: Kind) =>
      kind === "budget"
        ? page.getByRole("button", { name: /保存额度|确认保存结果|同步已保存额度/ })
        : page.getByRole("menuitem").first()
    const mutate = async (kind: Kind) => {
      if (kind === "budget") {
        await page.getByRole("switch", { name: "限制输出用量" }).click()
        await page.getByLabel("过去 24 小时输出上限").fill("250")
      }
      await trigger(kind).click()
    }
    const settle = async () =>
      page.waitForFunction(
        () =>
          !document.querySelector('[aria-busy="true"]') &&
          !document.querySelector("button:disabled .animate-spin") &&
          !document.querySelector('[role="menuitem"][data-disabled] .animate-spin')
      )
    const waitRelease = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
      assert.ok(release)
    }
    const callbackFailures: string[] = []
    for (const kind of ["budget", "notification"] as Kind[])
      for (const mode of ["success", "rejection"] as const)
        for (const transition of ["restore", "unmount"] as const) {
          const f = await reset(kind)
          await mount(f)
          held = true
          outcome = mode
          await mutate(kind)
          await waitRelease()
          const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
          assert.ok(raw)
          if (transition === "restore") {
            store!.db.run(
              "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)",
              ["workspace.restored", "replacement", "{}", 1]
            )
            await page.evaluate(
              (snapshot) => window.fixtureStore.setState({ snapshot }),
              store!.snapshot()
            )
          } else {
            await page.evaluate(() => window.fixtureUnmount())
            await page.getByTestId("settings-owner").waitFor({ state: "detached" })
          }
          const beforeReplyReads = reads,
            beforeReplyRefresh = refreshes
          release!()
          release = undefined
          try {
            if (transition === "restore") {
              // The stable budget pane stays mounted; the notification owner remounts only when its actual prop changes.
              await page.waitForFunction(
                (key) =>
                  window.fixtureRaw(key) === null ||
                  (!document.querySelector("button:disabled .animate-spin") &&
                    !document.querySelector('[role="menuitem"][data-disabled] .animate-spin')),
                f.key
              )
              assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
              assert.equal(await trigger(kind).isDisabled(), true)
            } else {
              await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
              assert.equal(reads, beforeReplyReads, "unmounted owner must not read settings")
              assert.equal(
                refreshes,
                beforeReplyRefresh,
                "unmounted owner must not refresh Workspace"
              )
            }
          } catch (error) {
            callbackFailures.push(
              `${kind}/${mode}/${transition}: ${error instanceof Error ? error.message : error}`
            )
          }
          journeys.push(`${kind}/${mode}/${transition}`)
        }
    if (callbackFailures.length) console.log(JSON.stringify({ callbackFailures }))
    assert.deepEqual(
      callbackFailures,
      [],
      "actual settings owners retain retired records and avoid post-commit reads"
    )
    for (const kind of ["budget", "notification"] as Kind[]) {
      for (const corrupt of ["obsolete", "corrupt", "unreadable"] as const) {
        const f = await reset(kind),
          before = mutations
        if (corrupt === "unreadable") await page.evaluate(() => (window.fixtureUnreadable = true))
        else
          await page.evaluate(
            ({ key, input, corrupt }) =>
              localStorage.setItem(
                key,
                corrupt === "corrupt" ? "{" : JSON.stringify({ ...input, dataEpoch: "old" })
              ),
            { ...f, corrupt }
          )
        await mount(f)
        const recovery = page.getByRole("alert", { name: "待确认保存记录" })
        await recovery.waitFor()
        assert.equal(await trigger(kind).isDisabled(), true)
        if (corrupt !== "unreadable") {
          await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
          await recovery.getByRole("checkbox").check()
          await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
          await recovery.waitFor({ state: "detached" })
          assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
        }
        assert.equal(mutations, before)
        journeys.push(`${kind}/${corrupt}-protected`)
      }
      for (const mode of ["success", "rejection"] as const) {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        await page.evaluate(() => (window.fixtureRemoveFails = true))
        outcome = mode
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: "操作结果已确认，本机记录尚未清除" })
          .waitFor()
        await page.evaluate(() => (window.fixtureRemoveFails = false))
        await trigger(kind).click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(mutations, before + 1)
        journeys.push(`${kind}/${mode}-cleanup-only`)
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        lose = true
        await mutate(kind)
        await page.getByRole("alert").filter({ hasText: "回执丢失" }).waitFor()
        const original = requests.at(-1)
        await trigger(kind).click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.deepEqual(requests.at(-1), original)
        assert.equal(mutations, before + 2)
        journeys.push(`${kind}/unknown-same-nonce`)
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        await page.evaluate(() => (window.fixtureWriteRestore = true))
        await mutate(kind)
        assert.equal(mutations, before)
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        journeys.push(`${kind}/epoch-recheck-before-dispatch`)
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        outcome = "epoch"
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: /工作区数据已恢复|原操作被明确拒绝/ })
          .waitFor()
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        assert.equal(await trigger(kind).isDisabled(), true)
        assert.equal(mutations, before + 1)
        journeys.push(`${kind}/server-epoch-retains`)
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        malform = true
        await mutate(kind)
        await page.getByRole("alert").filter({ hasText: "回执与原请求不一致" }).waitFor()
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        assert.equal(mutations, before + 1)
        journeys.push(`${kind}/mismatch-retains`)
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        readFail = true
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: /当前结果读取失败|sync failed/ })
          .waitFor()
        await trigger(kind).click()
        await settle()
        assert.equal(mutations, before + 1)
        journeys.push(`${kind}/known-read-only-sync`)
      }
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "notification-dark.png"), animations: "disabled" })
    await writeFile(
      join(output, "checks.json"),
      JSON.stringify({ passed: true, journeys, errors, startedAt }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, journeys, errors, startedAt }, null, 2))
  } catch (error) {
    console.error(await page.locator("body").innerText())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    release?.()
    await browser.close()
    store?.close()
    console.log(JSON.stringify({ physicallyClosedAt: new Date().toISOString() }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
