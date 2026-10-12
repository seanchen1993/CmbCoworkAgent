import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Real Workspace/Member UI, original draft/navigation store and authenticated
 * SQLite RPC. Outer desktop AppStore is controlled; no model or platform proof. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
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
import { BotDeletionLedger } from "../src/main/bots/deletion-ledger"
import { fenceBotCheckpointDatabase } from "../src/main/bots/checkpoint-data"
import { BOT_PROTOCOL_VERSION } from "../src/shared/bot-types"

async function main() {
  const source = resolve(process.env.CMB_GROUP_UI_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-group-members-ui-"))
  const output = resolve(process.env.CMB_GROUP_UI_OUTPUT ?? "output/bot-group-member-lifecycle")
  await mkdir(output, { recursive: true })
  let store = new BotStore(join(directory, "bots.sqlite"))
  const a = store.createBot({ nonce: "a", name: "项目助手" })
  const b = store.createBot({ nonce: "b", name: "质量助手" })
  const replacement = store.createBot({ nonce: "replacement", name: "替补助手" })
  const group = store.createGroup({
    nonce: "group",
    name: "成员导航群",
    members: [a.bot.id, b.bot.id]
  })
  const history = store.send({
    nonce: "history",
    conversationId: group.id,
    text: "群聊历史证据",
    recipients: [a.bot.id]
  })
  const historical = store.claim("fixture")!
  store.toolOnce(historical.lease, "history", {}, () =>
    store.groups.post(historical.lease, "已完成的群聊答复")
  )
  store.finish(historical.lease, "succeeded", "Completed")
  store.cancel(history.runIds[0])
  let host = new BotHost(store)
  const token = randomBytes(32).toString("hex")
  let rpc = new BotRpcServer(host, token)
  const socketPath =
    process.platform === "win32"
      ? `\\\\.\\pipe\\cmb-group-${token.slice(0, 16)}`
      : join(directory, "rpc.sock")
  let client = new BotTransportClient({
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
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botShellResources:{inspect:async()=>({mode:'exclusive',review:{state:'ready',reason:'none',entries:[],title:'命令现场已核对',hint:'没有未确认关闭的命令现场。'}})}};window.fixtureWorkspace=useBotWorkspaceStore;window.fixtureRefresh=()=>useBotWorkspaceStore.getState().refresh();useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},selected:${JSON.stringify(group.id)}});useBotWorkspaceStore.getState().draft(${JSON.stringify(a.conversationId)},'个人未发送草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(group.id)},'群聊未发送草稿');createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><BotWorkspace/><Toaster/></div>);`
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
      if (request.url === "/workspace.js") {
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
      calls.push({ method, input })
      return client.call(method as Parameters<BotTransportClient["call"]>[0], input)
    })
    const address = server.address()
    assert.ok(address && typeof address !== "string")
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
    const check = async (name: string, task: () => Promise<void>) => {
      try {
        await task()
        cases.push(name)
        console.log(`PASS ${name}`)
      } catch (error) {
        failures.push({ name, message: error instanceof Error ? error.message : String(error) })
        console.error(`FAIL ${name}: ${failures.at(-1)?.message}`)
      }
    }
    await check(
      "member click uses original personal chat navigation and preserves both drafts without dispatch",
      async () => {
        const before = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
        await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
        const details = page.getByRole("complementary", {
          name: `${group.name} 的详情`,
          exact: true
        })
        await details.getByRole("tab", { name: "成员", exact: true }).click()
        await details
          .getByRole("button", { name: /^(?:查看|打开) 项目助手 的(?:详情|聊天)$/ })
          .click()
        await page.waitForFunction(
          (id) =>
            (
              window as unknown as { fixtureWorkspace: { getState(): { selected: string } } }
            ).fixtureWorkspace.getState().selected === id,
          a.conversationId
        )
        await page.getByRole("heading", { name: a.bot.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "个人未发送草稿")
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          "向 Bot 交办工作"
        )
        await page
          .locator(".bot-sidebar")
          .getByRole("button", { name: group.name, exact: true })
          .click()
        await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "群聊未发送草稿")
        assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), before)
        assert.equal(
          calls.filter((item) => item.method === "send" || item.method === "create").length,
          0
        )
        await page.screenshot({ path: join(output, "member-chat.png"), animations: "disabled" })
      }
    )
    // Explicit fixture recovery keeps later assertions independent from a failed
    // old navigation callback; it is not counted as product navigation success.
    await page.evaluate(
      (id) =>
        (
          window as unknown as { fixtureWorkspace: { getState(): { select(id: string): void } } }
        ).fixtureWorkspace
          .getState()
          .select(id),
      group.id
    )
    await check(
      "real restored epoch retires the old member DOM and fresh navigation retains plain drafts without dispatch",
      async () => {
        await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
        const details = page.getByRole("complementary", {
          name: `${group.name} 的详情`,
          exact: true
        })
        await details.getByRole("tab", { name: "成员", exact: true }).click()
        await details
          .getByRole("button", { name: /^(?:查看|打开) 项目助手 的(?:详情|聊天)$/ })
          .evaluate((node) => {
            ;(window as unknown as { fixtureOldMember: HTMLElement }).fixtureOldMember =
              node as HTMLElement
          })
        client.close()
        await rpc.close()
        await host.stop()
        store.close()
        const restoredPath = join(directory, "restored.sqlite")
        await copyFile(join(directory, "bots.sqlite"), restoredPath)
        const ledger = new BotDeletionLedger(join(directory, "bots.sqlite"))
        try {
          fenceBotCheckpointDatabase(restoredPath, "member-ui-replacement", ledger)
        } finally {
          ledger.close()
        }
        store = new BotStore(restoredPath)
        host = new BotHost(store)
        rpc = new BotRpcServer(host, token)
        await rpc.listen(socketPath)
        client = new BotTransportClient({
          version: BOT_PROTOCOL_VERSION,
          hostId: host.id,
          pid: process.pid,
          socketPath,
          token
        })
        await page.evaluate(() =>
          (window as unknown as { fixtureRefresh(): Promise<void> }).fixtureRefresh()
        )
        await page.waitForFunction(
          () =>
            (
              window as unknown as {
                fixtureWorkspace: { getState(): { snapshot: { dataEpoch: string } } }
              }
            ).fixtureWorkspace.getState().snapshot?.dataEpoch === "member-ui-replacement"
        )
        await page.evaluate(
          (id) =>
            (
              window as unknown as {
                fixtureWorkspace: { getState(): { select(id: string): void } }
              }
            ).fixtureWorkspace
              .getState()
              .select(id),
          group.id
        )
        await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
        assert.equal(
          await page.evaluate(
            () =>
              (window as unknown as { fixtureOldMember: HTMLElement }).fixtureOldMember.isConnected
          ),
          false
        )
        await page.evaluate(() =>
          (window as unknown as { fixtureOldMember: HTMLElement }).fixtureOldMember.click()
        )
        assert.equal(
          await page.evaluate(
            () =>
              (
                window as unknown as { fixtureWorkspace: { getState(): { selected: string } } }
              ).fixtureWorkspace.getState().selected
          ),
          group.id
        )
        const before = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
        await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
        await details.getByRole("tab", { name: "成员", exact: true }).click()
        await details
          .getByRole("button", { name: /^(?:查看|打开) 项目助手 的(?:详情|聊天)$/ })
          .click()
        await page.waitForFunction(
          (id) =>
            (
              window as unknown as { fixtureWorkspace: { getState(): { selected: string } } }
            ).fixtureWorkspace.getState().selected === id,
          a.conversationId
        )
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "个人未发送草稿")
        await page
          .locator(".bot-sidebar")
          .getByRole("button", { name: group.name, exact: true })
          .click()
        await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "群聊未发送草稿")
        assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), before)
        assert.equal(
          calls.filter((item) => item.method === "send" || item.method === "create").length,
          0
        )
      }
    )
    await check(
      "last member deletion keeps readable group history and the original picker can add one replacement",
      async () => {
        const expectedDataEpoch = store.snapshot().dataEpoch
        await client.call("delete", { id: a.bot.id, revision: a.bot.revision, expectedDataEpoch })
        await client.call("delete", { id: b.bot.id, revision: b.bot.revision, expectedDataEpoch })
        await page.evaluate(() =>
          (window as unknown as { fixtureRefresh(): Promise<void> }).fixtureRefresh()
        )
        await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
        assert.deepEqual(store.getConversation(group.id).members, [])
        await page.getByText("群聊历史证据", { exact: true }).waitFor()
        assert.ok(store.messages(group.id).some((message) => message.botId === a.bot.id))
        await page.getByRole("button", { name: "查看群聊详情", exact: true }).click()
        const details = page.getByRole("complementary", {
          name: `${group.name} 的详情`,
          exact: true
        })
        await details.getByRole("tab", { name: "成员", exact: true }).click()
        assert.equal(
          await details
            .getByRole("list", { name: "群聊成员", exact: true })
            .getByRole("button")
            .count(),
          0
        )
        await details.getByRole("button", { name: "添加成员", exact: true }).click()
        await page
          .getByRole("button", { name: `添加 ${replacement.bot.name}`, exact: true })
          .click()
        await page.waitForFunction((id) => {
          const s = (
            window as unknown as {
              fixtureWorkspace: {
                getState(): { snapshot: { conversations: { id: string; members: string[] }[] } }
              }
            }
          ).fixtureWorkspace.getState()
          return s.snapshot.conversations.find((item) => item.id === id)?.members.length === 1
        }, group.id)
        assert.deepEqual(store.getConversation(group.id).members, [replacement.bot.id])
        assert.equal(store.getConversation(group.id).revision, group.revision + 3)
        assert.equal(
          calls.filter((item) => item.method === "send" || item.method === "create").length,
          0
        )
        await page.screenshot({
          path: join(output, "empty-group-replacement.png"),
          animations: "disabled"
        })
      }
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser?.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    client.close()
    await rpc.close()
    await host.stop()
    store.close()
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
