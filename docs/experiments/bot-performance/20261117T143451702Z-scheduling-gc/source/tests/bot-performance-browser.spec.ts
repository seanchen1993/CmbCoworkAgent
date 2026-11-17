/** Electron renderer performance observations using production hooks. No production profile/IM. */
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { _electron } from "playwright"

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "bot-perf-renderer-"))
  let app: Awaited<ReturnType<typeof _electron.launch>> | undefined
  const report: any = {
    kind: "production React hooks; simulated metadata IPC",
    recordedAt: new Date().toISOString(),
    cases: []
  }
  try {
    const bundle = await build({
      entryPoints: [resolve("tests/support/bot-performance-browser-fixture.tsx")],
      bundle: true,
      write: false,
      outdir: dir,
      platform: "browser",
      format: "iife",
      jsx: "automatic",
      alias: { "@": resolve("src/renderer/src") },
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [
        {
          name: "fixture-store",
          setup(p) {
            p.onResolve({ filter: /^@\/lib\/store$/ }, () => ({ path: "store", namespace: "perf" }))
            p.onLoad({ filter: /.*/, namespace: "perf" }, () => ({
              contents:
                "export const useAppStore = Object.assign(() => ({}), { getState: () => ({}) });"
            }))
          }
        }
      ]
    })
    await writeFile(
      join(dir, "index.html"),
      '<meta charset="utf-8"><style>' +
        bundle.outputFiles
          .filter((f) => f.path.endsWith(".css"))
          .map((f) => f.text)
          .join("\n") +
        '</style><div id="root"></div><script>' +
        bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text +
        "</script>"
    )
    await writeFile(
      join(dir, "main.cjs"),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(join(dir, "profile"))});app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(dir, "index.html"))}));`
    )
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({
      executablePath: createRequire(import.meta.url)("electron") as string,
      args: [join(dir, "main.cjs")],
      env
    })
    const page = await app.firstWindow()
    // React's snapshot commit precedes its refresh effect. A momentary zero in-flight
    // count is not completion; require a quiet period after the last request/notification.
    const idle = () =>
      page.waitForFunction(() => {
        const s = (window as any).botPerf
        return (
          s?.loaded &&
          s.revisionShown === s.revision &&
          !s.loading &&
          !s.inFlight &&
          performance.now() - s.lastActivityAt >= 200
        )
      })
    await idle()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(e.message))
    const observe = async (name: string, action: () => Promise<any>) => {
      await idle()
      await page.evaluate(() => {
        const s = (window as any).botPerf
        s.reset()
        s.startAt = performance.now()
      })
      await action()
      await idle()
      const result = await page.evaluate(() => {
        const s = (window as any).botPerf
        return {
          loaded: s.loaded,
          latencyMs: s.latency,
          counts: s.counts,
          peak: s.peak,
          maxBatch: s.maxBatch,
          requestSpanMs: Math.round((s.lastActivityAt - s.startAt) * 100) / 100,
          elapsedIncludingQuietPeriodMs: Math.round((performance.now() - s.startAt) * 100) / 100,
          domWorkRows: document.querySelectorAll(".bot-work-row").length
        }
      })
      report.cases.push({ name, ...result })
      console.log("PERF_CASE", JSON.stringify(report.cases.at(-1)))
    }
    await observe("100 simultaneous unrelated changes", async () => {
      await page.evaluate(() => {
        for (let i = 0; i < 100; i++)
          (window as any).botPerf.emit({ featureScope: { botId: "other", audience: "desktop" } })
      })
    })
    for (const count of [400, 2000]) {
      while ((await page.evaluate(() => (window as any).botPerf.loaded)) < count) {
        const before = await page.evaluate(() => (window as any).botPerf.loaded)
        await page.evaluate(() => (window as any).botPerf.more())
        await page.waitForFunction(
          (n) => (window as any).botPerf.loaded > n && !(window as any).botPerf.loading,
          before
        )
      }
      await observe(`unrelated change with ${count} loaded works`, async () => {
        await page.evaluate(() =>
          (window as any).botPerf.emit({ reactionTarget: { kind: "bot", botId: "other" } })
        )
      })
      await observe(`10 spaced unrelated changes with ${count} loaded works`, async () => {
        await page.evaluate(async () => {
          for (let i = 0; i < 10; i++) {
            ;(window as any).botPerf.emit()
            await new Promise((r) => setTimeout(r, 20))
          }
        })
      })
    }
    // A slow response must remain serialized and the final revision visible.
    assert.ok(report.cases.every((c: any) => c.peak <= 2 && c.maxBatch <= 40))
    assert.equal(await page.evaluate(() => (window as any).botPerf.loaded), 2000)
    assert.equal(
      report.cases.find((c: any) => c.name === "unrelated change with 2000 loaded works").counts
        .summaries ?? 0,
      0
    )
    assert.ok(report.cases.every((c: any) => !c.counts.list && !c.counts.summaries))
    await observe("one changed task outside first page with 2000 loaded works", async () => {
      await page.evaluate(() => {
        const s = (window as any).botPerf
        s.rows[1500].title = "Changed work 1500"
        s.emit({
          workChanges: [{ botId: "a", audience: "desktop", workIds: ["w1500"], removedIds: [] }]
        })
      })
    })
    assert.equal(report.cases.at(-1).counts.summaries, 1)
    assert.equal(report.cases.at(-1).maxBatch, 1)
    assert.equal(
      await page.evaluate(
        () => (window as any).botPerf.renderedItems.find((row: any) => row.id === "w1500").title
      ),
      "Changed work 1500"
    )
    await observe("removed loaded task", async () => {
      await page.evaluate(() => {
        const s = (window as any).botPerf
        s.rows.splice(
          s.rows.findIndex((row: any) => row.id === "w1500"),
          1
        )
        s.emit({
          workChanges: [{ botId: "a", audience: "desktop", workIds: [], removedIds: ["w1500"] }]
        })
      })
    })
    assert.equal(await page.evaluate(() => (window as any).botPerf.loaded), 1999)
    await observe("45 new tasks after fully loading history", async () => {
      await page.evaluate(() => {
        const s = (window as any).botPerf
        const rows = Array.from({ length: 45 }, (_, index) => ({
          ...s.rows[0],
          id: `new-${index}`,
          title: `New task ${index}`
        }))
        s.rows.unshift(...rows)
        s.emit({
          workChanges: [
            { botId: "a", audience: "desktop", workIds: rows.map((row) => row.id), removedIds: [] }
          ]
        })
      })
    })
    assert.equal(await page.evaluate(() => (window as any).botPerf.loaded), 2044)
    assert.equal(
      await page.evaluate(() =>
        (window as any).botPerf.renderedItems.some((row: any) => row.id === "new-44")
      ),
      true
    )
    // Use the actual Feature subscription, debounce and open-row lifecycle. Slow
    // metadata reads should not be mistaken for a real project/model benchmark.
    await page.evaluate(() => {
      const s = (window as any).botPerf
      s.latency = 10
      s.showFeature()
    })
    await page.getByRole("button", { name: /Performance Feature/ }).click()
    await page.waitForFunction(() => {
      const s = (window as any).botPerf
      return !s.inFlight && performance.now() - s.lastActivityAt >= 200
    })
    await page.evaluate(async () => {
      const s = (window as any).botPerf
      s.reset()
      s.latency = 600
      s.startAt = performance.now()
      for (let i = 0; i < 10; i++) {
        s.emit({ featureScope: { botId: "a", audience: "desktop" } })
        await new Promise((r) => setTimeout(r, 180))
      }
    })
    await page.waitForFunction(() => {
      const s = (window as any).botPerf
      return !s.inFlight && performance.now() - s.lastActivityAt >= 200
    })
    const featureResult = await page.evaluate(() => {
      const s = (window as any).botPerf
      return {
        name: "10 Feature changes while list/detail takes 600ms",
        counts: s.counts,
        peak: s.peak,
        latencyMs: s.latency,
        requestSpanMs: Math.round((s.lastActivityAt - s.startAt) * 100) / 100
      }
    })
    assert.ok(featureResult.peak <= 2, "one list and one detail request at most")
    assert.ok(featureResult.counts.feature_list <= 5)
    assert.ok(featureResult.counts.feature_detail <= 5)
    await page.evaluate(() => {
      ;(window as any).botPerf.latency = 10
    })
    for (let target = 80; target <= 130; target += 40) {
      await page.evaluate(() => (window as any).botPerf.featureData.more())
      await page.waitForFunction(
        (n) =>
          !(window as any).botPerf.featureData.loading &&
          (window as any).botPerf.featureData.items.length >= n,
        Math.min(target, 130)
      )
    }
    await page.evaluate(() => (window as any).botPerf.featureData.more())
    await page.waitForFunction(
      () =>
        (window as any).botPerf.featureData.items.length === 130 &&
        !(window as any).botPerf.featureData.loading
    )
    assert.equal(
      await page.evaluate(
        () => new Set((window as any).botPerf.featureData.items.map((row: any) => row.id)).size
      ),
      130
    )
    await page.evaluate(() => (window as any).botPerf.featureQuery("Feature item 129"))
    await page.waitForFunction(
      () =>
        !(window as any).botPerf.featureData.loading &&
        (window as any).botPerf.featureData.items.length === 1
    )
    assert.equal(
      await page.evaluate(() => (window as any).botPerf.featureData.items[0].id),
      "follow-129"
    )
    report.cases.push(featureResult)
    console.log("PERF_CASE", JSON.stringify(featureResult))
    await page.evaluate(() => {
      const s = (window as any).botPerf
      s.hold = true
      s.emit({ featureScope: { botId: "a", audience: "desktop", followId: "follow-129" } })
    })
    await page.waitForFunction(() => (window as any).botPerf.releases.length > 0)
    await page.evaluate(() => {
      const s = (window as any).botPerf
      s.featureGroup("other")
    })
    await page.waitForFunction(() => (window as any).botPerf.featureData.items.length === 0)
    await page.evaluate(() => {
      const s = (window as any).botPerf
      s.hold = false
      s.releases.splice(0).forEach((resolve: any) => resolve())
    })
    await page.waitForFunction(() => !(window as any).botPerf.featureData.loading)
    assert.equal(await page.evaluate(() => (window as any).botPerf.featureData.items.length), 0)
    assert.deepEqual(errors, [])
    report.status = "passed correctness; timing observations require review"
  } catch (error) {
    report.status = "failed"
    report.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    await app?.close()
    await rm(dir, { recursive: true, force: true })
    if (process.env.BOT_PERF_REPORT)
      await writeFile(process.env.BOT_PERF_REPORT, JSON.stringify(report, null, 2) + "\n", {
        flag: "wx"
      })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
