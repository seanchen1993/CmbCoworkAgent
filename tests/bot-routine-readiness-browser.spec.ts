/** Actual Summary/Resources/Form with SQLite and authenticated socket RPC. The outer
 * app/workspace facade is controlled; this is not packaged Electron or native kernel proof. */
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { BotRpcServer } from "../src/main/bots/rpc"
import { BotTransportClient } from "../src/main/bots/transport-client"
import { BOT_PROTOCOL_VERSION } from "../src/shared/bot-types"
import type { BotSaveRoutineInput } from "../src/shared/bot-routines"
import { highlightWorkerFixture } from "./fixtures/highlight-worker"

async function main() {
  const root = resolve("."),
    renderer = join(root, "src/renderer/src"),
    directory = await mkdtemp(join(tmpdir(), "cmb-bot10-ui-")),
    output = resolve(process.env.CMB_BOT10_OUTPUT ?? "output/bot-routine-readiness")
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(directory, "bots.sqlite"))
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    http: ReturnType<typeof createServer> | undefined,
    client: BotTransportClient | undefined,
    server: BotRpcServer | undefined,
    host: BotHost | undefined
  const pageErrors: string[] = [],
    calls: { method: string; input: unknown }[] = [],
    cases: string[] = []
  const verify = (botId: string, skillId: string) => {
    const skill = store.skills(botId).find((x) => x.id === skillId)!
    const trial = store.trialSkill({
      nonce: `verify-${skillId}`,
      botId,
      skillId,
      version: skill.version,
      inputs: "isolated",
      criteria: "check isolated evidence"
    })
    const claim = store.claim("ui-trial")!
    assert.equal(claim.run.id, trial.runId)
    store.finish(claim.lease, "succeeded", "isolated actual trial evidence")
    store.reviewSkillTrial({ id: trial.id, verdict: "passed", note: "Reviewed isolated result" })
  }
  try {
    const source = store.createBot({ nonce: "source", name: "Source" }),
      skill = store.saveSkill({
        botId: source.bot.id,
        name: "Copy Review",
        instructions: "Review isolated evidence",
        enabled: true
      })
    verify(source.bot.id, skill.id)
    const definition = {
      botId: source.bot.id,
      name: "Copied check",
      prompt: "Review isolated source",
      timezone: "UTC",
      schedule: { kind: "event" as const, topic: "ui.isolated" },
      skills: [{ botId: source.bot.id, id: skill.id, version: skill.version }]
    }
    store.saveRoutine({ ...definition, nonce: "source-active", enabled: true }, { kind: "human" })
    store.saveRoutine(
      { ...definition, nonce: "source-paused", name: "Paused check", enabled: false },
      { kind: "human" }
    )
    const clone = store.cloneBot({
        nonce: "copy",
        id: source.bot.id,
        revision: source.bot.revision
      }),
      copy = store.routines(clone.bot.id).find((x) => x.name === "Copied check")!,
      paused = store.routines(clone.bot.id).find((x) => x.name === "Paused check")!
    host = new BotHost(store)
    const token = randomBytes(32).toString("hex")
    server = new BotRpcServer(host, token)
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-bot10-ui-${token.slice(0, 16)}`
        : join(directory, "s.sock")
    await server.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
    const status = await client.call("status"),
      snapshot = await client.call("snapshot")
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
        contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotRoutineSummary}from'./src/renderer/src/components/bots/BotRoutineSummary';import{BotResources}from'./src/renderer/src/components/bots/BotResources';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-dark');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};function App(){const[resource,setResource]=useState(null);const[state,setState]=useState(0);window.fixtureReopen=()=>{setResource(null);setState(x=>x+1)};return <main className='bot-workspace h-screen overflow-auto bg-background p-8 text-foreground'><section aria-label='详情例程'><BotRoutineSummary key={state} botId=${JSON.stringify(clone.bot.id)} dataEpoch=${JSON.stringify(snapshot.dataEpoch)} active={!resource} open={intent=>setResource(intent)} manage={()=>setResource({mode:'view',dataEpoch:${JSON.stringify(snapshot.dataEpoch)}})}/></section>{resource&&<BotResources bot={${JSON.stringify(clone.bot)}} tab='routines' routineIntent={resource} close={()=>setResource(null)}/>}</main>};createRoot(document.getElementById('root')).render(<App/>);`
      },
      outfile: join(directory, "ui.js"),
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      jsx: "automatic",
      alias: { "@": renderer },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        await highlightWorkerFixture(renderer),
        {
          name: "bounded-outer-facade",
          setup(context) {
            context.onResolve({ filter: /(?:\/lib\/store|^@\/lib\/store)$/ }, () => ({
              path: "app",
              namespace: "fixture"
            }))
            context.onResolve({ filter: /^\.\/store$/ }, (args) =>
              args.importer.includes("/renderer/src/lib/")
                ? { path: "app", namespace: "fixture" }
                : undefined
            )
            context.onResolve({ filter: /bot-workspace-store$/ }, () => ({
              path: "workspace",
              namespace: "fixture"
            }))
            context.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
              loader: "ts",
              resolveDir: root,
              contents:
                path === "app"
                  ? `import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false}));`
                  : `import{create}from'zustand';export const useBotWorkspaceStore=create(set=>({snapshot:${JSON.stringify(snapshot)},host:${JSON.stringify(status)},selected:${JSON.stringify(clone.conversationId)},trackedWork:{},drafts:{},refresh:async()=>set({snapshot:await window.fixtureSnapshot()})}));window.fixtureWorkspace=useBotWorkspaceStore;`
            }))
          }
        }
      ]
    })
    const script = bundle.outputFiles.find((x) => x.path.endsWith(".js"))
    if (!script) throw Error("Missing actual JS bundle")
    const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css.build(scanner.scan())}${await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8")}${bundle.outputFiles
      .filter((x) => x.path.endsWith(".css"))
      .map((x) => x.text)
      .join("\n")}</style><body><div id="root"></div><script>${script.text}</script></body></html>`
    http = createServer((_, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8")
      res.end(html)
    })
    await new Promise<void>((done) => http!.listen(0, "127.0.0.1", done))
    const address = http.address()
    if (!address || typeof address === "string") throw Error("Missing HTTP fixture address")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    page.setDefaultTimeout(5000)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.exposeFunction("fixtureSnapshot", () => client!.call("snapshot"))
    const invoke = client.call.bind(client) as (method: string, input?: unknown) => Promise<unknown>
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      if (
        ![
          "routines",
          "skills",
          "availableSkills",
          "skillLibrary",
          "skillTrials",
          "saveRoutine"
        ].includes(method)
      )
        throw Error(`Unexpected UI method ${method}`)
      try {
        return await invoke(method, input)
      } catch (error) {
        return {
          botFailure: {
            code: (error as { code?: string }).code ?? "fixture_failure",
            message: error instanceof Error ? error.message : "Fixture failure"
          }
        }
      }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const row = page.getByRole("button", { name: "查看例程 Copied check", exact: true })
    await row.waitFor()
    assert.match(await row.innerText(), /需要设置/)
    await row.click()
    const resources = page
      .getByRole("dialog")
      .filter({ has: page.getByRole("heading", { name: "例程详情", exact: true }) })
    await resources.waitFor()
    const card = page.locator(`#bot-routine-${copy.id}`)
    await card.waitFor()
    assert.match(await card.innerText(), /需要设置/)
    await card.getByRole("button", { name: "例程 Copied check 的更多操作", exact: true }).click()
    await page.getByRole("menuitem", { name: "核对设置", exact: true }).click()
    await page.getByRole("textbox", { name: "名称", exact: true }).fill("Renamed copied check")
    await page.getByRole("button", { name: "保存修改", exact: true }).click()
    await page.getByRole("heading", { name: "Renamed copied check", exact: true }).waitFor()
    const firstSave = calls.find((x) => x.method === "saveRoutine")!.input as BotSaveRoutineInput
    assert.equal(firstSave.enabled, false)
    assert.equal(firstSave.desiredEnabled, true)
    assert.equal(firstSave.revision, copy.revision)
    assert.equal(store.routine(clone.bot.id, copy.id).effectiveState, "needs_setup")
    cases.push(
      "Summary → original Card → menu setup/Form preserves disabled authored intent via authenticated RPC"
    )
    verify(clone.bot.id, store.skills(clone.bot.id)[0].id)
    assert.equal(store.routine(clone.bot.id, copy.id).enabled, false)
    assert.equal(store.routine(clone.bot.id, paused.id).desiredEnabled, false)
    await page.evaluate("window.fixtureReopen()")
    const verifiedRow = page.getByRole("button", {
      name: "查看例程 Renamed copied check",
      exact: true
    })
    await verifiedRow.waitFor()
    assert.match(await verifiedRow.innerText(), /已验证，待确认启用/)
    await page.screenshot({ path: join(output, "needs-activation-dark.png") })
    await verifiedRow.click()
    const verifiedCard = page.locator(`#bot-routine-${copy.id}`)
    await verifiedCard
      .getByRole("button", { name: "例程 Renamed copied check 的更多操作", exact: true })
      .click()
    await page.getByRole("menuitem", { name: "启用", exact: true }).click()
    await page.waitForFunction(
      (id) => document.getElementById(`bot-routine-${id}`)?.textContent?.includes("等待事件触发"),
      copy.id
    )
    assert.equal(store.routine(clone.bot.id, copy.id).enabled, true)
    assert.equal(store.routine(clone.bot.id, copy.id).activationRequired, false)
    assert.equal(store.routine(clone.bot.id, paused.id).enabled, false)
    const activated = calls.filter((x) => x.method === "saveRoutine").at(-1)!
      .input as BotSaveRoutineInput
    assert.equal(activated.enabled, true)
    assert.equal(activated.desiredEnabled, true)
    assert.ok(activated.nonce)
    await page.evaluate("window.fixtureTheme('codex-light')")
    await page.screenshot({ path: join(output, "activated-light.png") })
    await page.setViewportSize({ width: 760, height: 800 })
    await page.emulateMedia({ reducedMotion: "reduce" })
    await page.screenshot({ path: join(output, "activated-narrow-reduced.png") })
    await resources.getByRole("button", { name: "Close", exact: true }).click()
    await resources.waitFor({ state: "detached" })
    const activeRow = page.getByRole("button", {
      name: "查看例程 Renamed copied check",
      exact: true
    })
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some(
        (item) =>
          item.getAttribute("aria-label") === "查看例程 Renamed copied check" &&
          item.textContent?.includes("等待事件触发")
      )
    )
    assert.match(await activeRow.innerText(), /等待事件触发/)
    assert.equal(
      await page
        .getByRole("switch", { name: "启用例程 Renamed copied check", exact: true })
        .getAttribute("aria-checked"),
      "true"
    )
    assert.equal(
      await page
        .getByRole("switch", { name: "启用例程 Paused check", exact: true })
        .getAttribute("aria-checked"),
      "false"
    )
    await page.screenshot({ path: join(output, "activated-summary-narrow-reduced.png") })
    assert.deepEqual(pageErrors, [])
    cases.push(
      "Actual trial alone stays off; explicit original Card activation enables only selected routine; closing Resources refreshes original Summary"
    )
    await writeFile(
      join(output, "results.json"),
      JSON.stringify(
        {
          status: "PASS",
          scope:
            "Actual React Summary/Resources/Form+SQLite+authenticated socket RPC; controlled outer facade; no packaged/native platform claims",
          directory,
          cases,
          calls,
          pageErrors
        },
        null,
        2
      ) + "\n"
    )
    console.log(JSON.stringify({ status: "PASS", cases, output, directory, pageErrors }))
  } finally {
    await browser?.close()
    if (http) {
      http.closeAllConnections()
      await new Promise<void>((done, reject) =>
        http!.close((error) => (error ? reject(error) : done()))
      )
    }
    client?.close()
    if (server?.server.listening) await server.close()
    await host?.stop()
    store.close()
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
