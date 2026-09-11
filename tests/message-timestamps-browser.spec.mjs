import assert from "node:assert/strict"
// Real message rows and Markdown with isolated tool/dialog dependencies. Run with
// npm run test:message-timestamps:browser; screenshots go to ignored output/.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { build } from "esbuild"
import { chromium } from "playwright"
import { compile } from "@tailwindcss/node"
import { Scanner } from "@tailwindcss/oxide"

const project = process.cwd()
const output = resolve("output/message-timestamps")
mkdirSync(output, { recursive: true })
const renderer = resolve("src/renderer/src")
const cssSource = readFileSync(join(renderer, "index.css"), "utf8").replace(
  /^@import "@fontsource[^\n]+\n/gm,
  ""
)
const css = await compile(cssSource, { base: renderer, onDependency: () => undefined })
const scanner = new Scanner({
  sources: [{ base: renderer, pattern: "**/*.{ts,tsx}", negated: false }]
})
const stylesheet = css.build(scanner.scan())
const bundle = await build({
  entryPoints: [join(project, "tests/support/message-timestamps-fixture.tsx")],
  bundle: true,
  platform: "browser",
  format: "iife",
  write: false,
  jsx: "automatic",
  loader: { ".png": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
  alias: { "@": renderer },
  plugins: [
    {
      name: "fixture-isolation",
      setup(builder) {
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
        builder.onLoad({ filter: /message-bubble-timing\.ts$/ }, (args) => ({
          contents: readFileSync(args.path, "utf8").replace(
            "const date = new Date(time)",
            "window.timestampFormats++; const date = new Date(time)"
          ),
          loader: "ts"
        }))
      }
    }
  ]
})
const browser = await chromium.launch({
  ...(existsSync(chromium.executablePath())
    ? {}
    : { channel: process.platform === "win32" ? "msedge" : "chrome" }),
  headless: true
})
try {
  const context = await browser.newContext({
    viewport: { width: 920, height: 700 },
    timezoneId: "Asia/Shanghai"
  })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setContent(
    '<style>body{margin:0}#viewport{height:100vh;overflow:auto}#root{max-width:760px;margin:auto;padding:24px}</style><div id="viewport"><div id="root"></div></div>'
  )
  await page.addStyleTag({ content: stylesheet })
  await page.addScriptTag({ content: bundle.outputFiles[0].text })
  await page.locator("time").first().waitFor()
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => window.actions.push(["copy", text]) }
    })
  )
  const results = []
  async function check(name, fn) {
    await fn()
    results.push(name)
    console.log("PASS " + name)
  }
  const user = page.locator('[data-chat-message-id="user"]')
  const assistant = page.locator('[data-chat-message-id="assistant"]')
  async function opacity(locator) {
    return locator.evaluate((el) => {
      let value = 1
      for (let p = el; p; p = p.parentElement) value *= Number(getComputedStyle(p).opacity)
      return value
    })
  }
  await check("full timestamps are visible without hover and controls stay hidden", async () => {
    assert.ok(await page.evaluate(() => window.timestampFormats >= 2))
    assert.equal(await user.locator("time").innerText(), "2026-09-10 14:32")
    assert.equal(await user.locator("time").getAttribute("datetime"), "2026-09-10 14:32")
    assert.equal(await opacity(user.locator("time")), 1)
    assert.equal(await opacity(user.getByRole("button", { name: "编辑后重新发送" })), 0)
    assert.match(await assistant.locator("time").innerText(), /开始于 2026-09-10 14:32/)
    assert.equal(await assistant.locator("time").getAttribute("datetime"), "2026-09-10 14:32")
    assert.match(await assistant.innerText(), /耗时 18s/)
  })
  await page.screenshot({ path: join(output, "timestamps-light.png") })
  await check(
    "unchanged history and completion updates perform zero timestamp formatting",
    async () => {
      const before = await page.evaluate(() => window.timestampFormats)
      await page.evaluate(() => {
        for (let i = 0; i < 100; i++) window.fixture.repaint()
        window.fixture.endUpdate()
      })
      assert.equal(await page.evaluate(() => window.timestampFormats), before)
    }
  )
  await check("restored start time passes both row and bubble memo boundaries", async () => {
    await page.evaluate(() => window.fixture.startUpdate())
    assert.match(await assistant.locator("time").innerText(), /14:35/)
  })
  await check("hover reveals controls without moving the timestamp", async () => {
    const before = await user.locator("time").boundingBox()
    await user.hover()
    await page.waitForTimeout(250)
    assert.equal(await opacity(user.getByRole("button", { name: "编辑后重新发送" })), 1)
    assert.deepEqual(await user.locator("time").boundingBox(), before)
    await user.getByRole("button", { name: "复制消息", exact: true }).click()
    await user.getByRole("button", { name: "编辑后重新发送" }).click()
    await user.getByRole("button", { name: "设为 Goal" }).click()
    const actions = await page.evaluate(() => window.actions)
    assert.deepEqual(
      actions.map((a) => a[0]),
      ["copy", "edit", "goal"]
    )
    assert.equal(actions[0][1], "帮我分析一下本周项目进展。")
    assert.equal(actions[2][1], "帮我分析一下本周项目进展。")
  })
  await check("keyboard focus exposes message actions", async () => {
    await page.mouse.move(0, 0)
    await user.getByRole("button", { name: "编辑后重新发送" }).focus()
    await page.waitForTimeout(250)
    assert.equal(await opacity(user.getByRole("button", { name: "编辑后重新发送" })), 1)
  })
  await check("dark and narrow layouts keep complete timestamps inside the viewport", async () => {
    await page.evaluate(() => {
      document.activeElement?.blur()
      window.fixture.theme("nord-dark")
    })
    await page.mouse.move(0, 0)
    await page.waitForTimeout(250)
    await page.screenshot({ path: join(output, "timestamps-dark.png") })
    await page.setViewportSize({ width: 360, height: 700 })
    const bounds = await page.locator("time").evaluateAll((nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect()
        return {
          left: r.left,
          right: r.right,
          width: r.width,
          client: n.clientWidth,
          scroll: n.scrollWidth
        }
      })
    )
    for (const b of bounds) {
      assert.ok(b.left >= 0 && b.right <= 360, JSON.stringify(b))
      assert.ok(b.scroll <= b.client || b.client === 0)
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360))
    await page.screenshot({ path: join(output, "timestamps-narrow.png") })
  })
  await check("streamed content keeps start time stable without reformatting it", async () => {
    const before = await page.evaluate(() => window.timestampFormats)
    await page.evaluate(() => window.fixture.stream())
    assert.match(await assistant.locator("time").innerText(), /14:35/)
    assert.equal(await page.evaluate(() => window.timestampFormats), before)
  })
  await check("long user messages still expand and collapse", async () => {
    await page.evaluate(() => window.fixture.longUser())
    await user.getByRole("button", { name: "显示更多", exact: true }).click()
    await user.getByRole("button", { name: "收起", exact: true }).click()
    assert.equal(await opacity(user.locator("time")), 1)
  })
  await check("invalid historical timestamps are omitted safely", async () => {
    await page.evaluate(() => window.fixture.invalid())
    assert.equal(await page.locator("time").count(), 0)
  })
  await check("large history still virtualizes message rows", async () => {
    await page.setViewportSize({ width: 920, height: 700 })
    await page.evaluate(() => window.fixture.large())
    await page.waitForTimeout(500)
    const mounted = await page.locator("[data-chat-message-row]").count()
    assert.ok(mounted > 0 && mounted < 100, `mounted rows: ${mounted}`)
    const before = await page.evaluate(() => window.timestampFormats)
    await page.evaluate(() => window.fixture.repaint())
    assert.equal(await page.evaluate(() => window.timestampFormats), before)
    console.log("Virtualized rows: " + mounted + " / 2000")
  })
  assert.deepEqual(errors, [])
  writeFileSync(
    join(output, "browser-results.json"),
    JSON.stringify({ passed: results, errors }, null, 2)
  )
} finally {
  await browser.close()
}
