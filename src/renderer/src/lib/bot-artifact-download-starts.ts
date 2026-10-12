import { z } from "zod"
import {
  BOT_ARTIFACT_DOWNLOAD_PENDING,
  botArtifactDownloadSourceSchema,
  type BotArtifactDownloadSource
} from "../../../shared/bot-artifact-downloads"
import { sameBotDownloadSource } from "./bot-artifact-download-view"

const KEY = "cmb:bot-artifact-download:pending"
const LIMIT = 64 * 1024
const startSchema = z
  .object({
    nonce: z.uuid(),
    source: botArtifactDownloadSourceSchema,
    name: z.string().min(1).max(255),
    mime: z.string().max(100)
  })
  .strict()
const recordSchema = z
  .object({
    version: z.literal(1),
    items: z.array(startSchema).max(BOT_ARTIFACT_DOWNLOAD_PENDING)
  })
  .strict()
export type BotDownloadStartIntent = z.infer<typeof startSchema>
export type BotDownloadStartRecord =
  | { kind: "empty" }
  | { kind: "valid"; items: BotDownloadStartIntent[] }
  | { kind: "corrupt"; raw: string }
  | { kind: "unreadable" }
type StoragePort = Pick<Storage, "getItem" | "setItem" | "removeItem">
export function createBotDownloadStartStore(storage: () => StoragePort = () => localStorage) {
  function inspect(): BotDownloadStartRecord {
    let raw: string | null
    try {
      raw = storage().getItem(KEY)
    } catch {
      return { kind: "unreadable" }
    }
    if (raw === null) return { kind: "empty" }
    if (!raw || raw.length > LIMIT) return { kind: "corrupt", raw }
    try {
      const parsed = recordSchema.safeParse(JSON.parse(raw))
      if (
        !parsed.success ||
        new Set(parsed.data.items.map((item) => item.nonce)).size !== parsed.data.items.length
      )
        return { kind: "corrupt", raw }
      return { kind: "valid", items: parsed.data.items }
    } catch {
      return { kind: "corrupt", raw }
    }
  }
  function read() {
    const record = inspect()
    if (record.kind === "unreadable" || record.kind === "corrupt")
      throw new Error("无法核对本机保存请求记录，本次保存尚未提交。")
    return record.kind === "valid" ? record.items : []
  }
  function write(items: BotDownloadStartIntent[]) {
    try {
      if (items.length) storage().setItem(KEY, JSON.stringify({ version: 1, items }))
      else storage().removeItem(KEY)
    } catch {
      throw new Error("无法更新本机保存请求记录，原请求仍保留。")
    }
  }
  function remember(
    source: BotArtifactDownloadSource,
    label: { name: string; mime: string }
  ): BotDownloadStartIntent {
    const items = read()
    const existing = items.find((item) => sameBotDownloadSource(item.source, source))
    if (existing) return existing
    if (items.length >= BOT_ARTIFACT_DOWNLOAD_PENDING)
      throw new Error("保存请求尚未确认，请先在下载列表中核对。")
    const parsed = startSchema.safeParse({
      nonce: crypto.randomUUID(),
      source,
      ...label
    })
    if (!parsed.success) throw new Error("文件信息无效，请重新选择保存。")
    const intent = parsed.data
    write([...items, intent]) // No privileged request is sent before this succeeds.
    return intent
  }
  function forget(expected: BotDownloadStartIntent) {
    const items = read()
    const current = items.find((item) => item.nonce === expected.nonce)
    if (!current) return
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error("保存请求已变化，请重新核对。")
    write(items.filter((item) => item.nonce !== expected.nonce))
  }
  function discardCorrupt(expectedRaw: string): boolean {
    const current = inspect()
    if (current.kind === "unreadable") throw new Error("无法读取保存请求，原记录仍保留。")
    if (current.kind !== "corrupt" || current.raw !== expectedRaw) return false
    storage().removeItem(KEY)
    return true
  }
  return { inspect, remember, forget, discardCorrupt }
}
export type BotDownloadStartStore = ReturnType<typeof createBotDownloadStartStore>
