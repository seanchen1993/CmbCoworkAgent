/**
 * ACPX Session Manager — 管理 threadId 与 acpx 会话的映射关系。
 *
 * 负责：
 *   - 创建 / 恢复 acpx 会话（ensureSession）
 *   - 发送消息并流式返回事件（runTurn）
 *   - 取消 / 关闭会话
 */

import { v4 as uuid } from "uuid"
import {
  getAcpxRuntime,
  type AcpRuntimeHandle,
  type AcpRuntimeEvent
} from "./runtime"

// ── 会话映射 ──
// threadId -> handle（内存缓存，acpx SDK 内部有持久化）
const handleMap = new Map<string, AcpRuntimeHandle>()

export type AcpxAgentId = string // "codex" | "claude" | "cursor" | "gemini" | ...

/**
 * 确保线程对应的 acpx 会话存在。
 * 如果已存在则复用，否则创建新会话。
 */
export async function ensureAcpxSession(
  threadId: string,
  agentId: AcpxAgentId,
  cwd: string
): Promise<AcpRuntimeHandle> {
  const existing = handleMap.get(threadId)
  if (existing) return existing

  const runtime = getAcpxRuntime(cwd)
  const handle = await runtime.ensureSession({
    sessionKey: `cmbcowork:${threadId}`,
    agent: agentId,
    mode: "persistent",
    cwd
  })

  handleMap.set(threadId, handle)
  return handle
}

/**
 * 发送消息给 acpx 会话，返回异步事件流。
 */
export function runAcpxTurn(
  threadId: string,
  text: string,
  signal?: AbortSignal
): AsyncIterable<AcpRuntimeEvent> {
  const handle = handleMap.get(threadId)
  if (!handle) {
    throw new Error(`No acpx session found for thread ${threadId}`)
  }

  const runtime = getAcpxRuntime(handle.cwd || process.cwd())
  return runtime.runTurn({
    handle,
    text,
    mode: "prompt",
    requestId: uuid(),
    signal
  })
}

/**
 * 取消当前 turn。
 */
export async function cancelAcpxTurn(threadId: string): Promise<void> {
  const handle = handleMap.get(threadId)
  if (!handle) return

  const runtime = getAcpxRuntime(handle.cwd || process.cwd())
  await runtime.cancel({ handle, reason: "user-cancelled" })
}

/**
 * 关闭会话并清理。
 */
export async function closeAcpxSession(threadId: string): Promise<void> {
  const handle = handleMap.get(threadId)
  if (!handle) return

  const runtime = getAcpxRuntime(handle.cwd || process.cwd())
  await runtime.close({ handle, reason: "session-end" })
  handleMap.delete(threadId)
}

/**
 * 检查线程是否有活跃的 acpx 会话。
 */
export function hasAcpxSession(threadId: string): boolean {
  return handleMap.has(threadId)
}
