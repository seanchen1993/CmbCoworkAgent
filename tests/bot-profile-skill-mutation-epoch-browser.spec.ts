/** Actual React controls, native facade packet shape, real SQLite checkpoint restore and
 * authenticated RPC. Native Electron IPC and model execution have separate acceptance gates. */
import assert from "node:assert/strict"
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BotDeletionLedger } from "../src/main/bots/deletion-ledger"
import { fenceBotCheckpointDatabase } from "../src/main/bots/checkpoint-data"
import { BotHost } from "../src/main/bots/host"
import { BotRpcServer } from "../src/main/bots/rpc"
import { BotTransportClient } from "../src/main/bots/transport-client"
import { BOT_PROTOCOL_VERSION, BotDomainError, type CoworkBot } from "../src/shared/bot-types"

type Surface = "inline" | "editor" | "create" | "quick" | "skill"
async function main() {
  const started = new Date().toISOString(),
    directory = await mkdtemp(join(tmpdir(), "cmb-profile-skill-ui-")),
    path = join(directory, "bots.sqlite"),
    point = join(directory, "point.sqlite"),
    renderer = resolve("src/renderer/src"),
    output = resolve("output/bot-profile-skill-mutation-epoch"),
    server = createServer(),
    errors: string[] = [],
    cases: string[] = [],
    failures: { name: string; message: string }[] = [],
    calls: { method: string; input: Record<string, unknown> }[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    store: BotStore | undefined,
    host: BotHost | undefined,
    rpc: BotRpcServer | undefined,
    client: BotTransportClient | undefined,
    bot: CoworkBot,
    forced = "",
    loseReply = false
  const closeHost = async () => {
    client?.close()
    if (rpc?.server.listening) await rpc.close()
    if (host) await host.stop()
    store?.close()
    client = undefined
    rpc = undefined
    host = undefined
    store = undefined
  }
  const connect = async () => {
    const token = randomBytes(32).toString("hex")
    host = new BotHost(store!)
    rpc = new BotRpcServer(host, token)
    const socket =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-profile-skill-${token.slice(0, 16)}`
        : join(directory, "rpc.sock")
    await rpc.listen(socket)
    client = new BotTransportClient({
      version: BOT_PROTOCOL_VERSION,
      hostId: host.id,
      pid: process.pid,
      socketPath: socket,
      token
    })
  }
  const checkpoint = async () => {
    await closeHost()
    await copyFile(path, point)
    store = new BotStore(path)
    await connect()
  }
  const restore = async () => {
    await closeHost()
    await copyFile(point, path)
    const ledger = new BotDeletionLedger(path)
    try {
      fenceBotCheckpointDatabase(path, "replacement", ledger)
    } finally {
      ledger.close()
    }
    store = new BotStore(path)
    await connect()
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
          contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotProfileInlineEditor}from'./src/renderer/src/components/bots/BotProfileInlineEditor';import{BotEditor}from'./src/renderer/src/components/bots/BotEditor';import{useBotQuickCreate}from'./src/renderer/src/lib/use-bot-quick-create';import{BotQuickCreateFeedback}from'./src/renderer/src/components/bots/BotQuickCreateFeedback';import{useBotSkillSave}from'./src/renderer/src/lib/use-bot-skill-save';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';applyThemePreference('codex-light');window.fixtureCallbacks={refresh:0,close:0,created:0,saved:0};window.fixtureHold=false;window.fixtureRelease=null;window.fixtureSettled=0;window.api={bots:new Proxy({}, {get:(_,method)=>async input=>{try{let reply=await window.fixtureCall(method,input);if(window.fixtureHold){window.fixtureHold=false;reply=await new Promise(done=>{window.fixtureRelease=()=>{window.fixtureRelease=null;done(reply)}})}return reply}finally{window.fixtureSettled++}}})};window.electron={process:{platform:'darwin'}};
function Quick(){const c=useBotQuickCreate(()=>window.fixtureCallbacks.created++),epoch=useBotWorkspaceStore(state=>state.snapshot?.dataEpoch??'initial');return <div data-busy={c.state.busy}><button onClick={()=>void c.start()} disabled={c.state.busy}>快速创建</button><BotQuickCreateFeedback state={c.state} dataEpoch={epoch} open={c.state.phase==='configure'} close={c.cancelReview} retry={c.start} repair={c.repair} confirmReview={c.confirmReview}/>{c.state.notice&&<p role='alert'>{c.state.notice.message}</p>}</div>}
function Skill({botId}){const s=useBotSkillSave(botId,undefined,async()=>{window.fixtureCallbacks.saved++});return <div data-busy={s.busy}><button disabled={s.busy||s.restored||!s.supported||s.blocked} onClick={()=>void s.save({name:'核对',instructions:'检查证据',enabled:true})}>{s.busy?'保存中…':s.pending?'核对原请求':'保存技能'}</button>{s.error&&<p role='alert'>{s.error}</p>}</div>}
function Fixture(){const[setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[key,setKey]=useState(0);window.fixtureMount=input=>flushSync(()=>{window.fixtureSettled=0;setSetup(input);setVisible(true);setKey(n=>n+1)});window.fixtureDetachAndReply=()=>flushSync(()=>{setVisible(false)});window.fixtureRefresh=async()=>{window.fixtureCallbacks.refresh++;const snapshot=await window.fixtureCall('snapshot');useBotWorkspaceStore.setState({snapshot})};if(!setup)return <main/>;const close=()=>window.fixtureCallbacks.close++,created=()=>window.fixtureCallbacks.created++;return <main className='bot-workspace' style={{minHeight:'100vh',padding:28}}><section data-testid='active-control' key={key}>{visible&&(setup.surface==='inline'?<BotProfileInlineEditor bot={setup.bot} dataEpoch={setup.epoch} field='name' onExit={close}/>:setup.surface==='editor'?<BotEditor bot={setup.bot} close={close} created={created}/>:setup.surface==='create'?<BotEditor close={close} created={created}/>:setup.surface==='quick'?<Quick/>:<Skill botId={setup.bot.id}/>)}</section><input aria-label='任务草稿' defaultValue='原任务草稿'/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
        },
        bundle: true,
        preserveSymlinks: true,
        platform: "browser",
        format: "iife",
        write: false,
        outfile: join(output, "fixture.js"),
        jsx: "automatic",
        alias: { "@": renderer },
        define: {
          "process.env.NODE_ENV": '"production"',
          "import.meta.env.DEV": "false"
        },
        plugins: [
          {
            name: "isolated-state-and-configuration",
            setup(b) {
              b.onResolve({ filter: /bot-workspace-store$/ }, () => ({
                path: "workspace",
                namespace: "fixture"
              }))
              b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
                loader: "ts",
                resolveDir: process.cwd(),
                contents: `import{create}from'zustand';export const useBotWorkspaceStore=create(()=>({snapshot:null,host:null,selected:null,viewportLease:null,refresh:async()=>window.fixtureRefresh(),select:()=>window.fixtureCallbacks.created++}));window.fixtureStore=useBotWorkspaceStore;`
              }))
              b.onResolve(
                {
                  filter: /^\.\/Bot(PersonaChooser|ConnectorPicker|HarnessBindingPicker)$/
                },
                (a) => ({ path: a.path, namespace: "configuration" })
              )
              b.onLoad({ filter: /.*/, namespace: "configuration" }, (a) => ({
                loader: "js",
                contents: `export const ${a.path.slice(2)}=()=>null`
              }))
            }
          }
        ]
      })
    const html = `<!doctype html><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
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
    const page = await browser.newPage({
      viewport: { width: 1000, height: 850 }
    })
    page.setDefaultTimeout(3500)
    page.on("pageerror", (error) => errors.push(error.message))
    await page.exposeFunction(
      "fixtureCall",
      async (method: string, input: Record<string, unknown>) => {
        if (method === "snapshot") return store!.snapshot()
        calls.push({ method, input })
        try {
          if (forced) throw new BotDomainError(forced, "工作区数据已恢复")
          const result = await client!.call(method as "create", input as never)
          if (loseReply) {
            loseReply = false
            return {
              botFailure: { code: "transport_error", message: "结果未收到" }
            }
          }
          return result
        } catch (error) {
          return {
            botFailure: {
              code: error instanceof BotDomainError ? error.code : "transport_error",
              message: error instanceof Error ? error.message : "失败"
            }
          }
        }
      }
    )
    await page.goto(`http://127.0.0.1:${address.port}`)
    const reset = async (surface: Surface, supported = true) => {
      await closeHost()
      await rm(path, { force: true })
      store = new BotStore(path)
      bot = store.createBot({ nonce: "owner", name: "Owner" }).bot
      await checkpoint()
      forced = ""
      loseReply = false
      const snapshot = store!.snapshot(),
        epoch = snapshot.dataEpoch,
        hostStatus = await client!.call("status")
      await page.evaluate(
        ({ surface, bot, snapshot, hostStatus }) => {
          localStorage.clear()
          window.fixtureCallbacks = {
            refresh: 0,
            close: 0,
            created: 0,
            saved: 0
          }
          window.fixtureSettled = 0
          window.fixtureRelease = null
          window.fixtureHold = false
          window.fixtureStore.setState({
            snapshot,
            host: hostStatus,
            selected: "original"
          })
          window.fixtureMount({ surface, bot, epoch: snapshot.dataEpoch })
        },
        {
          surface,
          bot,
          snapshot,
          hostStatus: supported
            ? hostStatus
            : {
                ...hostStatus,
                capabilities: hostStatus.capabilities.filter(
                  (cap) => cap !== "mutation-data-epoch-v2"
                )
              }
        }
      )
      await page.getByTestId("active-control").waitFor({ state: "attached" })
      return {
        epoch,
        key:
          surface === "quick" || surface === "create"
            ? "bot-editor-pending:new"
            : surface === "skill"
              ? `bot-skill-save-pending:${bot.id}:new`
              : `bot-editor-pending:${bot.id}`
      }
    }
    const submit = async (surface: Surface) => {
      if (surface === "inline") {
        const field = page.getByRole("textbox", {
          name: "编辑 Bot 名称",
          exact: true
        })
        await field.fill("Changed")
        await field.press("Tab")
      } else if (surface === "editor" || surface === "create") {
        await page.getByRole("textbox", { name: "名称", exact: true }).fill("Changed")
        await page.getByRole("button", { name: "保存", exact: true }).click()
      } else {
        await page
          .getByRole("button", {
            name: surface === "quick" ? "快速创建" : /^(保存技能|核对原请求)$/,
            exact: true
          })
          .click()
        if (surface === "quick") {
          const confirm = page
            .getByRole("dialog", { name: "创建 Bot", exact: true })
            .getByRole("button", { name: "创建 Bot", exact: true })
          if (await confirm.isVisible()) await confirm.click()
        }
      }
    }
    const idle = async (surface: Surface) => {
      await page.waitForFunction(() => window.fixtureSettled > 0)
      if (surface === "inline")
        await page.getByLabel("正在保存", { exact: true }).waitFor({ state: "hidden" })
      else if (surface === "editor" || surface === "create")
        await page
          .getByRole("button", { name: "保存中…", exact: true })
          .waitFor({ state: "hidden" })
      else await page.locator('[data-busy="false"]').waitFor()
    }
    const raw = (key: string) => page.evaluate((key) => localStorage.getItem(key), key)
    const recordCase = async (name: string, work: () => Promise<void>) => {
      try {
        await work()
        cases.push(name)
      } catch (error) {
        failures.push({
          name,
          message: error instanceof Error ? error.message : String(error)
        })
        await page.screenshot({
          path: join(output, `failure-${failures.length}.png`)
        })
        console.error(name, error)
      }
    }
    for (const surface of ["inline", "editor", "create", "quick", "skill"] as Surface[]) {
      for (const code of ["data_epoch", "workspace_replaced"])
        await recordCase(`${surface}/typed-${code}-before-poll`, async () => {
          const f = await reset(surface),
            before = calls.length
          forced = code
          await submit(surface)
          await idle(surface)
          const original = await raw(f.key)
          assert.ok(original, "scope refusal preserves exact operation")
          assert.equal(JSON.parse(original).input.expectedDataEpoch, f.epoch)
          assert.equal(await page.locator('[aria-label="任务草稿"]').inputValue(), "原任务草稿")
          if (surface === "quick") await submit(surface)
          else
            assert.equal(
              await page
                .getByRole("button", {
                  name:
                    surface === "skill"
                      ? "核对原请求"
                      : surface === "inline"
                        ? "核对原请求"
                        : "重试核对保存",
                  exact: true
                })
                .isDisabled(),
              true
            )
          assert.equal(calls.length, before + 1)
          assert.equal(await raw(f.key), original)
          assert.deepEqual(await page.evaluate(() => window.fixtureCallbacks), {
            refresh: 0,
            close: 0,
            created: 0,
            saved: 0
          })
        })
      await recordCase(`${surface}/actual-restore-before-poll`, async () => {
        const f = await reset(surface),
          before = store!.snapshot(),
          skills = store!.skills(bot.id)
        await restore()
        const restored = store!.snapshot()
        assert.equal(restored.bots.length, before.bots.length)
        await submit(surface)
        await idle(surface)
        assert.ok(await raw(f.key), "unknown original record retained")
        assert.equal(store!.snapshot().cursor, restored.cursor)
        assert.deepEqual(store!.skills(bot.id), skills)
        assert.equal(store!.getBot(bot.id).name, "Owner")
        assert.deepEqual(await page.evaluate(() => window.fixtureCallbacks), {
          refresh: 0,
          close: 0,
          created: 0,
          saved: 0
        })
      })
      for (const outcome of ["success", "rejection"])
        await recordCase(`${surface}/commit-unmount-${outcome}`, async () => {
          const f = await reset(surface)
          if (outcome === "rejection") forced = "invalid_input"
          await page.evaluate(() => (window.fixtureHold = true))
          await submit(surface)
          await page.waitForFunction(() => typeof window.fixtureRelease === "function")
          assert.ok(await raw(f.key))
          await page.evaluate(() => {
            window.fixtureDetachAndReply()
            const section = document.querySelector('[data-testid="active-control"]')
            window.fixtureDetachedAtReply = section.childElementCount === 0
            window.fixtureRelease()
          })
          assert.equal(await page.evaluate(() => window.fixtureDetachedAtReply), true)
          await page.waitForFunction((key) => localStorage.getItem(key) === null, f.key)
          assert.deepEqual(await page.evaluate(() => window.fixtureCallbacks), {
            refresh: 0,
            close: 0,
            created: 0,
            saved: 0
          })
        })
      await recordCase(`${surface}/lost-ACK-exact-reopen`, async () => {
        const f = await reset(surface),
          before = calls.length
        loseReply = true
        await submit(surface)
        await idle(surface)
        const original = await raw(f.key)
        assert.ok(original)
        const accepted = store!.snapshot().cursor,
          input = calls[calls.length - 1].input
        await page.evaluate(
          ({ surface, bot, epoch }) => window.fixtureMount({ surface, bot, epoch }),
          { surface, bot, epoch: f.epoch }
        )
        if (surface === "inline")
          await page.getByRole("button", { name: "核对原请求", exact: true }).click()
        else if (surface === "editor" || surface === "create")
          await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
        else await submit(surface)
        await page.waitForFunction((key) => localStorage.getItem(key) === null, f.key)
        assert.equal(calls.length, before + 2)
        assert.deepEqual(calls[calls.length - 1].input, input)
        assert.equal(store!.snapshot().cursor, accepted, "replay is read-only")
      })
      await recordCase(`${surface}/accepted-receipt-restored-Host`, async () => {
        const f = await reset(surface)
        loseReply = true
        await submit(surface)
        await idle(surface)
        const original = await raw(f.key)
        assert.ok(original)
        await checkpoint()
        await restore()
        const before = store!.snapshot().cursor
        await page.evaluate(
          ({ surface, bot, epoch }) => window.fixtureMount({ surface, bot, epoch }),
          { surface, bot, epoch: f.epoch }
        )
        if (surface === "inline")
          await page.getByRole("button", { name: "核对原请求", exact: true }).click()
        else if (surface === "editor" || surface === "create")
          await page.getByRole("button", { name: "重试核对保存", exact: true }).click()
        else await submit(surface)
        await idle(surface)
        assert.equal(
          await raw(f.key),
          original,
          "old accepted receipt must not ACK the replacement authority"
        )
        assert.equal(store!.snapshot().cursor, before)
        assert.deepEqual(await page.evaluate(() => window.fixtureCallbacks), {
          refresh: 0,
          close: 0,
          created: 0,
          saved: 0
        })
      })
      await recordCase(`${surface}/old-Host-no-write`, async () => {
        const f = await reset(surface, false),
          before = calls.length
        if (surface === "quick") await submit(surface)
        else if (surface === "inline")
          assert.equal(
            await page.getByRole("textbox", { name: "编辑 Bot 名称", exact: true }).isDisabled(),
            true
          )
        else
          assert.equal(
            await page
              .getByRole("button", {
                name: surface === "skill" ? "保存技能" : "保存",
                exact: true
              })
              .isDisabled(),
            true
          )
        assert.equal(calls.length, before)
        assert.equal(await raw(f.key), null)
      })
    }
    assert.deepEqual(errors, [])
    await page.screenshot({ path: join(output, "scope-final.png") })
    console.log(
      JSON.stringify(
        {
          started,
          cases,
          failures,
          errors,
          caseCount: cases.length,
          source:
            "actual renderer + SQLite checkpoint fence + authenticated RPC; native bridge shape controlled"
        },
        null,
        2
      )
    )
    assert.deepEqual(failures, [])
    assert.equal(cases.length, 40)
  } finally {
    await browser?.close()
    await closeHost()
    if (server.listening)
      await new Promise<void>((done, fail) =>
        server.close((error) => (error ? fail(error) : done()))
      )
    await rm(directory, { recursive: true, force: true })
    console.log(
      JSON.stringify({
        physicalClose: new Date().toISOString(),
        serverListening: server.listening
      })
    )
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
