/** Real React controls through the contextBridge packet shape. Backend scope/receipt
 * proofs are separate real SQLite + authenticated RPC tests, not this controlled facade. */
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"

type Surface = "form" | "run" | "trial" | "toggle"
async function main() {
  const started = new Date().toISOString(),
    store = new BotStore(":memory:")
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const server = createServer(),
    errors: string[] = [],
    cases: string[] = [],
    failures: { name: string; message: string }[] = [],
    calls: { method: string; input: Record<string, unknown> }[] = []
  const methods = {
    form: "saveRoutine",
    run: "runRoutine",
    trial: "trialSkill",
    toggle: "saveRoutine"
  }
  const { bot } = store.createBot({ nonce: "owner", name: "研发 Bot" }),
    skill = store.saveSkill({
      botId: bot.id,
      name: "核对",
      instructions: "核对证据",
      enabled: true
    }),
    routine = store.saveRoutine({
      botId: bot.id,
      name: "检查",
      prompt: "检查证据",
      enabled: true,
      timezone: "UTC",
      schedule: { kind: "cron", expression: "0 9 * * *" }
    }),
    snapshot = store.snapshot(),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-routine-mutation-epoch")
  const caps = [
    "mutation-data-epoch-v2",
    "routine-management",
    "routine-editor",
    "routine-run-version",
    "skill-save-receipts",
    "skill-trials"
  ]
  try {
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
      }),
      bundle = await build({
        stdin: {
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotRoutineForm}from'./src/renderer/src/components/bots/BotRoutineForm';import{BotRoutineRunButton}from'./src/renderer/src/components/bots/BotRoutineRunButton';import{BotSkillCard}from'./src/renderer/src/components/bots/BotSkillCard';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';window.fixtureSettled=0;window.fixtureCallbacks={saved:0,reload:0,refresh:0};window.fixtureHoldMethod='';window.fixtureRelease=null;window.api={bots:new Proxy({}, {get:(_,method)=>async input=>{try{let response=await window.fixtureCall(method,input);if(window.fixtureHoldMethod===method){window.fixtureHoldMethod='';response=await new Promise(done=>{window.fixtureRelease=()=>{window.fixtureRelease=null;done(response)}})}return response}finally{window.fixtureSettled++}}})};function Fixture(){const[selection,setSelection]=useState({surface:'form',key:'initial'});const[visible,setVisible]=useState(true);const epoch=useBotWorkspaceStore(state=>state.snapshot.dataEpoch);window.fixtureRender=(surface,key)=>{setSelection({surface,key});setVisible(true)};window.fixtureVisible=setVisible;window.fixtureUnmountAndReply=()=>new Promise(done=>{const section=document.querySelector('[data-fixture-case]');const observer=new MutationObserver(()=>{if(section.childElementCount!==0)return;observer.disconnect();window.fixtureDetachedAtReply=section.childElementCount===0;window.fixtureRelease();done()});observer.observe(section,{childList:true,subtree:true});setVisible(false)});return <main className='min-h-screen bg-background p-6 text-foreground' data-epoch={epoch}><section key={selection.key} data-fixture-case={selection.key} className='mx-auto max-w-xl space-y-4'>{visible&&(selection.surface==='form'?<BotRoutineForm botId='${bot.id}' idempotent onSaved={()=>window.fixtureCallbacks.saved++}/>:selection.surface==='run'?<BotRoutineRunButton routine={${JSON.stringify(routine)}} dataEpoch={epoch} disabled={false}/>:selection.surface==='trial'?<BotSkillCard skill={${JSON.stringify(skill)}} trials={[]} reload={async()=>{window.fixtureCallbacks.reload++}}/>:<BotResources bot={${JSON.stringify(bot)}} tab='routines' close={()=>window.fixtureCallbacks.saved++}/>)}</section><Toaster position='top-center' richColors duration={2200}/></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
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
            name: "mutation-epoch-workspace",
            setup(context) {
              context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
                path: "workspace",
                namespace: "fixture"
              }))
              context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                loader: "ts",
                resolveDir: process.cwd(),
                contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(snapshot)},host:{capabilities:${JSON.stringify(caps)}},trackedWork:{},refresh:async()=>{window.fixtureCallbacks.refresh++}}));window.fixtureWorkspace=useBotWorkspaceStore;`
              }))
            }
          }
        ]
      }),
      styles = await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8"),
      html = `<!doctype html><html><head><meta charset='utf-8'><style>${css.build(scanner.scan())}${styles}</style></head><body><div id='root'></div><script>${bundle.outputFiles[0].text}</script></body></html>`
    server.on("request", (_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(html)
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1000, height: 980 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => errors.push(error.message))
    let rejection = ""
    await page.exposeFunction(
      "fixtureCall",
      async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input })
        if (method === "routines") return [routine]
        if (
          ["skills", "availableSkills", "skillTrials", "skillLibrary", "memories"].includes(method)
        )
          return []
        if (rejection) return { botFailure: { code: rejection, message: "工作区数据已恢复" } }
        return { id: "accepted", status: "queued" }
      }
    )
    await page.goto(`http://127.0.0.1:${address.port}`)
    const mutationCalls = () =>
        calls.filter((call) => ["saveRoutine", "runRoutine", "trialSkill"].includes(call.method)),
      globals = <T>(code: string) => page.evaluate(code) as Promise<T>,
      rawRecords = () =>
        globals<Record<string, string>>(
          "Object.fromEntries(Object.keys(localStorage).map(key=>[key,localStorage.getItem(key)]))"
        )
    const render = async (
      surface: Surface,
      key: string,
      records: { key: string; raw: string }[] = [],
      support = true
    ) => {
      rejection = ""
      await page.evaluate(
        ({ surface, key, records, caps }) => {
          const fixture = window as unknown as {
            fixtureWorkspace: { getState(): { snapshot: object }; setState(value: unknown): void }
            fixtureRender(surface: string, key: string): void
            fixtureCallbacks: unknown
            fixtureHoldMethod: string
          }
          localStorage.clear()
          for (const record of records) localStorage.setItem(record.key, record.raw)
          fixture.fixtureWorkspace.setState({
            snapshot: { ...fixture.fixtureWorkspace.getState().snapshot, dataEpoch: key, runs: [] },
            host: { capabilities: caps }
          })
          fixture.fixtureCallbacks = { saved: 0, reload: 0, refresh: 0 }
          fixture.fixtureHoldMethod = ""
          fixture.fixtureRender(surface, key)
        },
        {
          surface,
          key,
          records,
          caps: support ? caps : caps.filter((cap) => cap !== "mutation-data-epoch-v2")
        }
      )
      await page.locator(`[data-fixture-case='${key}']`).waitFor({ state: "attached" })
    }
    const prepare = async (surface: Surface, pending = false) => {
      if (surface === "form" && !pending) {
        await page.getByLabel("名称", { exact: true }).fill("范围草稿")
        await page.getByLabel("内容", { exact: true }).fill("核对证据")
      } else if (surface === "trial" && !pending) {
        await page.getByRole("button", { name: "试跑", exact: true }).click()
        await page.getByLabel("本次输入", { exact: true }).fill("真实输入")
        await page.getByLabel("验收条件", { exact: true }).fill("交付证据")
      }
    }
    const submit = (surface: Surface, pending = false) =>
        page.getByRole("button", {
          name:
            surface === "form"
              ? pending
                ? "重试核对保存"
                : "保存"
              : surface === "run"
                ? pending
                  ? "核对并重试"
                  : "运行一次"
                : pending
                  ? "重试核对试跑"
                  : "开始试跑",
          exact: true
        }),
      begin = async (surface: Surface, pending = false) => {
        await prepare(surface, pending)
        await submit(surface, pending).click()
      },
      waitHold = () =>
        page.waitForFunction(
          () =>
            typeof (window as unknown as { fixtureRelease: unknown }).fixtureRelease === "function"
        ),
      hold = (surface: Surface) =>
        page.evaluate((method) => {
          ;(window as unknown as { fixtureHoldMethod: string }).fixtureHoldMethod = method
        }, methods[surface]),
      reply = async () => {
        const before = await globals<number>("window.fixtureSettled")
        await page.evaluate(() => {
          ;(window as unknown as { fixtureRelease(): void }).fixtureRelease()
        })
        await page.waitForFunction(
          (before) => (window as unknown as { fixtureSettled: number }).fixtureSettled > before,
          before
        )
      }
    const legacy = (surface: Surface, key: string) => {
      const input =
          surface === "form"
            ? {
                nonce: "legacy-save",
                botId: bot.id,
                name: "原例程",
                prompt: "原证据",
                enabled: true,
                timezone: "UTC",
                schedule: { kind: "cron", expression: "0 9 * * *" }
              }
            : surface === "run"
              ? { botId: bot.id, id: routine.id, revision: routine.revision, nonce: "legacy-run" }
              : {
                  nonce: "legacy-trial",
                  botId: bot.id,
                  skillId: skill.id,
                  version: skill.version,
                  inputs: "原输入",
                  criteria: "原证据"
                },
        storageKey =
          surface === "form"
            ? `bot-routine-pending:${bot.id}:new`
            : surface === "run"
              ? `bot-routine-run-pending:${bot.id}:${routine.id}`
              : `bot-skill-trial-pending:${bot.id}:${skill.id}`
      return { key: storageKey, raw: JSON.stringify({ dataEpoch: key, input }), input }
    }
    const check = async (name: string, test: () => Promise<void>) => {
      try {
        await test()
        cases.push(name)
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) })
        console.log(`FAIL ${name}: ${String(error)}`)
        console.log(
          JSON.stringify({
            diagnostic: name,
            body: await page.locator("body").innerText(),
            records: await rawRecords(),
            callbacks: await globals("window.fixtureCallbacks"),
            epoch: await globals("window.fixtureWorkspace.getState().snapshot.dataEpoch")
          })
        )
        await page.evaluate(() => {
          ;(window as unknown as { fixtureRelease?: () => void }).fixtureRelease?.()
        })
      }
    }
    for (const surface of ["form", "run", "trial"] as const) {
      await check(`${surface}: fresh submitted scope and exact durable intent`, async () => {
        const key = `${surface}-fresh`
        await render(surface, key)
        await hold(surface)
        await begin(surface)
        await waitHold()
        const input = mutationCalls().at(-1)!.input,
          records = await rawRecords()
        assert.equal(input.expectedDataEpoch, key)
        assert.equal(Object.keys(records).length, 1)
        assert.equal(JSON.parse(Object.values(records)[0]).input.expectedDataEpoch, key)
        await reply()
        await page.waitForFunction(() => localStorage.length === 0)
        assert.deepEqual(await rawRecords(), {})
      })
      await check(`${surface}: accepted legacy pending sends unchanged payload`, async () => {
        const key = `${surface}-legacy`,
          record = legacy(surface, key)
        await render(surface, key, [record])
        await hold(surface)
        await begin(surface, true)
        await waitHold()
        const actual = mutationCalls().at(-1)!.input,
          expected = { ...record.input } as Record<string, unknown>
        if (surface === "run") delete expected.botId
        assert.deepEqual(actual, expected)
        assert.deepEqual(await rawRecords(), { [record.key]: record.raw })
        await reply()
        await page.waitForFunction(() => localStorage.length === 0)
        assert.deepEqual(await rawRecords(), {})
      })
      await check(
        `${surface}: Host retired scope preserves intent and disables redispatch before poll`,
        async () => {
          const key = `${surface}-retired`
          await render(surface, key)
          await hold(surface)
          rejection = "data_epoch"
          await begin(surface)
          await waitHold()
          const records = await rawRecords(),
            before = mutationCalls().length
          await reply()
          await page.getByText(/原(?:保存|运行|试跑)记录仍保留/).waitFor()
          assert.deepEqual(await rawRecords(), records)
          assert.ok((await page.locator("body").innerText()).includes("原"))
          assert.equal(await submit(surface, true).isDisabled(), true)
          assert.equal(mutationCalls().length, before)
          await page.evaluate((surface) => {
            const fixture = window as unknown as {
              fixtureWorkspace: { getState(): { snapshot: object }; setState(value: unknown): void }
              fixtureRender(surface: string, key: string): void
            }
            fixture.fixtureWorkspace.setState({
              snapshot: {
                ...fixture.fixtureWorkspace.getState().snapshot,
                dataEpoch: "replacement"
              }
            })
            fixture.fixtureRender(surface, `${surface}-retired-reopen`)
          }, surface)
          await page.getByRole("button", { name: "复制原记录", exact: true }).waitFor()
          assert.deepEqual(await rawRecords(), records)
        }
      )
      for (const pending of [false, true])
        await check(
          `${surface}: missing Host scope capability blocks ${pending ? "pending replay" : "new mutation"} without discarding records`,
          async () => {
            const key = `${surface}-unsupported-${pending}`,
              records = pending ? [legacy(surface, key)] : []
            await render(surface, key, records, false)
            await prepare(surface, pending)
            const before = mutationCalls().length
            assert.equal(await submit(surface, pending).isDisabled(), true)
            assert.ok((await page.locator("body").innerText()).includes("请更新 Bot 后台"))
            assert.deepEqual(
              await rawRecords(),
              Object.fromEntries(records.map((record) => [record.key, record.raw]))
            )
            assert.equal(mutationCalls().length, before)
          }
        )
      await check(
        `${surface}: DOM-detach microtask ACK clears exact intent without refresh or old callbacks`,
        async () => {
          await render(surface, `${surface}-detach`)
          await hold(surface)
          await begin(surface)
          await waitHold()
          const before = await globals<number>("window.fixtureSettled")
          await page.evaluate(async () => {
            await (
              window as unknown as { fixtureUnmountAndReply(): Promise<void> }
            ).fixtureUnmountAndReply()
          })
          await page.waitForFunction(
            (before) => (window as unknown as { fixtureSettled: number }).fixtureSettled > before,
            before
          )
          assert.equal(await globals("window.fixtureDetachedAtReply"), true)
          await page.waitForFunction(() => localStorage.length === 0)
          assert.deepEqual(await rawRecords(), {})
          assert.deepEqual(await globals("window.fixtureCallbacks"), {
            saved: 0,
            reload: 0,
            refresh: 0
          })
        }
      )
    }
    await check("toggle: fresh pause binds current scope before durable save", async () => {
      const key = "toggle-fresh"
      await render("toggle", key)
      await hold("toggle")
      await page.getByRole("button", { name: "例程 检查 的更多操作", exact: true }).click()
      await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
      await waitHold()
      assert.equal(mutationCalls().at(-1)!.input.expectedDataEpoch, key)
      await reply()
      await page.waitForFunction(() => localStorage.length === 0)
      assert.deepEqual(await rawRecords(), {})
    })
    await check("toggle: old Host cannot start a fresh pause", async () => {
      await render("toggle", "toggle-unsupported", [], false)
      const before = mutationCalls().length
      await page.getByRole("button", { name: "例程 检查 的更多操作", exact: true }).click()
      await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
      await page.getByText("请更新 Bot 后台后调整例程。原记录保持不变。", { exact: true }).waitFor()
      assert.equal(mutationCalls().length, before)
      assert.deepEqual(await rawRecords(), {})
    })
    await page.screenshot({
      path: join(output, "scope-final.png"),
      fullPage: true,
      animations: "disabled"
    })
    console.log(JSON.stringify({ started, cases, failures, errors }))
    assert.deepEqual(failures, [])
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    if (server.listening)
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done()))
      )
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
