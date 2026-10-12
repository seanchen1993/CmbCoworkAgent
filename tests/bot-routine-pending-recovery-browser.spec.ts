/** Actual Resources/Forms and contextBridge-shaped packets with real persistent SQLite receipts.
 * It does not test Electron IPC, model execution, or native dialogs. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import type { BotSaveRoutineInput } from "../src/shared/bot-routines"

async function main() {
  const started = new Date().toISOString(),
    directory = await mkdtemp(join(tmpdir(), "cmb-orphan-routine-")),
    database = join(directory, "bots.sqlite")
  let store = new BotStore(database)
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  let httpServer: ReturnType<typeof createServer> | undefined
  let release: (() => void) | null = null
  try {
    const { bot } = store.createBot({ nonce: "owner", name: "研发 Bot" })
    const snapshot = store.snapshot(),
      epoch = snapshot.dataEpoch,
      renderer = resolve("src/renderer/src"),
      output = resolve("output/bot-routine-pending-recovery")
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
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';window.fixtureTheme=applyThemePreference;window.api={bots:new Proxy({},{get:(_,method)=>async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureSettled++}}})};window.fixtureSettled=0;const originalGet=Storage.prototype.getItem,originalRemove=Storage.prototype.removeItem;window.fixtureRaw=key=>originalGet.call(localStorage,key);window.fixtureDenied=false;window.fixtureCleanupFails=false;Storage.prototype.getItem=function(key){if(window.fixtureDenied)throw Error('storage denied');return originalGet.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails)throw Error('remove denied');return originalRemove.call(this,key)};window.fixtureCopied='';Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async raw=>{window.fixtureCopied=raw}}});function Fixture(){const[key,setKey]=useState('initial');window.fixtureRender=setKey;return <main className='min-h-screen bg-background text-foreground'><section data-fixture-key={key} key={key}><BotResources bot={${JSON.stringify(bot)}} tab='routines' close={()=>{}}/></section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`,
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
          name: "fixture-workspace",
          setup(context) {
            context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
              path: "workspace",
              namespace: "fixture"
            }))
            context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              loader: "ts",
              resolveDir: process.cwd(),
              contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:${JSON.stringify(snapshot)},host:{capabilities:['mutation-data-epoch-v2','routine-management','routine-editor','routine-run-version']},trackedWork:{},refresh:async()=>{const snapshot=await window.fixtureSnapshot();useBotWorkspaceStore.setState({snapshot})}}));window.fixtureWorkspace=useBotWorkspaceStore;`
            }))
          }
        }
      ]
    })
    const html = `<!doctype html><html><head><meta charset='utf-8'><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}</style></head><body><div id='root'></div><script>${bundle.outputFiles[0].text}</script></body></html>`
    const server = (httpServer = createServer((_request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(html)
    }))
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const calls: { method: string; input: unknown }[] = [],
      cases: string[] = [],
      failures: { name: string; message: string }[] = [],
      errors: string[] = []
    let heldMethod = "",
      heldResponse = "",
      dropNextMethod = ""
    const create = () =>
      store.saveRoutine({
        botId: bot.id,
        name: "原项目检查",
        prompt: "检查现有项目并交付证据",
        enabled: true,
        timezone: "UTC",
        schedule: { kind: "event", topic: "project.changed" }
      })
    const saveInput = (routine: ReturnType<typeof create>, nonce: string): BotSaveRoutineInput => ({
      botId: bot.id,
      id: routine.id,
      revision: routine.revision,
      nonce,
      name: routine.name,
      prompt: routine.prompt,
      enabled: false,
      timezone: routine.timezone,
      schedule: routine.schedule
    })
    const remove = (routine: ReturnType<typeof create>) =>
      store.deleteRoutine({
        botId: bot.id,
        id: routine.id,
        revision: routine.revision,
        nonce: `delete:${routine.id}`
      })
    const reopen = () => {
      store.close()
      store = new BotStore(database)
    }
    const mutationCalls = () =>
      calls.filter((call) => ["saveRoutine", "runRoutine"].includes(call.method))
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1000, height: 980 } })
    page.setDefaultTimeout(3000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureSnapshot", () => store.snapshot())
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      let response: unknown
      try {
        if (method === "routines") response = store.routines(input as string)
        else if (["skills", "availableSkills", "skillTrials", "skillLibrary"].includes(method))
          response = []
        else if (method === "saveRoutine")
          response = store.saveRoutine(input as BotSaveRoutineInput)
        else if (method === "runRoutine")
          response = store.runRoutine(input as Parameters<BotStore["runRoutine"]>[0])
        else throw new Error(`Unsupported fixture method: ${method}`)
      } catch (error) {
        response = {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_failure",
            message: error instanceof Error ? error.message : "Fixture failed"
          }
        }
      }
      if (method === dropNextMethod) {
        dropNextMethod = ""
        response = {
          botFailure: {
            code: "connection_closed",
            message: "Response lost after actual SQLite operation"
          }
        }
      }
      if (method === heldMethod) {
        heldMethod = ""
        if (heldResponse === "lost")
          response = {
            botFailure: {
              code: "connection_closed",
              message: "Response lost after actual SQLite operation"
            }
          }
        await new Promise<void>((done) => {
          release = done
        })
      }
      return response
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const render = async (
      key: string,
      records: { key: string; raw: string }[],
      dataEpoch = epoch,
      denied = false
    ) => {
      await page.evaluate(
        ({ key, records, dataEpoch, denied }) => {
          const fixture = window as unknown as {
            fixtureDenied: boolean
            fixtureCleanupFails: boolean
            fixtureRender(key: string): void
            fixtureWorkspace: { getState(): { snapshot: object }; setState(value: unknown): void }
          }
          fixture.fixtureDenied = false
          fixture.fixtureCleanupFails = false
          localStorage.clear()
          for (const record of records) localStorage.setItem(record.key, record.raw)
          fixture.fixtureDenied = denied
          const current = fixture.fixtureWorkspace.getState().snapshot
          fixture.fixtureWorkspace.setState({ snapshot: { ...current, dataEpoch } })
          fixture.fixtureRender(key)
        },
        { key, records, dataEpoch, denied }
      )
      await page.locator(`[data-fixture-key='${key}']`).waitFor({ state: "attached" })
    }
    const section = () => page.getByRole("region", { name: "原例程的待核对操作", exact: true })
    const raw = (key: string) =>
      page.evaluate(
        (key) => (window as unknown as { fixtureRaw(key: string): string | null }).fixtureRaw(key),
        key
      )
    const record = (kind: "save" | "run", id: string, input: unknown, dataEpoch = epoch) => ({
      key: `${kind === "save" ? "bot-routine-pending" : "bot-routine-run-pending"}:${bot.id}:${id}`,
      raw: JSON.stringify({ dataEpoch, input })
    })
    const check = async (name: string, test: () => Promise<void>) => {
      cases.push(name)
      try {
        await test()
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) })
        console.log(`FAIL ${name}: ${String(error)}`)
        release?.()
        release = null
        heldMethod = ""
      }
    }
    const retrySave = () =>
      section().getByRole("button", { name: "重试核对保存", exact: true }).click()
    const retryRun = () =>
      section().getByRole("button", { name: "核对并重试", exact: true }).click()
    await check(
      "accepted save loses ACK, is deleted, and reopens through original SQLite receipt without revival",
      async () => {
        const routine = create()
        await render("save-original", [])
        const card = page.locator(`#bot-routine-${routine.id}`)
        await card.waitFor()
        dropNextMethod = "saveRoutine"
        await card
          .getByRole("button", { name: `例程 ${routine.name} 的更多操作`, exact: true })
          .click()
        await page.getByRole("menuitem", { name: "暂停", exact: true }).click()
        await page.getByRole("button", { name: "重试核对保存", exact: true }).waitFor()
        const input = mutationCalls().at(-1)!.input as BotSaveRoutineInput,
          source = {
            key: `bot-routine-pending:${bot.id}:${routine.id}`,
            raw: (await raw(`bot-routine-pending:${bot.id}:${routine.id}`))!
          }
        assert.ok(source.raw)
        remove(store.routine(bot.id, routine.id))
        reopen()
        const before = mutationCalls().length
        await render("accepted-save", [source])
        await section().waitFor()
        assert.equal(await section().getByLabel("名称", { exact: true }).isDisabled(), true)
        await retrySave()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before + 1)
        assert.deepEqual(mutationCalls().at(-1)?.input, input)
        assert.equal(
          store.routines(bot.id).some((item) => item.id === routine.id),
          false
        )
      }
    )
    await check(
      "never accepted missing save is definitively rejected, exact-cleared, and cannot create replacement",
      async () => {
        const routine = create(),
          input = saveInput(routine, "not-accepted-save")
        remove(routine)
        const source = record("save", routine.id, input),
          before = mutationCalls().length
        await render("rejected-save", [source])
        await section().waitFor()
        await retrySave()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before + 1)
        assert.equal(
          store.routines(bot.id).some((item) => item.id === routine.id),
          false
        )
      }
    )
    await check(
      "accepted manual run loses ACK, deletion cancels it, retry keeps original job and does not enqueue",
      async () => {
        const routine = create()
        await render("run-original", [])
        const card = page.locator(`#bot-routine-${routine.id}`)
        await card.waitFor()
        dropNextMethod = "runRoutine"
        await card.getByRole("button", { name: "运行一次", exact: true }).click()
        await card.getByText("尚未确认运行状态。重试将核对同一次请求。", { exact: true }).waitFor()
        const apiInput = mutationCalls().at(-1)!.input as Parameters<BotStore["runRoutine"]>[0],
          accepted = store.runRoutine(apiInput),
          source = {
            key: `bot-routine-run-pending:${bot.id}:${routine.id}`,
            raw: (await raw(`bot-routine-run-pending:${bot.id}:${routine.id}`))!
          }
        assert.ok(source.raw)
        remove(routine)
        reopen()
        const before = mutationCalls().length,
          runs = store.snapshot().runs.length
        await render("accepted-run", [source])
        await section().waitFor()
        await retryRun()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before + 1)
        assert.deepEqual(mutationCalls().at(-1)?.input, apiInput)
        assert.equal(store.snapshot().runs.length, runs)
        assert.equal(store.getRun(accepted.id).status, "cancelled")
      }
    )
    await check(
      "never accepted missing manual run is exact-cleared after not_found and no new job",
      async () => {
        const routine = create(),
          input = {
            botId: bot.id,
            id: routine.id,
            revision: routine.revision,
            nonce: "not-accepted-run"
          }
        remove(routine)
        const source = record("run", routine.id, input),
          runs = store.snapshot().runs.length,
          before = mutationCalls().length
        await render("rejected-run", [source])
        await section().waitFor()
        await retryRun()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before + 1)
        assert.equal(store.snapshot().runs.length, runs)
      }
    )
    await check(
      "current routine records stay in their own cards while both orphan operation kinds remain reachable",
      async () => {
        const current = create(),
          gone = create()
        remove(gone)
        const ownSave = record("save", current.id, saveInput(current, "current-save")),
          ownRun = record("run", current.id, {
            botId: bot.id,
            id: current.id,
            revision: current.revision,
            nonce: "current-run"
          })
        const goneSave = record("save", gone.id, saveInput(gone, "gone-save")),
          goneRun = record("run", gone.id, {
            botId: bot.id,
            id: gone.id,
            revision: gone.revision,
            nonce: "gone-run"
          }),
          before = mutationCalls().length
        await render("inventory-scope", [ownSave, ownRun, goneSave, goneRun])
        await section().waitFor()
        assert.equal(await section().getByRole("option").count(), 2)
        assert.ok(
          (
            await section()
              .getByRole("combobox", { name: "选择原例程操作", exact: true })
              .textContent()
          )?.includes(gone.id)
        )
        assert.equal(mutationCalls().length, before)
        remove(current)
      }
    )
    await check(
      "retired save and run require explicit raw preservation and exact archive without invoking Host",
      async () => {
        const routine = create()
        remove(routine)
        const save = record("save", routine.id, saveInput(routine, "retired-save"), "old-epoch"),
          run = record(
            "run",
            routine.id,
            { botId: bot.id, id: routine.id, revision: routine.revision, nonce: "retired-run" },
            "old-epoch"
          ),
          before = mutationCalls().length
        await render("retired", [save, run])
        await section().waitFor()
        for (const source of [save, run]) {
          await section()
            .getByRole("combobox", { name: "选择原例程操作", exact: true })
            .selectOption(`${source === save ? "save" : "run"}:${routine.id}`)
          const alert = section().getByRole("alert")
          await alert.getByRole("button", { name: "复制原记录", exact: true }).click()
          await alert.getByText("原记录已复制", { exact: true }).waitFor()
          assert.equal(
            await page.evaluate(
              () => (window as unknown as { fixtureCopied: string }).fixtureCopied
            ),
            source.raw
          )
          await alert.getByRole("checkbox").check()
          await alert.getByRole("button", { name: "清除此条记录", exact: true }).click()
          await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        }
        assert.equal(mutationCalls().length, before)
        assert.equal(await section().count(), 0)
      }
    )
    await check(
      "corrupt disappeared record remains original until preserved and reviewed exact archive",
      async () => {
        const source = { key: `bot-routine-run-pending:${bot.id}:corrupt`, raw: "{broken raw}" },
          before = mutationCalls().length
        await render("corrupt", [source])
        await section().waitFor()
        const alert = section().getByRole("alert")
        assert.equal(await raw(source.key), source.raw)
        await alert.getByRole("button", { name: "复制原记录", exact: true }).click()
        await alert.getByText("原记录已复制", { exact: true }).waitFor()
        await alert.getByRole("checkbox").check()
        await alert.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before)
      }
    )
    await check(
      "storage access denied blocks recovery with an explicit safe message and no Host mutation",
      async () => {
        const source = { key: `bot-routine-run-pending:${bot.id}:denied`, raw: "retained" },
          before = mutationCalls().length
        await render("denied", [source], epoch, true)
        await section().waitFor()
        await section()
          .getByText("存储权限不可用，原记录保持不变。请恢复应用存储访问后重新打开。", {
            exact: true
          })
          .waitFor()
        assert.equal(await raw(source.key), source.raw)
        assert.equal(mutationCalls().length, before)
      }
    )
    await check(
      "64 original identities render a bounded selector and a single opened body in narrow dark layout",
      async () => {
        const records = Array.from({ length: 64 }, (_, index) =>
          record("save", `gone-${index}`, {
            botId: bot.id,
            id: `gone-${index}`,
            revision: 1,
            nonce: `old-${index}`,
            name: "待核对检查",
            prompt: "检查证据",
            timezone: "UTC",
            enabled: false,
            schedule: { kind: "event", topic: "project.changed" }
          })
        )
        await render("bounded", records)
        await section().waitFor()
        assert.equal(await section().getByRole("option").count(), 64)
        assert.equal(
          await section().getByRole("form", { name: "核对原例程保存", exact: true }).count(),
          1
        )
        await page.setViewportSize({ width: 420, height: 760 })
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.dataset.colorScheme),
          "dark"
        )
        const box = await section().boundingBox()
        assert.ok(box && box.width < 420 && box.x >= 0)
        await page.screenshot({
          path: join(output, "routine-recovery-dark-narrow.png"),
          animations: "disabled"
        })
        await page.setViewportSize({ width: 1000, height: 980 })
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme(
            "cmbdevclaw-white"
          )
        )
      }
    )
    await check(
      "late reply to an unmounted old selection may exact-ACK but does not close the new opened record",
      async () => {
        const first = create(),
          second = create(),
          input = saveInput(first, "late-selected-save"),
          accepted = store.saveRoutine(input)
        remove(accepted)
        remove(second)
        const a = record("save", first.id, input),
          b = record("run", second.id, {
            botId: bot.id,
            id: second.id,
            revision: second.revision,
            nonce: "new-opened-run"
          })
        await render("selection-race", [a, b])
        await section().waitFor()
        await section()
          .getByRole("combobox", { name: "选择原例程操作", exact: true })
          .selectOption(`save:${first.id}`)
        heldMethod = "saveRoutine"
        heldResponse = "success"
        await retrySave()
        for (let index = 0; !release && index < 100; index++)
          await new Promise((done) => setTimeout(done, 5))
        assert.ok(release)
        await section()
          .getByRole("combobox", { name: "选择原例程操作", exact: true })
          .selectOption(`run:${second.id}`)
        release()
        release = null
        await page.waitForFunction((key) => localStorage.getItem(key) === null, a.key)
        assert.equal(await raw(b.key), b.raw)
        assert.equal(
          await section()
            .getByRole("combobox", { name: "选择原例程操作", exact: true })
            .inputValue(),
          `run:${second.id}`
        )
        await section().getByText("上次运行尚未确认，可核对同一次请求。", { exact: true }).waitFor()
      }
    )
    await check(
      "successful receipt with failed local cleanup retries acknowledged state only, without a second operation",
      async () => {
        const routine = create(),
          input = saveInput(routine, "cleanup-save"),
          accepted = store.saveRoutine(input)
        remove(accepted)
        const source = record("save", routine.id, input),
          before = mutationCalls().length
        await render("cleanup", [source])
        await section().waitFor()
        await page.evaluate(() => {
          ;(window as unknown as { fixtureCleanupFails: boolean }).fixtureCleanupFails = true
        })
        await retrySave()
        await section()
          .getByText("保存结果已确认，本机记录尚未清除。重试只核对此条记录。", { exact: true })
          .waitFor()
        assert.equal(await raw(source.key), source.raw)
        await page.evaluate(() => {
          ;(window as unknown as { fixtureCleanupFails: boolean }).fixtureCleanupFails = false
        })
        await retrySave()
        await page.waitForFunction((key) => localStorage.getItem(key) === null, source.key)
        assert.equal(mutationCalls().length, before + 1)
      }
    )
    await check(
      "restore before an old success ACK preserves its retired original record and exposes no new save",
      async () => {
        const routine = create(),
          input = saveInput(routine, "restore-save"),
          accepted = store.saveRoutine(input)
        remove(accepted)
        const source = record("save", routine.id, input)
        await render("restore-race", [source])
        await section().waitFor()
        heldMethod = "saveRoutine"
        heldResponse = "success"
        await retrySave()
        for (let index = 0; !release && index < 100; index++)
          await new Promise((done) => setTimeout(done, 5))
        assert.ok(release)
        await page.evaluate(() => {
          const fixture = window as unknown as {
            fixtureWorkspace: { getState(): { snapshot: object }; setState(value: unknown): void }
          }
          fixture.fixtureWorkspace.setState({
            snapshot: { ...fixture.fixtureWorkspace.getState().snapshot, dataEpoch: "restored" }
          })
        })
        release()
        release = null
        await section().getByText("有恢复前的例程保存记录", { exact: true }).waitFor()
        assert.equal(await raw(source.key), source.raw)
        assert.equal(
          await section().getByRole("button", { name: "保存", exact: true }).isDisabled(),
          true
        )
      }
    )
    console.log(JSON.stringify({ started, cases, failures, errors, sqlite: database }))
    assert.deepEqual(failures, [])
    assert.deepEqual(errors, [])
  } finally {
    release?.()
    await browser?.close()
    if (httpServer?.listening)
      await new Promise<void>((done, fail) =>
        httpServer!.close((error) => (error ? fail(error) : done()))
      )
    store.close()
    await rm(directory, { recursive: true, force: true })
    console.log(
      JSON.stringify({
        physicalClose: new Date().toISOString(),
        serverListening: httpServer?.listening ?? false
      })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
