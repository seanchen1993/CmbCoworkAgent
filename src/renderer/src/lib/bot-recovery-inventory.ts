const prefix = "cmb:bot-recovery:pending:"
const maximumKeys = 4096
const pageSize = 64
type StorageIndex = Pick<Storage, "length" | "key">

/** Enumerate identities only. Inspect the selected original record through the existing pending store. */
export function pendingBotRecoveryIdentities(storage: StorageIndex = localStorage): {
  ids: string[]
  hasMore: boolean
} {
  const length = storage.length
  if (length > maximumKeys) throw new Error("本机操作记录过多，请检查应用存储后重新打开。")
  const ids = new Set<string>()
  for (let index = 0; index < length; index++) {
    const name = storage.key(index)
    if (!name?.startsWith(prefix)) continue
    const id = name.slice(prefix.length)
    if (!id || id.length > 160 || !/^[\w:.-]+$/.test(id))
      throw new Error("无法读取任务恢复记录的索引。请保留原记录并检查应用存储。")
    ids.add(id)
  }
  const sorted = [...ids].sort()
  return { ids: sorted.slice(0, pageSize), hasMore: sorted.length > pageSize }
}
