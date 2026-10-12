/** Actual React/Chrome lifecycle with a delayed narrow browser transport.
 * This verifies viewer work; it does not claim OS desktop or input validation. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { BotBrowserFrame } from "../src/shared/bot-computer"

async function main() {
  const root = resolve(import.meta.dirname, ".."),
    renderer = join(root, "src/renderer/src"),
    output = join(root, "output/bot-computer-view-lifetime")
  await mkdir(output, { recursive: true })
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
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotComputer}from'./src/renderer/src/components/bots/BotComputer';import{useAppStore}from'./src/renderer/src/lib/store';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';import{useBotWorkspaceStore}from'./src/renderer/src/lib/bot-workspace-store';window.fixtureEpoch=value=>useBotWorkspaceStore.setState(state=>({host:{...state.host,hostId:value,dataEpoch:value,capabilities:[]}}));window.api={bots:{computerOpen:()=>window.fixtureOpen(),computerFrame:()=>window.fixtureFrame(),computerTake:target=>window.fixtureTake(target),teachStatus:async()=>null,computerInput:async input=>{const result=await window.fixtureInput(input);window.fixtureAcknowledged=true;return result;}}};applyThemePreference('codex-dark');window.fixtureSettings=value=>useAppStore.setState({showCustomizeView:value});function Fixture(){const[mode,setMode]=useState('active');const covered=useAppStore(state=>state.showCustomizeView);window.fixtureMode=setMode;return <main className="min-h-screen bg-background text-foreground" data-mode={mode} data-covered={covered}>{mode!=='closed'&&<section style={{display:mode==='hidden'?'none':'flex',height:640}}><BotComputer botId="bot" conversationId="conversation" name="工作 Bot" expanded active={mode==='active'}/></section>}</main>};createRoot(document.getElementById('root')).render(<Fixture/>);`
    },
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    outfile: join(output, "fixture.js"),
    jsx: "automatic",
    alias: { "@": renderer },
    define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" }
  })
  const frame: BotBrowserFrame = {
    botId: "bot",
    generation: "generation",
    controlEpoch: 1,
    control: "human",
    controlOwner: "self",
    controlOwnerConnected: true,
    viewId: "view",
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
    tabs: [{ viewId: "view", title: "工作网页", url: "https://example.com/" }]
  }
  const checks: string[] = [],
    failures: { name: string; error: string }[] = [],
    errors: string[] = []
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  try {
    for (const fault of ["open", "frame", "input"] as const) {
      const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
      page.setDefaultTimeout(10000)
      page.on("pageerror", (error) => errors.push(error.message))
      let opens = 0,
        frames = 0,
        inputs = 0
      const watching: BotBrowserFrame =
        fault === "input" ? frame : { ...frame, control: "bot", controlOwner: undefined }
      await page.exposeFunction("fixtureOpen", () => {
        opens++
        return fault === "open" && opens === 1
          ? { botFailure: { code: "transport_error", message: "合成连接暂不可用" } }
          : watching
      })
      await page.exposeFunction("fixtureFrame", () => {
        frames++
        return fault === "frame" && frames === 1
          ? { botFailure: { code: "transport_error", message: "合成画面暂不可用" } }
          : { ...watching, frameSeq: frames }
      })
      await page.exposeFunction("fixtureInput", () => {
        inputs++
        return { botFailure: { code: "transport_error", message: "合成输入结果待核对" } }
      })
      await page.route("http://127.0.0.1:43139/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset='utf-8'><style>${stylesheet.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
        })
      )
      const name =
        fault === "input"
          ? "input: uncertain input retains its notice after observation recovers, without replay"
          : `${fault}: recovered observation must not claim unsent input was cancelled`
      try {
        await page.goto("http://127.0.0.1:43139/")
        await page.getByRole("img", { name: "工作网页", exact: true }).waitFor()
        if (fault === "input") {
          await page.getByLabel("向浏览器输入文本", { exact: true }).fill("合成待核对输入")
          await page.getByRole("button", { name: "输入", exact: true }).click()
          await page.getByText("合成输入结果待核对", { exact: true }).waitFor()
          // Legacy human frames keep their painted input ticket until a
          // requested refresh; passive checks only verify control ownership.
          await page.getByRole("button", { name: "刷新画面", exact: true }).click()
          await page
            .getByText("操作未确认，已取消尚未发送的输入，请核对画面后重试。", { exact: true })
            .waitFor()
          assert.equal(inputs, 1, "An uncertain input must not be replayed")
        } else {
          // Ordinary passive capture recovers the connection and clears its
          // error. No keyboard/pointer operation or pending input existed.
          await page.getByRole("alert").waitFor({ state: "hidden" })
          assert.equal(inputs, 0)
          assert.equal(await page.getByText(/尚未发送的输入/).count(), 0)
        }
        checks.push(name)
      } catch (failure) {
        failures.push({ name, error: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        await page.close()
      }
    }
    for (const mode of ["closed", "hidden", "settings"] as const) {
      for (const outcome of ["accepted", "rejected"] as const) {
        const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
        page.setDefaultTimeout(10000)
        page.on("pageerror", (error) => errors.push(error.message))
        let frames = 0,
          inputs = 0,
          release: ((value: unknown) => void) | undefined
        await page.exposeFunction("fixtureOpen", () => frame)
        await page.exposeFunction("fixtureFrame", () => {
          frames++
          return { ...frame, frameSeq: frames }
        })
        await page.exposeFunction("fixtureCounts", () => ({
          frames,
          inputs,
          pending: Boolean(release)
        }))
        await page.exposeFunction("fixtureInput", () => {
          inputs++
          return new Promise((resolve) => {
            release = resolve
          })
        })
        await page.route("http://127.0.0.1:43139/**", (route) =>
          route.fulfill({
            contentType: "text/html",
            body: `<!doctype html><meta charset='utf-8'><style>${stylesheet.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
          })
        )
        const name = `${mode}: ${outcome} input completion starts no hidden capture`
        try {
          await page.goto("http://127.0.0.1:43139/")
          await page.getByLabel("向浏览器输入文本", { exact: true }).fill("已交办输入")
          const submit = page.getByRole("button", { name: "输入", exact: true })
          await submit.click()
          await page.waitForFunction(
            async () => (await Reflect.get(window, "fixtureCounts")()).pending
          )
          assert.equal(inputs, 1)
          assert.ok(release)
          const before = frames
          if (mode === "settings") {
            await page.evaluate(() => Reflect.get(window, "fixtureSettings")(true))
            await page.locator('main[data-covered="true"]').waitFor()
          } else {
            await page.evaluate((value) => Reflect.get(window, "fixtureMode")(value), mode)
            await page.locator(`main[data-mode="${mode}"]`).waitFor({ state: "attached" })
          }
          release(
            outcome === "accepted"
              ? undefined
              : { botFailure: { code: "transport_error", message: "输入结果待核对" } }
          )
          await page.waitForFunction(() => Reflect.get(window, "fixtureAcknowledged") === true)
          await page.evaluate(async () => {
            await new Promise(requestAnimationFrame)
            await new Promise(requestAnimationFrame)
          })
          assert.equal(frames, before, "Hidden/closed input completion started a new screenshot")
          assert.equal(inputs, 1, "Input must not be replayed")
          if (mode !== "closed") {
            if (mode === "settings")
              await page.evaluate(() => Reflect.get(window, "fixtureSettings")(false))
            else await page.evaluate(() => Reflect.get(window, "fixtureMode")("active"))
            await page.getByLabel("向浏览器输入文本", { exact: true }).fill("下一条输入")
            await page.waitForFunction(
              () => !document.querySelector('button[aria-label="输入"]')?.hasAttribute("disabled")
            )
            assert.equal(frames, before + 1, "Reopening must observe again before enabling input")
            assert.equal(inputs, 1)
          }
          checks.push(name)
        } catch (failure) {
          failures.push({
            name,
            error: failure instanceof Error ? failure.message : String(failure)
          })
        } finally {
          release?.(undefined)
          await page.close()
        }
      }
    }
    for (const change of ["takeover", "hidden", "epoch"] as const) {
      const page = await browser.newPage({ viewport: { width: 960, height: 720 } })
      page.setDefaultTimeout(10000)
      page.on("pageerror", (error) => errors.push(error.message))
      let frames = 0,
        takes = 0,
        activeFrames = 0,
        maximumFrames = 0,
        pending: ((value: BotBrowserFrame) => void) | undefined
      let current: BotBrowserFrame = {
        ...frame,
        control: "bot",
        controlOwner: undefined,
        title: "当前画面"
      }
      await page.exposeFunction("fixtureOpen", () => current)
      await page.exposeFunction("fixtureFrame", async () => {
        frames++
        activeFrames++
        maximumFrames = Math.max(maximumFrames, activeFrames)
        try {
          if (frames === 2)
            return await new Promise<BotBrowserFrame>((resolve) => {
              pending = resolve
            })
          return { ...current, frameSeq: frames }
        } finally {
          activeFrames--
        }
      })
      await page.exposeFunction("fixtureCounts", () => ({ frames, pending: Boolean(pending) }))
      await page.exposeFunction("fixtureTake", () => {
        takes++
        current = { ...current, control: "human", controlOwner: "self", controlEpoch: 2 }
        return current
      })
      await page.route("http://127.0.0.1:43139/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><meta charset='utf-8'><style>${stylesheet.build(scanner.scan())}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
        })
      )
      const name = `${change}: passive capture never locks takeover or overwrites a newer owner`
      try {
        await page.goto("http://127.0.0.1:43139/")
        await page.waitForFunction(
          async () => (await Reflect.get(window, "fixtureCounts")()).pending
        )
        const take = page.getByRole("button", { name: "接管操作", exact: true })
        assert.equal(await take.isEnabled(), true, "Automatic capture must not lock takeover")
        assert.equal(
          await page.getByRole("button", { name: "刷新画面", exact: true }).isEnabled(),
          true,
          "Automatic capture must not animate or lock manual refresh"
        )
        // Leave the read unresolved across another polling period. No queue may accumulate.
        await page.waitForTimeout(1700)
        assert.equal(frames, 2)
        assert.equal(maximumFrames, 1)
        if (change === "takeover") {
          await take.click()
          await page.getByRole("button", { name: "归还 Bot", exact: true }).waitFor()
          assert.equal(takes, 1)
          assert.equal(maximumFrames, 2, "At most one passive read overlaps one manual refresh")
        } else if (change === "hidden") {
          await page.evaluate(() => Reflect.get(window, "fixtureMode")("hidden"))
          await page.locator('main[data-mode="hidden"]').waitFor({ state: "attached" })
        } else {
          current = { ...current, title: "恢复后的画面", generation: "restored" }
          await page.evaluate(() => Reflect.get(window, "fixtureEpoch")("restored-data"))
          await page.getByRole("img", { name: "恢复后的画面", exact: true }).waitFor()
        }
        const before = frames
        pending!({ ...frame, control: "bot", controlOwner: undefined, title: "已废弃旧画面" })
        await page.waitForFunction(
          async () => (await Reflect.get(window, "fixtureCounts")()).frames >= 2
        )
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame)
          await new Promise(requestAnimationFrame)
        })
        assert.equal(await page.getByRole("img", { name: "已废弃旧画面", exact: true }).count(), 0)
        if (change === "takeover")
          assert.equal(
            await page.getByRole("button", { name: "归还 Bot", exact: true }).isEnabled(),
            true
          )
        if (change === "hidden") {
          await page.waitForTimeout(1700)
          assert.equal(frames, before, "Hidden panel must stop polling")
        }
        await page.evaluate(() => Reflect.get(window, "fixtureMode")("closed"))
        await page.locator('main[data-mode="closed"]').waitFor({ state: "attached" })
        const closedFrames = frames
        await page.waitForTimeout(1700)
        assert.equal(frames, closedFrames, "Unmounted panel must release polling timers")
        checks.push(name)
      } catch (failure) {
        failures.push({ name, error: failure instanceof Error ? failure.message : String(failure) })
      } finally {
        pending?.(frame)
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
  const result = { checks, failures, errors, physicalClose: new Date().toISOString() }
  await writeFile(join(output, "results.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify(result))
  assert.deepEqual(errors, [])
  assert.deepEqual(failures, [])
  assert.equal(checks.length, 12)
}
void main().catch((failure) => {
  console.error(failure)
  process.exitCode = 1
})
