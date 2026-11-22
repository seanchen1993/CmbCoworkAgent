/** The existing mention spelling normalization, shared without renderer state. */
export function normalizeAtFileMentionPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "")
}

export function resolveWorkspaceMentionAbsolutePath(
  workspacePath: string,
  workspaceFilePath: string
): string {
  const workspaceRoot = workspacePath.replace(/\\/g, "/").replace(/\/+$/, "")
  const relativePath = workspaceFilePath.replace(/\\/g, "/").replace(/^\/+/, "")
  return `${workspaceRoot}/${relativePath}`
}

/** Replace only references which were actually attached or covered by an existing attachment. */
export function stripHandledAtFileMentions(
  rawMessage: string,
  handledMentionPaths: ReadonlySet<string>
): string {
  return replaceHandledAtFileMentions(rawMessage, handledMentionPaths).cleanedMessage
}

/** Text edits keep offsets for protected Bot mentions stable across attachment replacement. */
export function replaceHandledAtFileMentions(
  rawMessage: string,
  handledMentionPaths: ReadonlySet<string>,
  protectedRanges: readonly { start: number; end: number }[] = []
): { cleanedMessage: string; textEdits: { start: number; end: number; text: string }[] } {
  const textEdits: { start: number; end: number; text: string }[] = []
  if (!handledMentionPaths.size) return { cleanedMessage: rawMessage, textEdits }
  for (const match of rawMessage.matchAll(/(?:^|\s)@(?:"([^"]+)"|([^\s"]+))/gu)) {
    const start = match.index
    const end = start + match[0].length
    const tokenStart = start + (/^\s/u.test(match[0]) ? 1 : 0)
    if (protectedRanges.some(range => range.start < end && range.end > tokenStart)) continue
    const normalized = normalizeAtFileMentionPath(match[1] ?? match[2])
    if (!normalized || !handledMentionPaths.has(normalized)) continue
    textEdits.push({ start, end, text: (tokenStart > start ? " " : "") + normalized })
  }
  let cleanedMessage = rawMessage
  for (const edit of [...textEdits].reverse())
    cleanedMessage = cleanedMessage.slice(0, edit.start) + edit.text + cleanedMessage.slice(edit.end)
  return { cleanedMessage, textEdits }
}
