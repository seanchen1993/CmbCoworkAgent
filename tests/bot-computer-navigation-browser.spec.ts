import { viteUrlAssetsFixture } from "./fixtures/vite-url-assets"
/** Actual React inspector/keyboard navigation with controlled frames and a narrow IPC bridge.
 * This tests local UI intent; it does not claim native desktop or remote input validation. */
import assert from "node:assert/strict"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium, type Page } from "playwright"
import type { BotBrowserFrame, BotHumanInput } from "../src/shared/bot-computer"

interface Calls {
  inputs: { target: BotBrowserFrame; input: BotHumanInput }[]
  take: (BotBrowserFrame & { conversationId: string; threadRootId?: string })[]
  release: BotBrowserFrame[]
  frame: number
  open: number
}
interface FrameState {
  get(): BotBrowserFrame
  set(value: BotBrowserFrame): void
  setHoldInput(value: boolean): void
  pending: (() => void)[]
}

function computerCalls(calls: Calls) {
  return {
    inputs: calls.inputs.length,
    take: calls.take.length,
    release: calls.release.length,
    frames: calls.frame,
    open: calls.open
  }
}

async function main() {
  const root = process.cwd()
  const renderer = join(root, "src/renderer/src")
  const output = resolve("output/bot-computer-navigation")
  await mkdir(output, { recursive: true })
  await rm(join(output, "results.json"), { force: true })
  const stylesheet = await compile(
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
      resolveDir: root,
      contents: `import'./src/renderer/src/components/bots/bot-workspace.css';import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotInspector}from'./src/renderer/src/components/bots/BotInspector';import{BotKeyboardHelp}from'./src/renderer/src/components/bots/BotKeyboardHelp';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';window.api={bots:{computerOpen:()=>window.fixtureOpen(),computerFrame:()=>window.fixtureFrame(),computerInput:input=>window.fixtureInput(input),computerTake:target=>window.fixtureTake(target),computerRelease:target=>window.fixtureRelease(target),teachStatus:async()=>null}};const bot={id:'bot-a',name:'工作 Bot',revision:1,status:'active',instructions:''};useBotWorkspaceStore.setState({host:{capabilities:[]},snapshot:{bots:[bot],conversations:[{id:'group-a',name:'协作群聊',members:['bot-a','bot-b'],kind:'group',revision:1}],runs:[],interactions:[],dataEpoch:'initial'}});function Fixture(){const[tab,setTab]=useState('computer'),[help,setHelp]=useState(false);return <div className='bot-workspace flex bg-background text-foreground' style={{width:960,height:720}}><button onClick={()=>setHelp(true)}>快捷键帮助</button><input aria-label='保留聊天草稿' defaultValue='保持主线任务'/><BotInspector bot={bot} conversationId='group-a' threadRootId='branch-a' tab={tab} onTabChange={setTab} settings={()=>{}} resource={()=>{}} close={()=>{}}/>{help&&<BotKeyboardHelp actions={[]} close={()=>setHelp(false)}/>}</div>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
    plugins: [
      viteUrlAssetsFixture(),
      {
        name: "preview-worker",
        setup(build) {
          build.onResolve({ filter: /code-highlight-worker\?worker$/ }, () => ({
            path: "highlight-worker",
            namespace: "preview-worker"
          }))
          build.onLoad({ filter: /.*/, namespace: "preview-worker" }, () => ({
            loader: "js",
            contents: `export default class extends Worker { constructor(options) { const url = URL.createObjectURL(new Blob([${JSON.stringify(highlight.outputFiles[0].text)}], {type:"text/javascript"})); super(url, options); URL.revokeObjectURL(url); } }`
          }))
        }
      }
    ]
  })
  const css =
    stylesheet.build(scanner.scan()) +
    (bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text || "")
  const js = bundle.outputFiles.find((file) => file.path.endsWith(".js")).text
  const frame: BotBrowserFrame = {
    botId: "bot-a",
    generation: "generation-a",
    controlEpoch: 1,
    control: "human",
    controlOwner: "self",
    controlOwnerConnected: true,
    viewId: "view-a",
    frameSeq: 1,
    width: 640,
    height: 360,
    url: "https://example.com/",
    title: "工作网页",
    image:
      "data:image/svg+xml;base64," +
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#303030"/></svg>'
      ).toString("base64"),
    tabs: [{ viewId: "view-a", title: "工作网页", url: "https://example.com/" }]
  }
  const checks: string[] = [],
    failures: { name: string; error: string }[] = [],
    pageErrors: string[] = [],
    localObservations: {
      name: string
      before: ReturnType<typeof computerCalls>
      after: ReturnType<typeof computerCalls>
    }[] = []
  const assertLocalComputerCalls = (
    name: string,
    before: ReturnType<typeof computerCalls>,
    calls: Calls
  ) => {
    const after = computerCalls(calls)
    localObservations.push({ name, before, after })
    assert.deepEqual(after, before, `${name}: local interaction changed computer RPCs`)
  }
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true,
    args: ["--disable-updater-scheduler"]
  })
  async function run(
    name: string,
    check: (page: Page, calls: Calls, state: FrameState) => Promise<void>,
    control: BotBrowserFrame["control"] = "human",
    platform = "darwin"
  ) {
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
    page.setDefaultTimeout(5000)
    const calls: Calls = { inputs: [], take: [], release: [], frame: 0, open: 0 },
      pending: (() => void)[] = []
    let current: BotBrowserFrame = {
        ...frame,
        control,
        controlOwner: control === "human" ? "self" : undefined
      },
      holdInput = false
    page.on("pageerror", (error) => pageErrors.push(`${name}: ${error.message}`))
    await page.exposeFunction("fixtureOpen", () => {
      calls.open++
      return current
    })
    await page.exposeFunction("fixtureFrame", () => {
      calls.frame++
      return current
    })
    await page.exposeFunction("fixtureInput", (input: Calls["inputs"][number]) => {
      calls.inputs.push(input)
      return holdInput
        ? new Promise<void>((resolve) => pending.push(() => resolve()))
        : Promise.resolve()
    })
    await page.exposeFunction("fixtureTake", (target: Calls["take"][number]) => {
      calls.take.push(target)
      current = { ...current, control: "human", controlOwner: "self" }
      return current
    })
    await page.exposeFunction("fixtureRelease", (target: BotBrowserFrame) => {
      calls.release.push(target)
      current = { ...current, control: "bot", controlOwner: undefined }
      return current
    })
    await page.addInitScript((platform) => {
      Reflect.set(window, "electron", { process: { platform } })
    }, platform)
    await page.route("http://127.0.0.1:43849/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${css}</style><div id='root'></div><script>${js}</script>`
      })
    )
    try {
      await page.goto("http://127.0.0.1:43849/")
      await page.waitForFunction(() => {
        const image = document.querySelector<HTMLImageElement>(".bot-computer-screen img")
        return (
          image?.complete &&
          image.naturalWidth > 0 &&
          !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
        )
      })
      await check(page, calls, {
        get: () => current,
        set: (value) => {
          current = value
        },
        setHoldInput: (value) => {
          holdInput = value
        },
        pending
      })
      checks.push(name)
      console.log(`PASS ${name}`)
    } catch (cause) {
      failures.push({ name, error: cause instanceof Error ? cause.message : String(cause) })
      console.log(`FAIL ${name}: ${failures.at(-1).error.split("\n")[0]}`)
    } finally {
      pending.splice(0).forEach((release) => release())
      await page.close()
    }
  }
  try {
    await run(
      "real Tab enters screen; local escape exits without RPC; Tab reaches control",
      async (page, calls) => {
        const screen = page.locator(".bot-computer-screen")
        await page.getByLabel("浏览器网址", { exact: true }).focus()
        await page.keyboard.press("Tab")
        assert.equal(await screen.evaluate((node) => document.activeElement === node), true)
        const before = computerCalls(calls)
        await page.keyboard.press("Control+Alt+Escape")
        assert.equal(
          await page
            .getByRole("button", { name: "归还 Bot", exact: true })
            .evaluate((node) => document.activeElement === node),
          true,
          "local shortcut left focus trapped in remote screen"
        )
        assert.equal(
          await page
            .getByRole("button", { name: "归还 Bot", exact: true })
            .evaluate(
              (node) =>
                node.matches(":focus-visible") &&
                (getComputedStyle(node).outlineStyle !== "none" ||
                  getComputedStyle(node).boxShadow !== "none")
            ),
          true,
          "returned control has no visible keyboard focus"
        )
        assertLocalComputerCalls("ready screen focus exit", before, calls)
        assert.equal(calls.release.length, 0, "focus escape released control")
        await page.keyboard.press("Tab")
        assert.equal(
          await page
            .getByRole("button", { name: "刷新画面", exact: true })
            .evaluate((node) => document.activeElement === node),
          true
        )
        const hint = await screen.getAttribute("aria-describedby")
        assert.ok(hint)
        assert.match(await page.locator(`[id='${hint}']`).innerText(), /⌃.*⌥.*Esc/)
        assert.equal(await screen.getAttribute("aria-keyshortcuts"), "Control+Alt+Escape")
      }
    )
    await run(
      "ordinary Tab Shift+Tab Escape F6 remain remote; plain Escape keeps expanded",
      async (page, calls) => {
        await page.getByRole("button", { name: "展开电脑面板", exact: true }).click()
        const screen = page.locator(".bot-computer-screen")
        for (const key of ["Tab", "Shift+Tab", "Escape", "F6"]) {
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
          )
          await screen.focus()
          await page.keyboard.press(key)
          const expected = key === "Shift+Tab" ? "Shift+Tab" : key
          await page.waitForFunction(
            () =>
              !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
          )
          assert.equal(calls.inputs.at(-1)?.input.key, expected)
          assert.equal(await screen.evaluate((node) => document.activeElement === node), true)
          assert.equal(
            await page.locator(".bot-inspector-panel").getAttribute("data-expanded"),
            "true"
          )
        }
        assert.equal(calls.take.length + calls.release.length, 0)
      }
    )
    await run(
      "local escape works before frame is ready without dispatching input",
      async (page, calls, state) => {
        const screen = page.locator(".bot-computer-screen")
        await screen.focus()
        const held = { ...state.get(), frameSeq: 2, image: "http://127.0.0.1:43849/held-frame" }
        await page.route(
          held.image,
          (route) =>
            new Promise<void>((resolve) =>
              state.pending.push(() =>
                route
                  .fulfill({
                    contentType: "image/svg+xml",
                    body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>'
                  })
                  .then(resolve)
              )
            )
        )
        state.set(held)
        // Dispatch starts the existing refresh while retaining real screen focus.
        await page.getByRole("button", { name: "刷新画面", exact: true }).dispatchEvent("click")
        await page.waitForFunction(() =>
          document
            .querySelector<HTMLImageElement>(".bot-computer-screen img")
            ?.src.endsWith("/held-frame")
        )
        const before = computerCalls(calls)
        await page.keyboard.press("Control+Alt+Escape")
        assert.equal(
          await page
            .getByRole("button", { name: "归还 Bot", exact: true })
            .evaluate((node) => document.activeElement === node),
          true
        )
        assertLocalComputerCalls("unseen frame focus exit", before, calls)
        state.pending.splice(0).forEach((release) => release())
      }
    )
    await run(
      "local escape during in-flight input focuses visible controls fallback without replay",
      async (page, calls, state) => {
        const screen = page.locator(".bot-computer-screen")
        state.setHoldInput(true)
        await screen.focus()
        await page.keyboard.press("Tab")
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled ===
            true
        )
        assert.equal(calls.inputs.length, 1)
        const before = computerCalls(calls)
        await page.keyboard.press("Control+Alt+Escape")
        const controls = page.getByRole("group", { name: "电脑操作控件", exact: true })
        assert.equal(
          await controls.evaluate(
            (node) =>
              document.activeElement === node &&
              node.matches(":focus-visible") &&
              getComputedStyle(node).boxShadow !== "none"
          ),
          true
        )
        assert.equal(calls.inputs.length, 1)
        assertLocalComputerCalls("in-flight input focus exit", before, calls)
        assert.equal(calls.release.length, 0)
        state.pending.splice(0).forEach((release) => release())
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLButtonElement>('button[aria-label="刷新画面"]')?.disabled
        )
        await page.keyboard.press("Tab")
        assert.equal(
          await page
            .getByRole("button", { name: "归还 Bot", exact: true })
            .evaluate((node) => document.activeElement === node),
          true
        )
      }
    )
    for (const key of ["click", "Enter", "Space"]) {
      await run(
        `preview ${key} expands existing inspector without remote input or control transfer`,
        async (page, calls) => {
          const screen = page.locator(".bot-computer-screen")
          assert.equal(
            await page.locator(".bot-computer-content").getAttribute("data-preview"),
            "true"
          )
          const before = computerCalls(calls)
          if (key === "click") await screen.locator("img").click()
          else {
            await screen.focus()
            await page.keyboard.press(key)
          }
          assert.equal(
            await page.locator(".bot-inspector-panel").getAttribute("data-expanded"),
            "true",
            "preview activation did not expand its parent inspector"
          )
          assert.equal(
            await page.locator(".bot-computer-content").getAttribute("data-preview"),
            null
          )
          assertLocalComputerCalls(`preview ${key} expansion`, before, calls)
          assert.equal(calls.take.length + calls.release.length, 0)
          assert.equal(await page.getByLabel("保留聊天草稿").inputValue(), "保持主线任务")
          await page.getByRole("button", { name: "接管操作", exact: true }).click()
          assert.equal(calls.take.length, 1)
          assert.equal(calls.take[0].botId, "bot-a")
          assert.equal(calls.take[0].conversationId, "group-a")
          assert.equal(calls.take[0].threadRootId, "branch-a")
        },
        "bot"
      )
    }
    await run(
      "Windows visible help and screen hint agree on local escape chord",
      async (page) => {
        const screen = page.locator(".bot-computer-screen")
        const id = await screen.getAttribute("aria-describedby")
        assert.ok(id)
        assert.match(await page.locator(`[id='${id}']`).innerText(), /Ctrl.*Alt.*Esc/)
        await page.getByRole("button", { name: "快捷键帮助", exact: true }).click()
        const row = page.getByRole("dialog").locator("dl > div").filter({ hasText: "回到电脑控件" })
        assert.equal(await row.count(), 1)
        assert.equal(await row.locator("kbd").innerText(), "Ctrl + Alt + Esc")
      },
      "human",
      "win32"
    )
  } finally {
    await browser.close()
  }
  const result = {
    checks,
    failures,
    pageErrors,
    localObservations,
    completedAt: new Date().toISOString()
  }
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify({ checks: checks.length, failures: failures.length, pageErrors }))
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(failures, [])

  assert.equal(checks.length, 8, "All eight computer navigation checks must run")
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
