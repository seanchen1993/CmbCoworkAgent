/** Actual MemoryPanel, API status and SQLite policy. Native bridge/visibility/held replies are controlled seams. */
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
import { botIpcFailure } from "../src/main/bots/error-diagnostic"
import { BotDomainError } from "../src/shared/bot-types"

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/memory-policy-epoch"),
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
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotMemoryPanel}from'./src/renderer/src/components/bots/BotMemoryPanel';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['memoryPolicy','setMemoryPolicy','retryMemory'].map(method=>[method,async input=>{window.fixtureReturned=false;try{return await window.fixtureCall(method,input)}finally{window.fixtureReturned=true}}]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;applyThemePreference('codex-light');
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});flushSync(()=>{setSetup(input);setVisible(true);setMount(value=>value+1)})};window.fixtureUnmount=()=>flushSync(()=>setVisible(false));if(!setup||!visible)return null;return <main className='bot-workspace bg-background text-foreground' style={{height:'100vh',padding:24}}><section key={mount} data-testid='memory-owner'><BotMemoryPanel botId={setup.bot.id} memories={[]} reload={()=>window.fixtureReload()} close={()=>setVisible(false)}/></section></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
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
    host: BotHost | undefined,
    held = false,
    release: (() => void) | undefined,
    outcome: "success" | "rejection" = "success",
    reads = 0,
    reloads = 0,
    mutations = 0,
    missingEpoch = false
  const requests: unknown[] = [],
    errors: string[] = [],
    journeys: string[] = [],
    failures: string[] = []
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 980, height: 760 } })
  page.setDefaultTimeout(7000)
  page.on("pageerror", (error) => errors.push(error.message))
  try {
    await page.exposeFunction("fixtureReload", () => {
      reloads++
      return Promise.resolve()
    })
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (method === "memoryPolicy") {
        reads++
        const policy = store!.memory.policy(String(input))
        if (missingEpoch) {
          const legacy = { ...policy }
          delete legacy.dataEpoch
          return legacy
        }
        return policy
      }
      mutations++
      requests.push(input)
      try {
        return await guardBotRpcMutationEpoch(
          method,
          input,
          () => store!.dataEpoch(),
          async () => {
            let result: ReturnType<BotStore["memory"]["setPolicy"]> | undefined
            if (outcome === "success") result = store!.memory.setPolicy(input)
            if (held)
              await new Promise<void>((done) => {
                release = done
              })
            if (outcome === "rejection")
              throw new BotDomainError("revision_conflict", "原设置已被拒绝")
            return result
          }
        )
      } catch (error) {
        return botIpcFailure(error)
      }
    })
    await page.route("http://127.0.0.1:43152/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43152/")
    await page.waitForFunction(() => typeof window.fixtureSetup === "function")
    const reset = async () => {
      await page.evaluate(() => window.fixtureUnmount())
      await page.getByTestId("memory-owner").waitFor({ state: "detached" })
      await host?.stop()
      store?.close()
      store = new BotStore(":memory:")
      host = new BotHost(store)
      held = false
      release = undefined
      outcome = "success"
      missingEpoch = false
      const bot = store.createBot({ nonce: "bot", name: "Memory Bot" }).bot,
        api = createBotAPI(host)
      return { bot, snapshot: store.snapshot(), host: await api.status() }
    }
    const mount = async (f: Awaited<ReturnType<typeof reset>>) => {
      await page.evaluate((f) => window.fixtureSetup(f), f)
      await page.getByLabel("自动整理任务经验", { exact: true }).waitFor()
      await page.waitForFunction(
        () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "true"
      )
    }
    const toggle = () => page.getByRole("switch", { name: "自动整理任务经验", exact: true })
    const waitRelease = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((done) => setTimeout(done, 5))
      assert.ok(release)
    }
    const restored = async (emit = true) => {
      store!.db.run(
        "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored',?,'{}',?)",
        ["replacement", store!.now()]
      )
      if (emit)
        await page.evaluate(
          (snapshot) => window.fixtureStore.setState({ snapshot }),
          store!.snapshot()
        )
    }
    const check = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
      }
      journeys.push(name)
    }
    {
      const f = await reset()
      await mount(f)
      const before = mutations
      await toggle().click()
      await page.waitForFunction(
        () => document.querySelector('[role="switch"]')?.getAttribute("aria-checked") === "false"
      )
      await check("actual policy authority submitted", async () => {
        assert.equal(
          (requests.at(-1) as { expectedDataEpoch?: string }).expectedDataEpoch,
          f.snapshot.dataEpoch
        )
        assert.equal(mutations, before + 1)
        assert.equal(store!.memory.policy(f.bot.id).enabled, false)
      })
    }
    {
      const f = await reset()
      await mount(f)
      await restored(false)
      const before = JSON.stringify([
        store!.memory.policy(f.bot.id),
        store!.db.exec("SELECT * FROM bot_events")
      ])
      await toggle().click()
      // A genuine scope rejection produces a frozen pane. Baseline may instead accept the mutation.
      await page.waitForFunction(() => window.fixtureReturned === true)
      await page.waitForFunction(
        () => document.querySelector('[role="switch"]')?.getAttribute("aria-busy") !== "true"
      )
      await check("stale renderer cannot toggle identical replacement policy", async () => {
        assert.equal(
          JSON.stringify([
            store!.memory.policy(f.bot.id),
            store!.db.exec("SELECT * FROM bot_events")
          ]),
          before
        )
        assert.equal(await toggle().isDisabled(), true)
      })
    }
    for (const mode of ["success", "rejection"] as const)
      for (const transition of ["restore", "unmount"] as const) {
        const f = await reset()
        await mount(f)
        held = true
        outcome = mode
        await toggle().click()
        await waitRelease()
        if (transition === "restore") await restored()
        else {
          await page.evaluate(() => window.fixtureUnmount())
          await page.getByTestId("memory-owner").waitFor({ state: "detached" })
        }
        const beforeReads = reads,
          beforeReloads = reloads
        release!()
        release = undefined
        await check(`${mode}/${transition} callback ownership`, async () => {
          if (transition === "restore") {
            await page.waitForFunction(
              () => !document.querySelector("button:disabled .animate-spin")
            )
            assert.equal(await toggle().isDisabled(), true)
            assert.equal(await toggle().getAttribute("aria-checked"), "true")
            await page.getByRole("alert").filter({ hasText: "工作区数据已恢复" }).first().waitFor()
          } else {
            // Join the actual returned call, then verify no subsequent read/reload was dispatched.
            await page.waitForFunction(() => window.fixtureReturned === true)
            assert.equal(reads, beforeReads)
            assert.equal(reloads, beforeReloads)
          }
        })
      }
    {
      const f = await reset()
      f.host.capabilities = f.host.capabilities!.filter((cap) => cap !== "mutation-data-epoch-v2")
      await mount(f)
      const before = mutations
      await check("older Host lacks policy scope capability", async () => {
        assert.equal(await toggle().isDisabled(), true)
        assert.equal(mutations, before)
      })
    }
    {
      const f = await reset()
      missingEpoch = true
      await mount(f)
      const before = mutations
      await check("older policy missing epoch stays readonly", async () => {
        assert.equal(await toggle().isDisabled(), true)
        assert.equal(mutations, before)
      })
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
    await page.screenshot({ path: join(output, "policy-scope.png"), animations: "disabled" })
    await writeFile(
      join(output, "checks.json"),
      JSON.stringify({ passed: true, journeys, errors, startedAt }, null, 2)
    )
    console.log(JSON.stringify({ passed: true, journeys, errors, startedAt }, null, 2))
  } catch (error) {
    console.log(JSON.stringify({ failures, journeys, errors }))
    console.error(await page.locator("body").innerText())
    await page.screenshot({ path: join(output, "failure.png") })
    throw error
  } finally {
    release?.()
    await browser.close()
    await host?.stop()
    store?.close()
    console.log(JSON.stringify({ physicallyClosedAt: new Date().toISOString() }))
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
