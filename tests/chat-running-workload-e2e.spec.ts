/** Real agent + Electron + SQLite + React; only the streaming HTTP model is local. */
import assert from "node:assert/strict"
import { createServer, type ServerResponse } from "node:http"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { writeFileSync } from "node:fs"
import { releaseGuideConfig } from "../src/renderer/src/components/guides/release-guide-content"
import { withModsMainCpuProfile } from "./support/mods-main-cpu-profile-diagnostic"
import { startChatRunningObservation } from "./support/chat-running-observation"
import { installChatScrollWriteDiagnostic } from "./support/chat-scroll-write-diagnostic"
import { withChatRunningRendererProfile } from "./support/chat-running-renderer-profile"
import {
  createHeadlessProjectCompositionLaunch,
  projectCompositionCandidate,
  projectCompositionEnvironment
} from "./support/project-composition-e2e-fixtures"

async function main() {
  const root = resolve(__dirname, "..")
  const fixture = projectCompositionEnvironment(root)
  const candidate = projectCompositionCandidate(root)
  const rounds = Number(process.env.CHAT_RUNNING_ROUNDS ?? "12")
  assert(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 120)
  const withGuest = process.env.CHAT_RUNNING_DISPLAY_GUEST === "1"
  let chunks = 0,
    answer: ServerResponse | undefined,
    ticker: NodeJS.Timeout | undefined
  const frame = (delta: object, finish_reason: string | null = null) =>
    answer!.write(
      "data: " +
        JSON.stringify({
          id: "workload-answer",
          object: "chat.completion.chunk",
          created: 1,
          model: "gpt-4",
          choices: [{ index: 0, delta, finish_reason }]
        }) +
        "\n\n"
    )
  const server = createServer(async (req, res) => {
    const buffers = []
    for await (const chunk of req) buffers.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(buffers).toString())
    if (
      !body.messages?.some((m: { content?: unknown }) =>
        JSON.stringify(m.content).includes("START_RUN_LOAD")
      ) ||
      answer
    ) {
      res.writeHead(400)
      res.end()
      return
    }
    answer = res
    res.writeHead(200, { "content-type": "text/event-stream" })
    frame({ role: "assistant", content: "LIVE_WORKLOAD " })
    ticker = setInterval(() => frame({ content: "word" + ++chunks + " " }), 40)
    res.on("close", () => clearInterval(ticker))
  })
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done))
  const address = server.address()
  assert(address && typeof address === "object")
  const samples: Array<{ kind: string; ms: number; round: number }> = []
  const telemetry: unknown[] = []
  const errors: string[] = []
  let lastInteraction: unknown
  let passed = false
  try {
    const app = await createHeadlessProjectCompositionLaunch(root, fixture, {
      unobtrusivePresentation: true
    })()
    let observation: Awaited<ReturnType<typeof startChatRunningObservation>> | undefined
    try {
      const page = await app.firstWindow()
      const nativeWindow = await app.browserWindow(page)
      await page.waitForFunction(() => !!window.api?.threads)
      page.on("pageerror", (e) => errors.push(e.message))
      const ids = await page.evaluate(
        async ({ workspace, baseUrl, guide }) => {
          await window.api.uiGuides.getState(guide)
          await window.api.uiGuides.acknowledge(guide)
          await window.api.models.setCustomConfig({
            id: "running-workload",
            name: "Local workload",
            apiKey: "local-fixture",
            baseUrl,
            model: "gpt-4",
            maxTokens: 32000,
            maxOutputTokens: 4096
          })
          await window.api.models.setDefault("custom:running-workload")
          await window.api.mods.configureGlobal(true)
          const result = []
          for (const name of ["Active workload", "History workload"]) {
            const { thread_id: id } = await window.api.threads.create({
              title: name,
              workspacePath: workspace,
              agentMode: "normal"
            })
            await window.api.workspace.set(id, workspace)
            await window.api.threads.patchMetadata(id, {
              set: { model: "custom:running-workload", subagentsEnabled: false }
            })
            await window.api.mods.configure(id, true, true)
            await window.api.threads.appendMessages(
              id,
              Array.from({ length: 160 }, (_, i) => ({
                role: i % 2 ? ("assistant" as const) : ("user" as const),
                id: id + "-" + i,
                content:
                  "ROW_" + i + "\n\n" + "Sample **paragraph** with code `unit()`.\n\n".repeat(8),
                created_at: new Date(1700000000000 + i * 1000)
              }))
            )
            result.push(id)
          }
          return result
        },
        {
          workspace: fixture.workspace,
          baseUrl: "http://127.0.0.1:" + address.port + "/v1",
          guide: releaseGuideConfig("2.0.0")
        }
      )
      if (withGuest)
        await page.evaluate(async (ids) => {
          await window.api.mods.installExamples()
          const status = await window.api.mods.status(ids[0])
          const plugin = status.functionMods?.find((item) => item.name === "function-commands")
          if (!plugin?.digest) throw Error("Expected a fresh fixture plugin")
          await window.api.mods.approveFunction(
            ids[0],
            plugin.pluginId,
            plugin.digest,
            status.workspace
          )
          for (const id of ids) {
            if (!(await window.api.mods.commands(id)).some((c) => c.command === "claw-info"))
              throw Error("Approved fixture did not start")
          }
        }, ids)
      await page.reload({ waitUntil: "domcontentloaded" })
      if (process.env.CHAT_RUNNING_SCROLL_WRITE_DIAGNOSTICS === "1")
        await installChatScrollWriteDiagnostic(page)
      if (process.env.CHAT_RUNNING_SCROLL_DIAGNOSTICS === "1")
        await page.evaluate(() => {
          const samples: unknown[] = []
          Reflect.set(window, "runningWheelSamples", samples)
          document.addEventListener(
            "wheel",
            (event) => {
              const target = event.target instanceof Element ? event.target : null
              const viewport = target?.closest("[data-radix-scroll-area-viewport]")
              const sample = {
                at: performance.now(),
                delta: event.deltaY,
                target: target?.tagName,
                thread: target
                  ?.closest("[data-chat-thread-id]")
                  ?.getAttribute("data-chat-thread-id"),
                top: viewport?.scrollTop,
                firstFrame: null as number | null,
                firstFrameAt: null as number | null,
                secondFrame: null as number | null,
                secondFrameAt: null as number | null,
                settled: null as number | null,
                settledAt: null as number | null,
                connectedAtSettlement: null as boolean | null
              }
              samples.push(sample)
              if (samples.length > 12) samples.shift()
              requestAnimationFrame(() => {
                sample.firstFrame = viewport?.scrollTop ?? -1
                sample.firstFrameAt = performance.now()
                requestAnimationFrame(() => {
                  sample.secondFrame = viewport?.scrollTop ?? -1
                  sample.secondFrameAt = performance.now()
                })
              })
              setTimeout(() => {
                sample.settled = viewport?.scrollTop ?? -1
                sample.settledAt = performance.now()
                sample.connectedAtSettlement = viewport?.isConnected ?? false
              }, 200)
            },
            { capture: true, passive: true }
          )
        })
      const select = (which: number) =>
        page
          .getByText(which ? "History workload" : "Active workload", { exact: true })
          .first()
          .click()
      const scope = (which: number) => page.locator('[data-chat-thread-id="' + ids[which] + '"]')
      const ready = (which: number) => observation
        ? observation.waitForReady(ids[which])
        : page.waitForFunction((id) => {
          const root = document.querySelector('[data-chat-thread-id="' + id + '"]')
          const view = root?.querySelector("[data-radix-scroll-area-viewport]")
          if (!view) return false
          const area = view.getBoundingClientRect()
          return [...view.querySelectorAll<HTMLElement>("[data-chat-message-row]")].some((row) => {
            const box = row.getBoundingClientRect()
            return (
              box.bottom > area.top &&
              box.top < area.bottom &&
              row.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) &&
              /ROW_|LIVE_WORKLOAD/.test(row.innerText)
            )
          })
        }, ids[which])
      await select(0)
      await ready(0)
      const composer = scope(0).locator("textarea.composer-textarea")
      await composer.fill("START_RUN_LOAD")
      await composer.locator("xpath=ancestor::form").locator('button[type="submit"]').click()
      const until = Date.now() + 30000
      while (chunks < 1 && Date.now() < until) await delay(50)
      assert(chunks > 0, "the UI request must reach the streaming HTTP provider")
      if (!withGuest)
        await page.waitForFunction((id) => {
          const rows = document.querySelectorAll<HTMLElement>(
            '[data-chat-thread-id="' + id + '"] [data-chat-message-row]'
          )
          return [...rows].some((row) => {
            if (
              !row.innerText.includes("LIVE_WORKLOAD") ||
              !row.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
            )
              return false
            const viewport = row.closest("[data-radix-scroll-area-viewport]")
            if (!viewport) return false
            const box = row.getBoundingClientRect(),
              view = viewport.getBoundingClientRect()
            return (
              box.bottom > view.top &&
              box.top < view.bottom &&
              box.right > view.left &&
              box.left < view.right
            )
          })
        }, ids[0])
      // A guest may hold model output until its publication check. Exercise navigation
      // during the physical run, including that interval, then verify the final durable body.
      const record = async (kind: string, round: number, run: () => Promise<unknown>) => {
        // Navigation legitimately changes scope; same-thread actions must retain
        // readiness so a disappearance during scrolling/resizing is still detected.
        await observation?.setPhase(kind, kind !== "switch")
        const start = performance.now()
        await run()
        samples.push({ kind, round, ms: Math.round(performance.now() - start) })
      }
      // Optional diagnostics run outside the measured interaction loop. Working set
      // growth alone cannot tell retained objects from V8's reusable heap capacity.
      const heapSample = async (phase: string) => {
        if (process.env.CHAT_RUNNING_HEAP_DIAGNOSTICS !== "1") return
        const main = await app.evaluate(async () => {
          const inspector = process.getBuiltinModule("node:inspector")
          const session = new inspector.Session()
          session.connect()
          try {
            await new Promise<void>((resolve, reject) => {
              session.post("HeapProfiler.collectGarbage", (error) =>
                error ? reject(error) : resolve()
              )
            })
            return process.memoryUsage()
          } finally {
            session.disconnect()
          }
        })
        const cdp = await page.context().newCDPSession(page)
        try {
          await cdp.send("HeapProfiler.collectGarbage")
          const renderer = await cdp.send("Runtime.getHeapUsage")
          telemetry.push({ phase, main, renderer })
        } finally {
          await cdp.detach()
        }
      }
      await heapSample("heap-before")
      if (process.env.CHAT_RUNNING_OBSERVE === "1") {
        observation = await startChatRunningObservation(app, page)
      }
      const beforeProcesses = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({
          pid: m.pid,
          type: m.type,
          cpuSeconds: m.cpu.cumulativeCPUUsage,
          memoryKiB: m.memory.workingSetSize
        }))
      )
      telemetry.push({ phase: "before", processes: beforeProcesses })
      const runWorkload = async () => {
        for (let round = 0; round < rounds; round++) {
          const before = chunks
          for (const which of [1, 0]) {
            await record("switch", round, async () => {
              await select(which)
              await ready(which)
            })
            const viewport = scope(which)
              .locator("[data-radix-scroll-area-viewport]")
              .filter({
                has: page.locator("[data-chat-message-row]")
              })
              .first()
            const hoverStart = process.env.CHAT_RUNNING_SCROLL_DIAGNOSTICS === "1"
              ? await viewport.evaluate(el => ({ at: performance.now(), top: el.scrollTop }))
              : undefined
            await viewport.hover()
            if (hoverStart) {
              telemetry.push({
                phase: "hover-diagnostic",
                round,
                threadId: ids[which],
                before: hoverStart,
                after: await viewport.evaluate(el => ({ at: performance.now(), top: el.scrollTop }))
              })
            }
            const prior = await viewport.evaluate((el) => el.scrollTop)
            const pointerTarget = process.env.CHAT_RUNNING_SCROLL_DIAGNOSTICS === "1"
              ? await viewport.evaluate(el => {
                const box = el.getBoundingClientRect()
                const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
                return { tag: target?.tagName, classes: target?.className,
                  thread: target?.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id") }
              }) : undefined
            lastInteraction = { kind: "scroll", round, threadId: ids[which], prior, pointerTarget }
            await record("scroll", round, async () => {
              await page.mouse.wheel(0, prior > 1200 ? -1050 : 1050)
              await page.waitForFunction(
                ({ id, prior }) => {
                  const row = document.querySelector(
                    '[data-chat-thread-id="' + id + '"] [data-chat-message-row]'
                  )
                  const el = row?.closest("[data-radix-scroll-area-viewport]")
                  return el && Math.abs(el.scrollTop - prior) > 8
                },
                { id: ids[which], prior }
              )
              await ready(which)
            })
            // Exercise native window resizing while the HTTP response is still producing
            // tokens, including a detached reading position and the inactive run's history.
            if (round % 3 === 0) {
              const size = which === 1 ? { width: 1320, height: 800 }
                : { width: 1440, height: 960 }
              await record("resize", round, async () => {
                const previous = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
                await nativeWindow.evaluate((window, size) => {
                  window.setContentSize(size.width, size.height, false)
                }, size)
                // Windows DPI/native window constraints can adjust the requested size.
                // Verify the actual renderer resized, without equating native and CSS pixels.
                await page.waitForFunction(({ width, height }) =>
                  innerWidth !== width || innerHeight !== height, previous)
                await ready(which)
                await page.evaluate(() => new Promise<void>((done) =>
                  requestAnimationFrame(() => requestAnimationFrame(() => done()))))
              })
            }
            if (which === 1) {
              const edit = scope(1).locator("textarea.composer-textarea")
              await record("type", round, async () => {
                const text = "draft " + round
                await edit.fill(text)
                await page.evaluate(
                  () =>
                    new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
                )
                assert.equal(await edit.inputValue(), text)
              })
            }
          }
          assert(chunks > before, "HTTP stream must still be active")
          telemetry.push(
            await page.evaluate(() => ({
              messageRows: document.querySelectorAll("[data-chat-message-row]").length,
              nodes: document.getElementsByTagName("*").length
            }))
          )
        }
      }
      await withChatRunningRendererProfile(page, fixture.isolated, () =>
        withModsMainCpuProfile(app, fixture.isolated, runWorkload))
      const afterProcesses = await app.evaluate(({ app }) =>
        app.getAppMetrics().map((m) => ({
          pid: m.pid,
          type: m.type,
          cpuSeconds: m.cpu.cumulativeCPUUsage,
          memoryKiB: m.memory.workingSetSize
        }))
      )
      telemetry.push({ phase: "after", processes: afterProcesses })
      if (process.env.CHAT_RUNNING_SCROLL_DIAGNOSTICS === "1") {
        telemetry.push({ phase: "wheel-diagnostic", samples: await page.evaluate(() =>
          Reflect.get(window, "runningWheelSamples")) })
      }
      if (process.env.CHAT_RUNNING_SCROLL_WRITE_DIAGNOSTICS === "1") {
        telemetry.push({ phase: "scroll-write-diagnostic", writes: await page.evaluate(() =>
          Reflect.get(window, "chatScrollWriteDiagnostic")) })
      }
      await page.screenshot({ path: join(fixture.isolated, "running-workload.png") })
      await observation?.setPhase("settlement")
      clearInterval(ticker)
      frame({ content: " END_RUN_LOAD" }, "stop")
      answer!.end("data: [DONE]\n\n")
      await page.waitForFunction(
        async (id) => {
          const result = await window.api.threads.getMessagesPage(id, { limit: 4 })
          return result.messages.some((m) => JSON.stringify(m.content).includes("END_RUN_LOAD"))
        },
        ids[0],
        { polling: 250 }
      )
      await heapSample("heap-after-settlement")
      if (process.env.CHAT_RUNNING_HEAP_DIAGNOSTICS === "1") {
        await delay(1000)
        await heapSample("heap-after-idle")
      }
      assert.deepEqual(errors, [])
      if (observation) {
        const observed = await observation.snapshot()
        // Preserve the checked snapshot even if failure diagnostics later lose the CDP context.
        telemetry.push({ phase: "observation-check", ...observed })
        assert.deepEqual(observed.errors, [])
        for (const [phase, stats] of Object.entries(observed.renderer?.phases ?? {})) {
          assert.equal(stats.visibility?.postReadyBlankSamples ?? 0, 0,
            `readable content disappeared after ${phase} was ready`)
        }
      }
      for (const kind of ["switch", "scroll", "resize", "type"]) {
        const values = samples
          .filter((s) => s.kind === kind)
          .map((s) => s.ms)
          .sort((a, b) => a - b)
        const p95 = values[Math.ceil(values.length * 0.95) - 1]
        console.log(kind, { p95, max: values.at(-1) })
        assert(p95 < 1500, kind + " p95 reached " + p95 + "ms")
      }
      passed = true
    } catch (error) {
      const page = await app.firstWindow()
      telemetry.push({
        phase: "failure",
        lastInteraction,
        view: await page.evaluate(() => ({
          body: document.body.innerText.slice(-4000),
          wheels: Reflect.get(window, "runningWheelSamples"),
          viewports: [...document.querySelectorAll("[data-radix-scroll-area-viewport]")].map(
            (el) => ({
              top: el.scrollTop,
              height: el.scrollHeight,
              client: el.clientHeight,
              thread: el.closest("[data-chat-thread-id]")?.getAttribute("data-chat-thread-id"),
              initial: el
                .querySelector("[data-chat-initial-presentation]")
                ?.getAttribute("data-chat-initial-presentation"),
              rect: el.getBoundingClientRect().toJSON()
            })
          )
        }))
      })
      await page.screenshot({ path: join(fixture.isolated, "running-workload-failure.png") })
      throw error
    } finally {
      if (observation) telemetry.push({ phase: "observation", ...(await observation.stop()) })
      await app.close()
    }
  } finally {
    clearInterval(ticker)
    server.closeAllConnections()
    server.close()
    writeFileSync(
      join(fixture.isolated, "running-workload.json"),
      JSON.stringify(
        { passed, candidate, withGuest, rounds, chunks, samples, telemetry, errors,
          ...(process.env.CHAT_RUNNING_RENDERER_PROFILE === "1" ||
            process.env.CHAT_RUNNING_SCROLL_WRITE_DIAGNOSTICS === "1"
            ? { diagnosticOnly: true } : {}) },
        null,
        2
      )
    )
    console.log("Evidence:", fixture.isolated)
  }
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
