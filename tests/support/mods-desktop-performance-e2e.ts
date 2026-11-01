import assert from "node:assert/strict"
import { createHash } from "node:crypto"
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
import {
  DESKTOP_STREAM_DIAGNOSTIC_MARKER,
  desktopStreamDiagnostic,
  parseDesktopStreamDiagnostic,
  rethrowAfterDesktopStreamEvidence
} from "./mods-desktop-stream-diagnostic"

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
  const diagnostic = desktopStreamDiagnostic(process.env.CMB_MODS_DESKTOP_STREAM_DIAGNOSTIC)
  assert(!diagnostic || !smoke, "STREAM_DIAGNOSTIC_SMOKE_CONFLICT")
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
  for (const enabled of diagnostic ? [] : [false, true]) {
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
    const identitiesObserved = [...before, ...after].every(
      (process) => typeof process.creationTime === "number" && Number.isFinite(process.creationTime)
    )
    idle.push({
      enabled,
      elapsedMs,
      cpuPoints: identitiesObserved ? desktopCpuPoints(before, after, elapsedMs) : null,
      before,
      after
    })
    save()
    console.log(
      JSON.stringify({ idleEnabled: enabled, elapsedMs, cpuPoints: idle.at(-1)!.cpuPoints })
    )
  }
  if (!diagnostic)
    input.pass(
      "whole Electron idle windows include main, renderer and utility CPU; missing or changing process metrics remain unknown"
    )
  const pieces = Array.from({ length: 40 }, (_, i) => `word${String(i).padStart(3, "0")} `)
  const expected = pieces.join("")
  let requests = 0
  let diagnosticCallSequence = 0
  let activeCallKey: string | null = null
  const diagnosticCalls: unknown[] = []
  const serverReceipts: Array<{
    callKey: string | null
    responseId: string
    writes: Array<{ sequence: number; atMs: number; characters: number }>
    finished?: boolean
    destroyed?: boolean
  }> = []
  const saveDiagnostic = () =>
    writeFileSync(
      join(artifacts, "desktop-stream-diagnostic.json"),
      JSON.stringify(
        {
          diagnosticOnly: true,
          timingEligible: false,
          requests,
          calls: diagnosticCalls,
          serverReceipts
        },
        null,
        2
      )
    )
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    JSON.parse(Buffer.concat(chunks).toString("utf8"))
    requests++
    const responseId = `desktop-stream-${requests}`
    const receipt: (typeof serverReceipts)[number] | undefined = diagnostic
      ? { callKey: activeCallKey, responseId, writes: [] }
      : undefined
    if (receipt) serverReceipts.push(receipt)
    response.writeHead(200, { "content-type": "text/event-stream" })
    for (const [index, piece] of pieces.entries()) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      if (response.destroyed) {
        if (receipt) receipt.destroyed = true
        return
      }
      response.write(
        `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: 1, model: "desktop-perf", choices: [{ index: 0, delta: { ...(index === 0 ? { role: "assistant" } : {}), content: piece }, finish_reason: null }] })}\n\n`
      )
      if (receipt)
        receipt.writes.push({ sequence: index, atMs: performance.now(), characters: piece.length })
    }
    response.write(
      `data: ${JSON.stringify({ id: responseId, object: "chat.completion.chunk", created: 1, model: "desktop-perf", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`
    )
    response.end("data: [DONE]\n\n")
    if (receipt) receipt.finished = true
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
    const captureDom = async () => {
      const read = await page.evaluate(async (threadId) => {
        const roots = Array.from(
          document.querySelectorAll<HTMLElement>("[data-chat-thread-id]")
        ).filter((root) => root.getAttribute("data-chat-thread-id") === threadId)
        if (roots.length !== 1) throw Error(`STREAM_DIAGNOSTIC_OWNED_CHAT_ROOT:${roots.length}`)
        const root = roots[0]
        const snapshot = () =>
          Array.from(
            root.querySelectorAll<HTMLElement>(
              '[data-chat-message-scroll-area] [data-chat-message-row][data-message-role="assistant"]'
            )
          )
            .filter((row) => row.closest("[data-chat-thread-id]") === root)
            .slice(-3)
            .map((row) => ({
              messageId: row.getAttribute("data-chat-message-id"),
              role: row.getAttribute("data-message-role"),
              segments: Array.from(row.querySelectorAll<HTMLElement>("[data-chat-search-text]"))
                .slice(0, 4)
                .map((segment) => ({
                  length: (segment.textContent ?? "").length,
                  text: (segment.textContent ?? "").slice(0, 1024),
                  visible: segment.getClientRects().length > 0
                }))
            }))
        const before = snapshot()
        const twoFrames = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 1500)
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              clearTimeout(timer)
              resolve(true)
            })
          )
        })
        return { threadId, before, twoFrames, after: twoFrames ? snapshot() : null }
      }, id)
      return {
        ...read,
        before: read.before.map((row) => ({
          ...row,
          segments: row.segments.map(({ text, length, visible }) => ({
            length,
            capturedLength: text.length,
            visible,
            sha256: length === text.length ? createHash("sha256").update(text).digest("hex") : null,
            shaUnavailable: length !== text.length
          }))
        })),
        after:
          read.after?.map((row) => ({
            ...row,
            segments: row.segments.map(({ text, length, visible }) => ({
              length,
              capturedLength: text.length,
              visible,
              sha256:
                length === text.length ? createHash("sha256").update(text).digest("hex") : null,
              shaUnavailable: length !== text.length
            }))
          })) ?? null
      }
    }
    const recordDiagnostic = async (callKey: string, value: Record<string, unknown> | null) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const text = typeof value?.actualText === "string" ? value.actualText : undefined
      const completeText = text !== undefined && value?.actualTruncated === false
      const observation: Record<string, unknown> = {
        callKey,
        threadId: id,
        value,
        actualSha256: completeText ? createHash("sha256").update(text).digest("hex") : null,
        shaUnavailable: !completeText
      }
      diagnosticCalls.push(observation)
      saveDiagnostic()
      try {
        const dom = await Promise.race([
          captureDom(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(Error("STREAM_DIAGNOSTIC_DOM_TIMEOUT")), 2500)
          })
        ])
        observation.dom = dom
        saveDiagnostic()
      } catch (error) {
        observation.domUnavailable = error instanceof Error ? error.message : String(error)
        saveDiagnostic()
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    const call = async (): Promise<DesktopStreamSample> => {
      stop()
      const prior = requests
      const callKey = diagnostic ? `desktop-stream-diagnostic-${++diagnosticCallSequence}` : ""
      if (diagnostic) activeCallKey = callKey
      let sample: DesktopStreamSample & { diagnostic?: Record<string, unknown> }
      try {
        sample = await page.evaluate(
          ({ id, expected, diagnostic, callKey, marker }) =>
            new Promise<DesktopStreamSample & { diagnostic?: Record<string, unknown> }>(
              (resolve, reject) => {
                const started = performance.now()
                let first: number | undefined,
                  last = 0,
                  text = ""
                const head: Record<string, unknown>[] | undefined = diagnostic ? [] : undefined
                const tail: Record<string, unknown>[] | undefined = diagnostic ? [] : undefined
                const typeCounts = diagnostic ? new Map<string, number>() : undefined
                let eventCount = 0,
                  contentEvents = 0,
                  overflow = 0,
                  headBytes = 0
                const plain = (value: unknown): Record<string, unknown> | undefined =>
                  value && typeof value === "object" && !Array.isArray(value)
                    ? (value as Record<string, unknown>)
                    : undefined
                const scalar = (value: unknown, maximum = 128) =>
                  typeof value === "string" ? value.slice(0, maximum) : null
                const payload = () => {
                  if (!head || !tail || !typeCounts) throw Error("STREAM_DIAGNOSTIC_DISABLED")
                  let mismatch = -1
                  for (let index = 0; index < Math.max(text.length, expected.length); index++)
                    if (text[index] !== expected[index]) {
                      mismatch = index
                      break
                    }
                  const result = {
                    schemaVersion: 1,
                    callKey,
                    actualText: text.slice(0, 4096),
                    actualLength: text.length,
                    actualTruncated: text.length > 4096,
                    expectedLength: expected.length,
                    actualEqual: text === expected,
                    firstMismatch: mismatch,
                    started,
                    first: first ?? null,
                    last,
                    done: performance.now(),
                    eventCount,
                    contentEvents,
                    typeCounts: [...typeCounts],
                    events: { head, tail, overflow, byteBudgetTruncated: false }
                  }
                  if (new TextEncoder().encode(JSON.stringify(result)).length > 60000) {
                    result.events.head = head.slice(0, 16)
                    result.events.tail = tail.slice(-4)
                    result.events.byteBudgetTruncated = true
                  }
                  return result
                }
                const failure = (message: string) =>
                  Error(diagnostic ? message + marker + JSON.stringify(payload()) : message)
                let cleanup = () => {}
                const timer = setTimeout(() => {
                  cleanup()
                  void window.api.agent.cancel(id)
                  reject(failure("DESKTOP_STREAM_TIMEOUT"))
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
                      const chunk = e.data[0] as {
                        content?: unknown
                        kwargs?: { content?: unknown }
                      }
                      const value = chunk?.kwargs?.content ?? chunk?.content
                      if (typeof value === "string") content = value
                    }
                    if (content) {
                      first ??= performance.now()
                      last = performance.now()
                      text += content
                    }
                    if (diagnostic && head && tail && typeCounts) {
                      eventCount++
                      if (content) contentEvents++
                      const tuple =
                        e.type === "stream" && e.mode === "messages" && Array.isArray(e.data)
                          ? e.data
                          : []
                      const chunk = plain(tuple[0]),
                        kwargs = plain(chunk?.kwargs)
                      const metadata = plain(tuple[1])
                      const additional =
                        plain(kwargs?.additional_kwargs) ?? plain(chunk?.additional_kwargs)
                      const classId = Array.isArray(chunk?.id) ? chunk.id.at(-1) : null
                      const contentValue = kwargs?.content ?? chunk?.content
                      const type = String(e.type).slice(0, 32)
                      if (typeCounts.has(type) || typeCounts.size < 32)
                        typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1)
                      const occurrence = additional?.cmb_internal_provider_occurrence
                      const record = {
                        atMs: performance.now() - started,
                        type,
                        mode: scalar(e.mode, 32),
                        contentShape: Array.isArray(contentValue) ? "array" : typeof contentValue,
                        contentChars: content.length,
                        className: scalar(classId, 64),
                        kwargsId: scalar(kwargs?.id),
                        plainId: scalar(chunk?.id),
                        providerSourceId: scalar(additional?.cmb_internal_provider_source_id),
                        providerOccurrence:
                          typeof occurrence === "number" &&
                          Number.isSafeInteger(occurrence) &&
                          occurrence > 0
                            ? occurrence
                            : null,
                        providerContainer: kwargs?.additional_kwargs
                          ? "kwargs"
                          : chunk?.additional_kwargs
                            ? "plain"
                            : null,
                        wire: {
                          content: scalar(metadata?.cmb_stream_message_content_mode, 16),
                          reasoning: scalar(metadata?.cmb_stream_message_reasoning_mode, 16),
                          tool: scalar(metadata?.cmb_stream_message_tool_calls_mode, 16)
                        }
                      }
                      const bytes = new TextEncoder().encode(JSON.stringify(record)).length
                      if (head.length < 128 && headBytes + bytes <= 32768) {
                        head.push(record)
                        headBytes += bytes
                      } else {
                        overflow++
                        tail.push(record)
                        if (tail.length > 16) tail.shift()
                      }
                    }
                    if (e.type === "error" || e.type === "interrupt") {
                      clearTimeout(timer)
                      cleanup()
                      reject(failure(e.error ?? "DESKTOP_STREAM_INTERRUPTED"))
                    }
                    if (e.type === "done") {
                      clearTimeout(timer)
                      cleanup()
                      if (text !== expected || first === undefined || last <= first)
                        reject(failure(`DESKTOP_STREAM_CONTENT:${text.length}`))
                      else
                        resolve({
                          ttftMs: first - started,
                          streamMs: last - first,
                          characters: text.length,
                          ...(diagnostic ? { diagnostic: payload() } : {})
                        })
                    }
                  },
                  "custom:desktop-perf",
                  "normal"
                )
              }
            ),
          { id, expected, diagnostic, callKey, marker: DESKTOP_STREAM_DIAGNOSTIC_MARKER }
        )
      } catch (error) {
        if (!diagnostic) throw error
        await rethrowAfterDesktopStreamEvidence(
          error,
          async () => {
            await recordDiagnostic(callKey, parseDesktopStreamDiagnostic(error))
          },
          (diagnosticError) => {
            diagnosticCalls.push({
              callKey,
              unavailable:
                diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError)
            })
            saveDiagnostic()
          }
        )
        throw error
      }
      if (diagnostic) await recordDiagnostic(callKey, sample.diagnostic ?? null)
      assert.equal(
        requests,
        prior + 1,
        "one physical provider request, no model retry or completion revision"
      )
      await pause(200)
      return sample
    }
    if (diagnostic) {
      for (const enabled of [false, true]) {
        if (enabled) await enable()
        else await input.off()
        await call()
      }
      await input.off()
      saveDiagnostic()
      input.pass("diagnostic-only paired stream observations; not a performance qualification")
      return
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
