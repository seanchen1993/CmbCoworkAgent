/** Reuse the workbench's IPC-prefix cleanup without hiding the actionable error. */
export function botErrorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return (
    message
      .replace(/^Error invoking remote method '[^']+':\s*/i, "")
      .replace(/^(?:BotError|Error):\s*/, "")
      .trim() || fallback
  )
}
