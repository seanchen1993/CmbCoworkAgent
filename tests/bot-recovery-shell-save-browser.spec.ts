/** Actual React owners and SQLite receipts; the native bridge, visibility and held replies are controlled seams. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { highlightWorkerFixture } from "./fixtures/highlight-worker"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotDomainError } from "../src/shared/bot-types"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotHost } from "../src/main/bots/host"
import { randomUUID } from "node:crypto"

type Kind = "recovery" | "shell"
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/recovery-shell-save"),
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
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotRecovery}from'./src/renderer/src/components/bots/BotRecovery';import{BotShellJob}from'./src/renderer/src/components/bots/BotShellJob';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['effects','status','recover','shellJob','stopShellJob'].map(method=>[method,input=>window.fixtureCall(method,input).finally(()=>{if(method==='recover'||method==='stopShellJob')window.fixtureDelivered++})]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureCloses=0;window.fixtureDelivered=0;window.fixtureUnreadable=false;window.fixtureRemoveFails=false;window.fixtureWriteRestore=false;const read=Storage.prototype.getItem,remove=Storage.prototype.removeItem,write=Storage.prototype.setItem,owned=key=>key.startsWith('cmb:bot-recovery:pending:')||key.startsWith('bot-shell-stop:');Storage.prototype.getItem=function(key){if(window.fixtureUnreadable&&owned(key))throw Error('unreadable');return read.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureRemoveFails&&owned(key))throw Error('denied');return remove.call(this,key)};Storage.prototype.setItem=function(key,raw){write.call(this,key,raw);if(window.fixtureWriteRestore&&owned(key))useBotWorkspaceStore.setState(state=>({snapshot:{...state.snapshot,dataEpoch:'after-write'}}))};window.fixtureRaw=key=>read.call(localStorage,key);Object.defineProperty(navigator,'clipboard',{value:{writeText:async raw=>window.fixtureCopied=raw}});applyThemePreference('codex-dark');
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot,refresh:async()=>{const snapshot=await window.fixtureRefresh();useBotWorkspaceStore.setState({snapshot})}});flushSync(()=>{setSetup(input);setVisible(true);setMount(value=>value+1)})};window.fixtureUnmount=()=>flushSync(()=>setVisible(false));if(!setup||!visible)return null;return <main className='bot-workspace bg-background text-foreground' style={{height:'100vh',padding:24}}><section key={mount} data-testid='settings-owner'>{setup.kind==='recovery'?<BotRecovery run={setup.run} refresh={()=>window.fixtureRefresh()} close={()=>{window.fixtureCloses++;setVisible(false)}}/>:<BotShellJob address={setup.address} close={()=>{window.fixtureCloses++;setVisible(false)}} back={()=>{window.fixtureCloses++;setVisible(false)}}/>}</section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    plugins: [
      await highlightWorkerFixture(renderer),
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
    malform: boolean | "null" = false,
    outcome: "success" | "rejection" | "epoch" = "success",
    mutations = 0,
    reads = 0,
    refreshes = 0
  const now = 1_800_000_000_000
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
      if (["effects", "status", "shellJob"].includes(method)) {
        reads++
        if (readFail) {
          readFail = false
          return { botFailure: { code: "transport_error", message: "sync failed" } }
        }
        if (method === "effects") return store!.effects(String(input))
        if (method === "shellJob") return store!.shellJobs.read(input)
        return createBotAPI(new BotHost(store!)).status()
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
          method === "recover"
            ? store!.recover(input as Parameters<BotStore["recover"]>[0])
            : store!.shellJobs.stop(input)
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
      if (malform === "null") {
        malform = false
        return null
      }
      if (malform && result && typeof result === "object" && "revision" in result) {
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
      store = new BotStore(":memory:", () => now)
      held = false
      lose = false
      readFail = false
      malform = false
      outcome = "success"
      release = undefined
      const created = store.createBot({ nonce: "owner", name: "Review Bot" }),
        bot = created.bot
      store.send({ nonce: "task", conversationId: created.conversationId, text: "Verify changes" })
      const claim = store.claim("fixture")!
      let address: { conversationId: string; runId: string; jobId: string } | undefined
      if (kind === "shell") {
        const action = { command: "verify-output" },
          approval = store.requestInteraction(claim.lease, {
            kind: "approval",
            prompt: "Verify output",
            action
          })
        store.answerInteraction({ id: approval.id, revision: approval.revision, answer: "approve" })
        const jobId = store.toolOnce(claim.lease, "shell", action, () => {
          store!.beginEffect(claim.lease, { id: "shell-effect", action, approvalId: approval.id })
          return store!.shellJobs.reserve(claim.lease, "shell", "shell-effect", "verify-output")
        })
        store.shellJobs.start(claim.lease, jobId)
        address = { conversationId: created.conversationId, runId: claim.run.id, jobId }
      } else store.recoverAbandonedAtStartup()
      const run = store.getRun(claim.run.id),
        epoch = store.dataEpoch(),
        input =
          kind === "recovery"
            ? {
                id: run.id,
                revision: run.revision,
                nonce: "exact-original",
                dataEpoch: epoch,
                decision: "resume",
                note: "Verified project changes",
                effects: []
              }
            : {
                ...address!,
                dataEpoch: epoch,
                revision: store.shellJobs.read(address!).revision,
                nonce: randomUUID()
              },
        key =
          kind === "recovery"
            ? `cmb:bot-recovery:pending:${run.id}`
            : `bot-shell-stop:${address!.jobId}`,
        host = await createBotAPI(new BotHost(store)).status()
      await page.evaluate(() => {
        window.fixtureUnmount()
        window.fixtureCloses = 0
        localStorage.clear()
        window.fixtureUnreadable = false
        window.fixtureRemoveFails = false
        window.fixtureWriteRestore = false
      })
      return { kind, bot, run, address, host, epoch, input, key, snapshot: store.snapshot() }
    }
    const mount = async (f: Awaited<ReturnType<typeof reset>>) => {
      await page.evaluate((f) => window.fixtureSetup(f), f)
      await page.getByTestId("settings-owner").waitFor({ state: "attached" })
      if (f.kind === "recovery") await page.getByLabel("任务核对说明").waitFor()
      else await page.getByRole("button", { name: /停止命令|确认停止结果|同步停止结果/ }).waitFor()
      await page.waitForFunction(
        () =>
          !document.body.textContent.includes("正在读取执行记录") &&
          !document.body.textContent.includes("正在读取…")
      )
    }
    const trigger = (kind: Kind) =>
      kind === "recovery"
        ? page.getByRole("button", { name: /继续任务|确认上次提交|同步已确认任务/ })
        : page.getByRole("button", { name: /停止命令|确认停止结果|同步停止结果|确认停止中/ })
    const mutate = async (kind: Kind) => {
      if (kind === "recovery" && !(await page.getByLabel("任务核对说明").isDisabled()))
        await page.getByLabel("任务核对说明").fill("Verified project changes")
      await trigger(kind).click()
    }
    const settle = () =>
      page.waitForFunction(() => !document.querySelector("button:disabled .animate-spin"))
    const waitRelease = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
      assert.ok(release)
    }
    const callbackFailures: string[] = []
    for (const kind of ["recovery", "shell"] as Kind[])
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
          const delivered = await page.evaluate(() => window.fixtureDelivered),
            beforeReplyReads = reads,
            beforeReplyRefresh = refreshes
          release!()
          release = undefined
          await page.waitForFunction((before) => window.fixtureDelivered > before, delivered)
          try {
            if (transition === "restore") {
              // Both real owners remain mounted across restore, exactly like the Resources pane.
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
      "actual recovery/shell owners retain retired records and avoid post-commit reads"
    )
    for (const kind of ["recovery", "shell"] as Kind[]) {
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
        const recovery = page.getByRole("alert", {
          name: kind === "recovery" ? "待确认核对记录" : "待确认停止记录"
        })
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
          .first()
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
          .filter({ hasText: /当前状态读取失败|sync failed/ })
          .waitFor()
        await trigger(kind).click()
        await settle()
        assert.equal(mutations, before + 1)
        journeys.push(`${kind}/known-read-only-sync`)
      }
    }
    for (const kind of ["recovery", "shell"] as Kind[]) {
      const f = await reset(kind),
        before = mutations
      f.host.capabilities = f.host.capabilities?.filter((cap) => cap !== "mutation-data-epoch-v2")
      await mount(f)
      assert.equal(await trigger(kind).isDisabled(), true)
      assert.equal(mutations, before)
      journeys.push(kind + "/old-host-blocked")
    }
    for (const kind of ["recovery", "shell"] as Kind[]) {
      const f = await reset(kind),
        before = mutations
      await mount(f)
      malform = "null"
      await mutate(kind)
      await page.getByRole("alert").filter({ hasText: "回执与原请求不一致" }).waitFor()
      assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
      assert.equal(mutations, before + 1)
      journeys.push(kind + "/null-receipt-retains")
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "recovery-shell-dark.png"), animations: "disabled" })
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
