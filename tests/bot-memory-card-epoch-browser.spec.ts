/** Real MemoryCard/SharedPanel + SQLite mutations; native bridge, visibility and delayed replies are seams. */
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

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/memory-cards"),
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
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{MemoryCard}from'./src/renderer/src/components/bots/BotMemoryPanel';import{BotSharedMemoryPanel}from'./src/renderer/src/components/bots/BotSharedMemoryPanel';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['message','memories','sharedMemories','saveMemory','deleteMemory','saveSharedMemory','deleteSharedMemory'].map(method=>[method,async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureReturned++}}]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureReturned=0;applyThemePreference('codex-light');
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{if(!input.preservePending)localStorage.clear();useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});flushSync(()=>{setSetup(input);setVisible(true);setMount(v=>v+1)})};window.fixtureUnmount=()=>flushSync(()=>setVisible(false));if(!visible||!setup)return null;return <main className='bot-workspace bg-background text-foreground' style={{padding:24,height:'100vh'}}><section key={mount} data-testid='memory-owner'>{setup.shared?<BotSharedMemoryPanel bot={setup.bot} scope='user' close={()=>setVisible(false)}/>:<MemoryCard memory={setup.memory} reload={()=>window.fixtureReload()} close={()=>setVisible(false)}/>}</section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    plugins: [
      {
        name: "visibility",
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
    reads = 0,
    reloads = 0,
    mutations = 0,
    loseAck = false
  const requests: { method: string; input: unknown }[] = [],
    errors: string[] = [],
    failures: string[] = [],
    journeys: string[] = []
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 980, height: 800 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (e) => errors.push(e.message))
  try {
    await page.exposeFunction("fixtureReload", () => {
      reloads++
      return Promise.resolve()
    })
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      const api = createBotAPI(host!)
      if (method === "sharedMemories") {
        reads++
        return api.sharedMemories(input as Parameters<typeof api.sharedMemories>[0])
      }
      if (method === "message") return api.message(input as Parameters<typeof api.message>[0])
      mutations++
      requests.push({ method, input })
      try {
        const result = await guardBotRpcMutationEpoch(
          method,
          input,
          () => store!.dataEpoch(),
          async () => {
            const result = await (
              api[method as "saveMemory"] as (input: unknown) => Promise<unknown>
            )(input)
            if (held)
              await new Promise<void>((done) => {
                release = done
              })
            return result
          }
        )
        if (loseAck) throw new Error("connection closed after committed receipt")
        return result
      } catch (error) {
        return botIpcFailure(error)
      }
    })
    await page.route("http://127.0.0.1:43154/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43154/")
    await page.waitForFunction(() => typeof window.fixtureSetup === "function")
    const reset = async (shared = false) => {
      await page.evaluate(() => window.fixtureUnmount())
      await page.getByTestId("memory-owner").waitFor({ state: "detached" })
      await host?.stop()
      store?.close()
      store = new BotStore(":memory:")
      host = new BotHost(store)
      held = false
      loseAck = false
      release = undefined
      const bot = store.createBot({ nonce: "bot", name: "Memory Bot" }).bot,
        memory = shared
          ? await store.sharedMemories.save({
              botId: bot.id,
              botRevision: bot.revision,
              scope: "user",
              nonce: "original",
              text: "original memory"
            })
          : store.saveMemory({ botId: bot.id, text: "original memory" })
      return {
        bot,
        memory,
        shared,
        snapshot: store.snapshot(),
        host: await createBotAPI(host).status()
      }
    }
    const mount = async (f: Awaited<ReturnType<typeof reset>>) => {
      await page.evaluate((f) => window.fixtureSetup(f), f)
      await page.getByLabel("编辑记忆", { exact: true }).waitFor()
    }
    const edit = async () => {
      await page.getByLabel("编辑记忆", { exact: true }).click()
      await page.getByLabel("编辑记忆内容", { exact: true }).fill("edited memory")
      await page.getByRole("button", { name: "保存修订", exact: true }).click()
    }
    const remove = async (shared: boolean) => {
      await page.getByLabel("删除记忆", { exact: true }).click()
      if (shared) await page.getByRole("button", { name: "确认删除共享记忆", exact: true }).click()
    }
    const waitHeld = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((d) => setTimeout(d, 5))
      assert.ok(release)
    }
    const restore = async (emit = true) => {
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
    const evidence = () =>
      JSON.stringify([
        store!.db.exec("SELECT * FROM bot_memories"),
        store!.db.exec("SELECT * FROM bot_shared_memories"),
        store!.db.exec("SELECT * FROM bot_events")
      ])
    const settle = async (previous: number) => {
      await page.waitForFunction((previous) => window.fixtureReturned > previous, previous)
      await page.waitForTimeout(25)
    }
    const check = async (name: string, fn: () => Promise<void>) => {
      journeys.push(name)
      try {
        await fn()
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    for (const shared of [false, true]) {
      {
        const f = await reset(shared)
        await mount(f)
        const before = await page.evaluate(() => window.fixtureReturned)
        await edit()
        await settle(before)
        await check(`${shared ? "shared" : "private"} reviewed actual epoch`, async () => {
          assert.equal(
            (requests.at(-1)!.input as { expectedDataEpoch?: string }).expectedDataEpoch,
            f.snapshot.dataEpoch
          )
          const rows = shared
            ? await store!.sharedMemories.list({
                botId: f.bot.id,
                botRevision: f.bot.revision,
                scope: "user"
              })
            : store!.memories(f.bot.id)
          assert.equal(rows[0].text, "edited memory")
        })
      }
      for (const deleting of [false, true]) {
        const f = await reset(shared)
        await mount(f)
        await restore(false)
        const before = evidence(),
          returns = await page.evaluate(() => window.fixtureReturned)
        if (deleting) await remove(shared)
        else await edit()
        await settle(returns)
        await check(
          `${shared ? "shared" : "private"} stale ${deleting ? "delete" : "edit"} refused`,
          async () => {
            assert.equal(evidence(), before)
            assert.ok(await page.getByRole("alert").count())
            const buttons = await page.locator('[data-testid="memory-owner"] button').all()
            for (const button of buttons)
              if (await button.isVisible())
                assert.equal(
                  await button.isDisabled(),
                  true,
                  (await button.getAttribute("aria-label")) ?? (await button.innerText())
                )
          }
        )
      }
      {
        const f = await reset(shared)
        await mount(f)
        held = true
        await edit()
        await waitHeld()
        await page.evaluate(() => window.fixtureUnmount())
        await page.getByTestId("memory-owner").waitFor({ state: "detached" })
        const before = reads + reloads,
          returns = await page.evaluate(() => window.fixtureReturned)
        release!()
        await settle(returns)
        await check(
          `${shared ? "shared" : "private"} unmounted success has no followup`,
          async () => assert.equal(reads + reloads, before)
        )
      }
      {
        const f = await reset(shared)
        await mount(f)
        held = true
        await edit()
        await waitHeld()
        await restore()
        const before = reads + reloads,
          returns = await page.evaluate(() => window.fixtureReturned)
        release!()
        await settle(returns)
        await check(
          `${shared ? "shared" : "private"} restore held success freezes existing card`,
          async () => {
            assert.equal(reads + reloads, before)
            assert.equal(await page.getByLabel("编辑记忆内容", { exact: true }).isDisabled(), true)
          }
        )
      }
      {
        const f = await reset(shared)
        f.host.capabilities = f.host.capabilities?.filter((c) => c !== "memory-mutation-epoch")
        await mount(f)
        await check(`${shared ? "shared" : "private"} old Host readonly`, async () => {
          assert.equal(await page.getByLabel("编辑记忆", { exact: true }).isDisabled(), true)
          assert.equal(await page.getByLabel("删除记忆", { exact: true }).isDisabled(), true)
        })
      }
    }
    {
      const f = await reset(true)
      await mount(f)
      held = true
      await page.getByLabel("添加共享记忆", { exact: true }).fill("new shared")
      await page.getByRole("button", { name: "保存共享记忆", exact: true }).click()
      await waitHeld()
      await page.evaluate(() => window.fixtureUnmount())
      await page.getByTestId("memory-owner").waitFor({ state: "detached" })
      const before = reads,
        returns = await page.evaluate(() => window.fixtureReturned)
      release!()
      await settle(returns)
      await check("shared create unmounted success has no followup", async () =>
        assert.equal(reads, before)
      )
    }
    for (const operation of ["create", "edit", "delete"] as const) {
      await check(
        `shared lost ${operation} ACK survives reopen and retries only its original nonce`,
        async () => {
          const f = await reset(true)
          await mount(f)
          loseAck = true
          const returned = await page.evaluate(() => window.fixtureReturned)
          if (operation === "create") {
            await page.getByLabel("添加共享记忆", { exact: true }).fill("new shared memory")
            await page.getByRole("button", { name: "保存共享记忆", exact: true }).click()
          } else if (operation === "edit") await edit()
          else await remove(true)
          await settle(returned)
          const original = requests.at(-1)!,
            before = mutations
          const raw = await page.evaluate(() =>
            localStorage.getItem(
              Object.keys(localStorage).find((key) =>
                key.startsWith("bot-shared-memory-pending:")
              ) ?? ""
            )
          )
          assert.ok(raw)
          assert.equal(await page.getByLabel("添加共享记忆", { exact: true }).isDisabled(), true)
          await page.evaluate(() => window.fixtureUnmount())
          await page.getByTestId("memory-owner").waitFor({ state: "detached" })
          loseAck = false
          await page.evaluate((f) => window.fixtureSetup({ ...f, preservePending: true }), f)
          await page.getByRole("button", { name: "核对原记忆操作", exact: true }).waitFor()
          const previous = await page.evaluate(() => window.fixtureReturned)
          await page.getByRole("button", { name: "核对原记忆操作", exact: true }).click()
          await settle(previous)
          await page
            .getByRole("button", { name: "核对原记忆操作", exact: true })
            .waitFor({ state: "detached" })
          assert.equal(mutations, before + 1)
          assert.deepEqual(requests.at(-1), original)
          const rows = await store!.sharedMemories.list({
            botId: f.bot.id,
            botRevision: f.bot.revision,
            scope: "user"
          })
          assert.equal(rows.length, operation === "create" ? 2 : operation === "edit" ? 1 : 0)
          assert.equal(
            await page.evaluate(
              () =>
                Object.keys(localStorage).filter((k) => k.startsWith("bot-shared-memory-pending:"))
                  .length
            ),
            0
          )
        }
      )
    }
    await check(
      "shared known ACK cleanup failure retries locally without replaying mutation",
      async () => {
        const f = await reset(true)
        await mount(f)
        await page.evaluate(
          `window.fixtureRemove=Storage.prototype.removeItem;Storage.prototype.removeItem=function(key){if(key.startsWith('bot-shared-memory-pending:'))throw Error('storage cleanup unavailable');return window.fixtureRemove.call(this,key)}`
        )
        const previous = await page.evaluate(() => window.fixtureReturned)
        await edit()
        await settle(previous)
        const before = mutations
        await page.getByRole("button", { name: "核对原记忆操作", exact: true }).waitFor()
        await page.evaluate(`Storage.prototype.removeItem=window.fixtureRemove`)
        await page.getByRole("button", { name: "核对原记忆操作", exact: true }).click()
        await page
          .getByRole("button", { name: "核对原记忆操作", exact: true })
          .waitFor({ state: "detached" })
        assert.equal(mutations, before)
      }
    )
    await check(
      "shared restored held ACK retains exact retired request bytes on stable owner",
      async () => {
        const f = await reset(true)
        await mount(f)
        held = true
        await edit()
        await waitHeld()
        const raw = await page.evaluate(() =>
          localStorage.getItem(
            Object.keys(localStorage).find((key) => key.startsWith("bot-shared-memory-pending:")) ??
              ""
          )
        )
        assert.ok(raw)
        await restore()
        const previous = await page.evaluate(() => window.fixtureReturned)
        release!()
        await settle(previous)
        assert.equal(
          await page.evaluate(() =>
            localStorage.getItem(
              Object.keys(localStorage).find((key) =>
                key.startsWith("bot-shared-memory-pending:")
              ) ?? ""
            )
          ),
          raw
        )
        await page.evaluate(() => window.fixtureUnmount())
        await page.getByTestId("memory-owner").waitFor({ state: "detached" })
        const authority = { ...f, snapshot: store!.snapshot() }
        await page.evaluate((f) => window.fixtureSetup({ ...f, preservePending: true }), authority)
        await page.getByRole("alert", { name: "待确认共享记忆操作记录", exact: true }).waitFor()
        const before = mutations
        assert.equal(
          await page.getByRole("button", { name: "保存共享记忆", exact: true }).isDisabled(),
          true
        )
        assert.equal(mutations, before)
      }
    )
    await writeFile(
      join(output, "PROOF.json"),
      JSON.stringify(
        {
          startedAt,
          completedAt: new Date().toISOString(),
          journeys,
          errors,
          failures,
          requests,
          reads,
          reloads,
          mutations
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ journeys: journeys.length, errors, failures }))
    assert.deepEqual(errors, [])
    assert.deepEqual(failures, [])
  } finally {
    release?.()
    await page.close()
    await browser.close()
    await host?.stop()
    store?.close()
    console.log(
      JSON.stringify({ physicallyClosedAt: new Date().toISOString(), serverListening: false })
    )
  }
}
void main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
