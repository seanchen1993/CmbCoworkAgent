import { setTimeout as delay } from "node:timers/promises"
import type { BotShellProgress, BotShellResult } from "./shell-contract"

interface BackgroundSandbox {
  executeBackground(command: string, cwd: string, started: (id: string) => void): Promise<string>
  getTaskOutput(id: string): {
    completed: boolean
    output?: string
    partialOutput?: string
    partialTruncated?: boolean
    truncated?: boolean
    exitCode?: number | null
    capReached?: boolean
  } | null
}

/** Use the original Cmb lifecycle and process tree; the Host owns durable job identity. */
export async function executeBotBackgroundShell(
  sandbox: BackgroundSandbox,
  input: { command: string; cwd: string; timeoutMs: number },
  signal: AbortSignal,
  stop: () => Promise<boolean>,
  progress: (value: BotShellProgress) => void
): Promise<BotShellResult> {
  let taskId: string | undefined,
    timedOut = false,
    previous: string | undefined
  const deadline = setTimeout(() => {
    timedOut = true
    void stop().catch(() => {})
  }, input.timeoutMs)
  try {
    signal.throwIfAborted()
    const response = await sandbox.executeBackground(input.command, input.cwd, (id) => {
      taskId = id
    })
    if (!taskId)
      return {
        output: response,
        exitCode: timedOut ? 124 : signal.aborted ? 130 : 1,
        truncated: false
      }
    for (;;) {
      const state = sandbox.getTaskOutput(taskId)
      if (!state) throw new Error("后台命令的进程记录已失效，需核对执行结果")
      let output = state.completed ? (state.output ?? "") : (state.partialOutput ?? "")
      if (
        state.completed &&
        (timedOut || signal.aborted || state.exitCode === 130) &&
        previous &&
        !output.includes(previous)
      )
        output = `${previous}\n${output}`
      if (output !== previous) {
        progress({
          output: output.slice(0, 1_100_000),
          truncated:
            state.partialTruncated === true || state.truncated === true || output.length > 1_100_000
        })
        previous = output
      }
      if (state.completed)
        return {
          output: output.slice(0, 1_100_000),
          exitCode: timedOut ? 124 : (state.exitCode ?? null),
          truncated:
            state.partialTruncated === true ||
            state.truncated === true ||
            output.length > 1_100_000,
          ...(state.capReached ? { capReached: true } : {})
        }
      if (signal.aborted) {
        await stop()
        return {
          output,
          exitCode: timedOut ? 124 : 130,
          truncated: state.partialTruncated === true
        }
      }
      await delay(500)
    }
  } finally {
    clearTimeout(deadline)
  }
}
