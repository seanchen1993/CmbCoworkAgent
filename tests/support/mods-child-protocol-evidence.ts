type Until = (read: () => Promise<boolean>, label: string) => Promise<void>

/** Read-only phase evidence. Each phase keeps the caller's original bounded wait; no action retries. */
export async function waitForChildProbe(
  requests: readonly unknown[],
  start: number,
  until: Until
): Promise<void> {
  const phase = (accept: (last: { role?: string; tool_call_id?: string }) => boolean) =>
    requests.slice(start).some((request) => {
      const body = request as { messages?: Array<{
        role?: string
        content?: unknown
        tool_call_id?: string
      }> }
      const messages = body.messages
      const last = messages?.at(-1)
      const user = messages?.findLast((message) => message.role === "user")
      return !!last && JSON.stringify(user?.content ?? "").includes("[mods-child-worker]") &&
        accept(last)
    })
  await until(async () => phase(() => true), "child reaches its actual first provider step")
  await until(async () => phase((last) => last.role === "tool" && (
    last.tool_call_id === "mods-child-search" || last.tool_call_id === "mods-child-inspect")
  ), "child discovery or already published schema reaches the actual next provider step")
  await until(async () => phase((last) =>
    last.role === "tool" && last.tool_call_id === "mods-child-inspect"),
    "child registered or native probe returns its actual provider result")
}
