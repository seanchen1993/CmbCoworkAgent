/** Execution/data boundaries, as distinct from loaded-VM rendering or cached catalog queries. */
export function isFunctionContentBoundary(method: string): boolean {
  return (
    /^(?:fs|process|http|mcp|model)\./.test(method) ||
    [
      "tool.call",
      "command.run",
      "agent.spawn",
      "session.append",
      "session.send",
      "session.compact",
      "prompt.submit",
      "platform.act",
      "completion.check"
    ].includes(method)
  )
}
