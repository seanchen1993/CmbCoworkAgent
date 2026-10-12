import { botWindowsNativeSetupRequest } from "../../../shared/bot-windows-native-setup"
import type { z } from "zod"
export type WindowsSetupRequest = z.infer<typeof botWindowsNativeSetupRequest>
const key = "cmbdevclaw.windows-native-setup.pending.v1"
export function readWindowsSetupPending(): {
  request: WindowsSetupRequest | null
  corrupt: boolean
} {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return { request: null, corrupt: false }
    if (raw.length > 1024) throw new Error("Invalid stored setup request")
    return { request: botWindowsNativeSetupRequest.parse(JSON.parse(raw)), corrupt: false }
  } catch {
    return { request: null, corrupt: true }
  }
}
export function rememberWindowsSetupPending(request: WindowsSetupRequest): void {
  const parsed = botWindowsNativeSetupRequest.parse(request),
    raw = JSON.stringify(parsed)
  const previous = readWindowsSetupPending()
  if (
    previous.corrupt ||
    (previous.request &&
      (previous.request.nonce !== parsed.nonce || previous.request.scope !== parsed.scope))
  )
    throw new Error("已有初始化请求待确认，请先核对原请求")
  localStorage.setItem(key, raw)
  if (localStorage.getItem(key) !== raw) throw new Error("无法保存初始化请求，尚未开始初始化")
}
export function forgetWindowsSetupPending(request: WindowsSetupRequest): void {
  const stored = readWindowsSetupPending()
  if (
    stored.corrupt ||
    stored.request?.nonce !== request.nonce ||
    stored.request.scope !== request.scope
  )
    throw new Error("初始化请求记录已变化，请重新打开设置")
  localStorage.removeItem(key)
}
/** This only discards invalid UI bytes. The independent Main/Host physical
 * receipt barrier still blocks unknown provisioning and does not replay it. */
export function discardCorruptWindowsSetupPending(): void {
  if (!readWindowsSetupPending().corrupt) throw new Error("初始化请求记录已变化")
  localStorage.removeItem(key)
}
