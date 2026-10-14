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
  if (handledMentionPaths.size === 0) return rawMessage
  const replaceHandledMention = (match: string, pathValue: string): string => {
    const normalized = normalizeAtFileMentionPath(pathValue)
    if (!normalized || !handledMentionPaths.has(normalized)) return match
    return `${/^\s/u.test(match) ? " " : ""}${normalized}`
  }
  return rawMessage
    .replace(/(?:^|\s)@"([^"]+)"/gu, replaceHandledMention)
    .replace(/(?:^|\s)@([^\s"]+)/gu, replaceHandledMention)
}
