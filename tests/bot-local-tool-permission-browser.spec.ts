/** Actual React, SQLite and authenticated RPC. Only Electron's contextBridge packet
 * shape is controlled; native project IO/model/identity have owning Node coverage. */
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotHost } from "../src/main/bots/host"
import { BotRpcServer } from "../src/main/bots/rpc"
import { BotTransportClient } from "../src/main/bots/transport-client"
import { fenceBotCheckpointDatabase } from "../src/main/bots/checkpoint-data"
import { BotDeletionLedger } from "../src/main/bots/deletion-ledger"
import { BOT_PROTOCOL_VERSION, BotDomainError, type BotRunLease } from "../src/shared/bot-types"
async function main() {
  const started = new Date().toISOString(),
    directory = await mkdtemp(join(tmpdir(), "cmb-local-permission-ui-")),
    path = join(directory, "bots.sqlite"),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-local-tool-permission"),
    server = createServer(),
    cases: string[] = [],
    errors: string[] = [],
    calls: { method: string; input: unknown }[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    store: BotStore | undefined,
    host: BotHost | undefined,
    rpc: BotRpcServer | undefined,
    client: BotTransportClient | undefined,
    lease: BotRunLease,
    lose = false
  const stop = async () => {
    client?.close()
    if (rpc?.server.listening) await rpc.close()
    await host?.stop()
    store?.close()
    client = undefined
    rpc = undefined
    host = undefined
    store = undefined
  }
  const connect = async (target = "a".repeat(64)) => {
    store = new BotStore(path)
    store.localTools.bind({
      target: { id: target, label: "研发工作电脑 · 本机", platform: "win32" },
      assertCurrent() {
        /* Fixture owns this target for its entire lifetime. */
      }
    })
    host = new BotHost(store)
    const token = randomBytes(32).toString("hex")
    rpc = new BotRpcServer(host, token)
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-local-${token.slice(0, 16)}`
        : join(directory, "rpc.sock")
    await rpc.listen(socketPath)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      socketPath,
      pid: process.pid,
      token
    })
  }
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
          resolveDir: process.cwd(),
          loader: "tsx",
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotLocalToolPermissionSettings}from'./src/renderer/src/components/bots/BotLocalToolPermissionSettings';import{BotLocalToolPermissionCard}from'./src/renderer/src/components/bots/BotLocalToolPermissionCard';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');window.fixtureStore=useBotWorkspaceStore;window.fixtureSettled=0;window.fixtureHold=false;window.fixtureRelease=null;window.fixtureCallbacks={close:0,refresh:0};window.api={bots:new Proxy({}, {get:(_,method)=>async input=>{let reply=await window.fixtureCall(method,input);if(window.fixtureHold&&['resolveLocalToolPermission','changeLocalToolPermission'].includes(method)){window.fixtureHold=false;reply=await new Promise(done=>window.fixtureRelease=()=>{window.fixtureRelease=null;done(reply)})}window.fixtureSettled++;return reply}})};window.electron={process:{platform:'darwin'}};
function Fixture(){const [setup,setSetup]=useState(null),[visible,setVisible]=useState(false),[key,setKey]=useState(0);window.fixtureMount=input=>flushSync(()=>{setSetup(input);setVisible(true);setKey(n=>n+1)});window.fixtureDetach=()=>flushSync(()=>setVisible(false));window.fixtureRemount=()=>flushSync(()=>{setKey(n=>n+1);setVisible(true)});window.fixtureRestore=snapshot=>flushSync(()=>useBotWorkspaceStore.setState({snapshot}));if(!setup)return <main/>;return <main className='bot-workspace' style={{minHeight:'100vh',padding:24}}><section data-testid='active-control' key={key}>{visible&&(setup.surface==='policy'?<BotLocalToolPermissionSettings supported={setup.supported} close={()=>{window.fixtureCallbacks.close++;setVisible(false)}}/>:<BotLocalToolPermissionCard item={setup.item} run={setup.run} refresh={async()=>{window.fixtureCallbacks.refresh++}}/>)}</section><input aria-label='任务草稿' defaultValue='继续完成原任务'/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
        },
        bundle: true,
        preserveSymlinks: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(output, "fixture.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
        logLevel: "silent"
      })
    const html = `<!doctype html><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text}</script>`
    server.on("request", (_req, res) => {
      res.setHeader("Content-Type", "text/html;charset=utf-8")
      res.end(html)
    })
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 960, height: 820 } })
    page.setDefaultTimeout(4000)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        const result = await client!.call(method as "create", input as never)
        if (lose && ["changeLocalToolPermission", "resolveLocalToolPermission"].includes(method)) {
          lose = false
          return { botFailure: { code: "transport_error", message: "结果未收到，请核对原请求" } }
        }
        return result
      } catch (e) {
        return {
          botFailure: {
            code: e instanceof BotDomainError ? e.code : "transport_error",
            message: e instanceof Error ? e.message : "操作失败"
          }
        }
      }
    })
    await page.goto(`http://127.0.0.1:${address.port}`)
    const raw = (key: string) => page.evaluate((key) => localStorage.getItem(key), key)
    const reset = async (surface: "policy" | "card", supported = true) => {
      await stop()
      await rm(path, { force: true })
      await connect()
      lose = false
      const created = store!.createBot({ nonce: "bot", name: "项目助手" })
      store!.send({ nonce: "task", conversationId: created.conversationId, text: "读取项目" })
      const claimed = store!.claim("fixture")!
      lease = claimed.lease
      const permit = store!.localTools.request(lease, "read", {
        kind: "read-file",
        workspace: "C:\\Projects\\研发系统",
        target: "项目说明、配置和文件",
        description: "仅本次任务读取此项目，最长 10 分钟；不允许命令或文件修改",
        fingerprint: "b".repeat(64)
      })
      const status = await client!.call("status")
      assert.ok(status.capabilities.includes("local-tool-permission"))
      assert.ok(status.capabilities.includes("mutation-data-epoch-v2"))
      const item = store!.getInteraction(permit.interactionId!),
        run = store!.getRun(claimed.run.id),
        snapshot = store!.snapshot()
      await page.evaluate(
        ({ surface, supported, item, run, snapshot, status }) => {
          localStorage.clear()
          window.fixtureSettled = 0
          window.fixtureHold = false
          window.fixtureRelease = null
          window.fixtureCallbacks = { close: 0, refresh: 0 }
          window.fixtureStore.setState({
            snapshot,
            host: status
          })
          window.fixtureMount({ surface, supported, item, run })
        },
        { surface, supported, item, run, snapshot, status }
      )
      await page.getByTestId("active-control").waitFor({ state: "attached" })
      if (surface === "policy" && supported)
        await page.getByRole("button", { name: /每次询问/ }).waitFor()
      if (surface === "card")
        await page.waitForFunction(
          () =>
            document.querySelector('[aria-label="本机项目访问许可"]').getAttribute("aria-busy") ===
              "false" && !document.querySelector('[aria-label="本机项目访问许可"] button')?.disabled
        )
      return {
        item,
        run,
        key:
          surface === "policy"
            ? "cmb:bot-local-tool-policy:pending"
            : `cmb:bot-local-tool-answer:${item.id}`
      }
    }
    const idle = async () =>
      page.waitForFunction(
        () =>
          ![...document.querySelectorAll("[aria-busy]")].some(
            (node) => node.getAttribute("aria-busy") === "true"
          )
      )
    const run = async (name: string, work: () => Promise<void>) => {
      await work()
      cases.push(name)
      console.log("PASS", name)
    }
    await run("policy/default ask + precise boundary + light geometry", async () => {
      await reset("policy")
      assert.equal(
        await page.getByRole("button", { name: /每次询问/ }).getAttribute("aria-pressed"),
        "true"
      )
      assert.match(await page.getByRole("dialog").innerText(), /专用浏览器/)
      const rect = await page.getByRole("dialog").boundingBox()
      assert.ok(
        rect &&
          rect.x >= 0 &&
          rect.y >= 0 &&
          rect.x + rect.width <= 960 &&
          rect.y + rect.height <= 820
      )
      await page.screenshot({ path: join(output, "policy-light.png") })
    })
    await run("policy/lost reply then close-reopen exact nonce ACK", async () => {
      const f = await reset("policy")
      lose = true
      await page.getByRole("button", { name: /始终允许/ }).click()
      await page.getByRole("button", { name: "核对上次修改", exact: true }).waitFor()
      const pending = await raw(f.key)
      assert.ok(pending)
      const cursor = store!.snapshot().cursor
      await page.getByRole("button", { name: "完成", exact: true }).click()
      await page.evaluate(() => window.fixtureRemount())
      await page.getByRole("button", { name: "核对上次修改", exact: true }).click()
      await idle()
      assert.equal(await raw(f.key), null)
      assert.equal(store!.snapshot().cursor, cursor)
      const accepted = calls.filter((c) => c.method === "changeLocalToolPermission").slice(-2)
      assert.deepEqual(accepted[0].input, accepted[1].input)
    })
    await run("policy/CAS conflict does not auto replay", async () => {
      await reset("policy")
      const p = store!.localTools.read()
      store!.localTools.change({
        nonce: "other",
        targetId: p.target.id,
        dataEpoch: p.dataEpoch,
        revision: p.revision,
        choice: "never"
      })
      const n = calls.filter((c) => c.method === "changeLocalToolPermission").length
      await page.getByRole("button", { name: /始终允许/ }).click()
      await idle()
      assert.equal(store!.localTools.read().choice, "never")
      assert.equal(calls.filter((c) => c.method === "changeLocalToolPermission").length, n + 1)
      assert.match(await page.getByRole("alert").innerText(), /刷新/)
      assert.equal(await raw("cmb:bot-local-tool-policy:pending"), null)
    })
    for (const resolution of ["allow-once", "deny", "always", "never"] as const)
      await run(`card/${resolution} exact result`, async () => {
        const f = await reset("card")
        const names = {
          "allow-once": "本次允许",
          deny: "拒绝本次",
          always: "始终允许",
          never: "禁止本机项目访问"
        }
        await page.getByRole("button", { name: names[resolution], exact: true }).click()
        await idle()
        assert.equal(
          store!.getInteraction(f.item.id).answer,
          resolution === "allow-once" || resolution === "always" ? "approve" : "reject"
        )
        assert.equal(await raw(f.key), null)
        assert.equal(
          store!.localTools.read().choice,
          resolution === "always" || resolution === "never" ? resolution : "ask"
        )
        assert.equal(await page.getByLabel("任务草稿").inputValue(), "继续完成原任务")
      })
    await run("card/lost reply retains nonce and does not duplicate answer", async () => {
      const f = await reset("card")
      lose = true
      await page.getByRole("button", { name: "本次允许", exact: true }).click()
      await page.getByRole("button", { name: "核对上次回答", exact: true }).waitFor()
      const cursor = store!.snapshot().cursor
      assert.ok(await raw(f.key))
      await page.evaluate(() => window.fixtureRemount())
      await page.getByRole("button", { name: "核对上次回答", exact: true }).click()
      await idle()
      assert.equal(await raw(f.key), null)
      assert.equal(store!.snapshot().cursor, cursor)
    })
    await run(
      "answered card leaves snapshot; settings inventory replays original ACK without creating a grant",
      async () => {
        const f = await reset("card")
        lose = true
        await page.getByRole("button", { name: "本次允许", exact: true }).click()
        await page.getByRole("button", { name: "核对上次回答", exact: true }).waitFor()
        const original = await raw(f.key)
        assert.ok(original)
        assert.equal(
          store!.snapshot().interactions.some((item) => item.id === f.item.id),
          false
        )
        const cursor = store!.snapshot().cursor
        await page.evaluate(() => window.fixtureMount({ surface: "policy", supported: true }))
        await page.getByRole("button", { name: "核对原许可回答", exact: true }).waitFor()
        await page.waitForFunction(
          () => !document.querySelector('[aria-label="待核对的本机许可回答"] button')?.disabled
        )
        await page.getByRole("button", { name: "核对原许可回答", exact: true }).click()
        await idle()
        assert.equal(await raw(f.key), null)
        assert.equal(store!.snapshot().cursor, cursor)
        const sent = calls.filter((call) => call.method === "resolveLocalToolPermission").slice(-2)
        assert.deepEqual(sent[0].input, sent[1].input)
        await page
          .getByLabel("待核对的本机许可回答", { exact: true })
          .waitFor({ state: "detached" })
      }
    )
    for (const surface of ["policy", "card"] as const)
      await run(`${surface}/mounted late ACK after checkpoint restore keeps original`, async () => {
        const f = await reset(surface)
        await page.evaluate(() => {
          window.fixtureHold = true
        })
        await page
          .getByRole("button", { name: surface === "policy" ? /始终允许/ : /^本次允许$/ })
          .click()
        await page.waitForFunction(() => !!window.fixtureRelease)
        const original = await raw(f.key)
        assert.ok(original)
        await stop()
        const ledger = new BotDeletionLedger(join(directory, "ledger"))
        try {
          fenceBotCheckpointDatabase(path, "replacement", ledger)
        } finally {
          ledger.close()
        }
        await connect()
        await page.evaluate((snapshot) => window.fixtureRestore(snapshot), store!.snapshot())
        await page.evaluate(() => window.fixtureRelease())
        await idle()
        assert.equal(await raw(f.key), original)
        assert.equal(await page.evaluate(() => window.fixtureCallbacks.refresh), 0)
        assert.match(
          await (
            surface === "policy"
              ? page.getByRole("dialog")
              : page.getByLabel("本机项目访问许可", { exact: true })
          ).innerText(),
          /变化|恢复/
        )
        assert.equal(store!.localTools.read().effective, "ask")
      })
    await run("same-epoch physical target replacement refuses old accepted ACK", async () => {
      const f = await reset("policy")
      lose = true
      await page.getByRole("button", { name: /始终允许/ }).click()
      await page.getByRole("button", { name: "核对上次修改", exact: true }).waitFor()
      const original = await raw(f.key)
      await stop()
      await connect("c".repeat(64))
      await page.getByRole("button", { name: "核对上次修改", exact: true }).click()
      await idle()
      assert.equal(await raw(f.key), original)
      assert.equal(store!.localTools.read().effective, "ask")
      assert.match(await page.getByRole("dialog").innerText(), /重新打开|变化/)
      assert.equal(
        await page.getByRole("button", { name: "核对上次修改", exact: true }).isDisabled(),
        true
      )
    })
    await run("restored orphan answer supports exact export/archive without dispatch", async () => {
      const f = await reset("card")
      lose = true
      await page.getByRole("button", { name: "本次允许", exact: true }).click()
      await page.getByRole("button", { name: "核对上次回答", exact: true }).waitFor()
      const original = await raw(f.key)
      assert.ok(original)
      await stop()
      const ledger = new BotDeletionLedger(join(directory, "orphan-ledger"))
      try {
        fenceBotCheckpointDatabase(path, "replacement", ledger)
      } finally {
        ledger.close()
      }
      await connect()
      const snapshot = store!.snapshot(),
        status = await client!.call("status")
      await page.evaluate(
        ({ snapshot, status }) => {
          window.fixtureStore.setState({ snapshot, host: status })
          window.fixtureMount({ surface: "policy", supported: true })
        },
        { snapshot, status }
      )
      const recovery = page.getByLabel("待确认本机许可回答记录", { exact: true })
      await recovery.waitFor()
      assert.equal(await raw(f.key), original)
      const n = calls.filter((call) => call.method === "resolveLocalToolPermission").length
      const downloaded = page.waitForEvent("download")
      await recovery.getByRole("button", { name: "保存原记录", exact: true }).click()
      await downloaded
      await recovery.getByRole("checkbox").check()
      await recovery.getByRole("button", { name: "清除此条记录", exact: true }).click()
      await page.getByLabel("待核对的本机许可回答", { exact: true }).waitFor({ state: "detached" })
      assert.equal(await raw(f.key), null)
      assert.equal(calls.filter((call) => call.method === "resolveLocalToolPermission").length, n)
    })
    await run("old Host gives update guidance without API query", async () => {
      const before = calls.length
      await reset("policy", false)
      assert.match(await page.getByRole("dialog").innerText(), /更新 Bot 后台/)
      assert.equal(calls.length, before)
    })
    await run("dark narrow card remains in viewport + keyboard controls", async () => {
      await reset("card")
      await page.setViewportSize({ width: 420, height: 750 })
      await page.evaluate(() => window.fixtureTheme("codex-dark"))
      const rect = await page.getByLabel("本机项目访问许可", { exact: true }).boundingBox()
      assert.ok(rect && rect.x >= 0 && rect.x + rect.width <= 420)
      await page.getByRole("button", { name: "本次允许", exact: true }).focus()
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "本次允许")
      await page.keyboard.press("Tab")
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "拒绝本次")
      await page.screenshot({ path: join(output, "card-dark-narrow.png") })
    })
    assert.deepEqual(errors, [])
    console.log(
      JSON.stringify(
        {
          started,
          cases,
          caseCount: cases.length,
          errors,
          source: "actual React + SQLite + authenticated RPC; contextBridge shape controlled"
        },
        null,
        2
      )
    )
  } finally {
    await browser?.close()
    await stop()
    if (server.listening)
      await new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done())))
    await rm(directory, { recursive: true, force: true })
    console.log(
      JSON.stringify({ physicalClose: new Date().toISOString(), serverListening: server.listening })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
