import type { ChildProcess } from "node:child_process"

/** Host-owned process protocol, never exposed as a model tool argument. The
 * caller checks the original command before selecting its exact interpreter. */
export interface ProcessProtocol {
  executable: string
  args: string[]
  /** Credentials may be present in trusted argv; diagnostics must omit it. */
  sensitiveArguments?: boolean
  shell?: boolean
  stdin: string
  onOutput: (stream: "stdout" | "stderr", bytes: Buffer) => void
  onInputFailure?: () => void
}

/** EPIPE is normal for commands which do not consume their input. Any other
 * delivery failure invalidates the protocol; it cannot become an allow result. */
export function deliverProcessInput(
  child: ChildProcess,
  protocol: ProcessProtocol | undefined,
  onFailure: (error: Error) => void
): void {
  if (!protocol) return
  if (!child.stdin) {
    protocol.onInputFailure?.()
    onFailure(new Error("Command stdin is unavailable"))
    return
  }
  const failed = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") {
      protocol.onInputFailure?.()
      onFailure(new Error("Command stdin delivery failed"))
    }
  }
  child.stdin.on("error", failed)
  try {
    child.stdin.end(protocol.stdin)
  } catch (error) {
    failed(error instanceof Error ? error : new Error("Command stdin delivery failed"))
  }
}
