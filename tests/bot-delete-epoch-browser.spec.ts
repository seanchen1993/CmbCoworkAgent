import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Real Workspace delete confirmation UI, original draft/navigation store and authenticated
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
  const source = resolve(process.env.CMB_DELETE_UI_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-delete-confirmation-ui-"))
  const output = resolve(process.env.CMB_DELETE_UI_OUTPUT ?? "output/bot-delete-epoch")
  await mkdir(output, { recursive: true })
  let store = new BotStore(join(directory, "bots.sqlite"))
  const a = store.createBot({ nonce: "a", name: "确认删除助手" })
  const b = store.createBot({ nonce: "b", name: "换代删除助手" })
  let supportsDeleteEpoch = false
  let holdDelete = false
  let observedDelete: (() => void) | undefined
  let releaseDelete: (() => void) | undefined
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
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botShellResources:{inspect:async()=>({mode:'exclusive',review:{state:'ready',reason:'none',entries:[],title:'命令现场已核对',hint:'没有未确认关闭的命令现场。'}})}};window.fixtureWorkspace=useBotWorkspaceStore;window.fixtureRefresh=()=>useBotWorkspaceStore.getState().refresh();useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},selected:${JSON.stringify(a.conversationId)}});useBotWorkspaceStore.getState().draft(${JSON.stringify(a.conversationId)},'确认草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(b.conversationId)},'换代草稿');createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><BotWorkspace/><Toaster/></div>);`
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
      calls.push({
        method,
        input: input === undefined ? undefined : JSON.parse(JSON.stringify(input))
      })
      if (method === "status") {
        const status = await client.call("status")
        return {
          ...status,
          capabilities: supportsDeleteEpoch
            ? status.capabilities
            : status.capabilities?.filter((value) => value !== "bot-delete-epoch")
        }
      }
      if (method === "delete" && holdDelete) {
        const waiting = new Promise<void>((resolve) => {
          releaseDelete = resolve
        })
        observedDelete?.()
        await waiting
      }
      try {
        return await client.call(method as Parameters<BotTransportClient["call"]>[0], input)
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
    await page.goto(`http://127.0.0.1:${address.port}`)
    await page.getByRole("heading", { name: a.bot.name, level: 2 }).waitFor()
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
    const refresh = () =>
      page.evaluate(() =>
        (window as unknown as { fixtureRefresh(): Promise<void> }).fixtureRefresh()
      )
    const select = (id: string) =>
      page.evaluate(
        (id) =>
          (
            window as unknown as { fixtureWorkspace: { getState(): { select(id: string): void } } }
          ).fixtureWorkspace
            .getState()
            .select(id),
        id
      )
    const openDelete = async () => {
      await page.getByRole("button", { name: "更多 Bot 操作", exact: true }).click()
      await page.getByRole("menuitem", { name: "删除 Bot", exact: true }).click()
    }
    await check("an unsupported Host cannot accept a destructive confirmation", async () => {
      await openDelete()
      await page.getByText("请先重启最新后台，再删除 Bot。", { exact: true }).waitFor()
      assert.equal(await page.getByRole("dialog").count(), 0)
      assert.equal(calls.filter((call) => call.method === "delete").length, 0)
      assert.equal(store.getBot(a.bot.id).deletedAt, null)
    })
    // Test setup retires a baseline's unexpected confirmation; not a product PASS.
    await page.keyboard.press("Escape")
    supportsDeleteEpoch = true
    await refresh()
    await check(
      "confirmation submits the reviewed original epoch through authenticated RPC",
      async () => {
        await openDelete()
        const dialog = page.getByRole("dialog", { name: `删除 ${a.bot.name}？`, exact: true })
        await dialog.getByRole("button", { name: "删除 Bot", exact: true }).click()
        await page.waitForFunction(
          (id) =>
            !(
              window as unknown as {
                fixtureWorkspace: { getState(): { snapshot: { bots: { id: string }[] } } }
              }
            ).fixtureWorkspace
              .getState()
              .snapshot.bots.some((bot) => bot.id === id),
          a.bot.id
        )
        const request = calls.find((call) => call.method === "delete")!.input as {
          id: string
          revision: number
          expectedDataEpoch?: string
        }
        assert.deepEqual(request, {
          id: a.bot.id,
          revision: a.bot.revision,
          expectedDataEpoch: "initial"
        })
        assert.ok(store.getBot(a.bot.id, true).deletedAt)
        assert.equal(calls.filter((call) => call.method === "send").length, 0)
      }
    )
    await select(b.conversationId)
    await page.getByRole("heading", { name: b.bot.name, level: 2 }).waitFor()
    await check(
      "a delayed confirmation cannot delete a replacement workspace with the same Bot revision",
      async () => {
        await openDelete()
        holdDelete = true
        const admitted = new Promise<void>((resolve) => {
          observedDelete = resolve
        })
        const clicking = page
          .getByRole("dialog", { name: `删除 ${b.bot.name}？`, exact: true })
          .getByRole("button", { name: "删除 Bot", exact: true })
          .click()
        await admitted
        await clicking
        const captured = calls.filter((call) => call.method === "delete").at(-1)!.input
        const oldHostId = host.id
        client.close()
        await rpc.close()
        await host.stop()
        store.close()
        const restoredPath = join(directory, "restored.sqlite")
        await copyFile(join(directory, "bots.sqlite"), restoredPath)
        const ledger = new BotDeletionLedger(join(directory, "bots.sqlite"))
        try {
          fenceBotCheckpointDatabase(restoredPath, "delete-ui-replacement", ledger)
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
        assert.notEqual(host.id, oldHostId)
        assert.equal(store.getBot(b.bot.id).revision, b.bot.revision)
        const before = JSON.stringify(store.db.exec("SELECT * FROM bot_events ORDER BY cursor"))
        releaseDelete?.()
        holdDelete = false
        await refresh()
        await page.getByText("工作区数据已恢复，请重新打开并核对原操作", { exact: true }).waitFor()
        assert.equal(store.getBot(b.bot.id).deletedAt, null)
        assert.equal(
          JSON.stringify(store.db.exec("SELECT * FROM bot_events ORDER BY cursor")),
          before
        )
        assert.deepEqual(captured, {
          id: b.bot.id,
          revision: b.bot.revision,
          expectedDataEpoch: "initial"
        })
        assert.equal(await page.getByRole("dialog").count(), 0)
        await select(b.conversationId)
        await page.getByRole("heading", { name: b.bot.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "换代草稿")
        await openDelete()
        await page
          .getByRole("dialog", { name: `删除 ${b.bot.name}？`, exact: true })
          .getByRole("button", { name: "删除 Bot", exact: true })
          .click()
        await page.waitForFunction(
          (id) =>
            !(
              window as unknown as {
                fixtureWorkspace: { getState(): { snapshot: { bots: { id: string }[] } } }
              }
            ).fixtureWorkspace
              .getState()
              .snapshot.bots.some((bot) => bot.id === id),
          b.bot.id
        )
        assert.deepEqual(calls.filter((call) => call.method === "delete").at(-1)!.input, {
          id: b.bot.id,
          revision: b.bot.revision,
          expectedDataEpoch: "delete-ui-replacement"
        })
        assert.equal(
          calls.filter((call) => call.method === "send" || call.method === "create").length,
          0
        )
        await writeFile(
          join(output, "epoch-hosts.json"),
          JSON.stringify(
            {
              oldHostId,
              replacementHostId: host.id,
              captured,
              scope:
                "two Host objects in one Node process; real SQLite staging fence and authenticated sockets; bridge intentionally delays original input"
            },
            null,
            2
          )
        )
      }
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    releaseDelete?.()
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
