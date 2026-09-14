import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

const project = process.cwd()
const renderer = join(project, "src/renderer/src")
const baseline = process.env.CHAT_LAYOUT_BASELINE_REF
const output = resolve(
  process.env.CHAT_LAYOUT_ARTIFACT_DIR || "output/chat-layout",
  baseline ? "baseline" : "current"
)
mkdirSync(output, { recursive: true })
const css = await compile(
  readFileSync(join(renderer, "index.css"), "utf8").replace(/^@import "@fontsource[^\n]+\n/gm, ""),
  { base: renderer, onDependency: () => undefined }
)
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const bundle = await build({
  entryPoints: [join(project, "tests/support/chat-layout-fixture.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env.DEV": "false" },
  alias: { "@": renderer },
  plugins: [
    {
      name: "fixture-isolation",
      setup(builder) {
        builder.onResolve({ filter: /^@\/lib\/thread-context$/ }, () => ({
          path: "thread-context",
          namespace: "fixture-context"
        }))
        builder.onLoad({ filter: /.*/, namespace: "fixture-context" }, () => ({
          contents: "export const useThreadStateSelector=(_threadId, selector)=>selector({})",
          loader: "tsx"
        }))
        builder.onLoad({ filter: /(?:ChatMessageVirtualList|MessageBubble)\.tsx$/ }, (args) => {
          let contents = baseline
            ? execFileSync(
                "git",
                ["show", `${baseline}:${relative(project, args.path).replace(/\\/g, "/")}`],
                { encoding: "utf8" }
              )
            : readFileSync(args.path, "utf8")
          if (args.path.endsWith("MessageBubble.tsx")) {
            const marker = "  const [collapsedTools,"
            assert.equal(
              contents.split(marker).length - 1,
              1,
              "Render counter must be inserted once"
            )
            contents = contents.replace(
              marker,
              "  window.chatLayoutRenders++;\n  const [collapsedTools,"
            )
          }
          return { contents, loader: "tsx" }
        })
        builder.onResolve(
          { filter: /^\.\/(ToolCallRenderer|MessageFeedbackDialog|HookLogViews)$/ },
          (args) => ({ path: args.path, namespace: "fixture" })
        )
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
          contents: args.path.includes("HookLog")
            ? "export const HookLogChip=()=>null"
            : args.path.includes("Feedback")
              ? "export const MessageFeedbackDialog=()=>null"
              : "export const ToolCallRenderer=()=>null",
          loader: "tsx"
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath()) ? {} : { channel: "msedge" }),
  headless: true
})
const results = []
try {
  const page = await browser.newPage({
    viewport: { width: Number(process.env.CHAT_LAYOUT_WIDTH) || 920, height: 700 },
    deviceScaleFactor: Number(process.env.CHAT_LAYOUT_DPR) || 1
  })
  const errors = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.stack)
  })
  await page.setContent(
    '<style>body{margin:0}#viewport{height:100vh;overflow:auto}#root{max-width:760px;margin:auto;padding:24px}</style><div id="viewport"><div id="root"></div></div>'
  )
  await page.addStyleTag({ content: css.build(scanner.scan()) })
  await page.evaluate(() => {
    window.chatLayoutRenders = 0
  })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator('[data-chat-message-id="message-199"]').waitFor({ state: "attached" })
  await page.waitForTimeout(700)
  assert.ok(
    await page.evaluate(() => window.chatLayoutRenders > 0),
    "Render counter must be active"
  )
  async function check(name, fn) {
    try {
      results.push({ name, passed: true, details: await fn() })
    } catch (error) {
      results.push({ name, passed: false, error: String(error) })
    }
    console.log(JSON.stringify(results.at(-1)))
  }
  await check("virtual row spacing is included in measured heights", async () => {
    const rows = await page.locator("[data-item-index]").evaluateAll((elements) =>
      elements.map((el) => ({
        index: el.dataset.itemIndex,
        height: el.getBoundingClientRect().height,
        known: Number(el.dataset.knownSize),
        margin:
          parseFloat(getComputedStyle(el).marginTop) +
          parseFloat(getComputedStyle(el).marginBottom),
        gap: el.nextElementSibling
          ? el.nextElementSibling.getBoundingClientRect().top - el.getBoundingClientRect().bottom
          : 0
      }))
    )
    writeFileSync(join(output, "row-measurements.json"), JSON.stringify(rows, null, 2))
    assert.ok(rows.length > 1)
    assert.ok(
      rows.every(
        (row) => row.margin === 0 && Math.abs(row.gap) <= 1 && Math.abs(row.height - row.known) <= 1
      ),
      JSON.stringify(rows)
    )
    return rows
  })
  await check("expanded reasoning survives virtual unmount", async () => {
    const button = page.locator('[data-chat-message-id="message-198"] button[aria-expanded]')
    await button.click()
    assert.equal(await button.getAttribute("aria-expanded"), "true")
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(output, "reasoning-expanded.png") })
    await page.evaluate(() => window.chatLayoutFixture.seek(0))
    await page.locator('[data-chat-message-id="message-198"]').waitFor({ state: "detached" })
    await page.evaluate(() => window.chatLayoutFixture.seek(198))
    await button.waitFor()
    await page.waitForTimeout(400)
    assert.equal(await button.getAttribute("aria-expanded"), "true")
  })
  await check("manual collapse survives streaming updates and virtual unmount", async () => {
    await page.evaluate(() => {
      window.chatLayoutFixture.stream(2)
      window.chatLayoutFixture.seek(199)
    })
    const button = page.locator('[data-chat-message-id="message-199"] button[aria-expanded]')
    await button.waitFor()
    await page.waitForTimeout(250)
    assert.equal(await button.getAttribute("aria-expanded"), "true")
    await button.click()
    await page.evaluate(() => window.chatLayoutFixture.stream(3))
    assert.equal(await button.getAttribute("aria-expanded"), "false")
    await page.evaluate(() => window.chatLayoutFixture.seek(0))
    await button.waitFor({ state: "detached" })
    await page.evaluate(() => window.chatLayoutFixture.seek(199))
    await button.waitFor()
    await page.waitForTimeout(250)
    assert.equal(await button.getAttribute("aria-expanded"), "false")
  })
  await check("long streaming reasoning follows the tail without blank frames", async () => {
    const button = page.locator('[data-chat-message-id="message-199"] button[aria-expanded]')
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click()
    await page.waitForTimeout(300)
    await page.evaluate(() => window.chatLayoutFixture.follow())
    const samples = await page.evaluate(async () => {
      const viewport = document.getElementById("viewport")
      const samples = []
      let active = true
      function sample() {
        if (!active) return
        const rect = viewport.getBoundingClientRect()
        samples.push({
          top: viewport.scrollTop,
          height: viewport.scrollHeight,
          visible: [...document.querySelectorAll("[data-chat-message-row]")].some((row) => {
            const box = row.getBoundingClientRect()
            return box.bottom > rect.top && box.top < rect.bottom
          })
        })
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      for (let tick = 4; tick <= 45; tick++) {
        window.chatLayoutFixture.stream(tick)
        await new Promise((done) => setTimeout(done, 80))
      }
      await new Promise((done) => setTimeout(done, 1200))
      active = false
      return samples
    })
    writeFileSync(join(output, "stream-samples.json"), JSON.stringify(samples))
    const blankFrames = samples.filter((sample) => !sample.visible).length
    const reversals = samples.filter(
      (sample, index) =>
        index &&
        sample.top < samples[index - 1].top - 2 &&
        sample.height >= samples[index - 1].height
    ).length
    const last = samples.at(-1)
    const details = {
      frames: samples.length,
      blankFrames,
      reversals,
      bottomGap: last.height - last.top - 700
    }
    assert.equal(blankFrames, 0, JSON.stringify(details))
    assert.equal(reversals, 0, JSON.stringify(details))
    assert.ok(details.bottomGap <= 32, JSON.stringify(details))
    await page.evaluate(() => window.chatLayoutFixture.complete())
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "true",
      "explicit expansion remains after completion"
    )
    await page.screenshot({ path: join(output, "stream-complete.png") })
    return details
  })
  await check("automatic reasoning remains open after reasoning-only completion", async () => {
    await page.evaluate(() => window.chatLayoutFixture.resetAutomatic())
    const button = page.locator('[data-chat-message-id="message-199"] button[aria-expanded]')
    await button.waitFor()
    assert.equal(await button.getAttribute("aria-expanded"), "true")
    await page.evaluate(() => window.chatLayoutFixture.complete())
    assert.equal(await button.getAttribute("aria-expanded"), "true")
    await page.evaluate(() => window.chatLayoutFixture.seek(0))
    await button.waitFor({ state: "detached" })
    await page.evaluate(() => window.chatLayoutFixture.seek(199))
    await button.waitFor()
    assert.equal(await button.getAttribute("aria-expanded"), "true")
  })
  await check("automatic reasoning collapses when an answer starts", async () => {
    await page.evaluate(() => {
      window.chatLayoutFixture.stream(5)
      window.chatLayoutFixture.answer()
    })
    const button = page.locator('[data-chat-message-id="message-199"] button[aria-expanded]')
    assert.equal(await button.getAttribute("aria-expanded"), "false")
    await page.evaluate(() => window.chatLayoutFixture.stream(6))
    assert.equal(
      await button.getAttribute("aria-expanded"),
      "false",
      "later reasoning does not reopen a collapsed phase"
    )
  })
  await check(
    "manual reopen before the answer does not suppress the existing automatic collapse",
    async () => {
      await page.evaluate(() => window.chatLayoutFixture.resetAutomatic())
      const button = page.locator('[data-chat-message-id="message-199"] button[aria-expanded]')
      await button.waitFor()
      await button.click()
      await button.click()
      assert.equal(await button.getAttribute("aria-expanded"), "true")
      await page.evaluate(() => window.chatLayoutFixture.answer())
      assert.equal(await button.getAttribute("aria-expanded"), "false")
      await button.click()
      await page.evaluate(() => window.chatLayoutFixture.answer())
      assert.equal(
        await button.getAttribute("aria-expanded"),
        "true",
        "auto-collapse runs only once"
      )
    }
  )
  await check("unchanged updates do not rerender historical bubbles", async () => {
    await page.evaluate(() => window.chatLayoutFixture.complete())
    await page.waitForTimeout(400)
    await page.evaluate(() => window.chatLayoutFixture.seek(0))
    await page.locator('[data-chat-message-id="message-0"]').waitFor({ state: "attached" })
    await page.waitForTimeout(400)
    const metrics = await page.evaluate(() => {
      const before = window.chatLayoutRenders
      const started = performance.now()
      for (let i = 0; i < 100; i++) window.chatLayoutFixture.repaint()
      return {
        renders: window.chatLayoutRenders - before,
        durationMs: performance.now() - started,
        mountedRows: document.querySelectorAll("[data-chat-message-row]").length
      }
    })
    assert.equal(metrics.renders, 0, JSON.stringify(metrics))
    assert.ok(metrics.mountedRows >= 5 && metrics.mountedRows < 40, JSON.stringify(metrics))
    return metrics
  })
  for (const phase of ["answer", "tool"]) {
    await check(`reasoning catches up ${phase} completion while unmounted`, async () => {
      await page.evaluate(() => window.chatLayoutFixture.resetAutomatic())
      const row = page.locator('[data-chat-message-id="message-199"]')
      const button = row.locator("button[aria-expanded]")
      await button.waitFor()
      assert.equal(await button.getAttribute("aria-expanded"), "true")
      await page.evaluate(() => window.chatLayoutFixture.seek(0))
      await row.waitFor({ state: "detached" })
      await page.evaluate((phase) => {
        window.chatLayoutFixture[phase]()
        window.chatLayoutFixture.complete()
      }, phase)
      assert.equal(await row.count(), 0, "Completion must happen while the row is unmounted")
      await page.evaluate(() => window.chatLayoutFixture.seek(199))
      await button.waitFor()
      assert.equal(await button.getAttribute("aria-expanded"), "false")
      await button.click()
      await page.evaluate(() => window.chatLayoutFixture.seek(0))
      await row.waitFor({ state: "detached" })
      await page.evaluate(() => window.chatLayoutFixture.seek(199))
      await button.waitFor()
      assert.equal(
        await button.getAttribute("aria-expanded"),
        "true",
        "Manual reopening is retained"
      )
    })
  }
  await check("no uncaught render errors", async () => assert.deepEqual(errors, []))
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2))
  assert.ok(
    results.every((result) => result.passed),
    "Chat layout regression; see " + output
  )
} finally {
  await browser.close()
}
