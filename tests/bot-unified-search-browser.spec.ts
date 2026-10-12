import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Real unified Workspace search UI, original draft/navigation store and authenticated
 * SQLite RPC. Outer desktop AppStore is controlled; no model or platform proof. */
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
import { BOT_PROTOCOL_VERSION } from "../src/shared/bot-types"

async function main() {
  const source = resolve(process.env.CMB_SEARCH_UI_SOURCE ?? ".")
  const renderer = join(source, "src/renderer/src")
  const directory = await mkdtemp(join(tmpdir(), "cmb-unified-search-ui-"))
  const output = resolve(process.env.CMB_SEARCH_UI_OUTPUT ?? "output/bot-unified-search")
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
  let supportsContentSearch = false
  const host = new BotHost(store)
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
        contents: `import React from'react';import{createRoot}from'react-dom/client';import{Toaster}from'sonner';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore}from'@/lib/bot-workspace-store';import{applyThemePreference}from'@/lib/theme-preference';applyThemePreference('codex-light');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botShellResources:{inspect:async()=>({mode:'exclusive',review:{state:'ready',reason:'none',entries:[],title:'命令现场已核对',hint:'没有未确认关闭的命令现场。'}})}};window.fixtureTheme=applyThemePreference;window.fixtureWorkspace=useBotWorkspaceStore;window.fixtureRefresh=()=>useBotWorkspaceStore.getState().refresh();useBotWorkspaceStore.setState({snapshot:${JSON.stringify(store.snapshot())},selected:${JSON.stringify(a.conversationId)}});useBotWorkspaceStore.getState().draft(${JSON.stringify(a.conversationId)},'研发草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(b.conversationId)},'质量草稿');useBotWorkspaceStore.getState().draft(${JSON.stringify(group.id)},'群聊草稿');createRoot(document.getElementById('root')).render(<div style={{height:'100vh',display:'flex'}}><BotWorkspace/><Toaster/></div>);`
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
          capabilities: supportsContentSearch
            ? status.capabilities
            : status.capabilities?.filter((value) => value !== "content-search")
        }
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
    // Reuse the original full Workspace fixture's emitted component stylesheet admission.
    for (const asset of bundle.outputFiles)
      if (asset.path.endsWith(".css")) await page.addStyleTag({ content: asset.text })
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
    const closePalette = async () => {
      await page.keyboard.press("Escape")
    }
    const openKeyboardPalette = async () => {
      await page.getByLabel("向 Bot 交办工作", { exact: true }).focus()
      await page.keyboard.press("Control+k")
      await page.getByRole("dialog", { name: "快速查找与操作", exact: true }).waitFor()
    }
    const palette = page.getByRole("dialog", { name: "快速查找与操作", exact: true })
    const input = palette.getByRole("combobox")
    const unchangedRuns = JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs"))
    await check(
      "the top search opens unified local navigation even on a Host without content search",
      async () => {
        await page.getByRole("button", { name: "搜索工作区", exact: true }).click()
        await palette.waitFor()
        await palette.getByRole("option").filter({ hasText: a.bot.name }).first().waitFor()
        await palette.getByRole("tab", { name: "消息", exact: true }).click()
        await palette
          .getByRole("alert")
          .getByText("当前后台不支持内容搜索，请更新后台后再试", { exact: true })
          .waitFor()
        assert.equal(calls.filter((call) => call.method === "search").length, 0)
        await closePalette()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "研发草稿")
        supportsContentSearch = true
        await refresh()
        await page.getByRole("button", { name: "搜索工作区", exact: true }).click()
        await palette.waitFor()
        await closePalette()
      }
    )
    await closePalette()
    supportsContentSearch = true
    await refresh()
    await check(
      "the palette renders original colored Bot and group avatars with consistent action tiles",
      async () => {
        await openKeyboardPalette()
        await page.screenshot({ path: join(output, "palette-light.png"), animations: "disabled" })
        await page.evaluate(() =>
          (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-dark")
        )
        await page.screenshot({ path: join(output, "palette-dark.png"), animations: "disabled" })
        await page.setViewportSize({ width: 520, height: 800 })
        const bounds = await palette.boundingBox()
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 520)
        await page.screenshot({ path: join(output, "palette-narrow.png"), animations: "disabled" })
        await page.emulateMedia({ reducedMotion: "reduce" })
        await page.screenshot({ path: join(output, "palette-reduced.png"), animations: "disabled" })
        const originalRow = palette.getByRole("option").filter({ hasText: a.bot.name }).first()
        assert.equal(
          await originalRow
            .locator('[data-avatar-color="red"][data-avatar-shape="teardrop"]')
            .count(),
          1
        )
        const groupRow = palette.getByRole("option").filter({ hasText: group.name }).first()
        assert.equal(
          await groupRow.locator('[data-avatar-kind="group"][data-member-count="2"]').count(),
          1
        )
        assert.equal(await groupRow.locator('[data-avatar-color="red"]').count(), 1)
        assert.equal(await groupRow.locator('[data-avatar-color="blue"]').count(), 1)
        const actionRow = palette.getByRole("option").filter({ hasText: "本机项目访问" }).first()
        assert.equal(await actionRow.locator("span.bg-muted").count(), 1)
        assert.equal(await actionRow.locator(".sand-agent-avatar").count(), 0)
      }
    )
    await closePalette()
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await page.evaluate(() =>
      (window as unknown as { fixtureTheme(theme: string): void }).fixtureTheme("codex-light")
    )
    await check(
      "original palette navigation retains direct and group drafts and reveals hidden identities without dispatch",
      async () => {
        await openKeyboardPalette()
        await input.fill(group.name)
        await input.press("Enter")
        await page.getByRole("heading", { name: group.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "群聊草稿")
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          "向 Bot 交办工作"
        )
        await openKeyboardPalette()
        await input.fill(a.bot.name)
        await input.press("Enter")
        await page.getByRole("heading", { name: a.bot.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "研发草稿")
        await openKeyboardPalette()
        assert.equal(
          await palette.getByRole("option").filter({ hasText: hidden.bot.name }).count(),
          0
        )
        await input.fill(hidden.bot.name)
        const hiddenRow = palette.getByRole("option").filter({ hasText: hidden.bot.name }).first()
        await hiddenRow.getByText("隐藏", { exact: true }).waitFor()
        await closePalette()
        assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), unchangedRuns)
        assert.equal(
          calls.filter((call) => call.method === "send" || call.method === "create").length,
          0
        )
      }
    )
    await closePalette()
    await check(
      "explicit sidebar filtering preserves original pinned order and keyboard navigation then clears with Escape",
      async () => {
        assert.equal(await page.getByRole("textbox", { name: "搜索 Bot", exact: true }).count(), 0)
        const pins = store.snapshot().pinnedOrder!.ids
        await openKeyboardPalette()
        await input.fill("筛选 Bot 列表")
        await input.press("Enter")
        const filter = page.getByRole("textbox", { name: "搜索 Bot", exact: true })
        await filter.waitFor()
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          "搜索 Bot"
        )
        const row = page
          .getByRole("navigation", { name: "Bot 和群聊", exact: true })
          .getByRole("button", { name: b.bot.name, exact: true })
        await filter.fill(b.bot.name)
        for (const event of [{ isComposing: true }, { keyCode: 229 }])
          await filter.evaluate(
            (element, init) =>
              element.dispatchEvent(
                new KeyboardEvent("keydown", {
                  key: "Escape",
                  ...init,
                  bubbles: true,
                  cancelable: true
                })
              ),
            event
          )
        assert.equal(await filter.inputValue(), b.bot.name)
        assert.equal(await filter.count(), 1)
        assert.equal(await row.getAttribute("data-pinned"), null)
        await filter.press("Control+1")
        await page.getByRole("heading", { name: b.bot.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "质量草稿")
        await filter.press("Escape")
        assert.equal(await filter.count(), 0)
        assert.equal(await row.getAttribute("data-pinned"), "true")
        assert.deepEqual(store.snapshot().pinnedOrder!.ids, pins)
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          "搜索工作区"
        )
        await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
        await page.getByRole("menuitem", { name: "筛选 Bot 列表", exact: true }).click()
        await filter.fill("没有匹配")
        await page.getByRole("button", { name: "清除列表筛选", exact: true }).click()
        assert.equal(await filter.count(), 0)
        assert.deepEqual(store.snapshot().pinnedOrder!.ids, pins)
        await page.getByRole("button", { name: "工作区菜单", exact: true }).click()
        await page.getByRole("menuitem", { name: "显示隐藏的 Bot", exact: true }).click()
        await page
          .getByRole("navigation", { name: "Bot 和群聊", exact: true })
          .getByRole("button", { name: hidden.bot.name, exact: true })
          .waitFor()
      }
    )
    await closePalette()
    await check(
      "the existing bounded domain search still opens the original precise message and preserves its draft",
      async () => {
        await openKeyboardPalette()
        await palette.getByRole("tab", { name: "消息", exact: true }).click()
        await input.fill("搜索定位原始证据")
        await palette.getByRole("option").filter({ hasText: "搜索定位原始证据" }).click()
        await page.locator(`[data-message-id="${history.messageId}"]`).waitFor()
        await page.getByRole("heading", { name: a.bot.name, level: 2 }).waitFor()
        assert.equal(await page.getByLabel("向 Bot 交办工作").innerText(), "研发草稿")
        assert.equal(JSON.stringify(store.db.exec("SELECT id,status FROM bot_runs")), unchangedRuns)
        assert.equal(
          calls.filter((call) => call.method === "send" || call.method === "create").length,
          0
        )
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
