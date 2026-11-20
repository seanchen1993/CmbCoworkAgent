export interface LlmFileHistorySnapshot {
  exists: boolean
  content: string | null
  ts: string
  omitted?: boolean
  sizeBytes?: number
}

export interface PreparedLlmFileSnapshot {
  relPath: string
  snapshot: LlmFileHistorySnapshot
}

function shouldAppendSnapshot(
  history: LlmFileHistorySnapshot[],
  next: LlmFileHistorySnapshot
): boolean {
  const last = history.at(-1)
  if (!last) return true
  if (last.exists !== next.exists) return true
  if (!last.exists && !next.exists) return false
  if (last.omitted || next.omitted) {
    return last.omitted !== next.omitted || last.sizeBytes !== next.sizeBytes
  }
  return last.content !== next.content
}

export function mergeRecordedLlmFileMetadata(input: {
  existingFiles: Iterable<string>
  recentlyRevertedFiles: Iterable<string>
  fileHistory: Record<string, LlmFileHistorySnapshot[]>
  incomingFiles: Iterable<string>
  relativePathsByFile: ReadonlyMap<string, readonly string[]>
  snapshots: readonly PreparedLlmFileSnapshot[]
  maxSnapshotsPerFile: number
}): {
  files: string[]
  recentlyRevertedFiles: string[]
  fileHistory: Record<string, LlmFileHistorySnapshot[]>
} {
  const files = new Set(input.existingFiles)
  const reverted = new Set(input.recentlyRevertedFiles)
  const fileHistory = { ...input.fileHistory }
  for (const incoming of input.incomingFiles) {
    files.add(incoming)
    reverted.delete(incoming)
    for (const relPath of input.relativePathsByFile.get(incoming) ?? []) {
      reverted.delete(relPath)
    }
  }
  for (const { relPath, snapshot } of input.snapshots) {
    const history = [...(fileHistory[relPath] ?? [])]
    if (shouldAppendSnapshot(history, snapshot)) history.push(snapshot)
    fileHistory[relPath] = history.slice(-input.maxSnapshotsPerFile)
  }
  return {
    files: Array.from(files),
    recentlyRevertedFiles: Array.from(reverted),
    fileHistory
  }
}
