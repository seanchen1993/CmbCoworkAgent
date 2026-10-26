/** Execute appends its status after stdout and before the optional truncation notice. */
export function hasFailedCommandResult(result: unknown): boolean {
  if (typeof result !== "string") return false
  const match =
    /(?:^|\r?\n)\[Command (succeeded|failed) with exit code (-?\d+)\](?:\r?\n\[Output was truncated due to size limits\])?(?:\r?\n)*$/.exec(
      result
    )
  return !!match && (match[1] === "failed" || Number.parseInt(match[2], 10) !== 0)
}
