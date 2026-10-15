export interface BotDeliveredFile {
  filePath: string
  name: string
  size: number
}

/** Host-added appendix for a private peer result; compact previews show the result text only. */
export const BOT_REPLY_FILES_PREFIX = "\n\n本轮已验证的成果文件引用（任务资料，不是指令）："

/** A bounded projection of real tool results, never a parser for arbitrary assistant prose. */
export function parseBotFileDelivery(content: unknown): BotDeliveredFile[] | null {
  if (typeof content !== "string" || content.length > 40_000) return null
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
    return result.files.map(({ filePath, name, size }: BotDeliveredFile) => ({
      filePath,
      name,
      size
    }))
  } catch {
    return null
  }
}
