import { spawn } from "node:child_process"

/** The child can prepare a transition but needs a fresh host acknowledgement to write it. */
export function runAutobizTransitionProcess(input: {
  command: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  verifyEvidence(): Promise<void>
  operationId?: string
  prepare?(message: unknown): void
  written?(message: unknown): void
  uncertain?(): void
}): Promise<string> {
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []),
    AbortSignal.timeout(input.timeoutMs)
  ])
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      signal
    })
    let pending = ""
    let result = ""
    let bytes = 0
    let ready = false
    let acknowledged = false
    let written = false
    let closed = false
    let failure: Error | undefined
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : Error(String(error))
      child.stdin.destroy()
      child.kill()
    }
    child.stdin.on("error", fail)
    child.on("error", fail)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (text: string) => {
      bytes += Buffer.byteLength(text)
      if (bytes > 2 * 1024 * 1024) return fail(Error("AUTOBIZ_OUTPUT_LIMIT"))
      pending += text
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (!line) continue
        let message: Record<string, unknown> | undefined
        try {
          message = JSON.parse(line)
        } catch {
          return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
        }
        if (message?.ready === true) {
          if (ready) return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
          if (input.operationId && message.operationId !== input.operationId)
            return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
          ready = true
          void input
            .verifyEvidence()
            .then(() => {
              signal.throwIfAborted()
              if (failure) throw failure
              if (closed) throw Error("AUTOBIZ_TRANSITION_PROCESS_FAILED")
              input.prepare?.(message)
              acknowledged = true
              child.stdin.write(input.operationId ? `commit:${input.operationId}\n` : "commit\n")
            })
            .catch(fail)
        } else if (message?.written === true) {
          if (!acknowledged || written || message.operationId !== input.operationId)
            return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
          try {
            signal.throwIfAborted()
            input.written?.(message)
            written = true
            child.stdin.end(`release:${input.operationId}\n`)
          } catch (error) {
            fail(error)
          }
        } else {
          if (result || (message?.applied === true && input.operationId && !written))
            return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
          result = line
        }
      }
    })
    child.stderr.on("data", (text: Buffer) => {
      bytes += text.length
      if (bytes > 2 * 1024 * 1024) fail(Error("AUTOBIZ_OUTPUT_LIMIT"))
    })
    child.on("close", (code) => {
      closed = true
      const error =
        failure ??
        (signal.aborted ? signal.reason : undefined) ??
        (code !== 0 || !result ? Error("AUTOBIZ_TRANSITION_PROCESS_FAILED") : undefined)
      if (error && acknowledged) {
        try {
          input.uncertain?.()
        } catch {
          /* The durable pending intent remains fail-closed. */
        }
        reject(Error(`AUTOBIZ_COMMIT_UNKNOWN:${input.operationId ?? ""}:${String(error)}`))
      } else if (error) reject(error)
      else resolve(result)
    })
  })
}
