import { parseBotWorkAttachmentHref, parseBotWorkHistoryHref } from "../../shared/bots/work-history"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import type { BotTask, BotTaskState } from "../../shared/bots/contracts"
import { splitBotInlineReasoning } from "../../shared/bots/inline-reasoning"

export interface BotWorkResultAttachmentReference {
  sourceTaskId: string
  callId: string
  fileIndex: number
}

/** Internal mapping of a final citation to a command actually read by this private review. */
export type BotWorkResultCommandReference = { evidenceId: string; sourceTaskId: string } & (
  | { kind: "foreground"; callId: string }
  | { kind: "background"; commandId: string }
)

export interface BotWorkResultAttachment extends BotWorkResultAttachmentReference {
  file: BotDeliveredFile
  finalMessageId?: string
  assistantMessageId?: string
}

export interface BotWorkResultExecutionEvidence {
  taskId: string
  threadId: string
  finalMessageId?: string
  /** Private process endpoint for a silent physical turn. Never used as a result link. */
  processMessageId?: string
  deliveries: BotWorkResultAttachment[]
  foregroundCommands?: { callId: string; command: string; exactCommand?: true; directory?: string;
    exitCode: number; output: string; excerpt: boolean; startedAt?: number; observedAt?: number }[]
}

export interface BotWorkResultReviewRecord {
  requestTaskId: string
  authorityTaskId: string
  sourceTaskIds?: string[]
  incarnation: string
  phase: "executing" | "waiting" | "checking" | "interrupted" | "settled" | "retired"
  attempts: number
  repairs: number
  executionTaskId: string
  executionIds: string[]
  /** Standalone input that superseded an earlier execution in this request chain. */
  inputExecutionTaskId?: string
  /** First automatically attachable receipt after the latest accepted input. */
  attachmentBoundary?: { taskId: string; deliveryOffset: number }
  /** Accepted input that owns the current command and peer evidence. */
  commandScopeId?: string
  repairTaskId?: string
  reviewTaskId?: string
  outcome?: {
    state: BotTaskState
    text: string
    truncated: boolean
    /** A quiet continuation can keep the prior visible result. Null records that no source is available. */
    finalMessageId?: string | null
  }
  lastRepairFingerprint?: string
  deliveryOnly?: true
  redirectedExecutionTaskId?: string
}

export interface BotWorkResultPublication {
  id: string
  botId: string
  workId: string
  workThreadId: string
  incarnation: string
  requestTaskId: string
  executionTaskId: string
  /** Visible result in the same request chain, possibly before the final execution. */
  finalMessageId?: string
  sourceCreatedAt: number
  /** Already persisted final reply of the normal parent Bot turn; never a model-supplied ID. */
  responseMessageId?: string
  /** Original streamed text, retained if dependency validation amends the publication. */
  responseText?: string
  kind: "reported" | "ready" | "blocked" | "needs_user" | "interrupted"
  summary: string
  /** Absent on older receipts, whose persisted publication text must remain identical on retry. */
  attachmentLinkVersion?: 1
  /** Exact silent commands this result still needs. Empty explicitly means an offline result. */
  serviceIds?: string[]
  /** A selected dependency became unavailable while this result was being settled. */
  unavailableDependency?: true
  attachments: BotWorkResultAttachment[]
  /** Formal files in the same request scope that are available in its original history. */
  moreAttachments?: { count: number; messageId?: string }
}

/** An already reviewed alternative kept only until the first publication is prepared. */
export type BotWorkResultPublicationChoice = Pick<BotWorkResultPublication,
  "kind" | "summary" | "serviceIds" | "unavailableDependency" | "attachments" | "moreAttachments">

export function describeUnavailableWorkService(result: Pick<BotWorkResultPublicationChoice, "kind" | "summary">) {
  return { unavailableDependency: true as const, ...(result.kind === "ready"
    ? { kind: "blocked" as const, summary: "成果所需的服务已停止或就绪状态已失效，请在原任务查看已交付内容。" }
    : { kind: result.kind, summary: `成果所需的服务当前不可用。${result.kind === "reported" ? "原报告" : "原核查记录"}为「${splitBotInlineReasoning(result.summary).body}」` }) }
}

export function workResultMoreAttachmentsLabel(count: number): string {
  return `原任务还有 ${count} 个文件可查看`
}

export type BotWorkResultReviewCommit =
  | { state: "repair"; task: BotTask }
  | { state: "publish"; publication: BotWorkResultPublication }
  | { state: "yielded" }

export const BOT_WORK_RESULT_REPAIR_LIMIT = 2
export const BOT_WORK_RESULT_PUBLICATION_RETRY_LIMIT = 2
export const BOT_WORK_RESULT_DEFAULT_ATTACHMENT_LIMIT = 16
export const BOT_WORK_RESULT_SELECTED_ATTACHMENT_LIMIT = 8
export const BOT_WORK_RESULT_INTERRUPTED_ATTACHMENT_LIMIT = 8
export const BOT_WORK_RESULT_SERVICE_LIMIT = 16
export const BOT_WORK_RESULT_COMMAND_EVIDENCE_BASE = 8
export const BOT_WORK_RESULT_COMMAND_EVIDENCE_EXTRA = 8

export function hasWorkCommandOutput(output: unknown): boolean {
  if (typeof output !== "string") return false
  const text = output.trim()
  return text !== "" && text !== "<no output>"
}

export interface BotWorkResultServices {
  items: { id: string; command: string; state: string; ready: boolean;
    readiness?: { checkId: string; checkedAt: number; reason: string } }[]
  truncated: boolean
}

export function workResultServiceReadAllowance(services?: BotWorkResultServices): number {
  return Math.min(BOT_WORK_RESULT_COMMAND_EVIDENCE_EXTRA,
    services?.items.filter(item => item.state === "accepted" && !item.ready).length ?? 0)
}

/** The publication was accepted, but its transcript write or acknowledgement could not be confirmed. */
export class RetryableBotWorkPublicationError extends Error {
  constructor(options?: ErrorOptions) {
    super("原结果投递未确认，请在原任务查看已有成果。", options)
  }
}

/** Formal attachment rows and the current result link are generated from Host receipts. */
export function normalWorkResultSummary(text: string, workId: string,
  publication?: Pick<BotWorkResultPublication, "finalMessageId" | "attachments">): string {
  const deliveredNames = new Set(publication?.attachments.map(item => item.file.name
    .replace(/\p{Cc}/gu, " ").replace(/([\\[\]])/g, "\\$1").slice(0, 160)))
  let fence: { marker: string; length: number } | undefined
  return splitBotInlineReasoning(text).body.split("\n").filter(line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length }
      else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined
      return true
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return true
    const link = line.trim().match(/^(?:(?:[-*+]|\d{1,9}[.)])\s+)?\[((?:\\.|[^\]\\])+)\]\((#bot-history\/[^\s)]+)\)$/)
    if (!link) return true
    if (parseBotWorkAttachmentHref(link[2])?.workId === workId) return false
    const history = parseBotWorkHistoryHref(link[2])
    if (history?.workId !== workId) return true
    // A file label pointing at this result is an echoed delivery row, not an
    // attachment preview. Keep other messages and prose citations intact.
    if (publication?.finalMessageId === history.messageId && deliveredNames.has(link[1])) return false
    return link[1] !== "查看原任务结果"
  }).join("\n").trimEnd()
}
