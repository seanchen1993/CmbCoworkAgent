/** Actual React controls and Cmb FunctionPanes against a delayed contextBridge-shaped facade.
 * Backend receipt semantics have independent tests; this suite measures renderer lifetime only. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotPluginPaneView } from "../src/shared/bot-plugin-panes"

type Surface = "form" | "run" | "toggle" | "trial" | "plugin"
async function main() {
  const started = new Date().toISOString(),
    store = new BotStore(":memory:")
  const { bot, conversationId } = store.createBot({ nonce: "owner", name: "研发 Bot" })
  const skill = store.saveSkill({
    botId: bot.id,
    name: "核对",
    instructions: "核对证据",
    enabled: true
  })
  const routine = store.saveRoutine({
    botId: bot.id,
    name: "检查",
    prompt: "检查证据",
    enabled: true,
    timezone: "UTC",
    schedule: { kind: "cron", expression: "0 9 * * *" }
  })
  const snapshot = store.snapshot(),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-protected-operation")
  const sessionId = "21111111-1111-4111-8111-111111111111",
    generation = "31111111-1111-4111-8111-111111111111"
  const pane: BotPluginPaneView = {
    sessionId,
    revision: 1,
    busy: false,
    panes: [
      {
        key: "review",
        id: "review",
        plugin: "fixture",
        title: "工作检查",
        generation,
        closeOnEscape: false,
        rows: 3,
        tree: {
          type: "Button",
          props: { key: "submit", label: "执行插件动作" },
          press: { plugin: "fixture", handle: 1 }
        }
      }
    ]
  }
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotRoutineForm}from'./src/renderer/src/components/bots/BotRoutineForm';import{BotRoutineRunButton}from'./src/renderer/src/components/bots/BotRoutineRunButton';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{BotSkillCard}from'./src/renderer/src/components/bots/BotSkillCard';import{BotPluginPanes}from'./src/renderer/src/components/bots/BotPluginPanes';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';window.api={bots:new Proxy({}, {get:(_,method)=>async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureSettled++}}})};window.fixtureSettled=0;const originalGet=Storage.prototype.getItem,originalRemove=Storage.prototype.removeItem;window.fixtureRaw=(key)=>originalGet.call(localStorage,key);window.fixtureDenied=false;window.fixtureCleanupFails=false;window.fixtureCopyFails=false;window.fixtureCopied='';Storage.prototype.getItem=function(key){if(window.fixtureDenied)throw Error('read denied');return originalGet.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails)throw Error('cleanup failed');return originalRemove.call(this,key)};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async raw=>{if(window.fixtureCopyFails)throw Error('clipboard unavailable');window.fixtureCopied=raw}}});window.fixtureCallbacks={saved:0,reload:0,refresh:0};
  function Fixture(){const[selection,setSelection]=useState({surface:'form',key:'initial'});const[visible,setVisible]=useState(true);const epoch=useBotWorkspaceStore(state=>state.snapshot.dataEpoch);window.fixtureRender=(surface,key)=>{setSelection({surface,key});setVisible(true)};window.fixtureVisible=setVisible;const reload=async()=>{window.fixtureCallbacks.reload++};return <main className="min-h-screen bg-background p-6 text-foreground" data-epoch={epoch}><section data-fixture-case={selection.key} key={selection.key} className="mx-auto max-w-xl space-y-4">{visible&&(selection.surface==='form'?<BotRoutineForm botId='${bot.id}' idempotent onSaved={()=>window.fixtureCallbacks.saved++}/>:selection.surface==='run'?<BotRoutineRunButton routine={${JSON.stringify(routine)}} dataEpoch={epoch} disabled={false}/>:selection.surface==='toggle'?<BotResources bot={${JSON.stringify(bot)}} tab="routines" close={()=>window.fixtureCallbacks.saved++}/>:selection.surface==='trial'?<BotSkillCard skill={${JSON.stringify(skill)}} trials={[]} reload={reload}/>:<BotPluginPanes address={{botId:'${bot.id}',conversationId:'${conversationId}'}} dataEpoch={epoch}/>)}</section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: "tsx"
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "epoch-workspace",
        setup(context) {
          context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
            path: "workspace",
            namespace: "fixture"
          }))
          context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            loader: "ts",
            resolveDir: process.cwd(),
            contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(snapshot)},host:{capabilities:['mutation-data-epoch-v2','routine-management','routine-editor','routine-run-version','skill-save-receipts','skill-trials']},trackedWork:{},refresh:async()=>{window.fixtureCallbacks.refresh++}}));window.fixtureWorkspace=useBotWorkspaceStore;`
          }))
        }
      }
    ]
  })
  const botStyles = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css.build(scanner.scan())}${botStyles}</style></head><body><div id="root"></div><script>${bundle.outputFiles[0].text}</script></body></html>`
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8")
    response.end(html)
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const errors: string[] = [],
    calls: { method: string; input: unknown }[] = [],
    cases: string[] = [],
    failures: { name: string; message: string }[] = []
  let holdMethod = "",
    release: (() => void) | null = null,
    rejection = "",
    rejectNextMethod = ""
  const historyStatus = "succeeded"
  const methodFor = {
    form: "saveRoutine",
    run: "runRoutine",
    toggle: "saveRoutine",
    trial: "trialSkill",
    plugin: "pluginPaneAction"
  }
  const codeFor = {
    form: "revision_conflict",
    run: "version_conflict",
    toggle: "revision_conflict",
    trial: "skill_changed",
    plugin: "plugin_pane_stale"
  }
  try {
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1000, height: 980 } })
    page.setDefaultTimeout(7000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction(
      "fixtureCall",
      async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input })
        let response: unknown
        if (method === "routines") response = [routine]
        else if (
          ["availableSkills", "skills", "skillTrials", "skillLibrary", "memories"].includes(method)
        )
          response = []
        else if (method === "pluginPanes") response = pane
        else if (method === "pluginPaneAction") response = { runIds: ["plugin-run"] }
        else if (method === "runHistory")
          response = {
            run: {
              id: "plugin-run",
              status: historyStatus,
              error: historyStatus === "failed" ? "Terminal plugin failure" : null
            },
            items: [],
            next: null
          }
        else
          response =
            method === "saveRoutine"
              ? { ...routine, ...input, revision: (Number(input?.revision) || 0) + 1 }
              : { id: "accepted-run" }
        if (method === rejectNextMethod) {
          rejectNextMethod = ""
          response = { botFailure: { code: rejection, message: "Fixture rejected response" } }
        }
        if (method === holdMethod) {
          holdMethod = ""
          if (rejection)
            response = { botFailure: { code: rejection, message: "Old rejected response" } }
          await new Promise<void>((done) => {
            release = done
          })
        }
        return response
      }
    )
    await page.goto(`http://127.0.0.1:${address.port}`)
    const globals = <T>(script: string) => page.evaluate(script) as Promise<T>
    const render = async (
      surface: Surface,
      key: string,
      seed?: { key: string; raw: string },
      denied = false
    ) => {
      await page.evaluate(
        ({ surface, key, seed, denied }) => {
          const fixture = window as unknown as {
            fixtureWorkspace: { getState(): { snapshot: unknown }; setState(value: unknown): void }
            fixtureRender(surface: string, key: string): void
            fixtureCallbacks: unknown
            fixtureDenied: boolean
            fixtureCleanupFails: boolean
            fixtureCopyFails: boolean
          }
          fixture.fixtureDenied = false
          fixture.fixtureCleanupFails = false
          fixture.fixtureCopyFails = false
          localStorage.clear()
          if (seed) localStorage.setItem(seed.key, seed.raw)
          fixture.fixtureDenied = denied
          const state = fixture.fixtureWorkspace.getState()
          fixture.fixtureWorkspace.setState({
            snapshot: { ...(state.snapshot as object), dataEpoch: key, runs: [] }
          })
          fixture.fixtureCallbacks = { saved: 0, reload: 0, refresh: 0 }
          fixture.fixtureRender(surface, key)
        },
        { surface, key, seed, denied }
      )
      await page.locator(`[data-fixture-case="${key}"]`).waitFor({ state: "attached" })
    }
    const begin = async (surface: Surface) => {
      if (surface === "form") {
        await page.getByLabel("名称", { exact: true }).fill("旧例程草稿")
        await page.getByLabel("内容", { exact: true }).fill("核对旧证据")
        await page.getByRole("button", { name: "保存", exact: true }).click()
      } else if (surface === "run")
        await page.getByRole("button", { name: "运行一次", exact: true }).click()
      else if (surface === "toggle") {
        await page.getByRole("button", { name: "例程 检查 的更多操作", exact: true }).click()
        await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
      } else if (surface === "trial") {
        await page.getByRole("button", { name: "试跑", exact: true }).click()
        await page.getByLabel("本次输入", { exact: true }).fill("原输入")
        await page.getByLabel("验收条件", { exact: true }).fill("原证据")
        await page.getByRole("button", { name: "开始试跑", exact: true }).click()
      } else await page.getByRole("button", { name: "执行插件动作", exact: true }).click()
    }
    const check = async (name: string, run: () => Promise<void>) => {
      try {
        await run()
        cases.push(name)
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) })
        release?.()
        release = null
      }
    }
    const sources = {
      form: {
        key: `bot-routine-pending:${bot.id}:new`,
        label: "例程保存",
        input: {
          nonce: "original",
          botId: bot.id,
          name: "原例程",
          prompt: "原证据",
          enabled: true,
          timezone: "UTC",
          schedule: { kind: "cron", expression: "0 9 * * *" }
        }
      },
      run: {
        key: `bot-routine-run-pending:${bot.id}:${routine.id}`,
        label: "例程运行",
        input: { nonce: "original", botId: bot.id, id: routine.id, revision: routine.revision }
      },
      trial: {
        key: `bot-skill-trial-pending:${bot.id}:${skill.id}`,
        label: "试跑",
        input: {
          nonce: "original",
          botId: bot.id,
          skillId: skill.id,
          version: skill.version,
          inputs: "原输入",
          criteria: "原证据"
        }
      },
      plugin: {
        key: `bot-plugin-pane-pending:${JSON.stringify([bot.id, conversationId, null, null])}`,
        label: "面板操作",
        input: {
          botId: bot.id,
          conversationId,
          target: "pane",
          sessionId,
          action: {
            pane: "review",
            generation,
            plugin: "fixture",
            handle: 1,
            kind: "press",
            intentId: "original-intent-001"
          }
        }
      }
    }
    const mutationCalls = (surface: Surface) =>
      calls.filter((item) => item.method === methodFor[surface])
    const retry = async (surface: Exclude<Surface, "toggle">) => {
      const label = {
        form: "重试核对保存",
        run: "核对并重试",
        trial: "重试核对试跑",
        plugin: "核对进度"
      }[surface]
      await page.getByRole("button", { name: label, exact: true }).click()
    }
    const rawFor = (surface: keyof typeof sources, epoch: string) =>
      JSON.stringify({ dataEpoch: epoch, input: sources[surface].input })
    const storageRaw = (key: string) =>
      page.evaluate(
        (key) => (window as unknown as { fixtureRaw(key: string): string | null }).fixtureRaw(key),
        key
      )
    for (const surface of ["form", "run", "trial", "plugin"] as const) {
      const source = sources[surface]
      await check(
        `${surface}: retired record blocks replacement and explicit exact archive never auto-submits`,
        async () => {
          const raw = rawFor(surface, "before-restore"),
            before = mutationCalls(surface).length
          await render(surface, `${surface}-retired`, { key: source.key, raw })
          const recovery = page.getByRole("alert", {
            name: `待确认${source.label}记录`,
            exact: true
          })
          assert.equal(await recovery.count(), 1)
          assert.equal(
            await recovery.getByRole("button", { name: "清除此条记录", exact: true }).isDisabled(),
            true
          )
          await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
          await recovery.getByText("原记录已复制", { exact: true }).waitFor()
          assert.equal(await globals("window.fixtureCopied"), raw)
          await recovery.getByRole("checkbox").check()
          await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
          await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
          assert.equal(mutationCalls(surface).length, before)
          assert.equal(await recovery.count(), 0)
        }
      )
      await check(
        `${surface}: corrupt record survives clipboard failure and only reviewed downloaded raw can be archived`,
        async () => {
          const raw = "broken exact operation",
            before = mutationCalls(surface).length
          await render(surface, `${surface}-corrupt`, { key: source.key, raw })
          const recovery = page.getByRole("alert", {
            name: `待确认${source.label}记录`,
            exact: true
          })
          assert.equal(await recovery.count(), 1)
          await page.evaluate(() => {
            ;(window as unknown as { fixtureCopyFails: boolean }).fixtureCopyFails = true
          })
          await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
          await recovery
            .getByText("复制失败，请保存原记录文件后再继续。", { exact: true })
            .waitFor()
          assert.equal(await recovery.getByRole("checkbox").isDisabled(), true)
          assert.equal(await storageRaw(source.key), raw)
          const download = page.waitForEvent("download")
          await recovery.getByRole("button", { name: "保存原记录", exact: true }).click()
          const file = await download,
            filePath = await file.path()
          assert.ok(filePath)
          assert.equal(await readFile(filePath, "utf8"), raw)
          await recovery.getByRole("checkbox").check()
          await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
          await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
          assert.equal(mutationCalls(surface).length, before)
        }
      )
      await check(
        `${surface}: unreadable storage stays blocked and offers no destructive archive`,
        async () => {
          const raw = rawFor(surface, "original"),
            before = mutationCalls(surface).length
          await render(surface, `${surface}-unreadable`, { key: source.key, raw }, true)
          const recovery = page.getByRole("alert", {
            name: `待确认${source.label}记录`,
            exact: true
          })
          assert.equal(await recovery.count(), 1)
          assert.equal(await recovery.getByRole("button").count(), 0)
          assert.equal(await storageRaw(source.key), raw)
          assert.equal(mutationCalls(surface).length, before)
        }
      )
      await check(
        `${surface}: lost reply remount reuses the exact submitted payload and identity`,
        async () => {
          await render(surface, `${surface}-lost`)
          rejection = "connection_closed"
          rejectNextMethod = methodFor[surface]
          const before = mutationCalls(surface).length
          await begin(surface)
          await page
            .getByText(
              /尚未收到保存结果|尚未确认运行状态|Fixture rejected response|操作结果尚未确认/
            )
            .first()
            .waitFor()
          const original = mutationCalls(surface).at(-1)!.input,
            raw = await storageRaw(source.key)
          assert.ok(raw)
          await page.evaluate((key) => {
            ;(
              window as unknown as { fixtureRender(surface: string, key: string): void }
            ).fixtureRender(key.split(":")[0], key)
          }, `${surface}:reopen`)
          await page
            .locator(`[data-fixture-case="${surface}:reopen"]`)
            .waitFor({ state: "attached" })
          assert.equal(await storageRaw(source.key), raw)
          await retry(surface)
          await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
          assert.equal(mutationCalls(surface).length, before + 2)
          assert.deepEqual(mutationCalls(surface).at(-1)!.input, original)
        }
      )
      for (const outcome of ["success", "definitive rejection"] as const)
        await check(
          `${surface}: ${outcome} with failed local cleanup retries only acknowledged record`,
          async () => {
            await render(surface, `${surface}-cleanup-${outcome.replaceAll(" ", "-")}`)
            await page.evaluate(() => {
              ;(window as unknown as { fixtureCleanupFails: boolean }).fixtureCleanupFails = true
            })
            rejection = outcome === "success" ? "" : codeFor[surface]
            rejectNextMethod = rejection ? methodFor[surface] : ""
            const before = mutationCalls(surface).length
            await begin(surface)
            await page
              .getByText(/结果已确认，本机记录尚未清除/)
              .first()
              .waitFor()
            assert.ok(await storageRaw(source.key))
            await page.evaluate(() => {
              ;(window as unknown as { fixtureCleanupFails: boolean }).fixtureCleanupFails = false
            })
            await retry(surface)
            await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
            assert.equal(mutationCalls(surface).length, before + 1)
          }
        )
    }
    await check(
      "routine toggle routes retired exact request to original editor without submitting inverse",
      async () => {
        const input = { ...routine, nonce: "original-toggle" }
        const retained = {
          nonce: input.nonce,
          botId: bot.id,
          id: routine.id,
          revision: routine.revision,
          name: routine.name,
          prompt: routine.prompt,
          schedule: routine.schedule,
          timezone: routine.timezone,
          enabled: false
        }
        const seed = {
          key: `bot-routine-pending:${bot.id}:${routine.id}`,
          raw: JSON.stringify({ dataEpoch: "retired", input: retained })
        }
        const before = mutationCalls("toggle").length
        await render("toggle", "toggle-retired", seed)
        await page
          .getByRole("button", { name: `例程 ${routine.name} 的更多操作`, exact: true })
          .click()
        await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
        await page.getByRole("alert", { name: "待确认例程保存记录", exact: true }).waitFor()
        assert.equal(await storageRaw(seed.key), seed.raw)
        assert.equal(mutationCalls("toggle").length, before)
        const recovery = page.getByRole("alert", { name: "待确认例程保存记录", exact: true })
        await recovery.getByRole("button", { name: "复制原记录", exact: true }).click()
        await recovery.getByText("原记录已复制", { exact: true }).waitFor()
        await recovery.getByRole("checkbox").check()
        await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, seed.key)
        assert.equal(
          mutationCalls("toggle").length,
          before,
          "archiving a filled edit form never submits a fresh save"
        )
      }
    )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "protected-final.png"),
      fullPage: true
    })
    console.log(JSON.stringify({ cases, failures, errors, started }))
    assert.deepEqual(failures, [])
    assert.deepEqual(errors, [])
  } finally {
    release?.()
    await browser?.close()
    await new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done())))
    store.close()
    console.log(
      JSON.stringify({ physicalClose: new Date().toISOString(), serverListening: server.listening })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
