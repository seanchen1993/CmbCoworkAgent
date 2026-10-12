/** Real React, SQLite, authenticated RPC, Chrome and native browser Teach.
 * Only frame/ack delivery at the Electron bridge is controlled; no model or OS desktop. */
import { afterAll, beforeAll, expect, it } from "vitest"
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomBytes } from "node:crypto"
import { build, type BuildOptions } from "esbuild"
import { highlightWorkerFixture } from "../../../tests/fixtures/highlight-worker"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Browser } from "playwright"
import { BotStore } from "./store"
import { BotHost } from "./host"
import { BotHostLock } from "./host-lock"
import { BotRpcServer } from "./rpc"
import { BotTransportClient } from "./transport-client"
import { LocalBotComputerProvider } from "./computer-provider"
import { BotTeachService } from "./teach-service"
import { serializeBotFailure } from "./error-diagnostic"
import { writeBotComputerHelp } from "../../shared/bot-computer-help"

const enabled = process.env.CMB_GROK_COMPUTER_UI_TEST === "1"
let browser: Browser, fixtureBundle: string, strictFixtureBundle: string, fixtureCss: string
let workspaceFixtureBundle: string, workspaceFixtureCss: string
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
  // Match the existing Cmb browser fixtures' actual Vite worker transform.
  const bundleOptions: BuildOptions = {
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React,{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{Dialog,DialogTitle}from'./src/renderer/src/components/ui/dialog';import{BotDialogContent}from'./src/renderer/src/components/bots/BotDialog';
      window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)})};applyThemePreference('codex-dark');window.fixtureTheme=applyThemePreference;
      function Fixture(){const[value,setValue]=useState(null),[tab,setTab]=useState('computer'),[covered,setCovered]=useState(false);useEffect(()=>{window.fixtureEffectMounts=(window.fixtureEffectMounts??0)+1;return()=>{window.fixtureEffectCleanups=(window.fixtureEffectCleanups??0)+1}},[]);window.fixtureCover=setCovered;window.fixtureShow=input=>{useBotWorkspaceStore.setState({host:input.host,snapshot:input.snapshot});setValue(input)};return <main className="relative flex h-screen bg-background text-foreground"><nav style={{width:200,flexShrink:0}}><button id="background-action" onClick={()=>window.backgroundClicks=(window.backgroundClicks??0)+1}>后台按钮</button></nav><section className="bot-workspace relative flex min-w-0 flex-1"><div className="flex-1"/>{value&&<BotInspector bot={value.bot} conversationId={value.conversationId} covered={covered} tab={tab} onTabChange={setTab} settings={()=>{}} resource={()=>{}} showDownloads={()=>{}} close={()=>setValue(null)}/>}</section><Dialog open={covered} onOpenChange={setCovered}><BotDialogContent><DialogTitle>资源界面遮挡</DialogTitle><button onClick={()=>setCovered(false)}>返回电脑</button></BotDialogContent></Dialog></main>};createRoot(document.getElementById('root')).render(window.fixtureStrictMode?<React.StrictMode><Fixture/></React.StrictMode>:<Fixture/>);`
    },
    outfile: "grok-computer-ui.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    alias: { "@": renderer },
    define: {
      "process.env.NODE_ENV": '"production"',
      "import.meta.env.DEV": "false",
      __APP_VERSION__: '"ui-fixture"'
    },
    plugins: [await highlightWorkerFixture(renderer)]
  }
  const bundle = await build(bundleOptions)
  const strictBundle = await build({
    ...bundleOptions,
    define: {
      ...bundleOptions.define,
      "process.env.NODE_ENV": '"development"'
    }
  })
  const productionScript = bundle.outputFiles?.find((file) => file.path.endsWith(".js"))
  const developmentScript = strictBundle.outputFiles?.find((file) => file.path.endsWith(".js"))
  if (!productionScript || !developmentScript) throw new Error("Missing Computer UI fixture bundle")
  fixtureBundle = productionScript.text
  strictFixtureBundle = developmentScript.text
  const workspaceBundle = await build({
    ...bundleOptions,
    stdin: {
      resolveDir: process.cwd(),
      loader: "tsx",
      contents: `import React from'react';import{createRoot}from'react-dom/client';import{BotWorkspace}from'./src/renderer/src/components/bots/BotWorkspace';import{useBotWorkspaceStore as store}from'./src/renderer/src/lib/bot-workspace-store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';applyThemePreference('codex-dark');window.api={bots:new Proxy({},{get:(_,method)=>input=>window.fixtureCall(method,input)}),botArtifactDownloads:{page:async()=>({items:[],nextCursor:null,total:0})}};window.fixtureShow=input=>{store.setState({host:input.host,snapshot:input.snapshot});store.getState().select(input.conversationId)};window.fixtureSelection=()=>store.getState().selected;createRoot(document.getElementById('root')).render(<main className="flex h-screen bg-background text-foreground"><BotWorkspace/></main>);`
    },
    plugins: [
      ...bundleOptions.plugins!,
      {
        name: "unrelated-outer-shell",
        setup(builder) {
          builder.onResolve({ filter: /^(?:@\/lib\/store|\.\/store)$/ }, (args) =>
            args.path === "./store" && !args.importer.startsWith(join(renderer, "lib"))
              ? undefined
              : { path: "app-store", namespace: "outer" }
          )
          builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
            path: "thread",
            namespace: "outer"
          }))
          builder.onLoad({ filter: /.*/, namespace: "outer" }, (args) => ({
            loader: "js",
            resolveDir: process.cwd(),
            contents:
              args.path === "app-store"
                ? 'import{create}from"zustand";export const useAppStore=create(()=>({models:[],showCustomizeView:false,setMainView:()=>{},setShowCustomizeView:()=>{}}));'
                : "export const useThreadStateSelector=(_id,select)=>select({workspacePath:null,workspaceFiles:[]});"
          }))
        }
      }
    ]
  })
  workspaceFixtureBundle = workspaceBundle.outputFiles!.find((file) =>
    file.path.endsWith(".js")
  )!.text
  // Include every actual imported component stylesheet, as the application bundle does.
  workspaceFixtureCss =
    css.build(scanner.scan()) +
    "\n" +
    workspaceBundle
      .outputFiles!.filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n")
  await mkdir(resolve("output/grok-computer-ui"), { recursive: true })
  browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
}, 30_000)
afterAll(async () => {
  if (enabled) await browser?.close()
}, 30_000)

async function fixture(
  holdInitialFrame = false,
  strict = false,
  preserveEvidence = false,
  workspace = false
) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cmb-grok-computer-ui-")))
  const cleanup: (() => void | Promise<void>)[] = [
    () => (preserveEvidence ? Promise.resolve() : rm(directory, { recursive: true, force: true }))
  ]
  const stop = async () => {
    for (const close of cleanup.reverse()) await close()
  }
  try {
    const lock = BotHostLock.acquire(directory)!
    cleanup.push(() => lock.release())
    const store = new BotStore(join(directory, "bots.sqlite"))
    cleanup.push(() => store.close())
    const computer = new LocalBotComputerProvider(join(directory, "browser"))
    computer.persistence = store
    cleanup.push(() => computer.shutdown())
    const teach = new BotTeachService(join(directory, "teach"), store, computer)
    cleanup.push(() => teach.close())
    const host = new BotHost(store, undefined, 1, computer, undefined, teach)
    host.bindOwnership(lock)
    cleanup.push(() => host.stop())
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\cmb-grok-ui-${randomBytes(12).toString("hex")}`
        : join(directory, "rpc.sock")
    const token = randomBytes(32).toString("hex"),
      rpc = new BotRpcServer(host, token)
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
      name: "验收助手"
    })
    expect(bot.workspacePath).toBeNull()
    store.send({ nonce: "work", conversationId, text: "核对网页" })
    const parent = store.claim(host.id, 300_000)!
    const edits: string[] = []
    const site = createServer(async (request, response) => {
      if (request.url?.startsWith("/edit?")) {
        edits.push(new URL(request.url, "http://localhost").searchParams.get("value") ?? "")
        response.end("ok")
        return
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8")
      response.end(
        '<!doctype html><title>实际浏览器页面</title><input autofocus placeholder="结果"><select id="region" size="2" style="position:absolute;left:300px;top:80px;width:200px;height:60px"><option value="">请选择</option><option value="east">东区</option></select><script>document.querySelector("input").addEventListener("input",event=>fetch("/edit?value="+encodeURIComponent(event.target.value)))</script>'
      )
    })
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          site.closeAllConnections()
          site.close(() => resolve())
        })
    )
    const siteUrl = `http://127.0.0.1:${(site.address() as import("node:net").AddressInfo).port}`
    const broker = await computer.get()
    const target = await client.call("computerOpen", bot.id)
    await broker.act(target, { op: "navigate", url: siteUrl }, () =>
      store.assertDispatch(parent.lease, true)
    )
    const page = await browser.newPage({
      viewport: { width: 1160, height: 840 }
    })
    page.setDefaultTimeout(10_000)
    cleanup.push(() => page.close())
    const calls: { method: string; input: unknown }[] = [],
      errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    let legacyFrame = false
    let firstFrame = holdInitialFrame,
      heldFrame: { release(): void } | null = null
    let holdInput = false,
      failInputAck = false,
      heldInput: { release(): void } | null = null
    let holdStatus = false,
      heldStatus: { release(): void } | null = null
    cleanup.push(() => {
      heldFrame?.release()
      heldInput?.release()
      heldStatus?.release()
    })
    await page.exposeFunction("fixtureCall", async (method: string, input: unknown) => {
      calls.push({ method, input })
      try {
        let value = await Reflect.apply(client.call, client, [
          method,
          ...(input === undefined ? [] : [input])
        ])
        if (method === "computerFrame" && legacyFrame) {
          const frame = { ...(value as import("../../shared/bot-computer").BotBrowserFrame) }
          delete frame.navigationEpoch
          delete frame.humanInputLease
          value = frame
        }
        if (method === "computerFrame" && firstFrame) {
          firstFrame = false
          return new Promise((resolve) => {
            heldFrame = { release: () => resolve(value) }
          })
        }
        if (method === "teachStatus" && holdStatus) {
          holdStatus = false
          return new Promise((resolve) => {
            heldStatus = { release: () => resolve(value) }
          })
        }
        if (method === "computerInput" && holdInput) {
          holdInput = false
          return new Promise((resolve) => {
            const reply = failInputAck
              ? {
                  botFailure: serializeBotFailure(
                    new Error("Controlled lost acknowledgement after input")
                  )
                }
              : value
            failInputAck = false
            heldInput = { release: () => resolve(reply) }
          })
        }
        return value
      } catch (error) {
        return { botFailure: serializeBotFailure(error) }
      }
    })
    await page.route("http://127.0.0.1:39184/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset="utf-8"><style>${workspace ? workspaceFixtureCss : fixtureCss}</style><div id="root"></div><script>window.fixtureStrictMode=${strict};${(workspace ? workspaceFixtureBundle : strict ? strictFixtureBundle : fixtureBundle).replaceAll("</script", "<\\/script")}</script>`
      })
    )
    await page.goto("http://127.0.0.1:39184")
    const sync = async () => {
      await page.evaluate((input) => Reflect.get(window, "fixtureShow")(input), {
        bot,
        conversationId,
        host: await client.call("status"),
        snapshot: store.snapshot()
      })
    }
    const show = async () => {
      await sync()
      if (workspace)
        await page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
    }
    const ready = async () => {
      await page.getByRole("img", { name: "实际浏览器页面", exact: true }).waitFor()
      await page.waitForFunction(
        () => document.querySelector(".bot-computer-screen")?.getAttribute("aria-busy") === "false"
      )
    }
    return {
      page,
      show,
      sync,
      parent,
      ready,
      stop,
      store,
      bot,
      broker,
      computer,
      teach,
      edits,
      calls,
      errors,
      directory,
      call: <T = unknown>(method: string, input: unknown) =>
        Reflect.apply(client.call, client, [method, input]) as Promise<T>,
      cover: async (covered: boolean) => {
        await page.evaluate((value) => Reflect.get(window, "fixtureCover")(value), covered)
        await page
          .getByRole("dialog", { name: "资源界面遮挡", exact: true })
          .waitFor({ state: covered ? "visible" : "hidden" })
      },
      legacyFrames: () => {
        legacyFrame = true
      },
      holdNextFrame: () => {
        heldFrame = null
        firstFrame = true
      },
      holdNextStatus: () => {
        heldStatus = null
        holdStatus = true
      },
      statusHeld: () => heldStatus !== null,
      releaseStatus: () => heldStatus?.release(),
      frameHeld: () => heldFrame !== null,
      releaseFrame: () => heldFrame?.release(),
      holdNextInput: (failAcknowledgement = false) => {
        holdInput = true
        failInputAck = failAcknowledgement
      },
      inputHeld: () => heldInput !== null,
      releaseInput: () => heldInput?.release(),
      reconnect: async () => {
        await client.closeAndWait()
        client = new BotTransportClient(descriptor)
      }
    }
  } catch (error) {
    await stop()
    throw error
  }
}

it.skipIf(!enabled)(
  "keeps a clickable empty preview, opens a dedicated focus-safe screen and returns to the same ready card",
  async () => {
    const f = await fixture(true)
    try {
      await f.show()
      await expect.poll(f.frameHeld).toBe(true)
      const preview = f.page.getByRole("button", {
        name: "展开 验收助手 的电脑画面",
        exact: true
      })
      const empty = await preview.boundingBox()
      expect(empty!.width / empty!.height).toBeCloseTo(1.6, 2)
      await f.page.getByText("验收助手 的屏幕", { exact: true }).waitFor()
      await preview.click()
      const modal = f.page.locator('[data-fullscreen="true"]')
      await modal.waitFor()
      expect(await modal.getAttribute("role")).toBe("dialog")
      expect(await modal.getAttribute("aria-modal")).toBe("true")
      const fullBounds = await modal.boundingBox()
      expect(fullBounds).toEqual({ x: 0, y: 0, width: 1160, height: 840 })
      for (const insets of [
        { left: 86, right: 0 },
        { left: 0, right: 140 }
      ]) {
        await f.page.evaluate(({ left, right }) => {
          document.documentElement.style.setProperty("--titlebar-inset-left", `${left}px`)
          document.documentElement.style.setProperty("--titlebar-inset-right", `${right}px`)
        }, insets)
        const title = await modal.locator("header > span").boundingBox()
        const exit = await modal
          .getByRole("button", { name: "退出电脑全屏", exact: true })
          .boundingBox()
        expect(title!.x).toBeGreaterThanOrEqual(insets.left)
        expect(exit!.x + exit!.width).toBeLessThanOrEqual(1160 - insets.right)
      }
      await f.page.evaluate(() => {
        document.documentElement.style.removeProperty("--titlebar-inset-left")
        document.documentElement.style.removeProperty("--titlebar-inset-right")
      })
      expect(await f.page.getByRole("tab", { name: "资料库", exact: true }).count()).toBe(0)
      await f.page
        .locator("#background-action")
        .evaluate((button: HTMLButtonElement) => button.focus())
      expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      await expect(f.page.locator("#background-action").click({ timeout: 500 })).rejects.toThrow()
      expect(await f.page.evaluate(() => Reflect.get(window, "backgroundClicks") ?? 0)).toBe(0)
      for (let n = 0; n < 9; n++) await f.page.keyboard.press("Tab")
      expect(await modal.evaluate((element) => element.contains(document.activeElement))).toBe(true)
      f.releaseFrame()
      await f.ready()
      await f.page.getByRole("button", { name: "退出电脑全屏", exact: true }).focus()
      await f.page.keyboard.press("Escape")
      await f.page.getByRole("tab", { name: "资料库", exact: true }).waitFor()
      expect(await preview.evaluate((element) => element === document.activeElement)).toBe(true)
      const ready = await preview.boundingBox()
      expect(ready!.width).toBeCloseTo(empty!.width, 1)
      expect(ready!.height).toBeCloseTo(empty!.height, 1)
      expect(await f.page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none")
      expect(f.errors).toEqual([])
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/preview-dark.png"),
        animations: "disabled"
      })
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "keeps the live Teach controller/draft across expansion and permits a nested authenticated control transfer",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "示范给 Bot", exact: true }).click()
      await f.page.getByRole("button", { name: "暂停录制", exact: true }).waitFor()
      const session = f.teach.status(f.bot.id)!
      expect(session.phase).toBe("recording")
      await f.page.waitForFunction(() =>
        document.querySelector('[data-recording-phase="recording"]')
      )
      await expect.poll(() => f.teach.repository.get(session.id).frameCount).toBeGreaterThan(0)
      const controller = f.page.getByLabel("示范学习", { exact: true })
      await controller.evaluate((element) => Reflect.set(window, "teachElement", element))
      const input = f.page.getByLabel("向浏览器输入文本", { exact: true })
      await input.fill("尚未提交的草稿")
      await f.page.getByRole("button", { name: "展开电脑面板", exact: true }).click()
      await f.page.locator('[data-fullscreen="true"]').waitFor()
      expect(
        await controller.evaluate((element) => element === Reflect.get(window, "teachElement"))
      ).toBe(true)
      expect(await input.inputValue()).toBe("尚未提交的草稿")
      expect(
        await f.page
          .locator(".bot-computer-screen")
          .evaluate((element) => getComputedStyle(element).outlineStyle)
      ).toBe("solid")
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/teach-recording-fullscreen.png"),
        animations: "disabled"
      })
      await f.page.getByRole("button", { name: "暂停录制", exact: true }).click()
      await f.page.waitForFunction(() => document.querySelector('[data-recording-phase="paused"]'))
      expect(
        await f.page
          .locator(".bot-computer-screen")
          .evaluate((element) => getComputedStyle(element).outlineStyle)
      ).toBe("dashed")
      await f.reconnect()
      await f.page.getByRole("button", { name: "转移控制权", exact: true }).waitFor()
      await f.page.getByRole("button", { name: "转移控制权", exact: true }).click()
      await f.page.getByRole("dialog", { name: "将浏览器控制权转到这里？", exact: true }).waitFor()
      await f.page.keyboard.press("Escape")
      await f.page
        .getByRole("dialog", { name: "将浏览器控制权转到这里？", exact: true })
        .waitFor({ state: "hidden" })
      expect(await f.page.locator('[data-fullscreen="true"]').count()).toBe(1)
      await f.page.getByRole("button", { name: "转移控制权", exact: true }).click()
      await f.page.getByRole("button", { name: "确认转移", exact: true }).click()
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      await f.page.getByRole("button", { name: "继续录制", exact: true }).click()
      await f.page.waitForFunction(() =>
        document.querySelector('[data-recording-phase="recording"]')
      )
      await f.page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
      expect(
        await controller.evaluate((element) => element === Reflect.get(window, "teachElement"))
      ).toBe(true)
      expect(await input.inputValue()).toBe("尚未提交的草稿")
      expect(f.calls.filter((call) => call.method === "teachStart")).toHaveLength(1)
      expect(f.teach.repository.get(session.id).phase).toBe("recording")
      await f.page.getByRole("button", { name: "丢弃录制", exact: true }).click()
      await f.page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
      expect(f.teach.repository.get(session.id).phase).toBe("discarded")
      expect(await f.page.locator("[data-recording-phase]").count()).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "retains an in-flight authenticated input and its single result across fullscreen presentation changes",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      await f.page.getByLabel("向浏览器输入文本", { exact: true }).fill("一次输入")
      f.holdNextInput()
      await f.page.getByRole("button", { name: "输入", exact: true }).click()
      await expect.poll(f.inputHeld).toBe(true)
      await f.page.getByRole("button", { name: "展开电脑面板", exact: true }).click()
      await f.page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
      expect(await f.page.getByLabel("向浏览器输入文本", { exact: true }).inputValue()).toBe(
        "一次输入"
      )
      f.releaseInput()
      await expect
        .poll(() => f.page.getByLabel("向浏览器输入文本", { exact: true }).inputValue())
        .toBe("")
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(f.edits).toContain("一次输入")
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "uses theme tokens and a bounded reduced-motion fullscreen on a narrow viewport",
  async () => {
    const f = await fixture()
    try {
      await f.page.setViewportSize({ width: 560, height: 720 })
      await f.page.emulateMedia({ reducedMotion: "reduce" })
      await f.page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-light"))
      await f.show()
      await f.ready()
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/preview-light-narrow.png"),
        animations: "disabled"
      })
      await f.page.getByRole("button", { name: "展开 验收助手 的电脑画面", exact: true }).click()
      const layer = f.page.locator('[data-fullscreen="true"]')
      const screen = f.page.locator(".bot-computer-screen")
      const box = await screen.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(560)
      expect(box!.y + box!.height).toBeLessThanOrEqual(720)
      expect(await layer.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        "none"
      )
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/fullscreen-light-narrow.png"),
        animations: "disabled"
      })
      await f.page.evaluate(() => Reflect.get(window, "fixtureTheme")("codex-dark"))
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/fullscreen-dark-narrow.png"),
        animations: "disabled"
      })
      await f.page.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
      expect(
        await f.page.getByRole("tab", { name: "电脑", exact: true }).getAttribute("aria-selected")
      ).toBe("true")
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled)(
  "reports pending keyboard input as busy on the real React screen",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      const screen = f.page.getByRole("application", {
        name: "浏览器画面，接管后点击或按键操作",
        exact: true
      })
      await screen.focus()
      f.holdNextInput()
      await f.page.keyboard.press("a")
      await expect.poll(f.inputHeld).toBe(true)
      expect(await screen.getAttribute("aria-busy")).toBe("true")
      await f.page
        .locator(".bot-computer-control")
        .getByRole("status")
        .filter({ hasText: "正在输入" })
        .waitFor()
      f.releaseInput()
      await f.ready()
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "preserves rapid canvas keys in order while the real authenticated input acknowledgement is held",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      await f.page
        .getByRole("application", {
          name: "浏览器画面，接管后点击或按键操作",
          exact: true
        })
        .focus()
      f.holdNextInput()
      await f.page.keyboard.press("a")
      await expect.poll(f.inputHeld).toBe(true)
      await f.page.keyboard.press("b")
      await f.page.keyboard.press("c")
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      f.releaseInput()
      await expect.poll(() => f.edits.at(-1)).toBe("abc")
      await f.ready()
      const inputs = f.calls
        .filter((call) => call.method === "computerInput")
        .map(
          (call) =>
            call.input as {
              target: { viewId: string }
              input: { key: string; frameSeq: number; navigationEpoch: number }
            }
        )
      expect(inputs.map((call) => call.input.key)).toEqual(["a", "b", "c"])
      // The original painted ticket is retained; the new lease sequences effects without rebasing.
      expect(new Set(inputs.map((call) => call.input.frameSeq)).size).toBe(1)
      expect(new Set(inputs.map((call) => call.target.viewId)).size).toBe(1)
      expect(new Set(inputs.map((call) => call.input.navigationEpoch)).size).toBe(1)
      expect(JSON.stringify(inputs)).not.toContain("data:image")
      expect(JSON.stringify(inputs).length).toBeLessThan(2_000)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "rejects a legacy human frame after the same URL document reloads",
  async () => {
    const f = await fixture()
    try {
      await f.call("computerTake", await f.call("computerFrame", f.bot.id))
      const frame = await f.call<import("../../shared/bot-computer").BotBrowserFrame>(
        "computerFrame",
        f.bot.id
      )
      await f.broker.teachObserve(f.bot.id, (page) =>
        page.reload({ waitUntil: "domcontentloaded" })
      )
      await expect(
        f.call("computerInput", {
          target: frame,
          input: { kind: "key", key: "x", frameSeq: frame.frameSeq }
        })
      ).rejects.toMatchObject({ code: "stale_frame" })
      expect(f.edits).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "queues rapid text-click-key on the painted human document and merges the final refresh",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      const image = f.page.getByRole("img", { name: "实际浏览器页面", exact: true })
      const before = await image.boundingBox()
      expect(before).not.toBeNull()
      const framesBefore = f.calls.filter((call) => call.method === "computerFrame").length
      f.holdNextInput()
      await f.page.getByLabel("向浏览器输入文本", { exact: true }).fill("2026-10")
      await f.page.getByRole("button", { name: "输入", exact: true }).click()
      await expect.poll(f.inputHeld).toBe(true)
      await image.click({
        position: { x: (before!.width * 320) / 1920, y: (before!.height * 90) / 1200 }
      })
      await f.page.keyboard.press("ArrowDown")
      await f.page.keyboard.press("Enter")
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(await f.page.getByRole("alert").count()).toBe(0)
      const queued = await image.boundingBox()
      expect(queued!.y).toBe(before!.y)
      f.releaseInput()
      await f.ready()
      const actual = await f.broker.teachObserve(f.bot.id, async (page) => ({
        month: await page.locator("input").inputValue(),
        region: await page.locator("select").inputValue()
      }))
      expect(actual).toEqual({ month: "2026-10", region: "east" })
      const inputs = f.calls
        .filter((call) => call.method === "computerInput")
        .map(
          (call) =>
            (call.input as { input: import("../../shared/bot-computer").BotHumanInput }).input
        )
      expect(inputs.map((input) => input.kind)).toEqual(["text", "click", "key", "key"])
      expect(inputs.map((input) => input.humanInputLease?.sequence)).toEqual([1, 2, 3, 4])
      expect(new Set(inputs.map((input) => input.frameSeq)).size).toBe(1)
      expect(f.calls.filter((call) => call.method === "computerFrame").length - framesBefore).toBe(
        1
      )
      expect(await f.page.getByRole("alert").count()).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "retires an ACK deferred refresh when a manual operation owns the lock and restores observation",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      // Capture the actual 50ms callback, without racing a wall-clock sleep.
      // All 1500ms passive observations and real RPC work continue normally.
      await f.page.evaluate(() => {
        const timers = new Map<number, () => void>()
        const set = window.setTimeout.bind(window),
          clear = window.clearTimeout.bind(window)
        const interceptTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          if (timeout === 50 && typeof handler === "function") {
            const id = set(() => {}, 2_000_000_000)
            timers.set(id, () => handler(...args))
            return id
          }
          return set(handler, timeout, ...args)
        }
        Reflect.set(window, "setTimeout", interceptTimeout)
        window.clearTimeout = (id) => {
          if (id !== undefined) timers.delete(id)
          clear(id)
        }
        Reflect.set(window, "fixtureDeferredRefreshCount", () => timers.size)
        Reflect.set(window, "fixtureReleaseDeferredRefresh", () => {
          const pending = [...timers.entries()]
          timers.clear()
          for (const [id, run] of pending) {
            clear(id)
            run()
          }
          return pending.length
        })
      })
      f.holdNextInput()
      await f.page.getByLabel("向浏览器输入文本", { exact: true }).fill("once")
      await f.page.getByRole("button", { name: "输入", exact: true }).click()
      await expect.poll(f.inputHeld).toBe(true)
      f.releaseInput()
      await expect
        .poll(() => f.page.evaluate(() => Reflect.get(window, "fixtureDeferredRefreshCount")()))
        .toBe(1)
      expect(await f.page.locator(".bot-computer-screen").getAttribute("aria-busy")).toBe("true")
      f.holdNextFrame()
      await f.page.getByRole("button", { name: "刷新画面", exact: true }).click()
      await expect.poll(f.frameHeld).toBe(true) // The manual operation now owns the live lock.
      const deferred = await f.page.evaluate(() =>
        Reflect.get(window, "fixtureReleaseDeferredRefresh")()
      )
      f.releaseFrame()
      await f.ready()
      expect(deferred).toBe(0) // ClearTimeout retired it; before the fix it fired under the lock.
      const frames = f.calls.filter((call) => call.method === "computerFrame").length
      const image = f.page.getByRole("img", { name: "实际浏览器页面", exact: true })
      const priorImage = await image.getAttribute("src")
      await f.broker.teachObserve(f.bot.id, (page) =>
        page.locator("input").evaluate((element) => {
          ;(element as HTMLInputElement).value = "passive observation"
        })
      )
      await expect
        .poll(() => f.calls.filter((call) => call.method === "computerFrame").length, {
          timeout: 10_000
        })
        .toBeGreaterThan(frames)
      await expect.poll(() => image.getAttribute("src"), { timeout: 10_000 }).not.toBe(priorImage)
      await f.ready()
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(f.edits).toEqual(["once"])
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "preserves fresh single input from a legacy client without a navigation epoch",
  async () => {
    const f = await fixture()
    try {
      await f.call("computerTake", await f.call("computerFrame", f.bot.id))
      const frame = await f.call<import("../../shared/bot-computer").BotBrowserFrame>(
        "computerFrame",
        f.bot.id
      )
      await f.call("computerInput", {
        target: frame,
        input: { kind: "key", key: "x", frameSeq: frame.frameSeq }
      })
      await expect.poll(() => f.edits.at(-1)).toBe("x")
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "rejects malformed explicit human frame epochs without weakening legacy compatibility",
  async () => {
    const f = await fixture()
    try {
      await f.call("computerTake", await f.call("computerFrame", f.bot.id))
      for (const navigationEpoch of [null, -1, "unknown", {}, Number.MAX_SAFE_INTEGER + 1]) {
        const frame = await f.call<import("../../shared/bot-computer").BotBrowserFrame>(
          "computerFrame",
          f.bot.id
        )
        await expect(
          f.call("computerInput", {
            target: frame,
            input: { kind: "key", key: "x", frameSeq: frame.frameSeq, navigationEpoch }
          })
        ).rejects.toMatchObject({ code: "invalid_input" })
      }
      expect(f.edits).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "rejects a human frame when its document changes during the asynchronous before-input observer",
  async () => {
    const f = await fixture()
    const observer = f.broker.humanObserver
    try {
      await f.call("computerTake", await f.call("computerFrame", f.bot.id))
      const frame = await f.call<import("../../shared/bot-computer").BotBrowserFrame>(
        "computerFrame",
        f.bot.id
      )
      f.broker.humanObserver = async (botId, page, input, phase) => {
        if (phase === "before") await page.reload({ waitUntil: "domcontentloaded" })
        await observer?.(botId, page, input, phase)
      }
      await expect(
        f.call("computerInput", {
          target: frame,
          input: { kind: "key", key: "x", frameSeq: frame.frameSeq }
        })
      ).rejects.toMatchObject({ code: "stale_frame" })
      expect(f.edits).toEqual([])
    } finally {
      f.broker.humanObserver = observer
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled).each(["reload", "covered", "cancel", "release", "tab", "uncertain"] as const)(
  "retires queued keyboard intentions after %s without replaying them to a different document or owner",
  async (boundary) => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      await f.page
        .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
        .focus()
      f.holdNextInput(boundary === "uncertain")
      await f.page.keyboard.press("a")
      await expect.poll(f.inputHeld).toBe(true)
      await f.page.keyboard.press("b")
      await f.page.keyboard.press("c")
      await f.page.getByRole("button", { name: "取消待发送输入", exact: true }).waitFor()
      if (boundary === "reload")
        await f.broker.teachObserve(f.bot.id, (page) =>
          page.reload({ waitUntil: "domcontentloaded" })
        )
      else if (boundary === "covered") await f.cover(true)
      else if (boundary === "cancel")
        await f.page.getByRole("button", { name: "取消待发送输入", exact: true }).click()
      else if (boundary === "release")
        await f.call("computerRelease", await f.call("computerOpen", f.bot.id))
      else if (boundary === "tab") {
        const frame = await f.call<import("../../shared/bot-computer").BotBrowserFrame>(
          "computerFrame",
          f.bot.id
        )
        await f.call("computerInput", {
          target: frame,
          input: {
            kind: "tab_new",
            frameSeq: frame.frameSeq,
            navigationEpoch: frame.navigationEpoch
          }
        })
      }
      f.releaseInput()
      if (boundary === "covered") await f.cover(false)
      if (boundary === "tab")
        await f.page.getByRole("img", { name: "Bot 浏览器画面", exact: true }).waitFor()
      else await f.ready()
      await f.page.waitForFunction(
        () => document.querySelector(".bot-computer-screen")?.getAttribute("aria-busy") === "false"
      )
      expect(f.edits).toEqual(["a"])
      // An external Host transition can invalidate a lease before the renderer learns of it.
      // At most one next intent reaches the Host and is rejected; its remaining FIFO is retired.
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(
        ["reload", "release", "tab"].includes(boundary) ? 2 : 1
      )
      expect(
        await f.page.getByRole("button", { name: "取消待发送输入", exact: true }).count()
      ).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "preserves text FIFO and refuses a duplicate outstanding draft on the actual React form",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      const draft = f.page.getByLabel("向浏览器输入文本", { exact: true })
      const send = f.page.getByRole("button", { name: "输入", exact: true })
      f.holdNextInput()
      await draft.fill("A")
      await send.click()
      await expect.poll(f.inputHeld).toBe(true)
      await draft.fill("B")
      await send.click()
      expect(await send.isDisabled()).toBe(true)
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      f.releaseInput()
      await expect.poll(() => f.edits.at(-1), { timeout: 10_000 }).toBe("AB")
      await f.ready()
      const inputs = f.calls
        .filter((call) => call.method === "computerInput")
        .map((call) => call.input as { input: { kind: string; text: string; frameSeq: number } })
      expect(inputs.map((call) => call.input.text)).toEqual(["A", "B"])
      expect(new Set(inputs.map((call) => call.input.frameSeq)).size).toBe(1)
      expect(await draft.inputValue()).toBe("")
      expect(f.errors).toEqual([])
    } finally {
      try {
        await writeFile(
          resolve("output/grok-computer-ui/text-fifo-diagnostic.json"),
          JSON.stringify(
            {
              edits: f.edits,
              inputs: f.calls.filter((call) => call.method === "computerInput"),
              errors: f.errors,
              alert: await f.page.getByRole("alert").allTextContents(),
              screenBusy: await f.page.locator(".bot-computer-screen").getAttribute("aria-busy")
            },
            null,
            2
          )
        )
      } finally {
        await f.stop()
      }
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "bounds rapid keyboard intentions and reports overflow without retaining rejected input",
  async () => {
    const f = await fixture()
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      await f.page
        .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
        .focus()
      f.holdNextInput()
      await f.page.keyboard.press("a")
      await expect.poll(f.inputHeld).toBe(true)
      for (let n = 0; n < 20; n++) await f.page.keyboard.press("b")
      await f.page
        .getByRole("alert")
        .filter({ hasText: "待发送输入已满，本次输入未发送" })
        .waitFor()
      await f.page.getByRole("status").filter({ hasText: "待发送 15 项" }).waitFor()
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      await f.page.getByRole("button", { name: "取消待发送输入", exact: true }).click()
      f.releaseInput()
      await f.ready()
      expect(f.edits).toEqual(["a"])
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

it.skipIf(!enabled)(
  "permits fresh legacy Host single input and reports unsupported continuous input without replay",
  async () => {
    const f = await fixture()
    try {
      f.legacyFrames()
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "接管操作", exact: true }).click()
      await f.ready()
      await f.page
        .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
        .focus()
      f.holdNextInput()
      await f.page.keyboard.press("a")
      await expect.poll(f.inputHeld).toBe(true)
      await f.page.keyboard.press("b")
      await f.page
        .getByRole("alert")
        .filter({ hasText: "当前后台不支持连续输入，请等待画面更新后重试" })
        .waitFor()
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(
        await f.page.getByRole("button", { name: "取消待发送输入", exact: true }).count()
      ).toBe(0)
      f.releaseInput()
      await f.ready()
      expect(f.edits).toEqual(["a"])
      const input = f.calls.find((call) => call.method === "computerInput")!.input as {
        input: { navigationEpoch?: number }
      }
      expect(input.input).not.toHaveProperty("navigationEpoch")
      await f.page
        .getByRole("application", { name: "浏览器画面，接管后点击或按键操作", exact: true })
        .focus()
      await f.page.keyboard.press("c")
      await expect.poll(() => f.edits.at(-1)).toBe("ac")
      await f.ready()
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(2)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  60_000
)

function visibilityCounts(calls: { method: string }[]) {
  return {
    frame: calls.filter((item) => item.method === "computerFrame").length,
    ownership: calls.filter((item) => item.method === "computerOpen").length,
    teach: calls.filter((item) => item.method === "teachStatus").length,
    start: calls.filter((item) => item.method === "teachStart").length,
    stop: calls.filter((item) => item.method === "teachStop").length,
    pause: calls.filter((item) => item.method === "teachPause").length,
    input: calls.filter((item) => item.method === "computerInput").length
  }
}

it.skipIf(!enabled)(
  "hands off one actual Workspace viewer, preserves the Inspector draft and resumes only on authenticated return",
  async () => {
    const f = await fixture(false, false, false, true)
    try {
      await f.show()
      await f.ready()
      await f.page.locator(".bot-inspector-panel").evaluate((element) => {
        element.setAttribute("data-test-viewer", "original")
      })
      const original = f.page.locator('[data-test-viewer="original"]')
      await original.getByRole("button", { name: "接管操作", exact: true }).click()
      const draft = original.getByLabel("向浏览器输入文本", { exact: true })
      await draft.fill("保留在原查看器的草稿")
      await original.evaluate((element) => Reflect.set(window, "originalInspector", element))
      const target = f.broker.target(f.bot.id)
      const interaction = f.store.requestInteraction(f.parent.lease, {
        kind: "question",
        prompt: writeBotComputerHelp({
          version: 1,
          backend: "browser",
          instruction: "请在工作网页中完成登录",
          reason: "auth",
          hostId: f.parent.lease.owner,
          dataEpoch: f.store.dataEpoch(),
          botId: f.bot.id,
          runId: f.parent.run.id,
          runFence: f.parent.lease.fence,
          conversationId: f.parent.run.conversationId,
          generation: target.generation,
          controlEpoch: target.controlEpoch
        })
      })
      await f.sync()
      const card = f.page.getByLabel("电脑人工帮助", { exact: true })
      await card.waitFor()
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/help-card-dark.png"),
        animations: "disabled"
      })
      await card.getByRole("button", { name: "打开电脑", exact: true }).click()
      const help = f.page.locator('[data-fullscreen="true"]')
      await help.waitFor()
      expect(await help.count()).toBe(1)
      await help.evaluate((element) => element.setAttribute("data-test-viewer", "help"))
      try {
        await help.getByRole("img", { name: "实际浏览器页面", exact: true }).waitFor()
      } catch (error) {
        await writeFile(
          resolve("output/grok-computer-ui/help-failure-diagnostic.json"),
          JSON.stringify({
            visibleText: await help.innerText().catch(() => "Viewer closed"),
            methods: f.calls.map((call) => call.method),
            errors: f.errors,
            interactionStatus: f.store.getInteraction(interaction.id).status,
            runStatus: f.store.getRun(f.parent.run.id).status
          })
        )
        await f.page.screenshot({
          path: resolve("output/grok-computer-ui/help-failure.png"),
          animations: "disabled"
        })
        throw error
      }
      await help.getByRole("button", { name: "归还并继续", exact: true }).waitFor()
      const owner = f.broker.target(f.bot.id)
      expect(owner.control).toBe("human")
      expect(f.store.getRun(f.parent.run.id).status).toBe("waiting_input")
      await expect
        .poll(() => help.locator(".bot-computer-screen").getAttribute("aria-busy"))
        .toBe("false")
      // Current Hosts refresh the controlling viewer's continuous input lease
      // every 1500ms. The covered Inspector must not issue a second ticket or
      // accept input while that viewer owns presentation.
      expect(
        await original
          .getByRole("button", { name: "输入", exact: true, includeHidden: true })
          .isDisabled()
      ).toBe(true)
      // Hold the next real frame, then cross a complete polling interval. A
      // count sampled before a timer boundary can legitimately observe two
      // sequential heartbeats; an outstanding frame must never overlap another.
      f.holdNextFrame()
      await expect.poll(f.frameHeld, { timeout: 5000 }).toBe(true)
      const frames = f.calls.filter((call) => call.method === "computerFrame").length
      await new Promise((done) => setTimeout(done, 1700))
      expect(f.calls.filter((call) => call.method === "computerFrame")).toHaveLength(frames)
      f.releaseFrame()
      await f.page.screenshot({
        path: resolve("output/grok-computer-ui/help-handoff-dark.png"),
        animations: "disabled"
      })
      await help.getByRole("button", { name: "退出电脑全屏", exact: true }).click()
      await f.page
        .locator('[data-test-viewer="help"]')
        .getByRole("button", { name: "关闭电脑面板", exact: true })
        .click()
      expect(f.store.getInteraction(interaction.id).status).toBe("pending")
      expect(f.store.getRun(f.parent.run.id).status).toBe("waiting_input")
      expect(f.broker.target(f.bot.id).control).toBe("human")
      expect(await draft.inputValue()).toBe("保留在原查看器的草稿")
      expect(
        await original.evaluate((element) => element === Reflect.get(window, "originalInspector"))
      ).toBe(true)
      await card.getByRole("button", { name: "打开电脑", exact: true }).click()
      await help.getByRole("button", { name: "归还并继续", exact: true }).waitFor()
      await help.getByLabel("向浏览器输入文本", { exact: true }).fill("登录完成")
      await help.getByRole("button", { name: "输入", exact: true }).click()
      await expect.poll(() => f.edits.includes("登录完成")).toBe(true)
      await help.getByRole("button", { name: "归还并继续", exact: true }).click()
      await help.waitFor({ state: "hidden" })
      expect(f.store.getInteraction(interaction.id)).toMatchObject({
        status: "answered",
        answer: "done"
      })
      expect(f.store.getRun(f.parent.run.id).status).toBe("running")
      expect(f.broker.target(f.bot.id)).toMatchObject({
        generation: owner.generation,
        control: "bot",
        controlEpoch: owner.controlEpoch + 1
      })
      expect(f.calls.filter((call) => call.method === "computerRelease")).toHaveLength(0)
      const answers = f.calls.filter((call) => call.method === "answer")
      expect(answers).toHaveLength(1)
      expect(JSON.stringify(answers[0].input)).not.toContain("data:image")
      expect(JSON.stringify(answers[0].input).length).toBeLessThan(1024)
      expect(f.calls.filter((call) => call.method === "computerInput")).toHaveLength(1)
      expect(
        await original.evaluate((element) => element === Reflect.get(window, "originalInspector"))
      ).toBe(true)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  30_000
)

it.skipIf(!enabled)(
  "retires a held frame and renderer screenshot/status polling while the actual Inspector is covered",
  async () => {
    const f = await fixture(true, false, true)
    try {
      await f.show()
      await expect.poll(f.frameHeld).toBe(true)
      const controller = f.page.locator(".bot-teach-controls")
      await controller.evaluate((element) => Reflect.set(window, "coveredTeachElement", element))
      const initialControl = f.broker.target(f.bot.id)
      const runs = f.store.snapshot().runs.map((run) => run.id)
      await f.cover(true)
      const before = visibilityCounts(f.calls)
      f.releaseFrame()
      await new Promise((done) => setTimeout(done, 3400))
      const after = visibilityCounts(f.calls)
      const lateFrameCount = await f.page.locator(".bot-computer-screen img").count()
      await writeFile(
        resolve("output/grok-computer-ui/covered-idle-evidence.json"),
        JSON.stringify(
          {
            before,
            after,
            lateFrameCount,
            directory: f.directory,
            pageErrors: f.errors
          },
          null,
          2
        )
      )
      expect(lateFrameCount).toBe(0)
      expect(after).toEqual(before)
      expect(f.broker.target(f.bot.id)).toMatchObject({
        generation: initialControl.generation,
        controlEpoch: initialControl.controlEpoch,
        control: "bot"
      })
      expect(f.store.snapshot().runs.map((run) => run.id)).toEqual(runs)
      await f.cover(false)
      await f.ready()
      expect(
        await controller.evaluate(
          (element) => element === Reflect.get(window, "coveredTeachElement")
        )
      ).toBe(true)
      expect(visibilityCounts(f.calls).start).toBe(0)
      expect(visibilityCounts(f.calls).stop).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  30_000
)

it.skipIf(!enabled)(
  "preserves the real live recorder, human hold and draft across cover/uncover under development StrictMode and reduced motion",
  async () => {
    const f = await fixture(false, true, true)
    try {
      await f.page.emulateMedia({ reducedMotion: "reduce" })
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "示范给 Bot", exact: true }).click()
      await f.page.getByRole("button", { name: "暂停录制", exact: true }).waitFor()
      const session = f.teach.status(f.bot.id)!
      expect(session.phase).toBe("recording")
      await expect.poll(() => f.teach.repository.get(session.id).frameCount).toBeGreaterThan(0)
      const controller = f.page.locator(".bot-teach-controls")
      await controller.evaluate((element) => Reflect.set(window, "coveredTeachElement", element))
      const draft = f.page.getByLabel("向浏览器输入文本", { exact: true })
      await draft.fill("覆盖期间仍保留的未提交草稿")
      const previousImage = await f.page.locator(".bot-computer-screen img").getAttribute("src")
      const control = f.broker.target(f.bot.id)
      f.holdNextStatus()
      await f.call("teachPause", { id: session.id, paused: true })
      await expect.poll(f.statusHeld).toBe(true)
      await f.call("teachPause", { id: session.id, paused: false })
      expect(f.teach.repository.get(session.id).phase).toBe("recording")
      f.holdNextFrame()
      await f.broker.teachObserve(f.bot.id, async (page) => {
        await page.evaluate(() => {
          document.title = "覆盖期间的新画面"
          document.body.style.backgroundColor = "rgb(220,230,240)"
        })
      })
      await f.page.getByRole("button", { name: "刷新画面", exact: true }).click()
      await expect.poll(f.frameHeld).toBe(true)
      await f.page.evaluate(() => {
        Reflect.set(window, "coveredPhaseTransitions", [])
        const surface = document.querySelector(".bot-computer-content")!
        const observer = new MutationObserver(() => {
          Reflect.get(window, "coveredPhaseTransitions").push(
            surface.getAttribute("data-recording-phase")
          )
        })
        observer.observe(surface, { attributes: true, attributeFilter: ["data-recording-phase"] })
        Reflect.set(window, "coveredPhaseObserver", observer)
      })
      await f.cover(true)
      const before = visibilityCounts(f.calls)
      f.releaseFrame()
      f.releaseStatus()
      await new Promise((done) => setTimeout(done, 3400))
      const after = visibilityCounts(f.calls)
      const currentImage = await f.page.locator(".bot-computer-screen img").getAttribute("src")
      const phase = await f.page
        .locator("[data-recording-phase]")
        .getAttribute("data-recording-phase")
      const durable = f.teach.repository.get(session.id)
      const observed = await f.page.evaluate(() => ({
        mounts: Reflect.get(window, "fixtureEffectMounts"),
        cleanups: Reflect.get(window, "fixtureEffectCleanups"),
        transitions: Reflect.get(window, "coveredPhaseTransitions") as (string | null)[]
      }))
      await writeFile(
        resolve("output/grok-computer-ui/covered-recording-evidence.json"),
        JSON.stringify(
          {
            before,
            after,
            lateImageChanged: currentImage !== previousImage,
            phase,
            durablePhase: durable.phase,
            sameSession: f.teach.status(f.bot.id)?.id === session.id,
            observed,
            directory: f.directory,
            pageErrors: f.errors
          },
          null,
          2
        )
      )
      expect(currentImage === previousImage).toBe(true)
      expect(phase).toBe("recording")
      expect(observed).toEqual({ mounts: 2, cleanups: 1, transitions: [] })
      expect(after).toEqual(before)
      expect(durable.phase).toBe("recording")
      expect(f.teach.status(f.bot.id)?.id).toBe(session.id)
      expect(f.broker.target(f.bot.id)).toMatchObject({
        generation: control.generation,
        controlEpoch: control.controlEpoch,
        control: "human"
      })
      expect(
        await controller.evaluate(
          (element) => element === Reflect.get(window, "coveredTeachElement")
        )
      ).toBe(true)
      await f.page.evaluate(() => Reflect.get(window, "coveredPhaseObserver").disconnect())
      await f.cover(false)
      await f.page.getByRole("img", { name: "覆盖期间的新画面", exact: true }).waitFor()
      await f.page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
      await f.page.getByRole("button", { name: "暂停录制", exact: true }).waitFor()
      expect(await draft.inputValue()).toBe("覆盖期间仍保留的未提交草稿")
      expect(
        await controller.evaluate(
          (element) => element === Reflect.get(window, "coveredTeachElement")
        )
      ).toBe(true)
      expect(visibilityCounts(f.calls).start).toBe(1)
      expect(visibilityCounts(f.calls).stop).toBe(0)
      expect(visibilityCounts(f.calls).input).toBe(0)
      expect(f.teach.repository.list(f.bot.id)).toHaveLength(1)
      await f.page.getByRole("button", { name: "丢弃录制", exact: true }).click()
      await f.page.getByRole("button", { name: "示范给 Bot", exact: true }).waitFor()
      expect(f.teach.repository.get(session.id).phase).toBe("discarded")
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  40_000
)

it.skipIf(!enabled).each(["help", "downloads"] as const)(
  "pauses the real Workspace Inspector behind its %s Dialog and retires a late frame without changing its owner",
  async (surface) => {
    const f = await fixture(true, false, false, true)
    try {
      await f.show()
      await expect.poll(f.frameHeld).toBe(true)
      const screen = f.page.locator(".bot-computer-screen")
      await screen.evaluate((element) => Reflect.set(window, "originalWorkspaceScreen", element))
      const owner = f.broker.target(f.bot.id)
      const counts = () =>
        ["bot_runs", "bot_messages", "bot_effects", "bot_receipts"].map(
          (table) => f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
        )
      const beforeRows = counts()
      if (surface === "help")
        await f.page.getByRole("button", { name: "Bot 帮助", exact: true }).click()
      else {
        await f.page.getByRole("button", { name: "工作区菜单", exact: true }).click()
        await f.page.getByRole("menuitem", { name: "下载与保存", exact: true }).click()
      }
      const dialog = f.page.getByRole("dialog", {
        name: surface === "help" ? "Bot 帮助与信息" : "下载与保存",
        exact: true
      })
      await dialog.waitFor()
      const before = visibilityCounts(f.calls)
      f.releaseFrame()
      // Observe two original 1.5s polling opportunities; never change the product timer.
      await new Promise((done) => setTimeout(done, 3400))
      expect(visibilityCounts(f.calls)).toEqual(before)
      expect(await screen.locator("img").count()).toBe(0)
      expect(f.broker.target(f.bot.id)).toMatchObject({
        generation: owner.generation,
        controlEpoch: owner.controlEpoch,
        control: owner.control
      })
      expect(counts()).toEqual(beforeRows)
      await f.page.keyboard.press("Escape")
      await dialog.waitFor({ state: "hidden" })
      await f.ready()
      expect(
        await screen.evaluate(
          (element) => element === Reflect.get(window, "originalWorkspaceScreen")
        )
      ).toBe(true)
      expect(f.broker.target(f.bot.id)).toMatchObject({
        generation: owner.generation,
        controlEpoch: owner.controlEpoch,
        control: owner.control
      })
      expect(visibilityCounts(f.calls).frame).toBe(before.frame + 1)
      expect(visibilityCounts(f.calls).start).toBe(0)
      expect(visibilityCounts(f.calls).stop).toBe(0)
      expect(counts()).toEqual(beforeRows)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  30_000
)

it.skipIf(!enabled)(
  "keeps a newly quick-created Bot computer active after the successful feedback disappears",
  async () => {
    const f = await fixture(false, false, false, true)
    try {
      await f.show()
      await f.ready()
      await f.page.getByRole("button", { name: "新建聊天", exact: true }).click()
      await f.page
        .getByRole("region", { name: "新建聊天", exact: true })
        .getByRole("option")
        .filter({ hasText: "创建新 Bot" })
        .click()
      const createDialog = f.page.getByRole("dialog", { name: "创建 Bot", exact: true })
      await createDialog.getByRole("radio", { name: /^逐项确认/ }).check()
      await createDialog.getByRole("button", { name: "创建 Bot", exact: true }).click()
      await expect.poll(() => f.store.snapshot().bots.length).toBe(2)
      const created = f.store.snapshot().bots.find((bot) => bot.id !== f.bot.id)!
      const conversation = f.store
        .snapshot()
        .conversations.find((item) => item.kind === "direct" && item.members.includes(created.id))!
      await expect
        .poll(() => f.page.evaluate(() => Reflect.get(window, "fixtureSelection")()))
        .toBe(conversation.id)
      await f.page.getByRole("button", { name: "新建聊天", exact: true }).waitFor()
      expect(await f.page.getByRole("dialog", { name: "创建 Bot", exact: true }).count()).toBe(0)
      const creates = f.calls.filter((call) => call.method === "create")
      expect(creates).toHaveLength(1)
      expect(creates[0].input).toMatchObject({
        name: "新 Bot",
        modelRef: null,
        workspacePath: null,
        connectorIds: [],
        expectedDataEpoch: f.store.dataEpoch()
      })
      expect((creates[0].input as { nonce: string }).nonce).toMatch(/^[a-f0-9-]{36}$/)
      const rows = () =>
        ["bots", "bot_runs", "bot_messages", "bot_effects", "bot_receipts"].map(
          (table) => f.store.db.exec(`SELECT COUNT(*) FROM ${table}`)[0].values[0][0]
        )
      const beforeReplay = rows()
      const replay = await f.call<{ bot: { id: string }; conversationId: string }>(
        "create",
        creates[0].input
      )
      expect(replay.bot.id).toBe(created.id)
      expect(replay.conversationId).toBe(conversation.id)
      expect(rows()).toEqual(beforeReplay)
      await f.page.getByRole("button", { name: "查看 Bot 浏览器", exact: true }).click()
      const frameCalls = () =>
        f.calls.filter((call) => call.method === "computerFrame" && call.input === created.id)
          .length
      const statusCalls = () =>
        f.calls.filter((call) => call.method === "teachStatus" && call.input === created.id).length
      await expect.poll(frameCalls).toBeGreaterThan(0)
      await f.page.locator(".bot-computer-screen img").waitFor()
      await f.page.waitForFunction(
        () => document.querySelector(".bot-computer-screen")?.getAttribute("aria-busy") === "false"
      )
      const owner = f.broker.target(created.id)
      const screen = f.page.locator(".bot-computer-screen")
      await screen.evaluate((element) => Reflect.set(window, "newBotScreen", element))
      const before = { frame: frameCalls(), status: statusCalls() }
      // Observe two original 1.5s frame polling opportunities, without changing either timer.
      await new Promise((done) => setTimeout(done, 3400))
      expect(frameCalls()).toBeGreaterThan(before.frame)
      expect(statusCalls()).toBeGreaterThan(before.status)
      expect(
        await screen.evaluate((element) => element === Reflect.get(window, "newBotScreen"))
      ).toBe(true)
      expect(f.broker.target(created.id)).toMatchObject({
        generation: owner.generation,
        controlEpoch: owner.controlEpoch,
        control: owner.control
      })
      expect(rows()).toEqual(beforeReplay)
      expect(visibilityCounts(f.calls).start).toBe(0)
      expect(visibilityCounts(f.calls).stop).toBe(0)
      expect(visibilityCounts(f.calls).input).toBe(0)
      expect(f.errors).toEqual([])
    } finally {
      await f.stop()
    }
  },
  30_000
)
