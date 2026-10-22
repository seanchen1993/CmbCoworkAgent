/** Real React navigation against the real main-process manager with a deterministic model. */
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { NativeSqliteAdapter } from "../src/main/db/native-sqlite-adapter"
import { DesignSessionStore } from "../src/main/services/design/session-store"
import { DesignRunManager } from "../src/main/services/design/run-manager"
import {
  createDesignState,
  type DesignRunEvent,
  type DesignSessionChange
} from "../src/shared/managed-design-session"

const bundle = await build({
  stdin: {
    contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { DesignView } from './src/renderer/src/components/design/DesignView';
    function Fixture() {
      const [show, setShow] = useState(true);
      return <><button id="toggle-mode" onClick={() => setShow(!show)}>切换模式</button>
        <div style={{height:'900px'}}>{show ? <DesignView/> : <div>其他模式</div>}</div></>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  `,
    resolveDir: process.cwd(),
    loader: "tsx"
  },
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  jsx: "automatic",
  alias: { "@": resolve("src/renderer/src") },
  define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"test"' },
  plugins: [
    {
      name: "fixture-app-store",
      setup(builder) {
        builder.onLoad({ filter: /\/lib\/store\.ts$/ }, () => ({
          contents: `const state={loadModels:async()=>{},loadProviders:async()=>{}}; export function useAppStore(select){return select?select(state):state;}`,
          loader: "js"
        }))
      }
    }
  ]
})
const server = createServer((_request, response) => {
  response.setHeader(
    "Content-Type",
    _request.url === "/app.js" ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8"
  )
  response.end(
    _request.url === "/app.js"
      ? bundle.outputFiles[0].contents
      : '<div id="root"></div><script src="/app.js"></script>'
  )
})
await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady))
const address = server.address() as { port: number }
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined
})
const db = new NativeSqliteAdapter(new DatabaseSync(":memory:"))
const emitters: Array<(event: DesignRunEvent) => void> = []
const completions: Array<() => void> = []
let aborted = 0
let deliver: (change: DesignSessionChange) => void = () => undefined
const subscriptions = new Set<string>()
const manager = new DesignRunManager(new DesignSessionStore(db), {
  execute: (_request, _id, emit) => {
    emitters.push(emit)
    return new Promise<void>((done) => completions.push(done))
  },
  abort: () => {
    aborted++
  },
  finalize: (event) => ({ ...event, artifactPath: "/workspace/design.html" }),
  publish: (change) =>
    deliver(subscriptions.has(change.id) ? change : { ...change, snapshot: undefined })
})
manager.create({
  id: "ds_browser",
  meta: { id: "ds_browser", title: "浏览器回归", createdAt: 1, updatedAt: 1 },
  state: { ...createDesignState(), selectedModelId: "custom:test" },
  workspacePath: "/workspace"
})
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors: string[] = []
  page.setDefaultTimeout(10000)
  page.on("console", (message) => {
    if (message.type() === "error") console.log("BROWSER", message.text())
  })
  page.on("pageerror", (error) => errors.push(error.message))
  await page.exposeFunction("designRpc", (method: string, ...args: unknown[]) => {
    const id = String(args[0])
    if (method === "list") return manager.list()
    if (method === "migrate") return manager.migrate(args[0] as never)
    if (method === "open") {
      subscriptions.add(id)
      return manager.get(id)
    }
    if (method === "close") {
      subscriptions.delete(id)
      return
    }
    if (method === "patch") return manager.patch(id, args[1] as never, args[2] as never)
    if (method === "start") return manager.start(args[0] as never)
    if (method === "setWorkspace") return manager.setWorkspace(id, String(args[1]))
    if (method === "stop") return manager.stop(id)
    if (method === "retry") return manager.retry(id, String(args[1]))
    if (method === "markRead") return manager.markRead(id, Number(args[1]))
    if (method === "delete") return manager.remove(id)
    if (method === "create") return manager.create(args[0] as never)
    throw new Error(`Unknown RPC ${method}`)
  })
  deliver = (change) => {
    void page
      .evaluate(
        (payload) => (window as unknown as { deliver: (event: unknown) => void }).deliver(payload),
        change
      )
      .catch(() => undefined)
  }
  await page.addInitScript(() => {
    localStorage.setItem("design_last_session", "ds_browser")
    const listeners = new Set<(event: unknown) => void>()
    ;(window as unknown as { deliver: (event: unknown) => void }).deliver = (event) => {
      for (const callback of listeners) callback(event)
    }
    const rpc = (method: string, ...args: unknown[]) =>
      (window as unknown as { designRpc: (...args: unknown[]) => Promise<unknown> }).designRpc(
        method,
        ...args
      )
    const sessions = Object.fromEntries(
      [
        "list",
        "migrate",
        "open",
        "close",
        "patch",
        "start",
        "stop",
        "retry",
        "delete",
        "markRead",
        "create",
        "setWorkspace"
      ].map((method) => [method, (...args: unknown[]) => rpc(method, ...args)])
    )
    sessions.onChange = (callback: (event: unknown) => void) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    }
    ;(window as unknown as { api: unknown }).api = {
      design: {
        sessions,
        listSystems: async () => [],
        listTemplates: async () => [],
        storeHtml: async () => ({ ok: true })
      },
      skills: { list: async () => [], listPlugins: async () => [], getDisabled: async () => [] },
      models: {
        list: async () => [{ id: "custom:test", name: "Test", model: "test", available: true }]
      },
      workspace: { get: async () => "/workspace" },
      file: {
        readText: async () => ({ success: false }),
        readDataUrl: async () => ({ success: false })
      }
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}`)
  const input = page.locator("textarea").first()
  await input.waitFor()
  await input.fill("直接生成一个测试页面")
  await page.getByRole("button", { name: "▶ 发送", exact: true }).click()
  await page
    .getByRole("button", { name: "■ 停止", exact: true })
    .waitFor()
    .catch(async (error) => {
      console.log("BODY", (await page.locator("body").innerText()).slice(-1800))
      console.log("STATE", JSON.stringify(manager.get("ds_browser")).slice(0, 1200))
      throw error
    })
  await new Promise<void>((done) => setTimeout(done, 200))
  assert.equal(emitters.length, 1)
  emitters[0]({ type: "token", token: "离开前的消息。" })
  await page.getByText("离开前的消息。", { exact: true }).waitFor()
  await page.getByTitle("返回历史记录").click()
  await page.getByText("My Designs", { exact: true }).waitFor()
  emitters[0]({ type: "token", token: "离开期间新增的消息。" })
  await new Promise<void>((done) => setTimeout(done, 150))
  assert.equal(aborted, 0)
  await page.getByTitle("直接生成一个测试页面", { exact: true }).click()
  await page.getByText("离开前的消息。离开期间新增的消息。", { exact: true }).waitFor()
  assert.equal(await page.getByRole("button", { name: "■ 停止", exact: true }).count(), 1)
  await page.locator("#toggle-mode").click()
  emitters[0]({
    type: "execution",
    event: {
      kind: "validation",
      content: "后台验证已完成",
      status: "success",
      timestamp: Date.now()
    }
  })
  emitters[0]({
    type: "done",
    html: "<!doctype html><html><body><h1>后台完成的设计</h1></body></html>"
  })
  completions[0]()
  await page.locator("#toggle-mode").click()
  await page.getByText("✓ 设计已生成", { exact: true }).waitFor()
  await page.getByText("后台验证已完成", { exact: true }).waitFor()
  await page.frameLocator("iframe").first().getByText("后台完成的设计", { exact: true }).waitFor()
  assert.equal(aborted, 0)
  assert.equal(emitters.length, 1, "reopening must not rerun the model")
  assert.deepEqual(errors, [])
  console.log(
    "PASS: return/reopen, background messages, mode unmount, final transcript and preview"
  )
} finally {
  await browser.close()
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done()))
  )
  db.close()
}
