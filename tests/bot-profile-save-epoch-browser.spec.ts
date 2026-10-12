/** Actual React/Chrome + SQLite writes; two checkpoint journeys use authenticated replacement RPC. Other native bridges and held replies are controlled seams. */
import assert from "node:assert/strict"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import { BotStore } from "../src/main/bots/store"
import { BOT_PROTOCOL_VERSION, BotDomainError } from "../src/shared/bot-types"
import { tmpdir } from "node:os"
import { randomBytes } from "node:crypto"
import { BotHost } from "../src/main/bots/host"
import { BotRpcServer, createBotAPI } from "../src/main/bots/rpc"
import { BotTransportClient } from "../src/main/bots/transport-client"
import { BotDeletionLedger } from "../src/main/bots/deletion-ledger"
import { fenceBotCheckpointDatabase } from "../src/main/bots/checkpoint-data"

type Kind = "inline" | "editor" | "quick" | "group" | "members"
type Outcome = "success" | "rejection"
type Transition = "restore" | "unmount"
async function main() {
  const root = fileURLToPath(new URL("../", import.meta.url)),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/bot-profile-save-epoch")
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
      resolveDir: root,
      loader: "tsx",
      contents: `
import React,{useState}from'react';import{createRoot}from'react-dom/client';import{flushSync}from'react-dom';import{BotProfileInlineEditor}from'./src/renderer/src/components/bots/BotProfileInlineEditor';import{BotEditor}from'./src/renderer/src/components/bots/BotEditor';import{BotGroupEditor}from'./src/renderer/src/components/bots/BotGroupEditor';import{BotGroupMembers}from'./src/renderer/src/components/bots/BotGroupMembers';import{useBotQuickCreate}from'./src/renderer/src/lib/use-bot-quick-create';import{BotQuickCreateFeedback}from'./src/renderer/src/components/bots/BotQuickCreateFeedback';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import './src/renderer/src/components/bots/bot-workspace.css';
window.api={bots:Object.fromEntries(['update','create','updateGroup','createGroup','snapshot','status','messages'].map(method=>[method,async input=>window.fixtureCall(method,input)]))};window.electron={process:{platform:'darwin'}};window.fixtureStore=useBotWorkspaceStore;window.fixtureActions=[];window.fixtureSettled=[];window.fixtureReadFails=false;window.fixtureCleanupFails=false;const read=Storage.prototype.getItem,remove=Storage.prototype.removeItem;Storage.prototype.getItem=function(key){if(window.fixtureReadFails&&key.startsWith('bot-group-pending:'))throw new Error('read denied');return read.call(this,key)};Storage.prototype.removeItem=function(key){if(window.fixtureCleanupFails&&key.startsWith('bot-group-pending:'))throw new Error('cleanup denied');return remove.call(this,key)};window.fixtureRaw=key=>read.call(localStorage,key);Object.defineProperty(navigator,'clipboard',{value:{writeText:async raw=>window.fixtureCopied=raw}});applyThemePreference('codex-light');
function Quick(){const c=useBotQuickCreate(id=>window.fixtureActions.push({kind:'selected',id})),epoch=useBotWorkspaceStore(state=>state.snapshot?.dataEpoch??'initial');return <><button onClick={()=>void c.start()} disabled={c.state.busy}>快速创建</button><BotQuickCreateFeedback state={c.state} dataEpoch={epoch} open={c.state.phase==='configure'} close={c.cancelReview} retry={c.start} repair={c.repair} confirmReview={enabled=>c.confirmReview(enabled).finally(()=>window.fixtureSettled.push('quick'))}/></>}
function Fixture(){const [setup,setSetup]=useState(null),[visible,setVisible]=useState(true),[mount,setMount]=useState(0);window.fixtureSetup=input=>{useBotWorkspaceStore.setState(input.state);setSetup(input);setVisible(true);setMount(v=>v+1)};window.fixtureVisible=value=>flushSync(()=>setVisible(value));const snapshot=useBotWorkspaceStore(state=>state.snapshot);if(!setup)return <main/>;const bot=snapshot.bots.find(b=>b.id===setup.botId),group=snapshot.conversations.find(c=>c.id===setup.groupId),close=()=>window.fixtureActions.push({kind:'close'}),created=id=>window.fixtureActions.push({kind:'created',id});return <main className='bot-workspace' style={{height:'100vh',padding:30}}><section key={mount}>{visible&&<div data-testid="active-profile-owner">{setup.kind==='inline'?<BotProfileInlineEditor bot={bot} dataEpoch={snapshot.dataEpoch} field='name' onExit={close}/>:setup.kind==='editor'?<BotEditor bot={bot} close={close} created={created}/>:setup.kind==='quick'?<Quick/>:setup.kind==='group'?<BotGroupEditor bots={snapshot.bots} group={group} close={close} created={created}/>:<BotGroupMembers bots={snapshot.bots} group={group} openBot={created}/>}</div>}</section><input aria-label='当前任务草稿' defaultValue='不受保存回执影响'/></main>}createRoot(document.getElementById('root')).render(<Fixture/>);`
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
    plugins: [
      {
        name: "unrelated-profile-configuration-seams",
        setup(b) {
          b.onResolve(
            { filter: /^\.\/Bot(PersonaChooser|ConnectorPicker|HarnessBindingPicker)$/ },
            (a) => ({ path: a.path, namespace: "configuration-seam" })
          )
          b.onLoad({ filter: /.*/, namespace: "configuration-seam" }, (a) => ({
            loader: "js",
            contents: `export const ${a.path.slice(2)}=()=>null`
          }))
        }
      }
    ]
  })
  let store: BotStore | undefined,
    release: (() => void) | undefined,
    dispatchCount = 0,
    responseCount = 0,
    outcome: Outcome = "success",
    holdReplies = true,
    loseReply = false,
    failSnapshot = false,
    mismatchedReply = false,
    forcedFailure: string | undefined,
    mutationSupport = true,
    replacementClient: BotTransportClient | undefined,
    replacementReadCount = 0
  const errors: string[] = [],
    journeys: string[] = [],
    startedAt = new Date().toISOString()
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 1050, height: 820 } })
  page.setDefaultTimeout(10000)
  page.on("pageerror", (error) => errors.push(error.message))
  // Status and snapshots must come from the same Host, as they do over RPC.
  // Constructing a Host for each status read makes every refresh look like a restart.
  const apis = new WeakMap<BotStore, ReturnType<typeof createBotAPI>>()
  const api = () => {
    let current = apis.get(store!)
    if (!current) {
      current = createBotAPI(new BotHost(store!))
      apis.set(store!, current)
    }
    return current
  }
  const status = async () => {
    const value = await api().status()
    return {
      ...value,
      capabilities: mutationSupport
        ? value.capabilities
        : value.capabilities.filter((capability) => capability !== "mutation-data-epoch-v2")
    }
  }
  try {
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (replacementClient) {
        if (["snapshot", "status", "messages"].includes(method)) ++replacementReadCount
        else ++dispatchCount
        try {
          return await replacementClient.call(method, input)
        } catch (error) {
          return {
            botFailure: {
              code: (error as { code?: string }).code ?? "transport_error",
              message: error instanceof Error ? error.message : "失败"
            }
          }
        }
      }
      if (method === "snapshot") {
        if (failSnapshot) {
          failSnapshot = false
          return { botFailure: { code: "transport_error", message: "列表暂不可读取" } }
        }
        return api().snapshot(input as Parameters<ReturnType<typeof createBotAPI>["snapshot"]>[0])
      }
      if (method === "status") return status()
      if (method === "messages") return []
      dispatchCount++
      const owned = store!
      let result: unknown
      try {
        if (forcedFailure) throw new BotDomainError(forcedFailure, "工作区数据已恢复")
        if (outcome === "rejection")
          throw new BotDomainError(
            method === "create" ? "invalid_input" : "revision_conflict",
            "后台明确拒绝原请求"
          )
        if (method === "update")
          result = owned.updateBot(input as Parameters<BotStore["updateBot"]>[0])
        else if (method === "create")
          result = owned.createBot(input as Parameters<BotStore["createBot"]>[0])
        else if (method === "updateGroup")
          result = owned.updateGroup(input as Parameters<BotStore["updateGroup"]>[0])
        else if (method === "createGroup")
          result = owned.createGroup(input as Parameters<BotStore["createGroup"]>[0])
        else throw new Error("unexpected method " + method)
      } catch (error) {
        result = {
          botFailure: {
            code: error instanceof BotDomainError ? error.code : "transport_error",
            message: error instanceof Error ? error.message : "失败"
          }
        }
      }
      if (holdReplies)
        await new Promise<void>((resolve) => {
          release = resolve
        })
      responseCount++
      if (loseReply) {
        loseReply = false
        return { botFailure: { code: "transport_error", message: "保存回执丢失" } }
      }
      if (mismatchedReply && result && typeof result === "object" && "members" in result) {
        mismatchedReply = false
        return { ...result, members: [] }
      }
      return result
    })
    await page.route("http://127.0.0.1:43149/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${css.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43149/")
    for (const kind of ["inline", "editor", "quick", "group", "members"] as Kind[])
      for (const reply of ["success", "rejection"] as Outcome[])
        for (const transition of ["restore", "unmount"] as Transition[]) {
          store?.close()
          store = new BotStore(":memory:")
          const alpha = store.createBot({ nonce: "alpha", name: "Alpha" }),
            beta = store.createBot({ nonce: "beta", name: "Beta" }),
            group = store.createGroup({
              nonce: "group",
              name: "Team",
              members: [alpha.bot.id, beta.bot.id]
            })
          const epoch = store.dataEpoch(),
            key =
              kind === "group" || kind === "members"
                ? "bot-group-pending:" + group.id
                : "bot-editor-pending:" + (kind === "quick" ? "new" : alpha.bot.id)
          release = undefined
          outcome = reply
          const previousDispatch = dispatchCount,
            previousResponse = responseCount
          await page.evaluate(
            (setup) => {
              localStorage.clear()
              window.fixtureActions = []
              window.fixtureSettled = []
              window.fixtureSetup(setup)
            },
            {
              kind,
              botId: alpha.bot.id,
              groupId: group.id,
              state: {
                snapshot: store.snapshot(),
                host: await status(),
                selected: alpha.conversationId
              }
            }
          )
          if (kind === "inline") {
            const field = page.getByRole("textbox", { name: "编辑 Bot 名称", exact: true })
            await field.fill("Changed")
            await field.press("Tab")
          } else if (kind === "quick") {
            await page.getByRole("button", { name: "快速创建", exact: true }).click()
            // Use the actual creation review instead of bypassing its consent.
            await page
              .getByRole("dialog")
              .getByRole("button", { name: "创建 Bot", exact: true })
              .click()
          } else if (kind === "members") {
            await page.getByRole("button", { name: "移除 Beta", exact: true }).click()
            await page.getByRole("button", { name: "移出群聊", exact: true }).click()
          } else
            await page.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit())
          await page.waitForFunction((key) => localStorage.getItem(key) !== null, key)
          const original = await page.evaluate((key) => localStorage.getItem(key), key)
          const deadline = Date.now() + 2000
          while (!release && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10))
          assert.ok(release, kind + " actual dispatch held")
          assert.equal(dispatchCount, previousDispatch + 1)
          if (transition === "restore") {
            store.db.run(
              "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)",
              ["workspace.restored", "replacement", "{}", 1]
            )
            await page.evaluate(
              (snapshot) => window.fixtureStore.setState({ snapshot }),
              store.snapshot()
            )
            await page.waitForFunction(
              () => window.fixtureStore.getState().snapshot.dataEpoch === "replacement"
            )
          } else {
            await page.evaluate(() => window.fixtureVisible(false))
            await page.getByTestId("active-profile-owner").waitFor({ state: "detached" })
          }
          release()
          release = undefined
          while (responseCount === previousResponse && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 10))
          assert.equal(responseCount, previousResponse + 1)
          if (transition === "unmount")
            await page.waitForFunction((key) => localStorage.getItem(key) === null, key)
          else {
            // Wait for actual mounted UI completion instead of accepting an assertion before the reply's callback runs.
            if (kind === "inline")
              await page.getByLabel("正在保存", { exact: true }).waitFor({ state: "hidden" })
            else if (kind === "members")
              await page.waitForFunction(
                () =>
                  document
                    .querySelector('[aria-label="群聊成员操作"]')
                    ?.getAttribute("aria-busy") === "false"
              )
            else if (kind === "quick")
              await page.waitForFunction(() => window.fixtureSettled.length === 1)
            else
              await page
                .getByRole("button", { name: "保存中…", exact: true })
                .waitFor({ state: "hidden" })
            assert.equal(
              await page.evaluate((key) => localStorage.getItem(key), key),
              original,
              kind + " retired exact record must survive " + reply
            )
            assert.notEqual(epoch, store.dataEpoch())
            if (kind === "members")
              assert.equal(
                await page.getByRole("dialog").count(),
                1,
                "retired reply must keep the held removal confirmation open"
              )
          }
          assert.deepEqual(
            await page.evaluate(() => window.fixtureActions),
            [],
            kind + " late callback must not navigate/close"
          )
          journeys.push([kind, reply, transition].join("/"))
        }
    // Reopening protected group records uses the production form and member pane, not a parallel recovery mock.
    for (const kind of ["group", "members"] as Kind[]) {
      const reset = async () => {
        // Retire the previous React owner before replacing its database or case records.
        await page.evaluate(() => window.fixtureVisible(false))
        store?.close()
        store = new BotStore(":memory:")
        const alpha = store.createBot({ nonce: "alpha", name: "Alpha" }),
          beta = store.createBot({ nonce: "beta", name: "Beta" }),
          group = store.createGroup({
            nonce: "group",
            name: "Team",
            members: [alpha.bot.id, beta.bot.id]
          })
        outcome = "success"
        holdReplies = false
        loseReply = false
        failSnapshot = false
        mismatchedReply = false
        forcedFailure = undefined
        mutationSupport = true
        await page.evaluate(() => {
          window.fixtureReadFails = false
          window.fixtureCleanupFails = false
          localStorage.clear()
          window.fixtureActions = []
          window.fixtureSettled = []
        })
        const setup = {
          kind,
          botId: alpha.bot.id,
          groupId: group.id,
          state: {
            snapshot: store.snapshot(),
            host: await status(),
            selected: alpha.conversationId
          }
        }
        const key = "bot-group-pending:" + group.id
        return { setup, key, group, alpha, beta }
      }
      const mount = async (f: Awaited<ReturnType<typeof reset>>) => {
        await page.evaluate((input) => window.fixtureSetup(input), {
          ...f.setup,
          state: { ...f.setup.state, snapshot: store!.snapshot(), host: await status() }
        })
      }
      const save = async () => {
        if (kind === "members") {
          await page.getByRole("button", { name: "移除 Beta", exact: true }).click()
          await page.getByRole("button", { name: "移出群聊", exact: true }).click()
        } else {
          await page.getByRole("textbox", { name: "群聊名称", exact: true }).fill("Updated")
          await page.getByRole("button", { name: "保存群聊", exact: true }).click()
        }
      }
      const copyAndReview = async () => {
        await page.getByRole("button", { name: "复制原记录", exact: true }).click()
        await page
          .getByRole("checkbox", {
            name: "我已保存或复制原记录，并已核对相关工作区中的提交结果。",
            exact: true
          })
          .check()
      }
      {
        await reset()
        store!.close()
        const directory = await mkdtemp(join(tmpdir(), "cmb-group-rpc-browser-")),
          path = join(directory, "bots.sqlite"),
          point = join(directory, "point.sqlite")
        let server: BotRpcServer | undefined, host: BotHost | undefined
        try {
          store = new BotStore(path)
          const alpha = store.createBot({ nonce: "alpha", name: "Alpha" }),
            beta = store.createBot({ nonce: "beta", name: "Beta" }),
            group = store.createGroup({
              nonce: "group",
              name: "Team",
              members: [alpha.bot.id, beta.bot.id]
            }),
            key = "bot-group-pending:" + group.id,
            request = {
              nonce: "accepted-before-restore",
              expectedDataEpoch: store.dataEpoch(),
              id: group.id,
              revision: group.revision,
              name: "Accepted",
              description: "Original accepted intent",
              members: kind === "members" ? [alpha.bot.id] : group.members
            },
            accepted = store.updateGroup(request),
            raw = JSON.stringify({ dataEpoch: store.dataEpoch(), input: request }),
            setup = {
              kind,
              botId: alpha.bot.id,
              groupId: group.id,
              state: {
                snapshot: store.snapshot(),
                host: await status(),
                selected: alpha.conversationId
              }
            }
          await page.evaluate(
            ({ key, raw, setup }) => {
              localStorage.setItem(key, raw)
              window.fixtureSetup(setup)
            },
            { key, raw, setup }
          )
          await page
            .getByRole("button", {
              name: kind === "group" ? "重试核对保存" : "核对群聊修改",
              exact: true
            })
            .waitFor()
          store.close()
          await copyFile(path, point)
          await copyFile(point, path)
          const ledger = new BotDeletionLedger(path)
          try {
            fenceBotCheckpointDatabase(path, "replacement", ledger)
          } finally {
            ledger.close()
          }
          store = new BotStore(path)
          host = new BotHost(store)
          const token = randomBytes(32).toString("hex"),
            socket =
              process.platform === "win32"
                ? `\\\\.\\pipe\\cmb-group-${token.slice(0, 16)}`
                : join(directory, "rpc.sock")
          server = new BotRpcServer(host, token)
          await server.listen(socket)
          replacementClient = new BotTransportClient({
            version: BOT_PROTOCOL_VERSION,
            hostId: host.id,
            pid: process.pid,
            socketPath: socket,
            token
          })
          const before = dispatchCount,
            reads = replacementReadCount,
            afterRestore = JSON.stringify(store.db.exec("SELECT * FROM bot_events"))
          assert.equal(
            await page.evaluate(() => window.fixtureStore.getState().snapshot.dataEpoch),
            "initial"
          )
          assert.equal(store.dataEpoch(), "replacement")
          assert.deepEqual(store.updateGroup(request), accepted)
          await page
            .getByRole("button", {
              name: kind === "group" ? "重试核对保存" : "核对群聊修改",
              exact: true
            })
            .click()
          await page
            .getByText("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。", { exact: true })
            .waitFor()
          assert.equal(await page.evaluate((key) => window.fixtureRaw(key), key), raw)
          assert.equal(dispatchCount, before + 1)
          assert.equal(
            replacementReadCount,
            reads,
            "retired RPC reply must not trigger current-state reads"
          )
          assert.deepEqual(await page.evaluate(() => window.fixtureActions), [])
          assert.equal(
            await page.evaluate(() => window.fixtureStore.getState().snapshot.dataEpoch),
            "initial",
            "UI projection is deliberately old"
          )
          assert.equal(
            JSON.stringify(store.db.exec("SELECT * FROM bot_events")),
            afterRestore,
            "historical receipt and RPC refusal are readonly"
          )
          assert.equal(
            await page
              .getByRole("button", {
                name: kind === "group" ? "重试核对保存" : "核对群聊修改",
                exact: true
              })
              .isDisabled(),
            true
          )
          journeys.push(kind + "/authenticated-replacement-rpc-retains-accepted-old-receipt")
        } finally {
          replacementClient?.close()
          replacementClient = undefined
          await server?.close()
          await host?.stop()
          store?.close()
          store = undefined
          await rm(directory, { recursive: true, force: true })
        }
      }
      for (const code of ["data_epoch", "workspace_replaced"]) {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        forcedFailure = code
        await save()
        await page
          .getByText("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。", { exact: true })
          .waitFor()
        const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
        assert.ok(raw)
        assert.equal(JSON.parse(raw).input.expectedDataEpoch, f.setup.state.snapshot.dataEpoch)
        assert.equal(dispatchCount, before + 1)
        const retry = page.getByRole("button", {
          name: kind === "group" ? "重试核对保存" : "核对群聊修改",
          exact: true
        })
        assert.equal(await retry.isDisabled(), true)
        if (kind === "members") assert.equal(await page.getByRole("dialog").count(), 1)
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
        journeys.push(kind + "/host-" + code + "-retains-with-old-projection")
      }
      {
        const f = await reset(),
          before = dispatchCount
        mutationSupport = false
        await mount(f)
        const control = page.getByRole("button", {
          name: kind === "group" ? "保存群聊" : "移除 Beta",
          exact: true
        })
        assert.equal(await control.isDisabled(), true)
        assert.equal(dispatchCount, before)
        journeys.push(kind + "/old-host-cannot-submit")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        // The Host is restored first; its replacement snapshot has not reached this mounted pane.
        store!.db.run(
          "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES('workspace.restored','replacement','{}',1)"
        )
        await save()
        await page
          .getByText("工作区数据已恢复，请重新打开并核对原操作。原记录仍保留。", { exact: true })
          .waitFor()
        assert.equal(dispatchCount, before + 1)
        assert.equal(store!.getConversation(f.group.id).name, f.group.name)
        assert.deepEqual(store!.getConversation(f.group.id).members, f.group.members)
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        journeys.push(kind + "/real-host-epoch-before-projection")
      }
      {
        const f = await reset(),
          before = dispatchCount,
          request = {
            nonce: "retired",
            id: f.group.id,
            revision: f.group.revision,
            name: "Original",
            description: "保留原记录",
            members: f.group.members
          },
          raw = JSON.stringify({ dataEpoch: "retired", input: request })
        await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: f.key, raw })
        await mount(f)
        await page.getByText("有恢复前的保存记录", { exact: true }).waitFor()
        if (kind === "group")
          assert.equal(
            await page.getByRole("button", { name: "保存群聊", exact: true }).isDisabled(),
            true
          )
        else
          assert.equal(
            await page.getByRole("button", { name: "移除 Beta", exact: true }).isDisabled(),
            true
          )
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
        assert.equal(dispatchCount, before)
        await copyAndReview()
        await page.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await page.getByRole("alert", { name: "待确认保存记录" }).waitFor({ state: "hidden" })
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
        assert.equal(dispatchCount, before, "Archival does not submit a new group mutation")
        journeys.push(kind + "/retired-block-exact-archive-no-submit")
      }
      {
        const f = await reset(),
          before = dispatchCount,
          raw = "{broken"
        await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: f.key, raw })
        await mount(f)
        await page.getByText("本机保存记录无法读取", { exact: true }).waitFor()
        await copyAndReview()
        const replacement = JSON.stringify({
          dataEpoch: store!.dataEpoch(),
          input: {
            nonce: "newer",
            id: f.group.id,
            revision: f.group.revision,
            name: "Different",
            description: "",
            members: f.group.members
          }
        })
        await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), {
          key: f.key,
          raw: replacement
        })
        await page.getByRole("button", { name: "清除此条记录", exact: true }).click()
        await page
          .getByText("记录已变化或无法清除，请重新打开核对。新记录保持不变。", { exact: true })
          .waitFor()
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), replacement)
        assert.equal(dispatchCount, before)
        journeys.push(kind + "/corrupt-exact-discard-race")
      }
      {
        const f = await reset(),
          before = dispatchCount,
          raw = "unknown raw"
        await page.evaluate(
          ({ key, raw }) => {
            localStorage.setItem(key, raw)
            window.fixtureReadFails = true
          },
          { key: f.key, raw }
        )
        await mount(f)
        await page
          .getByText("存储权限不可用，原记录保持不变。请恢复应用存储访问后重新打开。", {
            exact: true
          })
          .waitFor()
        assert.equal(dispatchCount, before)
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
        journeys.push(kind + "/unreadable-blocks-dispatch")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        await page.evaluate(() => {
          window.fixtureCleanupFails = true
        })
        await save()
        await page
          .getByText("保存结果已确认，本机操作记录尚未清除。重试只核对已完成记录。", {
            exact: true
          })
          .waitFor()
        assert.equal(dispatchCount, before + 1)
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        await page.evaluate(() => {
          window.fixtureCleanupFails = false
        })
        await page
          .getByRole("button", {
            name: kind === "group" ? "核对已完成操作记录" : "核对群聊修改",
            exact: true
          })
          .click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(
          dispatchCount,
          before + 1,
          "known acknowledgement retries cleanup rather than mutation"
        )
        journeys.push(kind + "/known-ack-cleanup-readonly-retry")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        failSnapshot = true
        await save()
        await page
          .getByText("群聊已保存，列表同步失败。重试只重新读取列表。", { exact: true })
          .waitFor()
        assert.equal(dispatchCount, before + 1)
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), null)
        await page
          .getByRole("button", {
            name: kind === "group" ? "核对已完成操作记录" : "核对群聊修改",
            exact: true
          })
          .click()
        await page
          .getByText("群聊保存结果已确认。重试只同步列表和核对本机记录。", { exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(dispatchCount, before + 1)
        journeys.push(kind + "/known-ack-sync-readonly-retry")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        outcome = "rejection"
        await page.evaluate(() => {
          window.fixtureCleanupFails = true
        })
        await save()
        await page
          .getByText("保存结果已确认，本机操作记录尚未清除。重试只核对已完成记录。", {
            exact: true
          })
          .waitFor()
        assert.equal(dispatchCount, before + 1)
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        await page.evaluate(() => {
          window.fixtureCleanupFails = false
        })
        await page
          .getByRole("button", {
            name: kind === "group" ? "核对已完成操作记录" : "核对群聊修改",
            exact: true
          })
          .click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(dispatchCount, before + 1)
        assert.deepEqual(await page.evaluate(() => window.fixtureActions), [])
        journeys.push(kind + "/rejected-ack-cleanup-readonly-retry")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        const raw = JSON.stringify({
          dataEpoch: store!.dataEpoch(),
          input: {
            nonce: "other-pane",
            id: f.group.id,
            revision: f.group.revision,
            name: "Other pending",
            description: "",
            members: f.group.members
          }
        })
        await page.evaluate(({ key, raw }) => localStorage.setItem(key, raw), { key: f.key, raw })
        await save()
        if (kind === "group")
          await page
            .getByText("有一次群聊保存尚未确认，请先核对原请求。", { exact: true })
            .waitFor()
        else await page.getByRole("button", { name: "核对群聊修改", exact: true }).waitFor()
        assert.equal(dispatchCount, before)
        assert.equal(await page.evaluate((key) => window.fixtureRaw(key), f.key), raw)
        if (kind === "group")
          assert.equal(
            await page.getByRole("textbox", { name: "群聊名称", exact: true }).isDisabled(),
            true
          )
        else
          assert.equal(
            await page.getByRole("button", { name: "移除 Beta", exact: true }).isDisabled(),
            true
          )
        journeys.push(kind + "/other-pane-pending-kept-without-dispatch")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        mismatchedReply = true
        await save()
        await page
          .getByText("群聊保存回执与原请求不一致，原记录仍保留。请重试核对。", { exact: true })
          .waitFor()
        assert.equal(dispatchCount, before + 1)
        assert.ok(await page.evaluate((key) => window.fixtureRaw(key), f.key))
        assert.deepEqual(await page.evaluate(() => window.fixtureActions), [])
        journeys.push(kind + "/mismatched-receipt-keeps-original-intent")
      }
      {
        const f = await reset(),
          before = dispatchCount
        await mount(f)
        loseReply = true
        await save()
        await page
          .getByText("尚未收到保存结果。重试会核对同一次群聊保存，原内容和版本保持不变。", {
            exact: true
          })
          .waitFor()
        const raw = await page.evaluate((key) => window.fixtureRaw(key), f.key)
        assert.ok(raw)
        await mount(f)
        await page
          .getByRole("button", {
            name: kind === "group" ? "重试核对保存" : "核对群聊修改",
            exact: true
          })
          .click()
        await page.waitForFunction((key) => window.fixtureRaw(key) === null, f.key)
        assert.equal(dispatchCount, before + 2)
        assert.equal(
          store!.db.exec("SELECT COUNT(*) FROM bot_events WHERE kind='conversation.updated'")[0]
            .values[0][0],
          1
        )
        journeys.push(kind + "/lost-ack-exact-reopen-no-duplicate-effect")
      }
    }
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          pass: true,
          journeys,
          errors,
          startedAt,
          actual:
            "48 React Chrome journeys; 2 use actual copied SQLite checkpoint, production restore fence and authenticated replacement RPC",
          seams: "native bridge, unrelated optional configuration widgets, held replies"
        },
        null,
        2
      )
    )
    console.log(JSON.stringify({ pass: true, journeys: journeys.length, errors, startedAt }))
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    await writeFile(join(output, "failure.html"), await page.content()).catch(() => {})
    throw error
  } finally {
    await browser.close()
    store?.close()
    console.log(JSON.stringify({ physicallyClosed: true, finishedAt: new Date().toISOString() }))
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
