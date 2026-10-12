import { BotDomainError } from "../../../shared/bot-types"
import {
  botErrorDiagnosticSchema,
  type BotErrorDiagnostic
} from "../../../shared/bot-error-diagnostic"
import type { BotErrorTray, BotErrorTraySnapshot } from "../../../shared/bot-error-trays"
import { getApiErrorInfo } from "../../../main/agent/api-errors"

const STATUS_BY_ERROR_CODE = new Map([
  ["authentication_failed", 401],
  ["invalid_request", 400],
  ["rate_limit", 429],
  ["server_error", 500]
])
const ERROR_SOURCE_TITLES: Record<BotErrorTray["source"], string> = {
  run: "任务未完成",
  memory: "记忆整理未完成",
  teach: "示范处理未完成",
  backup: "备份未完成",
  host: "后台发生错误",
  rpc: "操作未完成"
}

/** Compact summaries use bounded typed metadata, never provider prose or paths.
 * A failed maintenance operation says nothing about the task's final outcome. */
export function compactBotErrorSummary(tray: Pick<BotErrorTray, "diagnostic" | "source">) {
  const info = getApiErrorInfo(
    tray.diagnostic.status ?? STATUS_BY_ERROR_CODE.get(tray.diagnostic.code),
    tray.diagnostic.code
  )
  if (info) return { title: info.label, message: info.hint ?? "查看错误详情" }
  if (tray.diagnostic.code === "network_error")
    return { title: "连接中断", message: "请检查网络连接，再查看错误详情" }
  const title = ERROR_SOURCE_TITLES[tray.source]
  return { title, message: `${title}，查看错误详情` }
}

export interface BotErrorNotice {
  message: string
  diagnostic?: BotErrorDiagnostic
}

export type BotErrorDiagnosticIdKind = "requestId" | "correlationId" | "callId"
export interface BotErrorDiagnosticId {
  kind: BotErrorDiagnosticIdKind
  label: string
  value: string
}

const NOTICE_LIMIT = 2_000
function noticeMessage(message: string, fallback: string): string {
  // Node owns secret redaction before persistence/wire transport. The renderer
  // only bounds the already safe message and renders it as plain text.
  return message.trim().slice(0, NOTICE_LIMIT) || fallback.trim().slice(0, NOTICE_LIMIT)
}

export function botErrorNotice(error: unknown, fallback = "操作失败，请重试"): BotErrorNotice {
  const message = noticeMessage(
    typeof error === "string" ? error : error instanceof Error ? error.message : "",
    fallback
  )
  // Only the IPC facade's domain error carries trusted, structured diagnostics.
  // Do not infer a provider request ID from arbitrary objects or error text.
  if (!(error instanceof BotDomainError)) return { message }
  const candidate = "diagnostic" in error ? error.diagnostic : undefined
  const parsed = botErrorDiagnosticSchema.safeParse(candidate)
  const code = botErrorDiagnosticSchema.safeParse({ code: error.code })
  return {
    message,
    ...(parsed.success
      ? { diagnostic: parsed.data }
      : code.success
        ? { diagnostic: code.data }
        : {})
  }
}

export function botErrorDiagnosticIds(diagnostic?: BotErrorDiagnostic): BotErrorDiagnosticId[] {
  if (!diagnostic) return []
  const labels: Record<BotErrorDiagnosticIdKind, string> = {
    requestId: "服务请求 ID",
    correlationId: "本地关联 ID",
    callId: "模型调用 ID"
  }
  return (["requestId", "correlationId", "callId"] as const).flatMap((kind) => {
    const value = diagnostic[kind]
    return value ? [{ kind, label: labels[kind], value }] : []
  })
}

export type BotErrorTrayOperation =
  | { kind: "dismiss"; id: string; revision: number }
  | { kind: "clear"; throughRevision: number }

export interface BotErrorTrayFeedback {
  tone: "info" | "error"
  notice: BotErrorNotice
}

export function botErrorTrayScopeKey(snapshot: Pick<BotErrorTraySnapshot, "hostId" | "dataEpoch">) {
  return JSON.stringify([snapshot.hostId, snapshot.dataEpoch])
}

export function botErrorTrayReceiptFeedback(
  expected: Pick<BotErrorTraySnapshot, "hostId" | "dataEpoch">,
  receipt: BotErrorTraySnapshot,
  operation: BotErrorTrayOperation
): BotErrorTrayFeedback | null {
  if (receipt.hostId !== expected.hostId || receipt.dataEpoch !== expected.dataEpoch)
    return {
      tone: "info",
      notice: { message: "后台已切换，请刷新通知后重试" }
    }
  if (operation.kind === "dismiss") {
    const remaining = receipt.items.find((item) => item.id === operation.id)
    if (remaining)
      return remaining.revision > operation.revision
        ? { tone: "info", notice: { message: "通知已更新，请查看后再关闭" } }
        : { tone: "error", notice: { message: "通知尚未关闭，请重试" } }
  } else if (receipt.items.some((item) => item.revision <= operation.throughRevision))
    return { tone: "error", notice: { message: "通知尚未清除，请重试" } }
  return null
}
