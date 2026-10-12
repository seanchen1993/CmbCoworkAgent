// Copied from Grok Bot 0.18 reconstruction; see PROVENANCE.json.
export function takeNextUserTask<T extends { source: string }>(pending: T[]): T | undefined {
  if (pending.length === 0) return undefined
  const preferred = pending.findIndex((item) => item.source !== "group-member")
  return pending.splice(preferred === -1 ? 0 : preferred, 1)[0]
}
