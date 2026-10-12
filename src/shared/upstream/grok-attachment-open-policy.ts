// Source: user-provided Grok Bot 0.18 reconstruction; see main/bots/upstream/PROVENANCE.json.
export function attachmentExtension(nameOrPath: string): string | null {
  const segments = nameOrPath.split(/[/\\]/)
  const base = segments[segments.length - 1] ?? ""
  const dot = base.lastIndexOf(".")
  if (dot <= 0 || dot === base.length - 1) return null
  return base.slice(dot + 1).toLowerCase()
}
