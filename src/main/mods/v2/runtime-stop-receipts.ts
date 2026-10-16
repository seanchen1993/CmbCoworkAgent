import type { ModControlStore } from "../control-store"

/** Host metadata only: this namespace is never available through $.store or $.config. */
export const RUNTIME_STOP_RECEIPTS_KEY = "native:function-runtime-stops:v1"

export interface RuntimeStopReceipt {
  workspace: string
  threadId: string
  generation: number
  sourceIds: string[]
  names?: string[]
  incarnationKey?: string
  state: "releasing" | "stopped" | "failed"
  error?: string
}

function decodeRuntimeStopReceipts(text: string): RuntimeStopReceipt[] {
  if (text.length > 256 * 1024 || Buffer.byteLength(text, "utf8") > 256 * 1024)
    throw Error("MODS_RUNTIME_RECEIPTS_INVALID")
  const value = JSON.parse(text)
  if (!value || value.version !== 1 || !Array.isArray(value.sessions) || value.sessions.length > 64)
    throw Error("MODS_RUNTIME_RECEIPTS_INVALID")
  const keys = new Set<string>()
  return value.sessions.map((row: RuntimeStopReceipt) => {
    if (
      !row ||
      typeof row.workspace !== "string" ||
      !row.workspace ||
      row.workspace.length > 4096 ||
      typeof row.threadId !== "string" ||
      !row.threadId ||
      row.threadId.length > 200 ||
      !Number.isSafeInteger(row.generation) ||
      row.generation < 1 ||
      !["releasing", "stopped", "failed"].includes(row.state) ||
      !Array.isArray(row.sourceIds) ||
      row.sourceIds.length > 8 ||
      row.sourceIds.some((id) => typeof id !== "string" || !id || id.length > 200) ||
      (row.names !== undefined &&
        (!Array.isArray(row.names) ||
          row.names.length > 16 ||
          row.names.some((name) => typeof name !== "string" || !name || name.length > 256))) ||
      (row.incarnationKey !== undefined &&
        (typeof row.incarnationKey !== "string" || row.incarnationKey.length > 4096)) ||
      (row.error !== undefined && (typeof row.error !== "string" || row.error.length > 2000))
    )
      throw Error("MODS_RUNTIME_RECEIPTS_INVALID")
    const key = JSON.stringify([row.workspace, row.threadId])
    if (keys.has(key)) throw Error("MODS_RUNTIME_RECEIPTS_INVALID")
    keys.add(key)
    return {
      ...row,
      ...(row.state === "releasing"
        ? {
            state: "failed" as const,
            error: "上次释放或恢复未确认完成，组件保持停止，请先核对任务结果。"
          }
        : {})
    }
  })
}

export function readRuntimeStopReceipts(store: ModControlStore): RuntimeStopReceipt[] {
  return decodeRuntimeStopReceipts(
    store.getSetting(RUNTIME_STOP_RECEIPTS_KEY, '{"version":1,"sessions":[]}')
  )
}

export function writeRuntimeStopReceipts(
  store: ModControlStore,
  receipts: Iterable<RuntimeStopReceipt>
): void {
  const sessions = [...receipts]
  if (sessions.length > 64) throw Error("MODS_RUNTIME_RECEIPTS_CAPACITY")
  const text = JSON.stringify({ version: 1, sessions })
  decodeRuntimeStopReceipts(text)
  store.setSetting(RUNTIME_STOP_RECEIPTS_KEY, text)
}
