export const SHELL_TASK_MONITOR_TOOL_NAME = "monitor"
export const SHELL_TASK_OUTPUT_TOOL_NAME = "task_output"
export const SHELL_TASK_MONITOR_TOOL_NAMES = [
  SHELL_TASK_MONITOR_TOOL_NAME,
  SHELL_TASK_OUTPUT_TOOL_NAME
] as const
export const SHELL_TASK_MONITOR_MAX_WAIT_MS = 600_000

export function isShellTaskMonitorToolName(
  name: string | undefined
): name is (typeof SHELL_TASK_MONITOR_TOOL_NAMES)[number] {
  return name === SHELL_TASK_MONITOR_TOOL_NAME || name === SHELL_TASK_OUTPUT_TOOL_NAME
}

export function expandShellTaskMonitorToolDenials(blocked: Set<string>): Set<string> {
  if (SHELL_TASK_MONITOR_TOOL_NAMES.some((name) => blocked.has(name))) {
    for (const name of SHELL_TASK_MONITOR_TOOL_NAMES) blocked.add(name)
  }
  return blocked
}

export interface ShellTaskSnapshot {
  completed: boolean
  output?: string
  exitCode?: number | null
  elapsedSeconds?: number
  command?: string
  cwd?: string
  partialOutput?: string
  partialTruncated?: boolean
  idleSeconds?: number
  capReached?: boolean
  truncated?: boolean
  stopReason?: string
}

export interface ShellTaskWaitOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

export type ShellTaskWaitResult =
  | { status: "completed" | "timeout"; result: ShellTaskSnapshot }
  | { status: "aborted" | "missing" }

type TerminalWait = "completed" | "timeout" | "aborted"

/** One completion signal per task. Each waiter owns and removes its cancellation handlers. */
export class ShellTaskMonitor {
  private completed = false
  private readonly waiters = new Set<(status: TerminalWait) => void>()

  publish(): void {
    if (this.completed) return
    this.completed = true
    for (const resolve of this.waiters) resolve("completed")
  }

  wait({ timeoutMs, signal }: ShellTaskWaitOptions = {}): Promise<TerminalWait> {
    if (this.completed) return Promise.resolve("completed")
    if (signal?.aborted) return Promise.resolve("aborted")
    if (timeoutMs === 0) return Promise.resolve("timeout")

    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (status: TerminalWait): void => {
        if (!this.waiters.delete(finish)) return
        if (timer !== undefined) clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        resolve(status)
      }
      const abort = (): void => finish("aborted")

      this.waiters.add(finish)
      signal?.addEventListener("abort", abort, { once: true })
      if (timeoutMs !== undefined) timer = setTimeout(() => finish("timeout"), timeoutMs)
    })
  }
}
