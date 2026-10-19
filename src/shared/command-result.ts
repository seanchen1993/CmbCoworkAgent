/** DeepAgents execute returns this status marker inside its text result. */
export function hasFailedCommandResult(result: unknown): boolean {
  if (typeof result !== "string") return false
  const match = /\[Command (succeeded|failed) with exit code (-?\d+)\]/.exec(result)
  return !!match && (match[1] === "failed" || Number.parseInt(match[2], 10) !== 0)
}
