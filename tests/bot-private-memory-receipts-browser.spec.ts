/** Real private MemoryPanel + SQLite receipts. Native bridge and delayed wire replies are controlled seams. */
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
import type { BotMemorySaveInput, BotMemoryDeleteInput } from "../src/shared/bot-memory"
import type { BotMemory } from "../src/shared/bot-types"

declare global {
  interface Window {
    fixtureReloadCompleted: number
    fixtureReloadVersion: number
    fixturePolicyReturned: number
    fixtureRows(rows: BotMemory[]): void
  }
}

async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/private-memory-receipts"),
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
window.api={bots:Object.fromEntries(['message','memories','memoryPolicy','setMemoryPolicy','retryMemory','saveMemory','deleteMemory'].map(method=>[method,async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureReturned++;if(method==='memoryPolicy')window.fixturePolicyReturned++}}]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureReturned=0;window.fixtureReloadCompleted=0;window.fixtureReloadVersion=0;window.fixturePolicyReturned=0;applyThemePreference('codex-light');
const nativeGet=Storage.prototype.getItem,nativeRemove=Storage.prototype.removeItem,nativeSet=Storage.prototype.setItem;window.fixtureStorage={read:false,remove:false,write:false};Storage.prototype.getItem=function(key){if(window.fixtureStorage.read&&key.startsWith('bot-private-memory-pending:'))throw Error('blocked read');return nativeGet.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureStorage.remove&&key.startsWith('bot-private-memory-pending:'))throw Error('blocked cleanup');return nativeRemove.call(this,key)};Storage.prototype.setItem=function(key,value){if(window.fixtureStorage.write&&key.startsWith('bot-private-memory-pending:'))throw Error('blocked write');return nativeSet.call(this,key,value)};
function Fixture(){const reloadVersion=window.fixtureReloadVersion;const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0),[memories,setMemories]=useState([]);window.fixtureSetup=input=>{if(!input.preservePending)localStorage.clear();useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});flushSync(()=>{setSetup(input);setMemories(input.memories);setVisible(true);setMount(v=>v+1)})};window.fixtureUnmount=()=>flushSync(()=>setVisible(false));window.fixtureRows=rows=>flushSync(()=>setMemories(rows));if(!visible||!setup)return null;return <main className='bot-workspace bg-background text-foreground' style={{padding:24,minHeight:'100vh'}}><section key={mount} data-testid='private-memory-owner'><BotMemoryPanel botId={setup.bot.id} memories={memories} reload={async()=>{const rows=await window.fixtureReload(reloadVersion);window.fixtureReloadCompleted++;setMemories(rows)}} close={()=>setVisible(false)}/></section></main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
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
    loseAck = false,
    invalidAck = false,
    rejected = false,
    release: (() => void) | undefined,
    reloads = 0,
    mutations = 0
  const reloadVersions: number[] = [],
    requests: { method: string; input: unknown }[] = [],
    errors: string[] = [],
    failures: string[] = [],
    journeys: string[] = []
  const browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true
    }),
    page = await browser.newPage({ viewport: { width: 1000, height: 900 } })
  page.setDefaultTimeout(5000)
  page.on("pageerror", (e) => errors.push(e.message))
  try {
    await page.exposeFunction("fixtureReload", (version: number) => {
      reloadVersions.push(version)
      reloads++
      return store!.memories(store!.snapshot().bots[0].id)
    })
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      const api = createBotAPI(host!)
      if (method === "memoryPolicy") return api.memoryPolicy(input as string)
      if (method === "message") return api.message(input as Parameters<typeof api.message>[0])
      if (method === "memories") return api.memories(input as string)
      mutations++
      requests.push({ method, input })
      try {
        const result = await guardBotRpcMutationEpoch(
          method,
          input,
          () => store!.dataEpoch(),
          async () => {
            if (rejected) {
              if (held)
                await new Promise<void>((done) => {
                  release = done
                })
              throw Object.assign(new Error("rejected original"), { code: "revision_conflict" })
            }
            const value =
              method === "saveMemory"
                ? await api.saveMemory(input as BotMemorySaveInput)
                : await api.deleteMemory(input as BotMemoryDeleteInput)
            if (held)
              await new Promise<void>((done) => {
                release = done
              })
            return value
          }
        )
        if (loseAck) throw new Error("connection closed after committed receipt")
        if (invalidAck) return null
        return result
      } catch (error) {
        return botIpcFailure(error)
      }
    })
    await page.route("http://127.0.0.1:43156/**", (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang='zh-CN'><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text.replaceAll("</script", "<\\/script")}</script></html>`
      })
    )
    await page.goto("http://127.0.0.1:43156/")
    await page.waitForFunction(() => typeof window.fixtureSetup === "function")
    const reset = async () => {
      await page.evaluate(() => window.fixtureUnmount())
      await page.getByTestId("private-memory-owner").waitFor({ state: "detached" })
      await host?.stop()
      store?.close()
      store = new BotStore(":memory:")
      host = new BotHost(store)
      held = loseAck = invalidAck = rejected = false
      release = undefined
      await page.evaluate(() => {
        window.fixtureStorage.read =
          window.fixtureStorage.write =
          window.fixtureStorage.remove =
            false
      })
      const bot = store.createBot({ nonce: "bot", name: "Memory Bot" }).bot,
        memory = store.saveMemory({ botId: bot.id, text: "original memory" })
      return {
        bot,
        memory,
        memories: store.memories(bot.id),
        snapshot: store.snapshot(),
        host: await createBotAPI(host).status()
      }
    }
    const mount = async (f: Awaited<ReturnType<typeof reset>>, preservePending = false) => {
      await page.evaluate((f) => window.fixtureSetup(f), { ...f, preservePending })
      await page.getByRole("heading", { name: "添加记忆", exact: true }).waitFor()
    }
    const raw = () =>
      page.evaluate(() =>
        localStorage.getItem(
          Object.keys(localStorage).find((key) => key.startsWith("bot-private-memory-pending:")) ??
            ""
        )
      )
    const setRaw = async (botId: string, value: string) =>
      page.evaluate(({ key, value }) => localStorage.setItem(key, value), {
        key: `bot-private-memory-pending:${encodeURIComponent(botId)}`,
        value
      })
    const originalRequest = async () => {
      const value = await raw()
      assert.ok(value)
      return JSON.parse(value).input
    }
    const settle = async (previous: number) => {
      await page.waitForFunction((previous) => window.fixtureReturned > previous, previous)
      await page.waitForTimeout(30)
    }
    const waitHeld = async () => {
      const deadline = Date.now() + 2000
      while (!release && Date.now() < deadline) await new Promise((d) => setTimeout(d, 5))
      assert.ok(release)
    }
    const create = async () => {
      await page.getByRole("textbox", { name: "内容", exact: true }).fill(" new private fact ")
      await page.getByRole("button", { name: "保存", exact: true }).click()
    }
    const edit = async () => {
      await page.getByLabel("编辑记忆", { exact: true }).first().click()
      await page.getByLabel("编辑记忆内容", { exact: true }).fill("edited private fact")
      await page.getByRole("button", { name: "保存修订", exact: true }).click()
    }
    const remove = () => page.getByLabel("删除记忆", { exact: true }).first().click()
    const retry = () => page.getByRole("button", { name: "核对原记忆操作", exact: true }).click()
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
    const check = async (name: string, fn: () => Promise<void>) => {
      journeys.push(name)
      try {
        await fn()
      } catch (e) {
        failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
        await page.screenshot({ path: join(output, `failure-${journeys.length}.png`) })
        console.error(failures.at(-1))
      } finally {
        release?.()
        held = false
      }
    }
    await check(
      "policy changes use the latest parent callback without render or unchanged-poll reload loops",
      async () => {
        const f = await reset()
        await mount(f)
        await page.waitForFunction(() => window.fixtureReloadCompleted > 0)
        const before = reloads
        await page.evaluate(async (rows) => {
          window.fixtureReloadVersion = 1
          window.fixtureRows(rows)
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done()))
          )
        }, f.memories)
        assert.equal(reloads, before, "Parent callback identity is not a policy revision")
        const completed = await page.evaluate(() => window.fixtureReloadCompleted)
        const policy = store!.memory.policy(f.bot.id)
        const queued = store!.memory.retry({
          botId: f.bot.id,
          nonce: "policy-reload-retry",
          revision: policy.revision,
          dataEpoch: policy.dataEpoch!
        })
        assert.equal(queued.lastOutcome, "queued")
        await page.waitForFunction(
          (previous) => window.fixtureReloadCompleted > previous,
          completed
        )
        assert.equal(reloads, before + 1)
        assert.equal(reloadVersions.at(-1), 1, "A real policy revision invokes the latest callback")
        const policyReturned = await page.evaluate(() => window.fixturePolicyReturned)
        await page.waitForFunction(
          (previous) => window.fixturePolicyReturned > previous,
          policyReturned
        )
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done()))
            )
        )
        assert.equal(
          reloads,
          before + 1,
          "An unchanged policy poll does not reread the memory list"
        )
      }
    )
    for (const kind of ["create", "edit", "delete"] as const) {
      const action = kind === "create" ? create : kind === "edit" ? edit : remove
      await check(
        `${kind} lost reply blocks a different intent, reopens with original nonce and does not repeat effects`,
        async () => {
          const f = await reset()
          await mount(f)
          loseAck = true
          const previous = await page.evaluate(() => window.fixtureReturned)
          await action()
          await settle(previous)
          const pending = await originalRequest(),
            before = JSON.stringify(store!.db.exec("SELECT * FROM bot_memories")),
            first = requests.at(-1)!
          assert.ok(pending.request.nonce)
          assert.equal(pending.request.expectedDataEpoch, f.snapshot.dataEpoch)
          assert.equal(
            await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
            true
          )
          await page.evaluate(() => window.fixtureUnmount())
          await page.getByTestId("private-memory-owner").waitFor({ state: "detached" })
          loseAck = false
          await mount({ ...f, memories: store!.memories(f.bot.id) }, true)
          if (kind === "delete")
            assert.equal(await page.getByLabel("编辑记忆", { exact: true }).count(), 0)
          const returned = await page.evaluate(() => window.fixtureReturned)
          await retry()
          await settle(returned)
          assert.deepEqual(requests.at(-1), first)
          assert.equal(JSON.stringify(store!.db.exec("SELECT * FROM bot_memories")), before)
          assert.equal(await raw(), null)
          assert.equal(
            await page.getByRole("button", { name: "核对原记忆操作", exact: true }).count(),
            0
          )
        }
      )
      await check(`${kind} known ACK cleanup failure retries local cleanup only`, async () => {
        const f = await reset()
        await mount(f)
        await page.evaluate(() => {
          window.fixtureStorage.remove = true
        })
        const previous = await page.evaluate(() => window.fixtureReturned)
        await action()
        await settle(previous)
        assert.ok(await raw())
        const before = mutations
        await page
          .getByText("操作结果已确认，本机记录尚未清除。重试只核对已完成记录。", { exact: true })
          .waitFor()
        await page.evaluate(() => {
          window.fixtureStorage.remove = false
        })
        await retry()
        await page
          .getByRole("button", { name: "核对原记忆操作", exact: true })
          .waitFor({ state: "detached" })
        assert.equal(mutations, before)
        assert.equal(await raw(), null)
      })
      await check(
        `${kind} stable owner restore retains exact raw and performs no late refresh`,
        async () => {
          const f = await reset()
          await mount(f)
          held = true
          await action()
          await waitHeld()
          const original = await raw(),
            before = reloads
          assert.ok(original)
          await restore()
          const previous = await page.evaluate(() => window.fixtureReturned)
          release!()
          await settle(previous)
          assert.equal(await raw(), original)
          assert.equal(reloads, before)
          assert.equal(
            await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
            true
          )
          await page.evaluate(() => window.fixtureUnmount())
          await page.getByTestId("private-memory-owner").waitFor({ state: "detached" })
          await mount(
            { ...f, snapshot: store!.snapshot(), memories: store!.memories(f.bot.id) },
            true
          )
          await page.getByRole("alert", { name: "待确认记忆操作记录", exact: true }).waitFor()
          const calls = mutations
          assert.equal(
            await page.getByRole("button", { name: "保存", exact: true }).isDisabled(),
            true
          )
          assert.equal(mutations, calls)
        }
      )
    }
    await check(
      "same-epoch actual unmount clears the exact accepted record without late refresh",
      async () => {
        const f = await reset()
        await mount(f)
        held = true
        await create()
        await waitHeld()
        assert.ok(await raw())
        const before = reloads
        await page.evaluate(() => window.fixtureUnmount())
        await page.getByTestId("private-memory-owner").waitFor({ state: "detached" })
        const previous = await page.evaluate(() => window.fixtureReturned)
        release!()
        await settle(previous)
        assert.equal(await raw(), null)
        assert.equal(reloads, before)
      }
    )
    await check("restore-held definitive rejection preserves retired request bytes", async () => {
      const f = await reset()
      await mount(f)
      held = rejected = true
      await edit()
      await waitHeld()
      const original = await raw()
      assert.ok(original)
      await restore()
      const previous = await page.evaluate(() => window.fixtureReturned)
      release!()
      await settle(previous)
      assert.equal(await raw(), original)
    })
    await check("old host ignoring nonce cannot receive a private save or delete", async () => {
      const f = await reset()
      f.host.capabilities = f.host.capabilities?.filter((cap) => cap !== "private-memory-receipts")
      await mount(f)
      const before = mutations
      assert.equal(
        await page.getByRole("textbox", { name: "内容", exact: true }).isDisabled(),
        true
      )
      assert.equal(await page.getByLabel("删除记忆", { exact: true }).isDisabled(), true)
      assert.equal(mutations, before)
    })
    await check(
      "corrupt intent blocks all editors until exact review and archive without auto-submit",
      async () => {
        const f = await reset()
        await page.evaluate(() => localStorage.clear())
        await setRaw(f.bot.id, '{"broken":true}')
        await mount(f, true)
        await page.getByRole("alert", { name: "待确认记忆操作记录", exact: true }).waitFor()
        assert.equal(
          await page.getByRole("textbox", { name: "内容", exact: true }).isDisabled(),
          true
        )
        const before = mutations
        await page.getByRole("button", { name: "保存原记录", exact: true }).click()
        await page.getByRole("checkbox").check()
        await page.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await page.getByRole("textbox", { name: "内容", exact: true }).waitFor()
        assert.equal(await raw(), null)
        assert.equal(mutations, before)
      }
    )
    await check("unreadable local record blocks dispatch without being overwritten", async () => {
      const f = await reset()
      await page.evaluate(() => {
        window.fixtureStorage.read = true
      })
      await mount(f)
      const before = mutations
      await page
        .getByText("存储权限不可用，原记录保持不变。请恢复应用存储访问后重新打开。", {
          exact: true
        })
        .waitFor()
      assert.equal(
        await page.getByRole("textbox", { name: "内容", exact: true }).isDisabled(),
        true
      )
      assert.equal(mutations, before)
    })
    await check("failed durable intent write causes no Host mutation", async () => {
      const f = await reset()
      await mount(f)
      await page.evaluate(() => {
        window.fixtureStorage.write = true
      })
      const before = mutations
      await create()
      await page.getByText("无法保留记忆操作记录，本次修改尚未提交。", { exact: true }).waitFor()
      assert.equal(mutations, before)
      assert.equal(store!.memories(f.bot.id).length, 1)
    })
    await check("invalid returned receipt keeps original request for review", async () => {
      const f = await reset()
      await mount(f)
      invalidAck = true
      const previous = await page.evaluate(() => window.fixtureReturned)
      await create()
      await settle(previous)
      assert.ok(await raw())
      assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true)
      await page
        .getByText("操作回执与原请求不一致，原记录仍保留。请核对原操作。", { exact: true })
        .waitFor()
    })
    await page.screenshot({ path: join(output, "private-memory-recovery.png"), fullPage: true })
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
