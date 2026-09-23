import assert from "node:assert/strict"
import { waitUntilMonotonic } from "./mods-monotonic-wait"
import { createServer } from "node:http"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ElectronApplication, Page } from "playwright"
import {
  desktopCpuPoints,
  desktopStreamBudget,
  type DesktopStreamSample
} from "./mods-desktop-performance"

export async function verifyDesktopPerformance(input: {
  app: ElectronApplication
  page: Page
  id: string
  artifacts: string
  smoke: boolean
  open(): Promise<void>
  off(): Promise<void>
  select(): Promise<void>
  pass(label: string): void
}): Promise<void> {
  const { app, page, id, artifacts, smoke } = input
  const stop = () => {
    if (existsSync(join(artifacts, "STOP"))) throw Error("DESKTOP_PERFORMANCE_STOP_REQUESTED")
  }
  const pause = (ms: number) => waitUntilMonotonic(performance.now() + ms, stop)
  const idle: Array<{
    enabled: boolean
    elapsedMs: number
    cpuPoints: number | null
    before: unknown
    after: unknown
  }> = []
  const stream: Array<{ round: number; enabled: boolean; samples: DesktopStreamSample[] }> = []
  const save = () =>
    writeFileSync(
      join(artifacts, "desktop-performance-progress.json"),
      JSON.stringify({ smoke, idle, stream }, null, 2)
    )
  const enable = async () => {
    await page.evaluate(() => window.api.mods.configureGlobal(true))
    await input.select()
    await input.open()
  }
  for (const enabled of [false, true]) {
    if (enabled) {
      await enable()
      for (let n = 0; n < 4; n++)
        await page.getByRole("button", { name: `关闭 Soak ${n}`, exact: true }).click()
      assert.equal(await page.locator("[data-function-pane]").count(), 0)
    } else await input.off()
    // Exclude cold guest loading and cleanup from the idle interval.
    await pause(smoke ? 250 : 5000)
    const before = await app.evaluate(({ app }) => app.getAppMetrics())
    const begin = performance.now()
    await pause(smoke ? 1000 : 300000)
    const after = await app.evaluate(({ app }) => app.getAppMetrics())
    const elapsedMs = performance.now() - begin
    idle.push({
      enabled,
      elapsedMs,
      cpuPoints: desktopCpuPoints(before, after, elapsedMs),
      before,
      after
    })
    save()
    console.log(
      JSON.stringify({ idleEnabled: enabled, elapsedMs, cpuPoints: idle.at(-1)!.cpuPoints })
    )
  }
  input.pass(
    "whole Electron idle windows include main, renderer and utility CPU; missing or changing process metrics remain unknown"
  )
  const pieces = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(3, "0")} `)
  const expected = pieces.join("")
  let requests = 0
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests++
    const responseId = `desktop-stream-${requests}`
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const [index, piece] of pieces.entries()) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (response.destroyed) return
      response.write(
        `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: 1, model: "desktop-perf", choices: [{ index: 0, delta: { ...(index === 0 ? { role: "assistant" } : {}), content: piece }, finish_reason: null }] })}\n\n`
      )
    }
    response.write(
      `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: 1, model: "desktop-perf", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert(address && typeof address !== "string")
  try {
    await page.evaluate(
      async ({ id, url }) => {
        await window.api.models.setCustomConfig({
          id: "desktop-perf",
          name: "Desktop performance protocol",
          baseUrl: url,
          model: "gpt-4",
          apiKey: "fixture-key",
          // Keep this controlled 110-call workload below automatic context compaction.
          // The previous 32K run triggered a real summary and correctly failed request pairing.
          maxTokens: 1000000,
          maxOutputTokens: 1024
        })
        await window.api.threads.patchMetadata(id, {
          set: { model: "custom:desktop-perf", subagentsEnabled: false }
        })
      },
      { id, url: `http://127.0.0.1:${address.port}/v1` }
    )
    const call = async (): Promise<DesktopStreamSample> => {
      stop()
      const prior = requests
      const sample = await page.evaluate(
        ({ id, expected }) =>
          new Promise<DesktopStreamSample>((resolve, reject) => {
            const started = performance.now()
            let first: number | undefined,
              last = 0,
              text = ""
            let cleanup = () => {}
            const timer = setTimeout(() => {
              cleanup()
              void window.api.agent.cancel(id)
              reject(Error("DESKTOP_STREAM_TIMEOUT"))
            }, 30000)
            cleanup = window.api.agent.invoke(
              id,
              "Return the deterministic benchmark stream.",
              (raw) => {
                const e = raw as unknown as {
                  type: string
                  mode?: string
                  data?: unknown
                  token?: string
                  error?: string
                }
                let content = ""
                if (e.type === "token") content = e.token ?? ""
                if (e.type === "stream" && e.mode === "messages" && Array.isArray(e.data)) {
                  const chunk = e.data[0] as { content?: unknown; kwargs?: { content?: unknown } }
                  const value = chunk?.kwargs?.content ?? chunk?.content
                  if (typeof value === "string") content = value
                }
                if (content) {
                  first ??= performance.now()
                  last = performance.now()
                  text += content
                }
                if (e.type === "error" || e.type === "interrupt") {
                  clearTimeout(timer)
                  cleanup()
                  reject(Error(e.error ?? "DESKTOP_STREAM_INTERRUPTED"))
                }
                if (e.type === "done") {
                  clearTimeout(timer)
                  cleanup()
                  if (text !== expected || first === undefined || last <= first)
                    reject(Error(`DESKTOP_STREAM_CONTENT:${text.length}`))
                  else
                    resolve({
                      ttftMs: first - started,
                      streamMs: last - first,
                      characters: text.length
                    })
                }
              },
              "custom:desktop-perf",
              "normal"
            )
          }),
        { id, expected }
      )
      assert.equal(
        requests,
        prior + 1,
        "one physical provider request, no model retry or completion revision"
      )
      await pause(200)
      return sample
    }
    for (let round = 0; round < (smoke ? 1 : 5); round++) {
      for (const enabled of round % 2 ? [true, false] : [false, true]) {
        if (enabled) await enable()
        else await input.off()
        await call() // cold/warmup excluded
        const samples: DesktopStreamSample[] = []
        stream.push({ round, enabled, samples })
        for (let n = 0; n < (smoke ? 2 : 10); n++) {
          samples.push(await call())
          save()
        }
        console.log(JSON.stringify({ streamRound: round, enabled, samples: samples.length }))
      }
    }
    const baseline = stream.filter((r) => !r.enabled).flatMap((r) => r.samples)
    const enabled = stream.filter((r) => r.enabled).flatMap((r) => r.samples)
    const budget = desktopStreamBudget(baseline, enabled)
    const idleDeltaPoints = idle.every((r) => r.cpuPoints !== null)
      ? idle[1].cpuPoints! - idle[0].cpuPoints!
      : null
    const qualified =
      !smoke &&
      idle.every((r) => r.elapsedMs >= 300000 && r.cpuPoints !== null) &&
      baseline.length === 50 &&
      enabled.length === 50
    const passed = qualified && idleDeltaPoints !== null && idleDeltaPoints <= 0.5 && budget.passed
    await input.off()
    writeFileSync(
      join(artifacts, "desktop-performance-result.json"),
      JSON.stringify(
        {
          qualified,
          passed,
          smoke,
          idle,
          stream,
          budget,
          idleDeltaPoints,
          requests,
          scope:
            "Actual desktop main/renderer/utility processes. Eight approved plugins with pass-through turn.step; four panes for streaming and closed panes for idle. Real agent, provider client, IPC and original completion loop with controlled local SSE producer.",
          limits: [
            "Character throughput on identical payloads; no fabricated provider token usage.",
            "TTFT is invocation-to-first-text at production preload IPC, not external inference or final rendered paint.",
            "Idle CPU uses cumulative seconds on one-core percentage-point basis; missing/replaced processes disqualify.",
            "No claim of real external model or Autobiz business acceptance."
          ]
        },
        null,
        2
      )
    )
    input.pass(
      "same fixed producer stream traverses production model/IPC with Mods off and eight no-op stream hooks enabled"
    )
    if (!smoke && !qualified) throw Error("DESKTOP_PERFORMANCE_EVIDENCE_INCOMPLETE")
    if (qualified && !passed) throw Error("DESKTOP_PERFORMANCE_BUDGET_FAILED")
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
