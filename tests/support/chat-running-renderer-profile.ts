import { closeSync, openSync, writeFileSync, writeSync } from "node:fs"
import { join } from "node:path"
import type { ConsoleMessage, Page } from "playwright"
import { startChatRunningRowProfile } from "./chat-running-row-profile"

/** Opt-in diagnostic only: profiled timings are not formal performance measurements. */
export async function withChatRunningRendererProfile(
  page: Page,
  directory: string,
  run: () => Promise<void>,
  limits = { traceBytes: 64 * 1024 * 1024, traceTimeoutMs: 15000 }
): Promise<void> {
  if (process.env.CHAT_RUNNING_RENDERER_PROFILE !== "1") return run()
  const cdp = await page.context().newCDPSession(page)
  let rows: Awaited<ReturnType<typeof startChatRunningRowProfile>> | undefined
  const messages: Array<{ type: string; text: string }> = []
  const errors: unknown[] = []
  let primaryError: unknown
  let primaryFailed = false
  let tracing = false,
    profiling = false,
    messageCount = 0
  let traceBytes = 0,
    truncated = false
  let traceStream: string | undefined
  let resolveTrace: ((value: { stream?: string }) => void) | undefined
  const traceComplete = new Promise<{ stream?: string }>((resolve) => {
    resolveTrace = resolve
  })
  const onTraceComplete = (value: { stream?: string }) => {
    traceStream = value.stream
    resolveTrace?.(value)
  }
  const onConsole = (message: ConsoleMessage) => {
    if (!["warning", "error"].includes(message.type())) return
    messageCount++
    if (messages.length < 20)
      messages.push({ type: message.type(), text: message.text().slice(0, 500) })
  }
  const attempt = async (label: string, action: () => unknown | Promise<unknown>) => {
    try {
      await action()
    } catch (cause) {
      errors.push(new Error(`Renderer profile ${label} failed`, { cause }))
    }
  }
  const deadline = async <T>(
    operation: Promise<T>,
    timeoutMs = limits.traceTimeoutMs
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Renderer trace completion timed out")),
            Math.max(0, timeoutMs)
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
  page.on("console", onConsole)
  cdp.on("Tracing.tracingComplete", onTraceComplete)
  try {
    await cdp.send("Tracing.start", {
      categories: "devtools.timeline,blink.user_timing",
      transferMode: "ReturnAsStream"
    })
    tracing = true
    rows = await startChatRunningRowProfile(page)
    await cdp.send("Profiler.enable")
    await cdp.send("Profiler.start")
    profiling = true
    await run()
  } catch (error) {
    primaryFailed = true
    primaryError = error
  } finally {
    try {
      if (profiling)
        await attempt("CPU stop/write", async () => {
          const result = await deadline(cdp.send("Profiler.stop"))
          writeFileSync(
            join(directory, "running-renderer.cpuprofile"),
            JSON.stringify(result.profile)
          )
        })
      if (tracing)
        await attempt("trace stop/read", async () => {
          const expiresAt = Date.now() + limits.traceTimeoutMs
          await deadline(cdp.send("Tracing.end"))
          const trace = await deadline(traceComplete, expiresAt - Date.now())
          if (!trace.stream) throw new Error("Renderer trace completed without a stream")
          let file: number | undefined
          try {
            file = openSync(join(directory, "running-renderer.trace.json"), "w")
            for (;;) {
              if (Date.now() >= expiresAt) throw new Error("Renderer trace read timed out")
              const chunk = await deadline(
                cdp.send("IO.read", {
                  handle: trace.stream,
                  size: 64 * 1024
                }),
                expiresAt - Date.now()
              )
              const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")
              const remaining = Math.max(0, limits.traceBytes - traceBytes)
              const output = bytes.subarray(0, remaining)
              let written = 0
              while (written < output.length) {
                const count = writeSync(file, output, written, output.length - written)
                if (count <= 0) throw new Error("Renderer trace write made no progress")
                written += count
                traceBytes += count
              }
              if (bytes.length > remaining || (!chunk.eof && traceBytes >= limits.traceBytes)) {
                truncated = true
                throw new Error(`Renderer trace exceeded ${limits.traceBytes} byte limit`)
              }
              if (chunk.eof) break
            }
          } finally {
            if (file !== undefined) await attempt("trace file close", () => closeSync(file!))
          }
        })
      if (traceStream)
        await attempt("trace stream close", () =>
          deadline(cdp.send("IO.close", { handle: traceStream! }))
        )
      if (rows)
        await attempt("row stop/write", async () => {
          const evidence = await deadline(rows!.stop())
          writeFileSync(join(directory, "running-renderer-rows.json"), JSON.stringify(evidence))
        })
      await attempt("diagnostic metadata write", () =>
        writeFileSync(
          join(directory, "running-renderer-console.json"),
          JSON.stringify(
            {
              diagnosticOnly: true,
              messageCount,
              messages,
              trace: { bytes: traceBytes, truncated, byteLimit: limits.traceBytes },
              primaryError: primaryFailed ? String(primaryError) : null,
              diagnosticErrors: errors.map((error) =>
                error instanceof Error
                  ? { message: error.message, cause: String(error.cause) }
                  : { message: String(error) }
              )
            },
            null,
            2
          )
        )
      )
    } finally {
      page.off("console", onConsole)
      cdp.off("Tracing.tracingComplete", onTraceComplete)
      await attempt("CDP detach", () => deadline(cdp.detach()))
    }
  }
  if (errors.length)
    throw new AggregateError(
      primaryFailed ? [primaryError, ...errors] : errors,
      "Renderer profile failed; inspect original and diagnostic errors",
      { cause: primaryFailed ? primaryError : errors[0] }
    )
  if (primaryFailed) throw primaryError
}
