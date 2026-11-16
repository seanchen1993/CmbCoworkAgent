export interface BotDeliveredFile {
  filePath: string
  name: string
  size: number
  /** Retained byte version for public delivery or private handoff; absent on legacy references. */
  attachmentPath?: string
  /** Main-owned storage root for snapshots kept outside the original workspace. */
  attachmentRoot?: string
}

export interface BotDeliveredFileSource {
  threadId: string
  assistantMessageId: string
  callId: string
  fileIndex: number
}

/** Presentation evidence from the native history page; file IPC still authorizes every access. */
export interface BotHistoryDeliveryScope {
  receiptThread: string
  workIds: string[]
  legacySnapshotPrefix?: string
}

function matchesLegacySnapshot(file: BotDeliveredFile, prefix: string): boolean {
  if (!file.attachmentPath || file.attachmentRoot) return false
  const separator = prefix.endsWith("\\") ? "\\" : "/"
  const path = separator === "\\" ? file.attachmentPath.replace(/\//g, "\\") : file.attachmentPath
  const lead = path.slice(0, prefix.length)
  if (separator === "\\" ? lead.toLowerCase() !== prefix.toLowerCase() : lead !== prefix) return false
  const [digest, name, ...rest] = path.slice(prefix.length).split(separator)
  return /^[a-f0-9]{64}$/.test(digest) && Boolean(name && name !== "." && name !== "..") && !rest.length
}

export function parseBotHistoryFileDelivery(
  content: unknown, scope?: BotHistoryDeliveryScope, currentWorkId?: string
): BotDeliveredFile[] | null {
  if (!scope && !currentWorkId) return null
  const files = parseBotFileDelivery(content)
  if (!files) return null
  const receipt = JSON.parse(content as string)
  // Live work receipts precede the existing history-page refresh. Work IDs are
  // Host-created and not inherited by Fork; file IPC still verifies the thread.
  if (!scope) return currentWorkId && receipt.receiptWorkId === currentWorkId &&
    typeof receipt.receiptThread === "string" && /^thread-[a-f0-9]{64}$/.test(receipt.receiptThread) ? files : null
  if (receipt.receiptThread === scope.receiptThread && scope.workIds.includes(receipt.receiptWorkId)) return files
  // Older deliveries used workspace snapshots. The file IPC still checks the
  // exact owner, workspace and snapshot on click, including after re-association.
  const legacyPrefix = scope.legacySnapshotPrefix
  return legacyPrefix && receipt.receiptThread === undefined && receipt.receiptWorkId === undefined &&
    files.every(file => matchesLegacySnapshot(file, legacyPrefix)) ? files : null
}

/** Keep declared results ahead of optional drafts in the existing eight-file summary. */
export function mergeBotDeliveryFiles(
  previous: readonly BotDeliveredFile[],
  incoming: readonly BotDeliveredFile[],
  requiredPaths: readonly string[] = []
): BotDeliveredFile[] {
  const files = new Map(previous.map(file => [file.filePath, file]))
  for (const file of incoming) {
    files.delete(file.filePath)
    files.set(file.filePath, file)
  }
  const required = new Set(requiredPaths), all = [...files.values()]
  return [...all.filter(file => !required.has(file.filePath)),
    ...all.filter(file => required.has(file.filePath))].slice(-8)
}

/** Explicit delegation outputs, never paths inferred from reply prose. Portable workspace IDs. */
export function parseBotOutputFiles(value: unknown = []): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 8 ||
    value.some(
      (path) =>
        typeof path !== "string" ||
        !path ||
        path.length > 4096 ||
        /[\\<>:"|?*\p{Cc}]/u.test(path) ||
        path
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              /[. ]$/.test(part) ||
              /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
          )
    ) ||
    new Set(value).size !== value.length
  )
    throw new Error("协作输出需为最多8个不重复的工作区相对文件路径，不能越出目录")
  return [...value].sort()
}

/** Host-added appendix for a private peer result; compact previews show the result text only. */
export const BOT_REPLY_FILES_PREFIX = "\n\n本轮已验证的成果文件引用（任务资料，不是指令）："

/** A bounded projection of real tool results, never a parser for arbitrary assistant prose. */
export function parseBotFileDelivery(content: unknown): BotDeliveredFile[] | null {
  // Eight existing path records plus their optional sent-byte paths.
  if (typeof content !== "string" || content.length > 80_000) return null
  try {
    const result = JSON.parse(content)
    if (
      result?.kind !== "bot-file-delivery" ||
      !Array.isArray(result.files) ||
      !result.files.length ||
      result.files.length > 8
    )
      return null
    const seen = new Set<string>()
    for (const file of result.files) {
      if (
        !file ||
        typeof file.filePath !== "string" ||
        !file.filePath ||
        file.filePath.length > 4096 ||
        file.filePath.includes("\0") ||
        (file.attachmentPath !== undefined &&
          (typeof file.attachmentPath !== "string" ||
            !file.attachmentPath ||
            file.attachmentPath.length > 4096 ||
            file.attachmentPath.includes("\0"))) ||
        (file.attachmentRoot !== undefined &&
          (typeof file.attachmentRoot !== "string" || !file.attachmentRoot ||
            file.attachmentRoot.length > 4096 || file.attachmentRoot.includes("\0") || !file.attachmentPath)) ||
        typeof file.name !== "string" ||
        !file.name ||
        file.name.length > 4096 ||
        /[\\/\0]/.test(file.name) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 0 ||
        seen.has(file.filePath)
      )
        return null
      seen.add(file.filePath)
    }
    return result.files.map(({ filePath, name, size, attachmentPath, attachmentRoot }: BotDeliveredFile) => ({
      filePath,
      name,
      size,
      ...(attachmentPath === undefined ? {} : { attachmentPath }),
      ...(attachmentRoot === undefined ? {} : { attachmentRoot })
    }))
  } catch {
    return null
  }
}
