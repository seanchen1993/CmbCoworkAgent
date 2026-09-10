/** Real Chromium DOM tests plus a deterministic pre-paint Markdown mount budget.
 * The list's bubble chrome is replaced with the actual StreamingMarkdown renderer.
 * CHAT_NAVIGATION_BASELINE_REF optionally runs the same scenarios against a Git revision.
 */
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { _electron, type Page } from "playwright"

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const binary = require("electron") as string
const baseline = process.env.CHAT_NAVIGATION_BASELINE_REF
const artifacts = join(projectRoot, "output/chat-navigation", baseline ? "baseline" : "current")
mkdirSync(artifacts, { recursive: true })

async function activeMatch(page: Page) {
  return page.evaluate(() => {
    const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> }).highlights
    const range = [...(registry.get("chat-search-active") ?? [])][0]
    const rect = range?.getBoundingClientRect()
    const viewport = document.getElementById("viewport")!
    const box = viewport.getBoundingClientRect()
    return {
      status: document.querySelector("[aria-live]")?.textContent,
      scrollTop: viewport.scrollTop,
      visible: Boolean(rect && rect.top >= box.top && rect.bottom <= box.bottom),
      highlightedText: range?.toString() ?? ""
    }
  })
}

async function waitForActiveMatch(page: Page): Promise<void> {
  const deadline = Date.now() + 5_000
  let stableChecks = 0
  while (Date.now() < deadline) {
    stableChecks = (await activeMatch(page)).visible ? stableChecks + 1 : 0
    if (stableChecks >= 3) return
    await page.waitForTimeout(50)
  }
  assert.fail(`No visible search occurrence: ${JSON.stringify(await activeMatch(page))}`)
}

async function main(): Promise<void> {
  const workerBundle = await build({
    entryPoints: [join(projectRoot, "src/renderer/src/lib/chat-search.worker.ts")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false
  })
  writeFileSync(join(artifacts, "search-worker.js"), workerBundle.outputFiles[0].text)
  const bundle = await build({
    entryPoints: [join(projectRoot, "tests/support/chat-navigation-fixture.tsx")],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    alias: { "@": join(projectRoot, "src/renderer/src") },
    plugins: [
      {
        name: "navigation-fixture",
        setup(builder) {
          if (baseline)
            builder.onLoad(
              {
                filter:
                  /(?:ChatSearchOverlay|StreamingMarkdown|ChatMessageVirtualList|chat-search-visible-content)\.tsx?$/
              },
              (args) => ({
                contents: execFileSync(
                  "git",
                  ["show", `${baseline}:${relative(projectRoot, args.path).replace(/\\/g, "/")}`],
                  { cwd: projectRoot, encoding: "utf8" }
                ),
                loader: "tsx"
              })
            )
          builder.onResolve({ filter: /^\.\/MessageBubble$/ }, () => ({
            path: "bubble",
            namespace: "fixture"
          }))
          builder.onResolve({ filter: /^\.\/HookLogViews$/ }, () => ({
            path: "hooks",
            namespace: "fixture"
          }))
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, (args) => ({
            contents:
              args.path === "hooks"
                ? "export const HookLogChip=()=>null"
                : `import {StreamingMarkdown} from ${JSON.stringify(join(projectRoot, "src/renderer/src/components/chat/StreamingMarkdown.tsx"))};
          export function MessageBubble({message}) {
            window.chatNavigationMetrics.renders++;
            return <StreamingMarkdown>{message.content}</StreamingMarkdown>
          }`,
            loader: "tsx",
            resolveDir: projectRoot
          }))
        }
      }
    ]
  })
  const isolated = mkdtempSync(join(tmpdir(), "cmb-chat-navigation-browser-"))
  const html = join(isolated, "index.html")
  writeFileSync(
    html,
    '<style>body{font:16px Arial}p{margin:0;line-height:24px;overflow-wrap:anywhere}[data-chat-search-overlay]{position:fixed;top:10px}button svg{width:18px;height:18px}</style><div id="root"></div>'
  )
  const entry = join(isolated, "main.cjs")
  writeFileSync(
    entry,
    `const {app,BrowserWindow}=require("electron");
    app.whenReady().then(()=>{const w=new BrowserWindow({show:true,width:1000,height:800,
      webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(html)})});`
  )
  const env = { ...process.env, CMB_E2E_ELECTRON_BIN: binary, CMB_E2E_DISABLE_GPU: "1" }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await _electron.launch({
    executablePath:
      process.platform === "win32"
        ? join(projectRoot, "tests/support/electron-launcher.cmd")
        : binary,
    args: [entry, `--user-data-dir=${join(isolated, "profile")}`],
    env,
    timeout: 30_000
  })
  const results: Array<{ name: string; passed: boolean; details?: unknown; error?: string }> = []
  const page = await app.firstWindow()
  await page.waitForURL(/index\.html$/)
  await page.bringToFront()
  page.setDefaultTimeout(10_000)
  const errors: string[] = []
  page.on("pageerror", (error) => {
    errors.push(error.message)
    console.error(error.stack)
  })
  const check = async (name: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      results.push({ name, passed: true, details: await run() })
    } catch (error) {
      results.push({ name, passed: false, error: String(error) })
    }
    console.log(JSON.stringify(results.at(-1)))
  }
  try {
    await page.addScriptTag({ content: "window.__name = (value) => value" })
    await page.evaluate((source) => {
      window.chatSearchWorkerUrl = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" })
      )
    }, workerBundle.outputFiles[0].text)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    const open = async (
      kind: "occurrences" | "folded" | "delayed" | "dense" | "tail" | "inline"
    ): Promise<void> => {
      await page.evaluate((value) => window.chatNavigationFixture.mountSearch(value), kind)
      await page.getByPlaceholder("在当前会话中搜索").waitFor()
      // Let the search's initial focus/selection frame finish before entering the query.
      await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => done())))
      await page.getByPlaceholder("在当前会话中搜索").fill("needle")
      await page.waitForFunction(() =>
        document.querySelector("[aria-live]")?.textContent?.includes("1/")
      )
    }
    await check("different occurrences in one tall message", async () => {
      await open("occurrences")
      await waitForActiveMatch(page)
      const first = await activeMatch(page)
      await page.getByRole("button", { name: "下一个匹配" }).click()
      await waitForActiveMatch(page)
      const second = await activeMatch(page)
      assert(first.visible && second.visible, JSON.stringify({ first, second }))
      assert(second.scrollTop - first.scrollTop > 1000)
      await page.getByRole("button", { name: "上一个匹配" }).click()
      await page.waitForFunction(
        (top) => Math.abs(document.getElementById("viewport")!.scrollTop - top) < 4,
        first.scrollTop
      )
      assert((await activeMatch(page)).visible)
      return { first, second }
    })
    await check("folded assistant search exposes its middle", async () => {
      await open("folded")
      await waitForActiveMatch(page)
      assert((await activeMatch(page)).visible, "the hit must be inside the viewport")
      assert.equal(await page.getByRole("button", { name: "展开全文", exact: true }).count(), 1)
      assert.equal(await page.locator("[data-chat-search-context-key]").count(), 1)
      assert((await page.locator("[data-chat-search-context-key]").innerText()).length <= 4096)
      assert.equal((await activeMatch(page)).highlightedText, "needle")
      await page.screenshot({ path: join(artifacts, "folded-search.png") })
    })
    await check("tail remains searchable after streaming completes", async () => {
      await open("tail")
      await waitForActiveMatch(page)
      await page.evaluate(() => window.chatNavigationFixture.tick!())
      await page.waitForTimeout(600)
      assert.equal((await activeMatch(page)).highlightedText, "needle")
      assert.equal(await page.getByRole("button", { name: "展开全文", exact: true }).count(), 1)
    })
    await check(
      "manual expansion still renders the original body and close releases its context",
      async () => {
        await open("folded")
        await waitForActiveMatch(page)
        await page.getByRole("button", { name: "展开全文", exact: true }).click()
        const length = await page
          .locator("[data-chat-search-source-start]")
          .evaluateAll((nodes) =>
            nodes.reduce((sum, node) => sum + (node.textContent?.length ?? 0), 0)
          )
        assert(length >= 100_006, "manual expansion preserves the full original answer")
        await page.getByRole("button", { name: "关闭搜索" }).click()
        assert.equal(await page.locator("[data-chat-search-context-key]").count(), 0)
      }
    )
    await check("highlight spans inline Markdown nodes", async () => {
      await open("inline")
      await page.getByPlaceholder("在当前会话中搜索").fill("alpha needle omega")
      await waitForActiveMatch(page)
      assert.equal((await activeMatch(page)).highlightedText, "alpha needle omega")
      assert.equal(await page.locator("[data-chat-search-context-key]").count(), 0)
    })
    await check("dense Markdown search stays bounded across twenty navigations", async () => {
      await open("dense")
      await waitForActiveMatch(page)
      const beforeNodes = await page.locator("#viewport *").count()
      const timings: number[] = []
      const longTasks: number[] = []
      for (let sample = 0; sample < 20; sample += 1) {
        await page.getByPlaceholder("在当前会话中搜索").fill("")
        await page.waitForFunction(() => !document.querySelector("[aria-live]")?.textContent)
        await page.evaluate(() => {
          const metrics = { elapsed: 0, longTasks: [] as number[] }
          ;(window as unknown as { searchPerf: typeof metrics }).searchPerf = metrics
          const observer = new PerformanceObserver((list) => {
            metrics.longTasks.push(...list.getEntries().map((entry) => entry.duration))
          })
          observer.observe({ type: "longtask" })
          document.querySelector("input")!.addEventListener(
            "input",
            () => {
              const start = performance.now()
              const poll = (): void => {
                const registry = (CSS as unknown as { highlights: Map<string, Set<Range>> })
                  .highlights
                const range = [...(registry.get("chat-search-active") ?? [])][0]
                if (range?.toString() === "needle") {
                  metrics.elapsed = performance.now() - start
                  setTimeout(() => observer.disconnect(), 100)
                } else requestAnimationFrame(poll)
              }
              requestAnimationFrame(poll)
            },
            { once: true }
          )
        })
        await page.getByPlaceholder("在当前会话中搜索").fill("needle")
        await page.waitForFunction(
          () => (window as unknown as { searchPerf: { elapsed: number } }).searchPerf.elapsed > 0
        )
        await page.waitForTimeout(120)
        const metrics = await page.evaluate(
          () =>
            (
              window as unknown as {
                searchPerf: { elapsed: number; longTasks: number[] }
              }
            ).searchPerf
        )
        timings.push(metrics.elapsed)
        longTasks.push(...metrics.longTasks)
      }
      assert.equal(await page.getByRole("button", { name: "展开全文", exact: true }).count(), 1)
      assert.equal(
        await page.locator("[data-chat-search-context-key]").count(),
        0,
        "head hit uses existing DOM"
      )
      const afterNodes = await page.locator("#viewport *").count()
      assert(afterNodes <= beforeNodes + 5, `${beforeNodes} -> ${afterNodes}`)
      assert.equal(longTasks.length, 0, `search introduced long tasks: ${longTasks}`)
      const sorted = [...timings].sort((a, b) => a - b)
      await page.screenshot({ path: join(artifacts, "dense-search.png") })
      return { beforeNodes, afterNodes, timings, median: sorted[10], p95: sorted[18], longTasks }
    })
    await check("multi-block cold indexing limits input, IPC and UI work", async () => {
      const samples = []
      for (let index = 0; index < 20; index += 1) {
        const sample = await page.evaluate(() => window.chatNavigationFixture.stressSearch())
        assert(sample.inputUnits <= 256 * 1024)
        assert(sample.maxPacketBytes < 64 * 1024)
        assert(sample.matches > 0)
        samples.push(sample)
      }
      const sorted = samples.map((sample) => sample.preparationMs).sort((a, b) => a - b)
      assert(sorted[18] < 8, `UI preparation exceeds frame budget: ${sorted}`)
      return { samples, preparationP95: sorted[18] }
    })
    await check("stream repaint never remounts an offscreen result", async () => {
      await open("occurrences")
      const before = await page.evaluate(() => window.chatNavigationMetrics.reveals.length)
      await page.evaluate(() => {
        window.chatNavigationFixture.hideRow!()
        window.chatNavigationFixture.tick!()
      })
      await page.waitForTimeout(600)
      assert.equal(await page.evaluate(() => window.chatNavigationMetrics.reveals.length), before)
    })
    await check("durable hydration uses committed callbacks despite local repaint", async () => {
      await open("delayed")
      await page.waitForFunction(() => Boolean(window.chatNavigationFixture.finishHydration))
      await page.evaluate(() => {
        window.chatNavigationFixture.tick!()
        window.chatNavigationFixture.finishHydration!()
      })
      await waitForActiveMatch(page)
      const reveals = await page.evaluate(() => window.chatNavigationMetrics.reveals)
      assert.deepEqual(reveals, [true])
      assert((await activeMatch(page)).visible)
    })
    await check("closing search invalidates an outstanding durable reveal", async () => {
      await open("delayed")
      await page.waitForFunction(() => Boolean(window.chatNavigationFixture.finishHydration))
      await page.getByRole("button", { name: "关闭搜索" }).click()
      await page.evaluate(() => window.chatNavigationFixture.finishHydration!())
      await page.waitForTimeout(200)
      assert.deepEqual(await page.evaluate(() => window.chatNavigationMetrics.reveals), [])
      assert.equal((await activeMatch(page)).highlightedText, "")
    })
    await check("manual scroll supersedes a pending durable navigation", async () => {
      await open("delayed")
      await page.waitForFunction(() => Boolean(window.chatNavigationFixture.finishHydration))
      await page.evaluate(() => {
        document.getElementById("viewport")!.dispatchEvent(new WheelEvent("wheel", { deltaY: -50 }))
        window.chatNavigationFixture.finishHydration!()
      })
      await page.waitForTimeout(300)
      assert.deepEqual(await page.evaluate(() => window.chatNavigationMetrics.reveals), [])
      assert.equal((await activeMatch(page)).scrollTop, 0)
    })
    await check("new query supersedes a pending durable navigation", async () => {
      await open("delayed")
      await page.waitForFunction(() => Boolean(window.chatNavigationFixture.finishHydration))
      await page.getByPlaceholder("在当前会话中搜索").fill("")
      await page.evaluate(() => window.chatNavigationFixture.finishHydration!())
      await page.waitForTimeout(300)
      assert.deepEqual(await page.evaluate(() => window.chatNavigationMetrics.reveals), [])
      assert.equal((await activeMatch(page)).highlightedText, "")
    })
    for (const count of [1, 80, 100, 101, 128]) {
      await check(`cached switch pre-paint budget: ${count} rows`, async () => {
        await page.evaluate((value) => window.chatNavigationFixture.mountList(value), count)
        await page.waitForFunction(() => Boolean(window.chatNavigationMetrics.beforeParent))
        const metrics = await page.evaluate(() => window.chatNavigationMetrics.beforeParent!)
        console.log(JSON.stringify({ count, ...metrics }))
        assert.equal(metrics.renders, 0, `pre-paint Markdown renders: ${JSON.stringify(metrics)}`)
        await page.waitForFunction(
          () => document.querySelectorAll("[data-chat-message-id]").length > 0
        )
        return metrics
      })
    }
    assert.deepEqual(errors, [], "no unhandled browser errors")
  } finally {
    writeFileSync(
      join(artifacts, "browser-results.json"),
      JSON.stringify({ baseline, results, errors }, null, 2)
    )
    await app.close()
  }
  assert(
    results.every((result) => result.passed),
    "Some navigation regressions failed"
  )
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
