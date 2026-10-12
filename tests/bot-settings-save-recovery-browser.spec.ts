/** Actual stable React settings panes and original SQLite receipt owners; native bridge and held ACKs are controlled seams. */
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
import { BotHost } from "../src/main/bots/host"
import { createBotAPI } from "../src/main/bots/rpc"
import { BotDomainError } from "../src/shared/bot-types"

type Kind = "rules" | "review"
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/settings-save-recovery"),
    startedAt = new Date().toISOString()
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
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotApprovalRules}from'./src/renderer/src/components/bots/BotApprovalRules';import{BotAutoReviewSettings}from'./src/renderer/src/components/bots/BotAutoReviewSettings';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['approvalRules','changeApprovalRule','autoReviewSettings','changeAutoReview'].map(method=>[method,input=>window.fixtureCall(method,input)]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureReadFails=false;window.fixtureCleanupFails=false;const read=Storage.prototype.getItem,remove=Storage.prototype.removeItem;const owned=key=>key.startsWith('cmb:bot-approval-rule:pending:')||key.startsWith('cmb:bot-auto-review:pending:');Storage.prototype.getItem=function(key){if(window.fixtureReadFails&&owned(key))throw Error('unreadable');return read.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails&&owned(key))throw Error('denied');return remove.call(this,key)};window.fixtureRaw=key=>read.call(localStorage,key);Object.defineProperty(navigator,'clipboard',{value:{writeText:async raw=>window.fixtureCopied=raw}});applyThemePreference('codex-dark');
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});setSetup(input);setVisible(true);setMount(value=>value+1)};window.fixtureVisible=setVisible;if(!setup)return null;return <main className='bot-workspace bg-background text-foreground' style={{height:'100vh',padding:24}}><section key={mount}>{visible&&(setup.kind==='rules'?<BotApprovalRules bot={setup.bot} denyRules close={()=>setVisible(false)}/>:<BotAutoReviewSettings botId={setup.bot.id}/>)}</section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    plugins: [
      await highlightWorkerFixture(renderer),
      {
        name: "visible-fixture",
        setup(context) {
          context.onResolve({ filter: /use-bot-view-visibility$/ }, () => ({
            path: "visible",
            namespace: "visible-seam"
          }))
          context.onLoad({ filter: /.*/, namespace: "visible-seam" }, () => ({
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
    hold = false,
    lose = false,
    failRead = false,
    malform = false,
    outcome: "success" | "rejection" = "success",
    mutations = 0,
    responses = 0
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 980, height: 820 } }),
    errors: string[] = [],
    journeys: string[] = []
  page.setDefaultTimeout(10_000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (method === "approvalRules" || method === "autoReviewSettings") {
        if (failRead) {
          failRead = false
          return { botFailure: { code: "transport_error", message: "当前设置读取失败" } }
        }
        return method === "approvalRules"
          ? store!.approvalRules.read(String(input))
          : store!.autoReview.read(String(input))
      }
      mutations++
      let result: unknown
      try {
        if (outcome === "rejection")
          throw new BotDomainError("revision_conflict", "原操作被明确拒绝")
        result =
          method === "changeApprovalRule"
            ? store!.approvalRules.change(input)
            : store!.autoReview.change(input)
      } catch (error) {
        result = {
          botFailure: {
            code: error instanceof BotDomainError ? error.code : "transport_error",
            message: error instanceof Error ? error.message : "失败"
          }
        }
      }
      if (hold)
        await new Promise<void>((done) => {
          release = done
        })
      responses++
      if (lose) {
        lose = false
        return { botFailure: { code: "transport_error", message: "回执丢失" } }
      }
      if (malform && result && typeof result === "object" && "botId" in result) {
        malform = false
        return { ...result, botId: "foreign" }
      }
      return result
    })
    await page.route("http://127.0.0.1:43143/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43143/")
    const reset = async (kind: Kind) => {
      store?.close()
      store = new BotStore(":memory:")
      const { bot, conversationId } = store.createBot({ nonce: "owner", name: "Settings Bot" })
      store.send({ nonce: "task", conversationId, text: "run project tests" })
      const { lease } = store.claim("settings-fixture")!
      const action = {
        shell: {
          command: "npm test",
          cwd: "C:/project",
          timeoutSeconds: 60,
          sandbox: "unelevated",
          definition: {
            kind: "package_script",
            path: "package.json",
            sha256: "c".repeat(64),
            definition: "node test.cjs"
          }
        }
      }
      const interaction = store.requestInteraction(lease, {
        kind: "approval",
        prompt: JSON.stringify(action),
        action,
        ruleScope: "a".repeat(64)
      })
      store.answerInteraction({
        id: interaction.id,
        revision: interaction.revision,
        answer: "approve",
        remember: true
      })
      const rules = store.approvalRules.read(bot.id),
        settings = store.autoReview.read(bot.id),
        key =
          (kind === "rules" ? "cmb:bot-approval-rule:pending:" : "cmb:bot-auto-review:pending:") +
          bot.id,
        input =
          kind === "rules"
            ? {
                botId: bot.id,
                ruleId: rules.rules[0].id,
                revision: rules.revision,
                dataEpoch: rules.dataEpoch,
                nonce: "original",
                behavior: "deny"
              }
            : {
                ...settings,
                nonce: "original",
                isEnabled: true,
                allowInstructions: ["tests"],
                blockInstructions: []
              }
      release = undefined
      hold = false
      lose = false
      failRead = false
      malform = false
      outcome = "success"
      await page.evaluate(() => {
        window.fixtureReadFails = false
        window.fixtureCleanupFails = false
        localStorage.clear()
      })
      return {
        kind,
        bot,
        key,
        input,
        host: await createBotAPI(new BotHost(store)).status(),
        snapshot: store.snapshot()
      }
    }
    type Setup = Awaited<ReturnType<typeof reset>>
    const mount = async (f: Setup) => {
      await page.evaluate((setup) => window.fixtureSetup(setup), f)
      await (
        f.kind === "rules"
          ? page.getByRole("button", { name: "从不允许", exact: true })
          : page.getByRole("button", { name: /^(保存审核设置|确认上次保存|同步已保存设置)$/ })
      ).waitFor()
    }
    const mutate = async (kind: Kind) => {
      if (kind === "rules")
        await page.getByRole("button", { name: "从不允许", exact: true }).click()
      else {
        await page
          .getByRole("textbox", { name: "自动审核允许规则", exact: true })
          .fill("tests\ntests")
        await page.getByRole("button", { name: "保存审核设置", exact: true }).click()
      }
    }
    const pane = (kind: Kind) =>
      kind === "rules"
        ? page.getByRole("dialog", { name: "审批规则", exact: true })
        : page.getByLabel("自动审核设置", { exact: true })
    const waitIdle = async () => {
      await page.waitForFunction(() => document.querySelectorAll(".animate-spin").length === 0)
    }
    const callbackFailures: string[] = []
    for (const kind of ["rules", "review"] as Kind[])
      for (const mode of ["success", "rejection"] as const)
        for (const transition of ["restore", "unmount"] as const) {
          const f = await reset(kind),
            before = mutations,
            previousResponses = responses
          await mount(f)
          hold = true
          outcome = mode
          await mutate(kind)
          await page.waitForFunction((key) => window.fixtureRaw(key) !== null, f.key)
          const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
          const deadline = Date.now() + 2000
          while (!release && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 10))
          assert.ok(release)
          assert.equal(mutations, before + 1)
          if (transition === "restore") {
            store!.db.run(
              "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)",
              ["workspace.restored", "replacement", "{}", 1]
            )
            await page.evaluate(
              (snapshot) => window.fixtureStore.setState({ snapshot }),
              store!.snapshot()
            )
          } else await page.evaluate(() => window.fixtureVisible(false))
          release()
          release = undefined
          while (responses === previousResponses && Date.now() < deadline)
            await new Promise((done) => setTimeout(done, 10))
          assert.equal(responses, previousResponses + 1)
          try {
            if (transition === "restore") {
              await waitIdle()
              assert.equal(
                await page.evaluate((key) => window.fixtureRaw(key), f.key),
                raw,
                kind + " original retired record must survive " + mode
              )
              assert.ok(
                await pane(kind)
                  .getByText(/工作区数据已恢复/)
                  .count()
              )
              assert.equal(
                await page
                  .getByRole("button", {
                    name: kind === "rules" ? "从不允许" : "确认上次保存",
                    exact: true
                  })
                  .isDisabled(),
                true
              )
            } else await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
          } catch (failure) {
            callbackFailures.push(
              [
                kind,
                mode,
                transition,
                failure instanceof Error ? failure.message : String(failure)
              ].join("/")
            )
          }
          journeys.push([kind, mode, transition].join("/"))
        }
    if (callbackFailures.length) console.log(JSON.stringify({ callbackFailures }))
    assert.deepEqual(callbackFailures, [], "each stable pane must keep retired records")
    for (const kind of ["rules", "review"] as Kind[]) {
      const trigger = () =>
        kind === "rules"
          ? page.getByRole("button", { name: "确认上次操作", exact: true })
          : page.getByRole("button", { name: /同步已保存设置|确认上次保存/ })
      {
        const f = await reset(kind),
          before = mutations
        await page.evaluate(
          ({ key, input }) =>
            localStorage.setItem(key, JSON.stringify({ ...input, dataEpoch: "old" })),
          f
        )
        await mount(f)
        const recovery = page.getByRole("alert", { name: "待确认保存记录" })
        await recovery.getByText("有恢复前的保存记录", { exact: true }).waitFor()
        assert.equal(
          await page
            .getByRole("button", {
              name: kind === "rules" ? "从不允许" : "保存审核设置",
              exact: true
            })
            .isDisabled(),
          true
        )
        const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
        await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
        await recovery.getByRole("checkbox").check()
        await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await recovery.waitFor({ state: "hidden" })
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
        assert.ok(raw)
        assert.equal(mutations, before)
        journeys.push(kind + "/obsolete-exact-archive-no-effect")
      }
      {
        const f = await reset(kind),
          before = mutations
        await page.evaluate((key) => localStorage.setItem(key, "{"), f.key)
        await mount(f)
        const recovery = page.getByRole("alert", { name: "待确认保存记录" })
        await recovery.waitFor()
        await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
        await recovery.getByRole("checkbox").check()
        await page.evaluate((key) => localStorage.setItem(key, "new-corruption"), f.key)
        await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), "new-corruption")
        await recovery
          .getByText("记录已变化或无法清除，请重新打开核对。新记录保持不变。", { exact: true })
          .waitFor()
        assert.equal(mutations, before)
        journeys.push(kind + "/corrupt-archive-race-keeps-new-raw")
      }
      {
        const f = await reset(kind),
          before = mutations
        await page.evaluate(() => (window.fixtureReadFails = true))
        await mount(f)
        await page
          .getByText("存储权限不可用，原记录保持不变。请恢复应用存储访问后重新打开。", {
            exact: true
          })
          .waitFor()
        assert.equal(
          await page
            .getByRole("button", {
              name: kind === "rules" ? "从不允许" : "保存审核设置",
              exact: true
            })
            .isDisabled(),
          true
        )
        assert.equal(mutations, before)
        journeys.push(kind + "/unreadable-blocks")
      }
      for (const mode of ["success", "rejection"] as const) {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        await page.evaluate(() => (window.fixtureCleanupFails = true))
        outcome = mode
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: "操作结果已确认，本机记录尚未清除。重试只核对已完成记录。" })
          .waitFor()
        await page.evaluate(() => (window.fixtureCleanupFails = false))
        await trigger().click()
        await waitIdle()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(mutations, before + 1)
        journeys.push(kind + "/known-" + mode + "-cleanup-only")
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        failRead = true
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: "设置已保存，当前结果读取失败。重试只重新读取设置。" })
          .waitFor()
        await trigger().click()
        await waitIdle()
        assert.equal(mutations, before + 1)
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
        journeys.push(kind + "/known-success-read-only")
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        await page.evaluate(({ key, input }) => localStorage.setItem(key, JSON.stringify(input)), f)
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: "有一次操作尚未确认，请先核对原请求。" })
          .waitFor()
        assert.equal(mutations, before)
        journeys.push(kind + "/another-pane-original-before-dispatch")
      }
      {
        const f = await reset(kind),
          before = mutations
        await mount(f)
        malform = true
        await mutate(kind)
        await page
          .getByRole("alert")
          .filter({ hasText: "保存回执与原请求不一致，原记录仍保留。请核对原操作。" })
          .waitFor()
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        assert.equal(mutations, before + 1)
        journeys.push(kind + "/mismatched-receipt-keeps-original")
      }
      {
        const f = await reset(kind),
          before = mutations
        const event = kind === "rules" ? "approval.rules_changed" : "auto_review.settings_changed"
        const beforeEvents = Number(
          store!.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind=?", [event])[0].values[0][0]
        )
        await mount(f)
        lose = true
        await mutate(kind)
        await page.getByRole("alert").filter({ hasText: "回执丢失" }).waitFor()
        const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
        await mount(f)
        await trigger().click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(mutations, before + 2)
        assert.equal(
          store!.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind=?", [event])[0].values[0][0],
          beforeEvents + 1
        )
        assert.ok(raw)
        journeys.push(kind + "/lost-ack-reopen-one-durable-effect")
      }
    }
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          pass: true,
          journeys,
          errors,
          startedAt,
          actual: "stable React panes + original SQLite receipt owners",
          seams: "native bridge, visibility predicate, held replies"
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ pass: true, journeys: journeys.length, errors, startedAt }))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    await writeFile(join(output, "failure.html"), await page.content()).catch(() => {})
    throw error
  } finally {
    await browser.close()
    store?.close()
    console.log(JSON.stringify({ physicallyClosed: true, finishedAt: new Date().toISOString() }))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
