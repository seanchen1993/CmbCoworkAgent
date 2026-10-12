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
    output = resolve("output/bot-operation-epoch")
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotRoutineForm}from'./src/renderer/src/components/bots/BotRoutineForm';import{BotRoutineRunButton}from'./src/renderer/src/components/bots/BotRoutineRunButton';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{BotSkillCard}from'./src/renderer/src/components/bots/BotSkillCard';import{BotPluginPanes}from'./src/renderer/src/components/bots/BotPluginPanes';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';window.api={bots:new Proxy({}, {get:(_,method)=>async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureSettled++}}})};window.fixtureSettled=0;window.fixtureCallbacks={saved:0,reload:0,refresh:0};
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
    historyStatus = "succeeded"
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
    const waitHold = async () => {
      const until = Date.now() + 5000
      while (!release) {
        assert.ok(Date.now() < until, "reply reached hold")
        await new Promise<void>((done) => setTimeout(done, 20))
      }
    }
    const render = async (surface: Surface, key: string) => {
      await page.evaluate(
        ({ surface, key }) => {
          const fixture = window as unknown as {
            fixtureWorkspace: { getState(): { snapshot: unknown }; setState(value: unknown): void }
            fixtureRender(surface: string, key: string): void
            fixtureCallbacks: unknown
          }
          localStorage.clear()
          const state = fixture.fixtureWorkspace.getState()
          fixture.fixtureWorkspace.setState({
            snapshot: { ...(state.snapshot as object), dataEpoch: key, runs: [] }
          })
          fixture.fixtureCallbacks = { saved: 0, reload: 0, refresh: 0 }
          fixture.fixtureRender(surface, key)
        },
        { surface, key }
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
    for (const surface of ["form", "run", "toggle", "trial", "plugin"] as const) {
      for (const outcome of ["success", "definitive rejection"] as const)
        await check(`${surface}: retained mounted old-${outcome} after restore`, async () => {
          const key = `${surface}-${outcome.replaceAll(" ", "-")}`
          await render(surface, key)
          rejection = outcome === "success" ? "" : codeFor[surface]
          holdMethod = methodFor[surface]
          await begin(surface)
          await waitHold()
          const records = await globals<Record<string, string>>(
            "Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))"
          )
          assert.equal(Object.keys(records).length, 1)
          await page
            .locator(`[data-fixture-case="${key}"]`)
            .evaluate((node) => node.setAttribute("data-original-instance", "held"))
          const before = await globals<number>("window.fixtureSettled")
          await page.evaluate(() => {
            const fixture = window as unknown as {
              fixtureWorkspace: {
                getState(): { snapshot: { dataEpoch: string } }
                setState(value: unknown): void
              }
            }
            const state = fixture.fixtureWorkspace.getState()
            fixture.fixtureWorkspace.setState({
              snapshot: { ...state.snapshot, dataEpoch: "restored" }
            })
          })
          assert.equal(
            await page
              .locator(`[data-fixture-case="${key}"]`)
              .getAttribute("data-original-instance"),
            "held"
          )
          release!()
          release = null
          await page.waitForFunction(
            (previous) =>
              (window as unknown as { fixtureSettled: number }).fixtureSettled > previous,
            before
          )
          assert.deepEqual(
            await globals<Record<string, string>>(
              "Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))"
            ),
            records
          )
          assert.deepEqual(await globals("window.fixtureCallbacks"), {
            saved: 0,
            reload: 0,
            refresh: 0
          })
          assert.equal(
            (await page.locator("body").innerText()).includes("Old rejected response"),
            false
          )
          if (surface === "form")
            assert.equal(await page.getByLabel("名称", { exact: true }).inputValue(), "旧例程草稿")
          if (surface === "trial") await page.getByLabel("本次输入", { exact: true }).waitFor()
        })
    }
    for (const status of ["succeeded", "failed"] as const)
      await check(`plugin late ${status} history cannot clear retired pending`, async () => {
        await render("plugin", `plugin-history-${status}`)
        rejection = ""
        historyStatus = status
        holdMethod = "runHistory"
        await begin("plugin")
        await waitHold()
        const records = await globals(
            "Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))"
          ),
          before = await globals<number>("window.fixtureSettled")
        await page.evaluate(() => {
          const fixture = window as unknown as {
            fixtureWorkspace: { getState(): { snapshot: object }; setState(value: unknown): void }
            fixtureCallbacks: unknown
          }
          fixture.fixtureCallbacks = { saved: 0, reload: 0, refresh: 0 }
          fixture.fixtureWorkspace.setState({
            snapshot: { ...fixture.fixtureWorkspace.getState().snapshot, dataEpoch: "restored" }
          })
        })
        release!()
        release = null
        await page.waitForFunction(
          (previous) => (window as unknown as { fixtureSettled: number }).fixtureSettled > previous,
          before
        )
        assert.deepEqual(
          await globals(
            "Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))"
          ),
          records
        )
        assert.equal(
          (await page.locator("body").innerText()).includes("Terminal plugin failure"),
          false
        )
      })
    for (const surface of ["form", "run", "toggle", "trial"] as const)
      await check(
        `${surface}: same-epoch unmount still acknowledges exact response without old UI`,
        async () => {
          await render(surface, `${surface}-unmount`)
          rejection = ""
          holdMethod = methodFor[surface]
          await begin(surface)
          await waitHold()
          const before = await globals<number>("window.fixtureSettled")
          await page.evaluate(() => {
            ;(window as unknown as { fixtureVisible(value: boolean): void }).fixtureVisible(false)
          })
          await page.waitForFunction(
            (surface) =>
              surface === "toggle"
                ? document.querySelector("[role=dialog]") === null
                : document.querySelector("[data-fixture-case]")?.childElementCount === 0,
            surface
          )
          release!()
          release = null
          await page.waitForFunction(
            (previous) =>
              (window as unknown as { fixtureSettled: number }).fixtureSettled > previous,
            before
          )
          assert.equal(await globals<number>("localStorage.length"), 0)
          assert.deepEqual(await globals("window.fixtureCallbacks"), {
            saved: 0,
            reload: 0,
            refresh: 0
          })
        }
      )
    await page.screenshot({
      animations: "disabled",
      path: join(output, "epoch-final.png"),
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
