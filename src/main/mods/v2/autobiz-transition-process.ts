import { spawn } from "node:child_process"

/** The child can prepare a transition but needs a fresh host acknowledgement to write it. */
export function runAutobizTransitionProcess(input: {
  command: string
  args: string[]
  cwd: string
  signal?: AbortSignal
  timeoutMs: number
  verifyEvidence(): Promise<void>
}): Promise<string> {
  const signal = AbortSignal.any([
    ...(input.signal ? [input.signal] : []), AbortSignal.timeout(input.timeoutMs)
  ])
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], signal
    })
    let pending = ""
    let result = ""
    let bytes = 0
    let ready = false
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
      if (bytes > 256 * 1024) return fail(Error("AUTOBIZ_OUTPUT_LIMIT"))
      pending += text
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        if (line === '{"ready": true}') {
          if (ready) return fail(Error("AUTOBIZ_PROTOCOL_INVALID"))
          ready = true
          void input.verifyEvidence().then(() => {
            signal.throwIfAborted()
            if (failure) throw failure
            child.stdin.end("commit\n")
          }).catch(fail)
        } else if (line) result = line
      }
    })
    child.stderr.on("data", (text: Buffer) => {
      bytes += text.length
      if (bytes > 256 * 1024) fail(Error("AUTOBIZ_OUTPUT_LIMIT"))
    })
    child.on("close", (code) => {
      if (failure) reject(failure)
      else if (signal.aborted) reject(signal.reason)
      else if (code !== 0 || !result) reject(Error("AUTOBIZ_TRANSITION_PROCESS_FAILED"))
      else resolve(result)
    })
  })
}
