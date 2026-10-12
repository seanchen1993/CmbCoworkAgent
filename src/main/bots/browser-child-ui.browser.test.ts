/** Real React/task history, SQLite, authenticated RPC and independent Chrome pages.
 * The context-bridge reply loss/delay is controlled; no model or OS desktop is exercised. */
import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { build } from "esbuild"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser, type Page } from "playwright"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotWorkflowStore } from "./workflow-store"
import { prepareBotWorkflow } from "./workflow-tool"
import { BOT_BACKGROUND_TASK_SCRIPT, backgroundTaskInput } from "./background-task-input"
import { writeBotModelSnapshot } from "./model-config"
import { serializeBotFailure } from "./error-diagnostic"
import type { BotRunAddress } from "../../shared/bot-run-history"
import type { BotBrowserFrame } from "../../shared/bot-computer"

const enabled = process.env.CMB_BROWSER_CHILD_UI_TEST === "1"
let browser: Browser
let fixtureBundle: string
let fixtureCss: string
beforeAll(async () => {
  if (!enabled) return
  const renderer = resolve("src/renderer/src")
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
  fixtureCss =
    css.build(scanner.scan()) +
    "\n" +
    (await readFile(join(renderer, "components/bots/bot-workspace.css"), "utf8"))
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotRunHistory}from'./src/renderer/src/components/bots/BotRunHistory';import{BotComputer}from'./src/renderer/src/components/bots/BotComputer';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
      window.api={bots:new Proxy({},{get:(_,method)=>async input=>{try{return await window.fixtureCall(method,input)}finally{window.fixtureReplies=(window.fixtureReplies??0)+1}}})};applyThemePreference('codex-dark');
      function Fixture(){const[value,setValue]=useState(null);window.fixtureShow=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});setValue(input)};if(!value)return null;return <main className="flex h-screen flex-col bg-background text-foreground">{value.mode==='history'?<BotRunHistory address={value.address} close={()=>setValue(null)}/>:<BotComputer botId={value.botId} conversationId={value.address.conversationId} name={value.name} taskAddress={value.mode==='child'?value.address:undefined} expanded active/>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    outfile: "browser-child-ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false"
    },
    plugins: [await highlightWorkerFixture(renderer)]
  })
  await mkdir(resolve("output/bot-browser-child"), { recursive: true })
  fixtureBundle = bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  if (enabled) await browser?.close()
})

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-browser-child-ui-")))
  const cleanup: (() => void | Promise<void>)[] = [
    () => rm(directory, { recursive: true, force: true })
  ]
  const stop = async () => {
    for (const close of cleanup.reverse()) await close()
  }
  try {
    const project = join(directory, "project")
    await mkdir(project)
    const lock = BotHostLock.acquire(directory)!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(directory, "bots.sqlite"))
    cleanup.push(() => store.close())
    const computer = new LocalBotComputerProvider(join(directory, "browser"))
    computer.persistence = store
    cleanup.push(() => computer.shutdown())
    const host = new BotHost(store, undefined, 1, computer)
    host.bindOwnership(lock)
    cleanup.push(() => host.stop())
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-browser-child-ui-${randomBytes(12).toString("hex")}`
        : join(directory, "rpc.sock")
    const token = randomBytes(32).toString("hex")
    const rpc = new BotRpcServer(host, token)
    await rpc.listen(socketPath)
    cleanup.push(() => rpc.close())
    const descriptor = {
      version: 1 as const,
      pid: process.pid,
      hostId: host.id,
      socketPath,
      token
    }
    let client = new BotTransportClient(descriptor)
    cleanup.push(() => client.closeAndWait())
    const { bot, conversationId } = await client.call("create", {
      nonce: "bot",
      name: "项目助手",
      workspacePath: project
    })
    store.send({ nonce: "work", conversationId, text: "分别核对网页 A 与 B" })
    const parent = store.claim(host.id, 300_000)!
    await mkdir(join(directory, "host"))
    const modelFile = join(directory, "host", "models.private")
    await writeBotModelSnapshot(modelFile, {
      version: 1,
      defaultRef: "fixture",
      models: [
        {
          id: "fixture",
          ref: "fixture",
          name: "fixture",
          model: "fixture",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "fixture"
        }
      ]
    })
    const task = async (label: string) => {
      const definition = await prepareBotWorkflow(
        {
          request: {
            ...parent,
            store,
            bot,
            signal: new AbortController().signal,
            messages: []
          },
          modelFile,
          admitRead: async () => undefined
        },
        {
          script: BOT_BACKGROUND_TASK_SCRIPT,
          args: {
            prompt: label,
            label,
            agentType: "browserUse",
            taskType: "browser"
          },
          maxConcurrency: 1,
          browserTask: true
        }
      )
      const workflow = BotWorkflowStore.open(store, parent.lease, label, definition)
      const input = backgroundTaskInput(definition)!
      store.workflowChildren.reserve(workflow, parent.lease, input)
      const child = store.workflowChildren.claim(workflow, parent.lease, input)
      return { ...child, address: { conversationId, runId: child.run.id } }
    }
    const a = await task("网页 A 核对"),
      b = await task("网页 B 核对")
    const edits: { owner: string; value: string }[] = []
    const site = createServer((request, response) => {
      const url = new URL(request.url!, "http://fixture.invalid")
      if (url.pathname === "/record") {
        edits.push({
          owner: url.searchParams.get("owner")!,
          value: url.searchParams.get("value")!
        })
        response.writeHead(200).end("ok")
        return
      }
      const name = url.pathname.slice(1)
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(
          `<!doctype html><title>${name} 任务页面</title><h1>${name} 独立任务</h1><input autofocus oninput="fetch('/record?owner=${name}&value='+encodeURIComponent(this.value))" style="width:380px;height:40px" aria-label="任务输入">`
        )
    })
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) => {
          site.close((error) => (error ? reject(error) : resolve()))
          site.closeAllConnections()
        })
    )
    const address = site.address() as import("node:net").AddressInfo
    const siteUrl = `http://127.0.0.1:${address.port}`
    const broker = await computer.get()
    for (const [owner, label] of [
      [bot.id, "Parent"],
      [a.address, "A"],
      [b.address, "B"]
    ] as const) {
      const target = await client.call("computerOpen", owner)
      await broker.act(target, { op: "snapshot" }, () => store.assertDispatch(parent.lease, true))
      await broker.act(target, { op: "navigate", url: `${siteUrl}/${label}` }, () =>
        store.assertDispatch(
          typeof owner === "string" ? parent.lease : owner.runId === a.run.id ? a.lease! : b.lease!,
          true
        )
      )
    }
    const page = await browser.newPage({
      viewport: { width: 1100, height: 900 }
    })
    page.setDefaultTimeout(10_000)
    cleanup.push(() => page.close())
    const calls: { method: string; input: unknown }[] = [],
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    let loseTake = false
    let heldFrame: {
      address: BotRunAddress
      resolve(value: unknown): void
      value: BotBrowserFrame
    } | null = null
    let holdNext: BotRunAddress | null = null
    const allowed = new Set([
      "runHistory",
      "computerOpen",
      "computerFrame",
      "computerTake",
      "computerRelease",
      "computerInput",
      "teachStatus"
    ])
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      if (!allowed.has(method)) throw new Error(`Unexpected method ${method}`)
      calls.push({ method, input })
      try {
        const value = await Reflect.apply(client.call, client, [
          method,
          ...(input === undefined ? [] : [input])
        ])
        if (method === "computerTake" && loseTake) {
          loseTake = false
          throw new Error("接管回执丢失，请核对当前控制权")
        }
        if (
          method === "computerFrame" &&
          holdNext &&
          (input as BotRunAddress).runId === holdNext.runId
        ) {
          const address = holdNext
          holdNext = null
          return new Promise((resolve) => {
            heldFrame = { address, resolve, value: value as BotBrowserFrame }
          })
        }
        return value
      } catch (error) {
        return { botFailure: serializeBotFailure(error) }
      }
    })
    await page.route("http://127.0.0.1:39183/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><style>${fixtureCss}</style><div id="root"></div><script>${fixtureBundle.replaceAll("</script", "<\\/script")}</script>`
      })
    )
    await page.goto("http://127.0.0.1:39183")
    const show = async (
      mode: "history" | "child" | "parent",
      address: BotRunAddress = { conversationId, runId: parent.run.id }
    ) => {
      await page.evaluate((input) => Reflect.get(window, "fixtureShow")(input), {
        mode,
        address,
        botId: bot.id,
        name:
          mode === "parent" ? bot.name : address.runId === a.run.id ? "网页 A 核对" : "网页 B 核对",
        host: await client.call("status"),
        snapshot: store.snapshot()
      })
    }
    return {
      page,
      store,
      computer,
      broker,
      client: () => client,
      bot,
      parent,
      a,
      b,
      edits,
      calls,
      errors,
      show,
      stop,
      loseNextTake: () => {
        loseTake = true
      },
      reconnect: async () => {
        await client.closeAndWait()
        client = new BotTransportClient(descriptor)
      },
      holdFrame: (address: BotRunAddress) => {
        holdNext = address
      },
      frameHeld: () => heldFrame !== null,
      releaseFrame: () => {
        const saved = heldFrame
        heldFrame = null
        saved?.resolve(saved.value)
      }
    }
  } catch (error) {
    await stop()
    throw error
  }
}

async function screen(page: Page, name: string) {
  await page.getByRole("img", { name: `${name} 任务页面`, exact: true }).waitFor()
  await page.waitForFunction(
    () =>
      !document.querySelector('[role="application"]')?.hasAttribute("aria-busy") ||
      document.querySelector('[role="application"]')?.getAttribute("aria-busy") === "false"
  )
}
async function enter(page: Page, value: string) {
  await page.getByLabel("向浏览器输入文本", { exact: true }).fill(value)
  await page.getByRole("button", { name: "输入", exact: true }).click()
}

it.skipIf(!enabled)(
  "opens a real child screen from history, takes only that child and returns through sibling and parent without mixing pages",
  async () => {
    const f = await fixture()
    try {
      await f.show("history")
      await f.page.getByRole("button", { name: /网页 A 核对/ }).click()
      await f.page.getByRole("button", { name: "查看任务浏览器", exact: true }).click()
      await f.page.getByRole("heading", { name: "网页 A 核对 · 浏览器", exact: true }).waitFor()
      await screen(f.page, "A")
      expect(await f.page.getByLabel("示范学习").count()).toBe(0)
      expect(f.calls.filter((call) => call.method === "teachStatus")).toHaveLength(0)
      await f.page.screenshot({
        path: resolve("output/bot-browser-child/task-running-dark.png"),
        animations: "disabled"
      })
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await enter(f.page, "A-INPUT")
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).click()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
      expect(f.edits).toContainEqual({ owner: "A", value: "A-INPUT" })
      expect(f.edits.some((edit) => edit.owner !== "A")).toBe(false)
      expect(f.broker.target(f.bot.id).control).toBe("bot")
      expect(f.broker.target(f.bot.id, f.b.run.id).control).toBe("bot")
      expect(f.broker.requiresObservation(f.bot.id, f.a.run.id)).toBe(true)
      await f.page.getByRole("button", { name: "返回任务记录", exact: true }).click()
      await f.page.getByRole("button", { name: "返回父任务", exact: true }).click()
      await f.page.getByRole("button", { name: /网页 B 核对/ }).click()
      await f.page.getByRole("button", { name: "查看任务浏览器", exact: true }).click()
      await screen(f.page, "B")
      await f.show("parent")
      await screen(f.page, "Parent")
      expect(
        f.calls
          .filter(
            (call) =>
              ["computerOpen", "computerFrame"].includes(call.method) &&
              typeof call.input === "string"
          )
          .at(-1)?.input
      ).toBe(f.bot.id)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "shows a completed child's retained last screen read-only without Teach or inactive action buttons",
  async () => {
    const f = await fixture()
    try {
      f.store.workflowChildren.settle(f.a.lease!, "succeeded", {
        text: "网页 A 已核对",
        structured: null,
        outputTokens: 0
      })
      f.broker.retireTask(f.bot.id, f.a.run.id)
      await f.show("history", f.a.address)
      await f.page.getByRole("button", { name: "查看任务浏览器", exact: true }).click()
      await screen(f.page, "A")
      await f.page.getByText("当前任务画面仅供查看", { exact: true }).waitFor()
      await f.page.screenshot({
        path: resolve("output/bot-browser-child/task-completed-dark.png"),
        animations: "disabled"
      })
      for (const name of [
        "接管操作",
        "归还 Bot",
        "新建浏览器标签页",
        "前往",
        "输入",
        "查看示范记录"
      ])
        expect(await f.page.getByRole("button", { name, exact: true }).count()).toBe(0)
      expect(await f.page.getByLabel("向浏览器输入文本").count()).toBe(0)
      await f.page.getByRole("button", { name: "刷新画面", exact: true }).click()
      expect(
        f.calls.filter((call) =>
          ["computerTake", "computerRelease", "computerInput", "teachStatus"].includes(call.method)
        )
      ).toHaveLength(0)
      const target = await f.client().call("computerOpen", f.a.address)
      await expect(f.client().call("computerTake", target)).rejects.toMatchObject({
        code: "workflow_browser_inactive"
      })
      expect(f.store.getRun(f.a.run.id).status).toBe("succeeded")
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "recovers a lost take reply and an authenticated viewer disconnect on the exact child's human hold",
  async () => {
    const f = await fixture()
    try {
      await f.show("child", f.a.address)
      await screen(f.page, "A")
      f.loseNextTake()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.page.getByRole("alert").filter({ hasText: "接管回执丢失" }).waitFor()
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      expect(f.calls.filter((call) => call.method === "computerTake")).toHaveLength(1)
      await f.reconnect()
      await f.page.getByRole("button", { name: "刷新画面", exact: true }).click()
      await f.page.getByText("控制端已断开，Bot 保持暂停", { exact: true }).waitFor()
      expect(await f.page.getByLabel("向浏览器输入文本").count()).toBe(0)
      expect(f.store.loadTaskBrowserSession(f.bot.id, f.a.run.id)?.humanHeld).toBe(true)
      await f.page.getByRole("button", { name: "转移控制权", exact: true }).click()
      await f.page.getByRole("button", { name: "确认转移", exact: true }).click()
      await enter(f.page, "AFTER-RECONNECT")
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).click()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
      expect(f.edits).toContainEqual({ owner: "A", value: "AFTER-RECONNECT" })
      expect(f.broker.target(f.bot.id).control).toBe("bot")
      expect(f.broker.target(f.bot.id, f.b.run.id).control).toBe("bot")
      expect(
        f.calls
          .filter((call) => call.method === "computerTake")
          .every((call) => (call.input as { taskRunId?: string }).taskRunId === f.a.run.id)
      ).toBe(true)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "retires a delayed child frame when the mounted computer changes owner before the reply arrives",
  async () => {
    const f = await fixture()
    try {
      f.holdFrame(f.a.address)
      await f.show("child", f.a.address)
      await expect.poll(f.frameHeld).toBe(true)
      await f.show("child", f.b.address)
      await screen(f.page, "B")
      const before = await f.page.evaluate(() => Reflect.get(window, "fixtureReplies") as number)
      f.releaseFrame()
      await f.page.waitForFunction((count) => Reflect.get(window, "fixtureReplies") > count, before)
      expect(await f.page.getByRole("img", { name: "A 任务页面", exact: true }).count()).toBe(0)
      expect(await f.page.getByRole("img", { name: "B 任务页面", exact: true }).count()).toBe(1)
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await enter(f.page, "B-ONLY")
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).click()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).waitFor()
      expect(f.edits).toContainEqual({ owner: "B", value: "B-ONLY" })
      expect(f.edits.some((edit) => edit.owner !== "B")).toBe(false)
      expect(f.errors).toEqual([])
    } finally {
      f.releaseFrame()
      await f.stop()
    }
  },
  40_000
)
