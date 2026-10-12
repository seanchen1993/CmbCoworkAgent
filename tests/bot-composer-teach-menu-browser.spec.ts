import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Actual Workspace/Computer/Teach, native browser and authenticated SQLite RPC.
 * Only post-RPC replies and a durable fixture restore-epoch marker are controlled.
 * Navigation checks use production React owners and real input/take RPCs, not a
 * full backup restore, model run or OS proof. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
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
import { BotHostLock } from "../src/main/bots/host-lock"
import { LocalBotComputerProvider } from "../src/main/bots/computer-provider"
import { BotTeachService } from "../src/main/bots/teach-service"
import type { BotTeachStartInput } from "../src/shared/bot-teach"
import { botThreadView } from "../src/renderer/src/lib/bot-thread-view"
import { BOT_PROTOCOL_VERSION } from "../src/shared/bot-types"

async function main() {
  const source = resolve(process.env.CMB_TEACH_MENU_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-teach-menu-ui-"))
  const output = resolve(process.env.CMB_TEACH_MENU_OUTPUT ?? "output/bot-teach-menu")
  await mkdir(output, { recursive: true })
  const store = new BotStore(join(directory, "bots.sqlite"))
  const a = store.createBot({
    nonce: "a",
    name: "研发助手",
    avatarColor: "red",
    avatarShape: "teardrop"
  })
  const b = store.createBot({
    nonce: "b",
    name: "质量助手",
    avatarColor: "blue",
    avatarShape: "hex"
  })
  const hidden = store.createBot({ nonce: "hidden", name: "归档助手", avatarColor: "yellow" })
  store.updateBot({ id: a.bot.id, revision: a.bot.revision, pinned: true })
  store.updateBot({ id: b.bot.id, revision: b.bot.revision, pinned: true })
  store.updateBot({ id: hidden.bot.id, revision: hidden.bot.revision, hidden: true })
  const group = store.createGroup({
    nonce: "group",
    name: "研发协作群",
    members: [a.bot.id, b.bot.id]
  })
  const history = store.send({
    nonce: "history",
    conversationId: a.conversationId,
    text: "搜索定位原始证据"
  })
  store.cancel(history.runIds[0])
  const discussion = store.send({
    nonce: "discussion",
    conversationId: group.id,
    text: "原群讨论",
    recipients: [a.bot.id]
  })
  const branch = botThreadView(group.id, discussion.messageId)
  const directBranch = botThreadView(a.conversationId, history.messageId)
  const lock = BotHostLock.acquire(directory)!
  const computer = new LocalBotComputerProvider(join(directory, "browser"))
  computer.persistence = store
  const teach = new BotTeachService(join(directory, "teach"), store, computer)
  const host = new BotHost(store, undefined, 1, computer, undefined, teach)
  host.bindOwnership(lock)
  const token = randomBytes(32).toString("hex")
  const rpc = new BotRpcServer(host, token)
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-group-${token.slice(0, 16)}`
      : join(directory, "rpc.sock")
  const client = new BotTransportClient({
    version: BOT_PROTOCOL_VERSION,
    hostId: host.id,
    pid: process.pid,
    socketPath,
    token
  })
  const server = createServer()
  const cases: string[] = []
  const failures: { name: string; message: string }[] = []
  const pageErrors: string[] = []
  const calls: { method: string; input: unknown }[] = []
  let loseFirstStartAck = false
  let holdStatus = false
  const heldStatuses: (() => void)[] = []
  // Hold only the actual authenticated postreply, never synthesize an accepted Start.
  let holdStartAck = false
  const heldStartAcks: (() => void)[] = []
  // Keep the actual Host result intact; only postpone delivery to its old React owner.
  let holdNextFrameFor: string | null = null
  const heldFrames: (() => void)[] = []
  let releasedFrames = 0
  let holdRoutineAck = false
  const heldRoutineAcks: (() => void)[] = []
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    await rpc.listen(socketPath)
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
    const highlight = await build({
      entryPoints: [join(renderer, "components/tabs/code-highlight-worker.ts")],
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      logLevel: "silent"
    })
    const bundle = await build({
      stdin: {
        loader: "tsx",
        resolveDir: source,
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botShellResources:{inspect:async()=>({mode:'exclusive',review:{state:'ready',reason:'none',entries:[],title:'命令现场已核对',hint:'没有未确认关闭的命令现场。'}})}};window.fixtureTheme=applyThemePreference;window.fixtureWorkspace=useBotWorkspaceStore;window.fixtureRefresh=()=>useBotWorkspaceStore.getState().refresh();useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},selected:${JSON.stringify(a.conversationId)}});useBotWorkspaceStore.getState().draft(${JSON.stringify(a.conversationId)},'研发草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(b.conversationId)},'质量草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(group.id)},'群聊草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(branch)},'分支草稿');createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><BotWorkspace/><Toaster/></div>);`
      },
      bundle: true,
      platform: "browser",
      format: "iife",
      write: false,
      outfile: join(directory, "workspace.js"),
      jsx: "automatic",
      alias: { "@": renderer },
      define: {
        "process.env.NODE_ENV": '"production"',
        "import.meta.env.DEV": "false",
        __APP_VERSION__: '"test-build"'
      },
      plugins: [
        viteUrlAssetsFixture(),
        {
          name: "original-workspace-controlled-desktop-app",
          setup(builder) {
            builder.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
              path: "highlight-worker",
              namespace: "preview-worker"
            }))
            builder.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
              loader: "js",
              contents: `export default class extends Worker{constructor(options){const url=URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}],{type:'text/javascript'}));super(url,options);URL.revokeObjectURL(url)}}`
            }))
            builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) => {
              if (args.path === "./store" && !args.importer.startsWith(join(renderer, "lib")))
                return undefined
              return { path: "app-store", namespace: "fixture" }
            })
            builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
              path: "thread-context",
              namespace: "fixture"
            }))
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
              loader: "js",
              resolveDir: source,
              contents:
                args.path === "app-store"
                  ? `import{create}from'zustand';export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));`
                  : "export const useThreadStateSelector=(_id,selector)=>selector({workspacePath:null,workspaceFiles:[]});"
            }))
          }
        }
      ]
    })
    const stylesheet = css.build(scanner.scan())
    server.on("request", (request, response) => {
      if (request.url === "/desktop") {
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(
          '<!doctype html><title>实际示范网页</title><input aria-label="订单编号"><button>核对订单</button>'
        )
      } else if (request.url === "/workspace.js") {
        response.setHeader("Content-Type", "text/javascript")
        response.end(bundle.outputFiles[0].text)
      } else if (request.url === "/style.css") {
        response.setHeader("Content-Type", "text/css")
        response.end(stylesheet)
      } else {
        response.setHeader("Content-Type", "text/html")
        response.end(
          '<!doctype html><html lang="zh-CN"><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/workspace.js"></script></body></html>'
        )
      }
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    browser = await chromium.launch({
      channel: process.platform === "win32" ? "msedge" : "chrome",
      headless: true,
      args: ["--disable-updater-scheduler"]
    })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
    page.setDefaultTimeout(6000)
    page.on("pageerror", (error) => pageErrors.push(error.message))
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({
        method,
        input: input === undefined ? undefined : JSON.parse(JSON.stringify(input))
      })
      try {
        const value: unknown = await Reflect.apply(
          client.call,
          client,
          input === undefined ? [method] : [method, input]
        )
        if (method === "teachStart" && loseFirstStartAck) {
          loseFirstStartAck = false
          return { botFailure: { code: "uncertain_ack", message: "测试桥接丢失已接受录制的回执" } }
        }
        if (method === "teachStart" && holdStartAck)
          await new Promise<void>((resolve) => heldStartAcks.push(resolve))
        if (method === "teachStatus" && holdStatus)
          await new Promise<void>((resolve) => heldStatuses.push(resolve))
        if (method === "computerFrame" && input === holdNextFrameFor) {
          holdNextFrameFor = null
          await new Promise<void>((resolve) => heldFrames.push(resolve))
          releasedFrames++
        }
        if (method === "saveRoutine" && holdRoutineAck)
          await new Promise<void>((resolve) => heldRoutineAcks.push(resolve))
        return value
      } catch (error) {
        const failure = error as { code?: string; message?: string }
        return {
          botFailure: {
            code: failure.code ?? "fixture_error",
            message: failure.message ?? String(error)
          }
        }
      }
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    const broker = await computer.get()
    for (const bot of [a.bot, b.bot]) {
      const target = await broker.ensure(bot.id)
      await broker.act(
        target,
        { op: "navigate", url: `http://127.0.0.1:${address.port}/desktop` },
        () => {}
      )
    }
    await page.goto(`http://127.0.0.1:${address.port}`)
    // Reuse the original full Workspace fixture's emitted component stylesheet admission.
    for (const asset of bundle.outputFiles)
      if (asset.path.endsWith(".css")) await page.addStyleTag({ content: asset.text })
    try {
      await page.getByRole("heading", { name: a.bot.name, level: 2 }).waitFor()
    } catch (error) {
      await page.screenshot({ path: join(output, "startup-failure.png") }).catch(() => {})
      await writeFile(join(output, "startup-failure.html"), await page.content()).catch(() => {})
      const state = await page
        .evaluate(() => {
          const value = (
            window as unknown as {
              fixtureWorkspace: Pick<
                typeof import("../src/renderer/src/lib/bot-workspace-store").useBotWorkspaceStore,
                "getState"
              >
            }
          ).fixtureWorkspace?.getState()
          return value
            ? {
                selected: value.selected,
                host: value.host,
                error: value.error,
                epoch: value.snapshot?.dataEpoch,
                workProjection: value.snapshot?.work?.projection,
                conversationIds: value.snapshot?.conversations?.map((item) => item.id)
              }
            : null
        })
        .catch(() => null)
      await writeFile(
        join(output, "startup-failure.json"),
        JSON.stringify({ pageErrors, state, methods: calls.map((call) => call.method) }, null, 2)
      ).catch(() => {})
      throw error
    }
    const check = async (name: string, task: () => Promise<void>) => {
      try {
        await task()
        cases.push(name)
        console.log(`PASS ${name}`)
      } catch (error) {
        const index = failures.length + 1
        await page.screenshot({ path: join(output, `failure-${index}.png`) }).catch(() => {})
        await writeFile(join(output, `failure-${index}.html`), await page.content()).catch(() => {})
        const keyboard = await page.evaluate(() => {
          const element = document.activeElement
          return {
            tag: element?.tagName,
            role: element?.getAttribute("role"),
            label: element?.getAttribute("aria-label"),
            closestDialog: element?.closest('[role="dialog"]')?.getAttribute("aria-label"),
            events: (window as unknown as { fixtureEscapeEvents?: unknown }).fixtureEscapeEvents
          }
        })
        await writeFile(
          join(output, `failure-${index}-keyboard.json`),
          JSON.stringify(keyboard, null, 2)
        )
        failures.push({
          name,
          message: error instanceof Error ? (error.stack ?? error.message) : String(error)
        })
        console.error(`FAIL ${name}: ${failures.at(-1)?.message}`)
      }
    }
    const refresh = () =>
      page.evaluate(() =>
        (window as unknown as { fixtureRefresh(): Promise<void> }).fixtureRefresh()
      )
    const starts = () => calls.filter((call) => call.method === "teachStart")
    const rows = (sql: string) => store.db.exec(sql)[0]?.values ?? []
    const originalDiscussion = JSON.stringify(rows("SELECT * FROM bot_group_cycles"))
    const waitFor = async (test: () => boolean) => {
      const deadline = Date.now() + 6000
      while (!test()) {
        if (Date.now() > deadline) throw new Error("fixture condition timeout")
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    await check(
      "direct input actions reuse attachments and only arm the original Computer until explicit recording",
      async () => {
        await page.getByRole("button", { name: "输入操作", exact: true }).click()
        const chooser = page.waitForEvent("filechooser")
        await page.getByRole("menuitem", { name: "添加附件", exact: true }).click()
        await (await chooser).setFiles([])
        assert.equal(calls.filter((call) => call.method === "stageFile").length, 0)
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
        )
        await page.getByRole("button", { name: "输入操作", exact: true }).click()
        await page.screenshot({
          animations: "disabled",
          path: join(output, "direct-menu-dark.png")
        })
        await page.getByRole("menuitem", { name: "教它做一项任务", exact: true }).click()
        await page.getByRole("button", { name: "开始录制", exact: true }).waitFor()
        await page.getByRole("dialog", { name: `${a.bot.name} 的电脑`, exact: true }).waitFor()
        assert.equal(starts().length, 0)
        assert.equal(teach.repository.list().length, 0)
        assert.equal(
          await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
          "研发草稿"
        )
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-dark")
        )
        await page.screenshot({ animations: "disabled", path: join(output, "direct-dark-arm.png") })
        const preparedComputer = page.getByRole("dialog", {
          name: `${a.bot.name} 的电脑`,
          exact: true
        })
        const preparedPanel = await preparedComputer.elementHandle()
        assert.ok(preparedPanel)
        await page.getByRole("button", { name: "取消准备", exact: true }).click()
        assert.equal(teach.repository.list().length, 0)
        assert.equal(calls.filter((call) => call.method === "teachStop").length, 0)
        await preparedComputer.waitFor()
        assert.equal(await preparedPanel.evaluate((panel) => panel.isConnected), true)
        await page
          .getByRole("button", { name: "开始录制", exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(starts().length, 0)
        assert.equal(
          await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
          "研发草稿"
        )
        await page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
        await preparedComputer.waitFor({ state: "hidden" })
        await preparedPanel.dispose()
        await page.waitForFunction(
          () => document.activeElement?.getAttribute("aria-label") === "向 Bot 交办工作",
          undefined,
          { timeout: 6000 }
        )
        await page.getByLabel("向 Bot 交办工作", { exact: true }).focus()
        await page.getByRole("button", { name: "输入操作", exact: true }).click()
        await page.keyboard.press("Escape")
        await page.getByRole("menu").waitFor({ state: "hidden" })
      }
    )
    await check(
      "group branch selects the exact learner, recovers the original accepted Start and queues once without replacing discussion",
      async () => {
        await page.evaluate(
          (view) =>
            (
              window as unknown as {
                fixtureWorkspace: { getState(): { select(view: string): Promise<void> } }
              }
            ).fixtureWorkspace
              .getState()
              .select(view),
          branch
        )
        await page.getByLabel("向 Bot 交办工作", { exact: true }).waitFor()
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
        )
        await page.getByRole("button", { name: "输入操作", exact: true }).click()
        await page.getByRole("menuitem", { name: "教它做一项任务", exact: true }).hover()
        await page.getByRole("menuitem", { name: b.bot.name, exact: true }).waitFor()
        await page.screenshot({
          animations: "disabled",
          path: join(output, "group-target-menu-light.png")
        })
        await page.getByRole("menuitem", { name: b.bot.name, exact: true }).click()
        const record = page.getByRole("button", { name: "开始录制", exact: true })
        await record.waitFor()
        await page.getByRole("dialog", { name: `${b.bot.name} 的电脑`, exact: true }).waitFor()
        assert.equal(starts().length, 0)
        assert.equal(
          await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
          "分支草稿"
        )
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(value: string): void }).fixtureTheme("codex-light")
        )
        holdStatus = true
        loseFirstStartAck = true
        await record.click()
        await page.getByText("测试桥接丢失已接受录制的回执", { exact: true }).waitFor()
        const accepted = teach.status(b.bot.id)!
        assert.equal(accepted.phase, "recording")
        assert.equal(accepted.conversationId, group.id)
        assert.equal(accepted.threadRootId, discussion.messageId)
        holdStartAck = true
        await page.getByRole("button", { name: "核对原录制请求", exact: true }).click()
        // The same nonce has already been accepted by the real RPC. Keep its
        // reply pending while a nested, original TeachHistory Dialog owns focus.
        try {
          await waitFor(() => heldStartAcks.length === 1)
          assert.equal(
            await page.getByRole("button", { name: "核对原录制请求", exact: true }).isDisabled(),
            true
          )
          assert.equal(starts().length, 2)
          assert.equal((starts()[1].input as BotTeachStartInput).nonce, accepted.startNonce)
          assert.deepEqual(starts()[0].input, starts()[1].input)
          assert.equal(teach.status(b.bot.id)?.id, accepted.id)
          assert.equal(teach.status(b.bot.id)?.startNonce, accepted.startNonce)
          assert.equal(teach.repository.list().length, 1)
          await page.getByRole("button", { name: "查看示范记录", exact: true }).click()
          const historyDialog = page.getByRole("dialog", { name: "示范记录", exact: true })
          await historyDialog.waitFor()
          const historyPanel = await historyDialog.elementHandle()
          const historyFocus = await historyDialog
            .getByRole("button", { name: "刷新记录", exact: true })
            .elementHandle()
          assert.ok(historyPanel)
          assert.ok(historyFocus)
          await page.waitForFunction(
            (button) => button instanceof HTMLButtonElement && !button.disabled,
            historyFocus,
            { timeout: 6000 }
          )
          await historyFocus.focus()
          assert.equal(
            await historyFocus.evaluate((button) => document.activeElement === button),
            true
          )
          holdStartAck = false
          for (const release of heldStartAcks.splice(0)) release()
          const acceptedSave = await page
            .getByRole("dialog", { name: `${b.bot.name} 的电脑`, exact: true, includeHidden: true })
            .getByRole("button", { name: "保存并学习", exact: true, includeHidden: true })
            .elementHandle()
          assert.ok(acceptedSave)
          await page.waitForFunction(
            (button) => button instanceof HTMLButtonElement && !button.disabled,
            acceptedSave,
            { timeout: 6000 }
          )
          await historyDialog.waitFor()
          assert.equal(await historyPanel.evaluate((panel) => panel.isConnected), true)
          assert.equal(
            await historyFocus.evaluate((button) => document.activeElement === button),
            true
          )
          assert.equal(starts().length, 2)
          assert.deepEqual(starts()[0].input, starts()[1].input)
          assert.equal(teach.status(b.bot.id)?.id, accepted.id)
          assert.equal(teach.status(b.bot.id)?.startNonce, accepted.startNonce)
          assert.equal(teach.repository.list().length, 1)
          assert.equal(calls.filter((call) => call.method === "send").length, 0)
          assert.equal(calls.filter((call) => call.method === "teachStop").length, 0)
          await historyDialog.getByRole("button", { name: "Close", exact: true }).click()
          await historyDialog.waitFor({ state: "hidden" })
          await acceptedSave.dispose()
          await historyFocus.dispose()
          await historyPanel.dispose()
        } finally {
          holdStartAck = false
          for (const release of heldStartAcks.splice(0)) release()
        }
        holdStatus = false
        for (const release of heldStatuses.splice(0)) release()
        await page.getByRole("button", { name: "保存并学习", exact: true }).waitFor()
        assert.equal(starts().length, 2)
        assert.deepEqual(starts()[0].input, starts()[1].input)
        const originalRequest = starts()[0].input as BotTeachStartInput
        await assert.rejects(
          client.call("teachStart", {
            ...originalRequest,
            nonce: "stale-epoch",
            expectedDataEpoch: "different-workspace"
          }),
          (error) => (error as { code?: string }).code === "data_epoch"
        )
        await assert.rejects(
          client.call("teachStart", {
            ...originalRequest,
            nonce: "stale-group",
            conversationRevision: group.revision + 1
          }),
          (error) => (error as { code?: string }).code === "revision_conflict"
        )
        await assert.rejects(
          client.call("teachStart", {
            ...originalRequest,
            nonce: "stale-target",
            target: { ...broker.target(b.bot.id), viewId: "different-target" }
          }),
          (error) => (error as { code?: string }).code === "stale_target"
        )
        assert.equal(teach.repository.list().length, 1)
        await page.getByRole("dialog", { name: `${b.bot.name} 的电脑`, exact: true }).waitFor()
        await page.evaluate(() => {
          const events: unknown[] = []
          ;(window as unknown as { fixtureEscapeEvents: unknown[] }).fixtureEscapeEvents = events
          for (const capture of [true, false])
            document.addEventListener(
              "keydown",
              (event: KeyboardEvent) => {
                if (event.key !== "Escape") return
                const target = event.target instanceof Element ? event.target : null
                events.push({
                  phase: event.eventPhase,
                  prevented: event.defaultPrevented,
                  tag: target?.tagName,
                  label: target?.getAttribute("aria-label"),
                  closestDialog: target?.closest('[role="dialog"]')?.getAttribute("aria-label")
                })
              },
              { capture, once: true }
            )
        })
        await page.keyboard.press("Escape")
        await page
          .getByRole("dialog", { name: `${b.bot.name} 的电脑`, exact: true })
          .waitFor({ state: "hidden" })
        assert.equal(teach.repository.get(accepted.id).phase, "recording")
        assert.equal(calls.filter((call) => call.method === "teachStop").length, 0)
        await page.getByRole("button", { name: "展开电脑面板", exact: true }).click()
        await page.getByRole("dialog", { name: `${b.bot.name} 的电脑`, exact: true }).waitFor()
        await waitFor(() => teach.repository.get(accepted.id).frameCount > 0)
        await page.screenshot({
          animations: "disabled",
          path: join(output, "group-light-recording.png")
        })
        await page.getByRole("button", { name: "保存并学习", exact: true }).click()
        await waitFor(() => teach.repository.get(accepted.id).phase === "learning")
        const saved = teach.repository.get(accepted.id)
        const run = store.getRun(saved.learningRunId!)
        assert.equal(run.botId, b.bot.id)
        assert.equal(run.conversationId, group.id)
        assert.equal(run.threadRootId, discussion.messageId)
        assert.equal(run.lane, "user")
        assert.equal(run.source, "teach-learning")
        assert.equal(JSON.stringify(rows("SELECT * FROM bot_group_cycles")), originalDiscussion)
        assert.equal(rows(`SELECT run_id FROM bot_group_runs WHERE run_id='${run.id}'`).length, 0)
        assert.equal(
          await page.getByLabel("向 Bot 交办工作", { exact: true }).innerText(),
          "分支草稿"
        )
        assert.equal(calls.filter((call) => call.method === "send").length, 0)
        await page.setViewportSize({ width: 760, height: 800 })
        await page.emulateMedia({ reducedMotion: "reduce" })
        const hintBounds = await page
          .getByText("Ctrl + Alt + Esc 回到电脑控件", { exact: true })
          .evaluate((hint) => {
            const captionElement = hint.parentElement!
            const caption = captionElement.getBoundingClientRect()
            const glyphs = hint.getBoundingClientRect()
            const input = document.querySelector(".bot-browser-input")!.getBoundingClientRect()
            return {
              captionBottom: caption.bottom,
              glyphBottom: glyphs.bottom,
              captionHeight: captionElement.clientHeight,
              captionScrollHeight: captionElement.scrollHeight,
              inputTop: input.top,
              viewportHeight: window.innerHeight
            }
          })
        assert.ok(
          hintBounds.glyphBottom <= hintBounds.captionBottom &&
            hintBounds.captionScrollHeight <= hintBounds.captionHeight &&
            hintBounds.captionBottom <= hintBounds.inputTop &&
            hintBounds.captionBottom <= hintBounds.viewportHeight,
          `Both browser hints must remain above the input bar: ${JSON.stringify(hintBounds)}`
        )
        await page.screenshot({
          animations: "disabled",
          path: join(output, "group-narrow-reduced.png")
        })
      }
    )
    await check(
      "removing the selected group learner revokes physical capture and cannot publish a learning task",
      async () => {
        await page.setViewportSize({ width: 1440, height: 960 })
        await page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
        await page.getByRole("button", { name: "输入操作", exact: true }).click()
        await page.getByRole("menuitem", { name: "教它做一项任务", exact: true }).hover()
        await page.getByRole("menuitem", { name: a.bot.name, exact: true }).click()
        await page.getByRole("button", { name: "开始录制", exact: true }).click()
        await waitFor(() => teach.status(a.bot.id)?.phase === "recording")
        const recording = teach.status(a.bot.id)!
        await waitFor(() => teach.repository.get(recording.id).frameCount > 0)
        const current = store.getConversation(group.id)
        store.updateGroup({
          ...current,
          description: current.description ?? "",
          nonce: "remove-learner",
          expectedDataEpoch: store.dataEpoch(),
          members: [b.bot.id]
        })
        await refresh()
        await waitFor(() => teach.repository.get(recording.id).phase === "failed")
        const stopped = teach.repository.get(recording.id)
        await new Promise((resolve) => setTimeout(resolve, 450))
        assert.equal(teach.repository.get(recording.id).frameCount, stopped.frameCount)
        assert.equal(stopped.learningRunId, null)
        assert.equal(broker.teachRecordingBot, undefined)
        assert.equal(
          rows(`SELECT id FROM bot_runs WHERE source='teach-learning' AND bot_id='${a.bot.id}'`)
            .length,
          0
        )
      }
    )
    // These cases extend the original stateful Teach fixture only after its
    // recording/learning assertions, so navigation cannot dilute those counts.
    const selectView = async (id: string, name: string) => {
      await page.evaluate(
        (value) =>
          (
            window as unknown as {
              fixtureWorkspace: { getState(): { select(id: string): void } }
            }
          ).fixtureWorkspace
            .getState()
            .select(value),
        id
      )
      await page.waitForFunction((value) => {
        const state = (
          window as unknown as {
            fixtureWorkspace: {
              getState(): { selected: string | null; opening: Record<string, boolean> }
            }
          }
        ).fixtureWorkspace.getState()
        return state.selected === value && !state.opening[value]
      }, id)
      await page.getByRole("heading", { name, level: 2, exact: true }).waitFor()
    }
    const closeInspector = async () => {
      const exit = page.getByRole("button", { name: "退出电脑全屏", exact: true })
      if (await exit.count()) await exit.click()
      const close = page.getByRole("button", { name: /^关闭(?:电脑|详情)面板$/ })
      if (await close.count()) await close.click()
      await page.locator(".bot-inspector-panel").waitFor({ state: "detached" })
    }
    const openComputer = async (id: string, name: string) => {
      await closeInspector()
      await selectView(id, name)
      await page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
      await page.getByRole("complementary", { name: `${name} 的电脑`, exact: true }).waitFor()
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          ".bot-computer-control button:not([aria-label])"
        )
        return !!button && !button.disabled
      })
    }
    const returnComputer = async () => {
      const release = page.getByRole("button", { name: "归还 Bot", exact: true })
      if (await release.count()) {
        await release.click()
        await page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
      }
    }
    const takeComputer = async () => {
      // Navigation can mount B before its first frame reveals that B already
      // has human control. Observe that frame before choosing release vs take.
      await page.waitForFunction(() => {
        const button = document.querySelector<HTMLButtonElement>(
          ".bot-computer-control button:not([aria-label])"
        )
        return !!button && !button.disabled
      })
      if (await page.getByRole("button", { name: "归还 Bot", exact: true }).count())
        await returnComputer()
      await page.getByRole("button", { name: "接管操作", exact: true }).click()
      await page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      await page.waitForFunction(() => {
        const input = document.querySelector<HTMLButtonElement>(
          '.bot-browser-input button[aria-label="输入"]'
        )
        // The text is not yet filled; readiness is proved by the URL control.
        const url = document.querySelector<HTMLInputElement>('input[aria-label="浏览器网址"]')
        return !!input && !!url && !url.disabled
      })
    }
    const inputCalls = () => calls.filter((call) => call.method === "computerInput")
    const takeCalls = () => calls.filter((call) => call.method === "computerTake")
    const releaseHeldFrames = () => {
      holdNextFrameFor = null
      for (const release of heldFrames.splice(0)) release()
    }

    await check(
      "closed Inspector stays closed across ordinary and same-Bot branch navigation",
      async () => {
        await closeInspector()
        const before = calls.filter(
          (call) => call.method === "computerOpen" || call.method === "computerFrame"
        ).length
        await selectView(a.conversationId, a.bot.name)
        await selectView(directBranch, a.bot.name)
        await selectView(b.conversationId, b.bot.name)
        assert.equal(await page.locator(".bot-inspector-panel").count(), 0)
        assert.equal(
          calls.filter((call) => call.method === "computerOpen" || call.method === "computerFrame")
            .length,
          before
        )
      }
    )

    await check(
      "same-Bot branch releases the navigation cover and takes the exact branch address",
      async () => {
        await openComputer(a.conversationId, a.bot.name)
        await returnComputer()
        const original = await page.locator(".bot-computer-content").elementHandle()
        assert.ok(original)
        try {
          const before = takeCalls().length
          await selectView(directBranch, a.bot.name)
          assert.equal(await original.evaluate((node) => node.isConnected), true)
          await takeComputer()
          assert.equal(takeCalls().length, before + 1)
          assert.deepEqual(
            (({ botId, conversationId, threadRootId }) => ({
              botId,
              conversationId,
              threadRootId
            }))(
              takeCalls().at(-1)!.input as {
                botId: string
                conversationId: string
                threadRootId?: string
              }
            ),
            { botId: a.bot.id, conversationId: a.conversationId, threadRootId: history.messageId }
          )
          assert.equal(
            await page
              .locator(".bot-inspector-base")
              .evaluate((node) => (node as HTMLElement).inert),
            false
          )
          await returnComputer()
        } finally {
          await original.dispose()
        }
      }
    )

    await check(
      "a late frame from Bot A cannot replace Bot B or dispatch input to A after navigation",
      async () => {
        await openComputer(a.conversationId, a.bot.name)
        // Opening Computer is a temporary reveal. Explicit tab clicks establish
        // the desired global fallback for unseen B without changing ownership assertions.
        await page.getByRole("tab", { name: "详情", exact: true }).click()
        await page.getByRole("tab", { name: "电脑", exact: true }).click()
        await takeComputer()
        await page.getByLabel("向浏览器输入文本", { exact: true }).fill("RETIRED-A")
        const oldInput = await page
          .getByRole("button", { name: "输入", exact: true })
          .elementHandle()
        assert.ok(oldInput)
        try {
          holdNextFrameFor = a.bot.id
          await page.getByRole("button", { name: "刷新画面", exact: true }).click()
          await waitFor(() => heldFrames.length === 1)
          await selectView(b.conversationId, b.bot.name)
          await page
            .getByRole("complementary", { name: `${b.bot.name} 的电脑`, exact: true })
            .waitFor()
          assert.equal(await oldInput.evaluate((node) => node.isConnected), false)
          const inputsBefore = inputCalls().length
          await oldInput.evaluate((node) => (node as HTMLButtonElement).click())
          assert.equal(inputCalls().length, inputsBefore)
          const releasedBefore = releasedFrames
          releaseHeldFrames()
          await waitFor(() => releasedFrames === releasedBefore + 1)
          await takeComputer()
          const physicalB = await broker.teachObserve(b.bot.id, async (ownedPage) => {
            await ownedPage.getByLabel("订单编号", { exact: true }).focus()
            return ownedPage
          })
          await page.getByLabel("向浏览器输入文本", { exact: true }).fill("CURRENT-B")
          await page.getByRole("button", { name: "输入", exact: true }).click()
          await waitFor(() => inputCalls().length === inputsBefore + 1)
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLInputElement>('input[aria-label="向浏览器输入文本"]')
                ?.value === ""
          )
          const applied = inputCalls().at(-1)!.input as {
            target: { botId: string }
            input: { kind: string; text?: string }
          }
          assert.equal(applied.target.botId, b.bot.id)
          assert.deepEqual(
            { kind: applied.input.kind, text: applied.input.text },
            { kind: "text", text: "CURRENT-B" }
          )
          assert.equal(
            await physicalB.getByLabel("订单编号", { exact: true }).inputValue(),
            "CURRENT-B"
          )
          assert.equal(
            await page
              .getByRole("complementary", { name: `${a.bot.name} 的电脑`, exact: true })
              .count(),
            0
          )
          await returnComputer()
        } finally {
          releaseHeldFrames()
          await oldInput.dispose()
        }
      }
    )

    await check(
      "an accepted routine save keeps its original owner busy and releases navigation to Bot B once",
      async () => {
        const routine = store.saveRoutine({
          nonce: "navigation-routine",
          expectedDataEpoch: store.dataEpoch(),
          botId: a.bot.id,
          name: "导航归属例程",
          prompt: "仅由本夹具明确事件触发，不调用模型。",
          schedule: { kind: "event", topic: "fixture-navigation-only" },
          timezone: "Asia/Shanghai",
          enabled: true
        })
        await refresh()
        await openComputer(a.conversationId, a.bot.name)
        await takeComputer()
        await page.getByLabel("向浏览器输入文本", { exact: true }).fill("BUSY-A")
        const oldInput = await page
          .getByRole("button", { name: "输入", exact: true })
          .elementHandle()
        assert.ok(oldInput)
        try {
          await page.getByRole("tab", { name: "详情", exact: true }).click()
          await page.getByRole("button", { name: `查看例程 ${routine.name}`, exact: true }).click()
          await page.getByLabel("例程详情", { exact: true }).waitFor()
          const savesBefore = calls.filter((call) => call.method === "saveRoutine").length
          holdRoutineAck = true
          await page.getByRole("button", { name: "暂停", exact: true }).click()
          await waitFor(() => heldRoutineAcks.length === 1)
          assert.equal(store.routine(a.bot.id, routine.id).revision, routine.revision + 1)
          assert.equal(store.routine(a.bot.id, routine.id).enabled, false)
          await selectView(b.conversationId, b.bot.name)
          assert.equal(
            await page.locator(".bot-inspector-panel").getAttribute("aria-label"),
            `${a.bot.name} 的例程详情`
          )
          assert.equal(
            await page
              .locator(".bot-inspector-base")
              .evaluate((node) => (node as HTMLElement).inert),
            true
          )
          assert.equal(
            await oldInput.evaluate((node) => (node as HTMLButtonElement).disabled),
            true
          )
          const before = inputCalls().length
          await oldInput.evaluate((node) => (node as HTMLButtonElement).click())
          assert.equal(inputCalls().length, before)
          assert.equal(
            await page.getByRole("button", { name: "返回 Bot 详情", exact: true }).isDisabled(),
            true
          )
          holdRoutineAck = false
          for (const release of heldRoutineAcks.splice(0)) release()
          await page
            .getByRole("complementary", { name: `${b.bot.name} 的详情`, exact: true })
            .waitFor()
          assert.equal(await page.getByLabel("例程详情", { exact: true }).count(), 0)
          assert.equal(
            calls.filter((call) => call.method === "saveRoutine").length,
            savesBefore + 1
          )
          assert.equal(store.routine(a.bot.id, routine.id).revision, routine.revision + 1)
          assert.equal(
            await page
              .locator(".bot-inspector-base")
              .evaluate((node) => (node as HTMLElement).inert),
            false
          )
          await page.getByRole("tab", { name: "电脑", exact: true }).click()
          await takeComputer()
          assert.equal((takeCalls().at(-1)!.input as { botId: string }).botId, b.bot.id)
          await returnComputer()
        } finally {
          holdRoutineAck = false
          for (const release of heldRoutineAcks.splice(0)) release()
          await oldInput.dispose()
        }
      }
    )

    await check(
      "each Bot remembers explicit tabs while header reveals and same-Bot branches remain temporary",
      async () => {
        await openComputer(a.conversationId, a.bot.name)
        await page.getByRole("tab", { name: "详情", exact: true }).click()
        await page.getByRole("tab", { name: "电脑", exact: true }).click()
        await selectView(b.conversationId, b.bot.name)
        assert.equal(
          await page.getByRole("tab", { name: "电脑", exact: true }).getAttribute("aria-selected"),
          "true"
        )
        await page.getByRole("tab", { name: "资料库", exact: true }).click()
        await selectView(a.conversationId, a.bot.name)
        assert.equal(
          await page.getByRole("tab", { name: "电脑", exact: true }).getAttribute("aria-selected"),
          "true"
        )
        await selectView(b.conversationId, b.bot.name)
        assert.equal(
          await page
            .getByRole("tab", { name: "资料库", exact: true })
            .getAttribute("aria-selected"),
          "true"
        )
        // Header details reveals do not overwrite B's saved library tab.
        await page.getByRole("button", { name: "查看 Bot 详情", exact: true }).click()
        assert.equal(
          await page.getByRole("tab", { name: "详情", exact: true }).getAttribute("aria-selected"),
          "true"
        )
        await selectView(a.conversationId, a.bot.name)
        await selectView(b.conversationId, b.bot.name)
        assert.equal(
          await page
            .getByRole("tab", { name: "资料库", exact: true })
            .getAttribute("aria-selected"),
          "true"
        )
        // Header Computer reveals are likewise transient across owner changes.
        await page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
        assert.equal(
          await page.getByRole("tab", { name: "电脑", exact: true }).getAttribute("aria-selected"),
          "true"
        )
        await selectView(a.conversationId, a.bot.name)
        await selectView(directBranch, a.bot.name)
        assert.equal(
          await page.getByRole("tab", { name: "电脑", exact: true }).getAttribute("aria-selected"),
          "true"
        )
        await selectView(b.conversationId, b.bot.name)
        assert.equal(
          await page
            .getByRole("tab", { name: "资料库", exact: true })
            .getAttribute("aria-selected"),
          "true"
        )
        await closeInspector()
      }
    )

    await check(
      "a replaced backend data epoch retires the old computer even when Bot and conversation IDs survive",
      async () => {
        await openComputer(a.conversationId, a.bot.name)
        await takeComputer()
        await page.getByLabel("向浏览器输入文本", { exact: true }).fill("OLD-EPOCH")
        const oldInput = await page
          .getByRole("button", { name: "输入", exact: true })
          .elementHandle()
        assert.ok(oldInput)
        const oldFrame = await client.call("computerFrame", a.bot.id)
        const epoch = `fixture-restored-${randomBytes(12).toString("hex")}`
        try {
          // Controlled data-replacement boundary only. This is the durable marker
          // that the real refresh reads, not a fake renderer snapshot or full restore.
          store.transaction(() =>
            store.db.run(
              "INSERT INTO bot_events(kind,entity_id,payload,created_at) VALUES(?,?,?,?)",
              [
                "workspace.restored",
                epoch,
                JSON.stringify({ fixture: "navigation-only" }),
                store.now()
              ]
            )
          )
          computer.invalidateObservations()
          const before = inputCalls().length
          await refresh()
          await page.waitForFunction(
            (expected) =>
              (
                window as unknown as {
                  fixtureWorkspace: { getState(): { snapshot: { dataEpoch: string } | null } }
                }
              ).fixtureWorkspace.getState().snapshot?.dataEpoch === expected,
            epoch
          )
          await page.locator(".bot-inspector-panel").waitFor({ state: "detached" })
          assert.equal(await oldInput.evaluate((node) => node.isConnected), false)
          await oldInput.evaluate((node) => (node as HTMLButtonElement).click())
          assert.equal(inputCalls().length, before)
          assert.equal(store.getBot(a.bot.id).id, a.bot.id)
          assert.equal(store.getConversation(a.conversationId).id, a.conversationId)
          await assert.rejects(
            client.call("computerInput", {
              target: oldFrame,
              input: { kind: "text", text: "OLD-EPOCH", frameSeq: oldFrame.frameSeq }
            }),
            (error: unknown) => {
              const code = (error as { code?: string }).code
              return code === "stale_target" || code === "stale_frame"
            }
          )
          // Navigation after the replacement cannot silently reacquire a computer.
          await selectView(b.conversationId, b.bot.name)
          await selectView(a.conversationId, a.bot.name)
          assert.equal(await page.locator(".bot-inspector-panel").count(), 0)
          await openComputer(a.conversationId, a.bot.name)
          await returnComputer()
          await closeInspector()
        } finally {
          await oldInput.dispose()
        }
      }
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    holdNextFrameFor = null
    for (const release of heldFrames.splice(0)) release()
    holdRoutineAck = false
    for (const release of heldRoutineAcks.splice(0)) release()
    holdStartAck = false
    for (const release of heldStartAcks.splice(0)) release()
    holdStatus = false
    for (const release of heldStatuses.splice(0)) release()
    console.log("TEARDOWN ui-browser")
    await browser?.close()
    console.log("TEARDOWN fixture-http")
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    console.log("TEARDOWN authenticated-client")
    client.close()
    await rpc.close()
    console.log("TEARDOWN host")
    await host.stop()
    console.log("TEARDOWN teach")
    await teach.close()
    console.log("TEARDOWN native-browser")
    await computer.shutdown()
    console.log("TEARDOWN sqlite-and-lock")
    store.close()
    lock.release()
    await writeFile(
      join(output, "result.json"),
      JSON.stringify({ source, directory, cases, failures, pageErrors, calls }, null, 2)
    )
  }
  assert.deepEqual(failures, [])
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
