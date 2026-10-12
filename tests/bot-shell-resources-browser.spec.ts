/** Actual Help/React/Chrome; the Main read/reveal boundary is a controlled fixture. */
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { build } from "esbuild"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"
import { chromium } from "playwright"
import type { BotDesktopShellResourceReview } from "../src/shared/bot-shell-resources"

async function main() {
  const root = resolve(import.meta.dirname, "..")
  const renderer = join(root, "src/renderer/src")
  const output = join(root, "output/bot-shell-resources")
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
      contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{BotHelp}from'./src/renderer/src/components/bots/BotHelp';import{applyThemePreference}from'./src/renderer/src/lib/theme-preference';
window.electron={process:{platform:'darwin',versions:{}},ipcRenderer:{invoke:async()=> '1.5.3'}};window.api={update:{getStatus:async()=>({})},botShellResources:{inspect:()=>window.fixtureInspect(),reveal:input=>window.fixtureReveal(input),revealDiagnostics:()=>window.fixtureReveal(null)}};window.fixtureTheme=applyThemePreference;applyThemePreference('codex-light');function Fixture(){const[visible,setVisible]=useState(true);window.fixtureVisible=setVisible;return visible?<BotHelp host={null} disconnected close={()=>setVisible(false)} refresh={async()=>{}} openSettings={()=>{}} openKeyboard={()=>{}}/>:null};createRoot(document.getElementById('root')).render(<Fixture/>);`
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
  const ready: BotDesktopShellResourceReview = {
    mode: "exclusive",
    review: {
      state: "ready",
      reason: "none",
      entries: [],
      title: "命令现场已核对",
      hint: "没有未确认关闭的命令现场。"
    }
  }
  const nonce = "e2b4a405-c38f-4d4b-a5b2-e47842eacebc"
  let snapshot = ready
  let reads = 0
  let heldRead: (() => void) | undefined
  let holdRead = false
  let failedRead = false
  let heldReveal: (() => void) | undefined
  let holdReveal = false
  const reveals: unknown[] = []
  const browser = await chromium.launch({
    channel: process.platform === "win32" ? "msedge" : "chrome",
    headless: true
  })
  const page = await browser.newPage({ viewport: { width: 960, height: 760 } })
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const checks: string[] = []
  try {
    await page.exposeFunction("fixtureInspect", async () => {
      reads++
      const captured = snapshot
      if (holdRead) {
        holdRead = false
        await new Promise<void>((resolve) => {
          heldRead = resolve
        })
      }
      if (failedRead) {
        failedRead = false
        return { botFailure: { code: "transport_error", message: "controlled read failure" } }
      }
      return captured
    })
    await page.exposeFunction("fixtureReveal", async (input: unknown) => {
      reveals.push(input)
      if (holdReveal) {
        holdReveal = false
        await new Promise<void>((resolve) => {
          heldReveal = resolve
        })
      }
    })
    await page.route("http://127.0.0.1:43129/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><meta charset='utf-8'><style>${stylesheet.build(scanner.scan())}${bundle.outputFiles.find((file) => file.path.endsWith(".css"))?.text || ""}</style><div id='root'></div><script>${bundle.outputFiles.find((file) => file.path.endsWith(".js"))!.text}</script>`
      })
    )
    await page.goto("http://127.0.0.1:43129/")
    await page.getByRole("tab", { name: "使用指南", exact: true }).waitFor()
    assert.equal(reads, 0)
    await page.getByRole("tab", { name: "关于与反馈", exact: true }).click()
    const review = page
      .getByRole("region", { name: "运行诊断信息", exact: true })
      .locator('section[aria-label="命令现场核对"]')
    await review.getByText("没有未确认关闭的命令现场。", { exact: true }).waitFor()
    assert.equal(reads, 1)
    assert.equal(
      await page.getByRole("button", { name: "重启后台", exact: true }).isDisabled(),
      true
    )
    checks.push("Diagnostic tab reads once without a Host; guide does not read resources")

    snapshot = {
      mode: "exclusive",
      review: {
        state: "requires_review",
        reason: "physical-closure-unproven",
        title: "有命令尚未确认停止",
        hint: "请保留现场，核对命令是否停止。",
        entries: [
          {
            nonce,
            runId: "fixture-run",
            hostId: "previous-host",
            dataEpoch: "epoch",
            phase: "closure-unproven",
            runAuthorized: true,
            status: "effect-unproven"
          }
        ]
      }
    }
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await review.getByText("命令现场待核对", { exact: true }).waitFor()
    holdReveal = true
    await review.getByRole("button", { name: `查看现场记录 ${nonce}`, exact: true }).click()
    await page.waitForFunction(() =>
      document
        .querySelector('[aria-label="命令现场核对"] button[aria-label]')
        ?.hasAttribute("disabled")
    )
    assert.deepEqual(reveals, [{ nonce }])
    heldReveal!()
    await review.getByRole("button", { name: "打开诊断目录", exact: true }).click()
    assert.deepEqual(reveals, [{ nonce }, null])
    assert.equal(await review.getByRole("button", { name: /清除|重试命令|继续命令/ }).count(), 0)
    checks.push(
      "Unknown resource keeps read-only record and folder actions; no clear/replay authority"
    )

    snapshot = { ...snapshot, mode: "active-owner" }
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await review.getByText("运行中或待确认", { exact: true }).waitFor()
    assert.equal(await review.getByText("命令现场待核对", { exact: true }).count(), 0)
    await review.getByText(snapshot.review.hint, { exact: true }).waitFor()
    assert.equal(
      await review
        .getByText("运行中的命令尚未确认关闭；完成后可重新核对。", { exact: true })
        .count(),
      0,
      "A live Host is not proof that an unconfirmed command is still running"
    )
    checks.push("Active lifetime owner is displayed as current work, not abandoned work")

    failedRead = true
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await review.getByRole("alert").waitFor()
    assert.equal(await review.getByText("运行中或待确认", { exact: true }).count(), 0)
    snapshot = ready
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await review.getByText(ready.review.hint, { exact: true }).waitFor()
    checks.push("A failed read removes stale readiness and explicit retry reads fresh state")

    holdRead = true
    snapshot = { ...ready, review: { ...ready.review, hint: "obsolete result must not appear" } }
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await page.getByRole("tab", { name: "使用指南", exact: true }).click()
    snapshot = ready
    await page.getByRole("tab", { name: "关于与反馈", exact: true }).click()
    await review.getByText(ready.review.hint, { exact: true }).waitFor()
    heldRead!()
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    assert.equal(
      await review.getByText("obsolete result must not appear", { exact: true }).count(),
      0
    )
    checks.push("Unmounted diagnostic tab's late reply cannot overwrite a newly mounted view")

    snapshot = {
      mode: "exclusive",
      review: {
        ...ready.review,
        entries: Array.from({ length: 64 }, (_, index) => ({
          nonce: `e2b4a405-c38f-4d4b-a5b2-${String(index).padStart(12, "0")}`,
          runId: "long-project-task-".repeat(20),
          hostId: "host",
          dataEpoch: "epoch",
          phase: "resource-closed",
          runAuthorized: true,
          status: "cleanup-pending"
        }))
      }
    }
    await review.getByRole("button", { name: "重新核对", exact: true }).click()
    await review.getByRole("listitem").last().waitFor()
    assert.equal(await review.getByRole("listitem").count(), 64)
    await page.setViewportSize({ width: 420, height: 620 })
    await page.evaluate(() => window.fixtureTheme("codex-dark"))
    await review.getByRole("button", { name: "打开诊断目录", exact: true }).scrollIntoViewIfNeeded()
    const dialog = page.getByRole("dialog")
    const bounds = await dialog.boundingBox()
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 420 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 620
    )
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true
    )
    await page.screenshot({ path: join(output, "review-dark-narrow.png") })
    checks.push("64 bounded records and long task identities preserve narrow dark dialog geometry")
    assert.deepEqual(errors, [])
    await writeFile(
      join(output, "checks.json"),
      JSON.stringify(
        { completedAt: new Date().toISOString(), checks, reads, pageErrors: errors },
        null,
        2
      )
    )
    console.log(`PASS ${checks.length} resource review journeys; page errors ${errors.length}`)
  } catch (error) {
    await page.screenshot({ path: join(output, "failure.png") }).catch(() => {})
    throw error
  } finally {
    heldRead?.()
    heldReveal?.()
    await browser.close()
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
