import {
  botBrowserMaintenanceRequest,
  type BotBrowserMaintenanceRequest
} from "../../../shared/bot-browser-maintenance"
import { z } from "zod"
import {
  botComputerCheckpointRequest,
  botComputerCheckpointSelection
} from "../../../shared/bot-computer-checkpoint"

const computerRequest = z.union([
  botComputerCheckpointRequest,
  z
    .object({ action: z.literal("delete-recovery"), checkpoint: botComputerCheckpointSelection })
    .strict()
])
export type BotComputerMaintenanceRequest = z.infer<typeof computerRequest>
export type MaintenancePendingRecord<T> =
  | { kind: "empty" }
  | { kind: "valid"; value: T }
  | { kind: "corrupt"; raw: string }
  | { kind: "unreadable" }
interface MaintenancePending<T> {
  inspect(): MaintenancePendingRecord<T>
  pending(): T | null
  remember(value: T): void
  forget(value: T): void
}

function pendingStore<T>(
  kind: string,
  schema: z.ZodType<T>,
  protect = false
): MaintenancePending<T> {
  const key = `cmb:bot-${kind}-maintenance:pending`
  function inspect(): MaintenancePendingRecord<T> {
    let raw: string | null
    try {
      raw = localStorage.getItem(key)
    } catch {
      return { kind: "unreadable" }
    }
    if (raw === null) return { kind: "empty" }
    if (!raw || raw.length > 4096) return { kind: "corrupt", raw }
    try {
      const value = schema.safeParse(JSON.parse(raw))
      return value.success ? { kind: "valid", value: value.data } : { kind: "corrupt", raw }
    } catch {
      return { kind: "corrupt", raw }
    }
  }
  function pending(): T | null {
    const record = inspect()
    return record.kind === "valid" ? record.value : null
  }
  function remember(value: T): void {
    const normalized = protect ? schema.parse(value) : value
    if (protect) {
      const record = inspect()
      if (record.kind === "unreadable" || record.kind === "corrupt") {
        throw new Error("无法读取上次操作记录，本次操作尚未提交。")
      }
      const previous = record.kind === "valid" ? record.value : null
      if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) {
        throw new Error("还有一项操作尚未确认，请先核对原请求。")
      }
    }
    // Do not send a replacement that cannot be reconciled after a lost response.
    try {
      localStorage.setItem(key, JSON.stringify(normalized))
    } catch {
      throw new Error("无法保存操作记录，本次操作尚未提交。")
    }
  }
  function forget(value: T): void {
    const normalized = protect ? schema.parse(value) : value
    const record = inspect()
    if (protect && (record.kind === "unreadable" || record.kind === "corrupt"))
      throw new Error("无法核对本机操作记录，原请求仍保留。")
    if (record.kind === "valid" && JSON.stringify(record.value) === JSON.stringify(normalized))
      localStorage.removeItem(key)
  }

  return { inspect, pending, remember, forget }
}
export function maintenancePending(
  kind: "computer"
): MaintenancePending<BotComputerMaintenanceRequest>
export function maintenancePending(
  kind: "browser" | "workspace"
): MaintenancePending<BotBrowserMaintenanceRequest>
export function maintenancePending(kind: "browser" | "workspace" | "computer") {
  return kind === "computer"
    ? pendingStore(kind, computerRequest, true)
    : pendingStore(kind, botBrowserMaintenanceRequest)
}
const browser = maintenancePending("browser")
export const pendingBrowserMaintenance = browser.pending
export const rememberBrowserMaintenance = browser.remember
export const forgetBrowserMaintenance = browser.forget

/** Only discard an explicitly preserved corrupt record, never a new valid intent. */
export function discardCorruptComputerMaintenance(expectedRaw: string): boolean {
  const store = maintenancePending("computer")
  const current = store.inspect()
  if (current.kind === "unreadable") throw new Error("无法读取操作记录，原记录仍保留。")
  if (current.kind !== "corrupt" || current.raw !== expectedRaw) return false
  localStorage.removeItem("cmb:bot-computer-maintenance:pending")
  return true
}
