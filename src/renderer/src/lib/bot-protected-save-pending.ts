import type { z } from "zod"

export type ProtectedSaveRecord<T> =
  | { kind: "empty" }
  | { kind: "valid"; input: T; raw: string }
  | { kind: "obsolete"; dataEpoch: string; input: T; raw: string }
  | { kind: "corrupt"; raw: string }
  | { kind: "unreadable" }
export type PendingSaveStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

/** One exact unacknowledged request per editor. Never overwrite an unknown or retired request. */
export function createProtectedSavePending<T>(options: {
  record: z.ZodType<{ dataEpoch: string; input: T }>
  input: z.ZodType<T>
  key(input: T): string
  maxCharacters: number
  oversizeMessage: string
  storageMessage: string
  /** Optional legacy wire encoding; inspection keeps the original raw bytes. */
  encodeRecord?: (record: { dataEpoch: string; input: T }) => unknown
  storage?: () => PendingSaveStorage
}) {
  const storage = options.storage ?? (() => localStorage)
  function inspect(key: string, dataEpoch: string): ProtectedSaveRecord<T> {
    let raw: string | null
    try {
      raw = storage().getItem(key)
    } catch {
      return { kind: "unreadable" }
    }
    if (raw === null) return { kind: "empty" }
    if (!raw || raw.length > options.maxCharacters) return { kind: "corrupt", raw }
    try {
      const parsed = options.record.safeParse(JSON.parse(raw))
      if (!parsed.success || options.key(parsed.data.input) !== key) return { kind: "corrupt", raw }
      const { input } = parsed.data
      return parsed.data.dataEpoch === dataEpoch
        ? { kind: "valid", input, raw }
        : { kind: "obsolete", dataEpoch: parsed.data.dataEpoch, input, raw }
    } catch {
      return { kind: "corrupt", raw }
    }
  }
  function read(key: string, dataEpoch: string): T | null {
    const current = inspect(key, dataEpoch)
    return current.kind === "valid" ? current.input : null
  }
  function remember(input: T, dataEpoch: string): void {
    const parsed = options.record.parse({ dataEpoch, input })
    const key = options.key(parsed.input),
      current = inspect(key, dataEpoch)
    if (current.kind === "valid") {
      if (JSON.stringify(current.input) === JSON.stringify(parsed.input)) return
      throw new Error("有一次保存尚未确认，请先核对原请求。本次修改尚未提交。")
    }
    if (current.kind === "obsolete")
      throw new Error("有恢复前的保存记录，请先核对并归档。本次修改尚未提交。")
    if (current.kind !== "empty") throw new Error("无法核对本机保存记录，本次修改尚未提交。")
    const serialized = JSON.stringify(options.encodeRecord ? options.encodeRecord(parsed) : parsed)
    if (serialized.length > options.maxCharacters) throw new Error(options.oversizeMessage)
    try {
      storage().setItem(key, serialized)
    } catch {
      throw new Error(options.storageMessage)
    }
  }
  function acknowledge(input: T, dataEpoch: string): boolean {
    const key = options.key(input),
      current = inspect(key, dataEpoch)
    if (current.kind === "empty") return true
    if (
      current.kind !== "valid" ||
      JSON.stringify(current.input) !== JSON.stringify(options.input.parse(input))
    )
      return false
    try {
      storage().removeItem(key)
      return true
    } catch {
      return false
    }
  }
  function discard(key: string, dataEpoch: string, expectedRaw: string): boolean {
    const current = inspect(key, dataEpoch)
    if ((current.kind !== "corrupt" && current.kind !== "obsolete") || current.raw !== expectedRaw)
      return false
    try {
      storage().removeItem(key)
      return true
    } catch {
      return false
    }
  }
  return { inspect, read, remember, acknowledge, discard }
}
