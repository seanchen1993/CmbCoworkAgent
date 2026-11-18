import { coordinatorTranscriptContentToText } from "../../shared/internal-notification-turn"
import { BotError, type BotDefinition, type BotTask } from "../../shared/bots/contracts"
import { botWorkAttachmentHref, botWorkHistoryHref, botWorkHref } from "../../shared/bots/work-history"
import { getThreadMessagesByIds } from "../db"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import type { LocalBotHost } from "./host"
import { createBotResultEvidenceReader, type BotResultEvidence } from "./work-result-evidence"
import { includeWorkResultAnswers, projectWorkResultProcess } from "./work-result-process"
import { verifiedWorkResultThread } from "./work-result-thread"
import { botHistoryMessageBody } from "./work-history"
import { announceBotResultMessage, persistBotResultMessage, completeBotResultMessage } from "./work-result-publication"
import { botSnapshotSourceRoot } from "./attachment-storage"
import { RetryableBotWorkPublicationError, normalWorkResultSummary, hasWorkCommandOutput, workResultMoreAttachmentsLabel, workResultServiceReadAllowance, type BotWorkResultCommandReference, type BotWorkResultAttachmentReference } from "./work-result-settlement"
import { isBinaryExtension } from "../ipc/plugin-file-gates"

const MAX_RESULT_TEXT_RECORDS = 3
const REVIEW_FIRST_BATCH_SNAPSHOTS = 8
const REVIEW_RESERVED_COMMANDS = 4
type ReviewCommandEvidence = Extract<BotResultEvidence, { kind: "text" }> & { readinessCandidate: boolean; failed: boolean }

function assertLease(task: BotTask, signal: AbortSignal) {
  signal.throwIfAborted()
  const lease = getLocalThreadRunLease(task.threadId)
  if (lease?.owner !== "bot" || lease.runId !== task.id)
    throw new Error("原结果核查的执行归属已变化。")
}

async function parseEvidence(
  taskId: string,
  input: {
    filename: string
    bytes: Uint8Array
    maxChars: number
    signal: AbortSignal
  }
) {
  const [{ isSupportedFile }, { getFileAttachmentParserClient }] = await Promise.all([
    import("../file-parser"),
    import("../file-attachment-parser/client")
  ])
  input.signal.throwIfAborted()
  if (!isSupportedFile(input.filename)) {
    const unsupported = { text: "此文件的留存字节与原正式快照一致。此格式未提取正文。", truncated: true }
    if (isBinaryExtension(input.filename)) return unsupported
    // The evidence reader has already authenticated these retained bytes. Match
    // file readers' strict UTF-8 handling without reopening the mutable source
    // or decoding an entire large file just to return one bounded excerpt.
    const bytes = input.bytes.subarray(0, input.maxChars * 4 + 4)
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes, {
        stream: bytes.length < input.bytes.length
      })
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return unsupported
      const excerpt = text.slice(0, input.maxChars).replace(/[\uD800-\uDBFF]$/, "")
      return {
        text: excerpt,
        truncated: bytes.length < input.bytes.length || excerpt.length < text.length
      }
    } catch {
      return unsupported
    }
  }
  const client = getFileAttachmentParserClient(),
    key = `bot-result-review:${taskId}`
  const cancel = () => client.cancelLatest(key)
  input.signal.addEventListener("abort", cancel, { once: true })
  try {
    const result = await client.parse(
      {
        kind: "bytes",
        fileName: input.filename,
        bytes: new Uint8Array(input.bytes).buffer
      },
      input.maxChars,
      key
    )
    return { text: result.content, truncated: result.truncated }
  } finally {
    input.signal.removeEventListener("abort", cancel)
  }
}

export function createWorkResultEvidenceAccess(
  host: LocalBotHost,
  bot: BotDefinition,
  task: BotTask,
  signal: AbortSignal
) {
  const current = () => {
    assertLease(task, signal)
    const context = host.workResultReview(task.id)
    if (!context) throw new Error("原工作或用户请求已变化，已结束本次核查。")
    const identity = verifiedWorkResultThread(context.work)
    if (identity.incarnation !== context.incarnation)
      throw new Error("原任务会话已变化，无法核查。")
    return { ...context, ...identity }
  }
  const original = current()
  const foregroundEvidence: ReviewCommandEvidence[] = []
  const commandReferences = new Map<string, BotWorkResultCommandReference>()
  const inspectedCommands = new Map<string, BotWorkResultCommandReference>()
  const referenceKey = (sourceTaskId: string, messageId: string) => JSON.stringify([sourceTaskId, messageId])
  const reader = createBotResultEvidenceReader(
    {
      botId: bot.id,
      workId: original.work.id,
      threadId: original.work.threadId,
      executionTaskId: original.executionTaskId,
      reviewTaskId: task.id
    },
    (binding) => {
      const context = current()
      if (
        context.work.id !== binding.workId ||
        context.work.threadId !== binding.threadId ||
        context.executionTaskId !== binding.executionTaskId ||
        context.requestTaskId !== original.requestTaskId
      )
        return null
      const snapshots: BotResultEvidence[] = []
      const commandEvidence: ReviewCommandEvidence[] = []
      const resultEvidence: BotResultEvidence[] = []
      const earlierVersions: BotResultEvidence[] = []
      const seen = new Set<string>()
      const paths = new Set<string>()
      const executions = context.evidence.filter(
        (execution) => execution.threadId === binding.threadId
      )
      // Keep the latest files first within the bounded catalogue, but retain
      // earlier exact versions for inspection and explicit selection.
      for (const execution of [...executions].reverse()) {
        for (const delivery of [...execution.deliveries].reverse()) {
          const reference = JSON.stringify([delivery.sourceTaskId, delivery.callId, delivery.fileIndex])
          if (
            delivery.sourceTaskId !== execution.taskId ||
            !delivery.file.attachmentPath ||
            seen.has(reference)
          )
            continue
          seen.add(reference)
          try {
            const target = paths.has(delivery.file.filePath) ? earlierVersions : snapshots
            target.push({
              kind: "snapshot", ...delivery, root: botSnapshotSourceRoot(delivery.file, context.workspacePath)
            })
            paths.add(delivery.file.filePath)
          } catch {
            // The retained source is unavailable. Its mutable original cannot replace it.
          }
        }
      }
      for (const command of context.commands) {
        if (!command.result.output && command.result.exitCode == null) continue
        commandReferences.set(referenceKey(command.sourceTaskId, command.id), {
          evidenceId: "", kind: "background", sourceTaskId: command.sourceTaskId, commandId: command.id
        })
        commandEvidence.push({
          kind: "text",
          sourceTaskId: command.sourceTaskId,
          messageId: command.id,
          label: "原任务命令结果",
          text: JSON.stringify({ state: command.state, ...command.result }),
          truncated: command.result.truncated,
          failed: command.result.exitCode != null && command.result.exitCode !== 0,
          readinessCandidate: command.state === "completed" && command.result.exitCode === 0 &&
            !command.result.cancelled && !command.result.unknown && !command.result.truncated &&
            hasWorkCommandOutput(command.result.output)
        })
      }
      for (const execution of executions
        .filter(item => item.finalMessageId && (!context.currentScopeIds || context.currentScopeIds.includes(item.taskId)))
        .slice(-MAX_RESULT_TEXT_RECORDS)
        .reverse()) {
        const [message] = getThreadMessagesByIds(binding.threadId, [execution.finalMessageId!])
        const body = message?.role === "assistant" && botHistoryMessageBody(message)
        if (body)
          resultEvidence.push({
            kind: "text",
            sourceTaskId: execution.taskId,
            messageId: message.id,
            label: "原任务执行结果",
            ...body
          })
      }
      const allowance = workResultServiceReadAllowance(context.services)
      if (allowance) {
        // Keep the first delivery batch visible. Use the remaining bounded
        // catalogue for current command receipts before optional history.
        const checks: ReviewCommandEvidence[] = []
        for (let i = 0; i < Math.max(foregroundEvidence.length, commandEvidence.length); i++) {
          if (foregroundEvidence[i]) checks.push(foregroundEvidence[i])
          if (commandEvidence[i]) checks.push(commandEvidence[i])
        }
        const preferred = checks.filter(item => item.readinessCandidate).slice(0, allowance)
        const failures = checks.filter(item => item.failed).slice(0, Math.floor(REVIEW_RESERVED_COMMANDS / 2))
        const front = new Set([...preferred, ...failures])
        const other = checks.filter(item => !front.has(item))
        const outcomeSlots = failures.length ? 1 : 0
        return [...snapshots.slice(0, REVIEW_FIRST_BATCH_SNAPSHOTS), ...preferred, ...failures,
          ...other.slice(0, REVIEW_RESERVED_COMMANDS - failures.length), ...resultEvidence.slice(0, outcomeSlots),
          ...other.slice(REVIEW_RESERVED_COMMANDS - failures.length), ...resultEvidence.slice(outcomeSlots),
          ...snapshots.slice(REVIEW_FIRST_BATCH_SNAPSHOTS), ...earlierVersions]
      }
      // Keep room in the two ordinary review pages for receipts and results.
      const backgroundCount = Math.min(commandEvidence.length, Math.floor(REVIEW_RESERVED_COMMANDS / 2))
      const foregroundCount = Math.min(foregroundEvidence.length, REVIEW_RESERVED_COMMANDS - backgroundCount)
      const remainingCommandSlots = REVIEW_RESERVED_COMMANDS - foregroundCount
      return [
        ...snapshots.slice(0, REVIEW_FIRST_BATCH_SNAPSHOTS),
        ...foregroundEvidence.slice(0, foregroundCount),
        ...commandEvidence.slice(0, remainingCommandSlots),
        ...resultEvidence,
        ...snapshots.slice(REVIEW_FIRST_BATCH_SNAPSHOTS),
        ...commandEvidence.slice(remainingCommandSlots),
        ...foregroundEvidence.slice(foregroundCount),
        ...earlierVersions
      ]
    },
    (input) => parseEvidence(task.id, input)
  )
  const executionEvidence = original.evidence.find(
    execution => execution.taskId === original.executionTaskId && execution.threadId === original.work.threadId
  )
  const finalMessageId = executionEvidence?.processMessageId ?? executionEvidence?.finalMessageId
  const addForegroundCommands = (source: typeof executionEvidence, earlier: boolean) => {
    if (!source || source.threadId !== original.work.threadId) return
    for (const { callId, ...receipt } of [...(source.foregroundCommands ?? [])].reverse()) {
      commandReferences.set(referenceKey(source.taskId, `foreground-command:${callId}`), {
        evidenceId: "", kind: "foreground", sourceTaskId: source.taskId, callId
      })
      foregroundEvidence.push({ kind: "text", sourceTaskId: source.taskId, messageId: `foreground-command:${callId}`,
        // Repeated runs otherwise look identical before inspection. Use the
        // existing Host observation time, without exposing command arguments.
        label: (earlier ? "同一请求较早回合的前台命令" : "本轮前台命令") +
          (Number.isFinite(receipt.observedAt) ? ` · observedAt(ms)=${receipt.observedAt}` : ""),
        // This bounded observation is complete as an exit-code record. Any
        // omitted output is explicitly marked inside it, and cannot be inferred.
        text: JSON.stringify(receipt),
        failed: receipt.exitCode !== 0,
        readinessCandidate: receipt.exitCode === 0 && !receipt.excerpt &&
          (receipt.exactCommand === true || hasWorkCommandOutput(receipt.output)) })
    }
  }
  addForegroundCommands(executionEvidence, false)
  for (const sourceId of [...(original.earlierForegroundCommandIds ?? [])].reverse())
    addForegroundCommands(original.evidence.find(item => item.taskId === sourceId), true)
  const readProcess = async () => {
    const previousInputs = original.previousProcesses ?? []
    const [page, previousPages] = await Promise.all([
      finalMessageId && original.executionRequestId
        ? readThreadMessagesPageInWorker(original.work.threadId, {
            targetMessageId: finalMessageId, limit: 24, byteBudget: 96 * 1024
          }).catch(() => null)
        : null,
      Promise.all(previousInputs.map(execution =>
        readThreadMessagesPageInWorker(original.work.threadId, {
          targetMessageId: execution.finalMessageId, limit: 24, byteBudget: 96 * 1024
        }).catch(() => null)))
    ])
    signal.throwIfAborted()
    current()
    // These receipts were observed within the authorized tool invocation,
    // independently of how many rows or bytes of the transcript fit below.
    const latest = page && finalMessageId
      ? projectWorkResultProcess(page, {
          taskId: original.executionTaskId,
          requestId: original.executionRequestId,
          supplementRequestIds: original.executionSupplementRequestIds,
          finalMessageId,
          foregroundCommands: executionEvidence?.foregroundCommands,
          earlierExecutions: original.evidence.length > 1
        })
      : undefined
    const previous = previousInputs.map((execution, index) => {
      const earlierPage = previousPages[index]
      return earlierPage ? projectWorkResultProcess(earlierPage, {
        ...execution, earlierExecutions: true
      }, true) : { coverage: "unavailable" as const, steps: [] }
    })
    return includeWorkResultAnswers(latest, previous)
  }
  const selection: { attachments?: BotWorkResultAttachmentReference[] } = {}
  // Historical ready services are not automatically dependencies of this report.
  const serviceIds = new Set<string>()
  return { current, reader, commandReferences, inspectedCommands, serviceIds, selection, referenceKey, readProcess }
}

export async function publishWorkResult(
  host: LocalBotHost,
  bot: BotDefinition,
  task: BotTask,
  signal: AbortSignal,
  prepareMainThread: () => void
): Promise<void> {
  assertLease(task, signal)
  if (task.threadId !== bot.threadId) throw new Error("原结果交付身份已变化。")
  let written: ReturnType<typeof getThreadMessagesByIds>[number] | null
  let publication: NonNullable<ReturnType<LocalBotHost["workResultPublication"]>>
  let work: ReturnType<LocalBotHost["getWork"]>
  let identity: ReturnType<typeof verifiedWorkResultThread>
  try {
    const pending = host.workResultPublication(task.id)
    if (!pending) throw new BotError("CONFLICT", "原结果交付身份已变化。")
    written = getThreadMessagesByIds(task.threadId, [pending.responseMessageId ?? task.requestId])[0] ?? null
    // A normal reply exists before publication. Refresh dependencies only while
    // it still contains the original text, never after links have been committed.
    const unfinished = pending.responseMessageId && written?.role === "assistant" &&
      coordinatorTranscriptContentToText(written.content).trim() === (pending.responseText ?? pending.summary)
    publication = (!written || unfinished ? host.workResultPublication(task.id, true) : pending) ?? pending
    work = host.getWork(bot.id, publication.workId)
    identity = verifiedWorkResultThread(work)
    if (work.threadId !== publication.workThreadId || identity.incarnation !== publication.incarnation)
      throw new BotError("CONFLICT", "原任务会话已变化，无法交付。")
  } catch (error) {
    if (signal.aborted || error instanceof BotError) throw error
    throw new RetryableBotWorkPublicationError({ cause: error })
  }
  const historyHref = (messageId: string) =>
    botWorkHistoryHref({ workId: work.id, messageId, incarnation: identity.incarnation })
  const links = publication.attachments.map((item) => {
    const name = item.file.name
      .replace(/\p{Cc}/gu, " ")
      .replace(/([\\[\]])/g, "\\$1")
      .slice(0, 160)
    const messageId = item.assistantMessageId ?? item.finalMessageId
    if (!messageId) return `- ${name}`
    const href = publication.attachmentLinkVersion === 1 && item.assistantMessageId
      ? botWorkAttachmentHref({ workId: work.id, messageId: item.assistantMessageId,
          incarnation: identity.incarnation, callId: item.callId, fileIndex: item.fileIndex })
      : historyHref(messageId)
    return `- [${name}](${href})`
  })
  const more = publication.moreAttachments
  const moreHref = more?.messageId ? historyHref(more.messageId) :
    publication.finalMessageId ? historyHref(publication.finalMessageId) : botWorkHref(work.id)
  const summary = publication.responseMessageId ? normalWorkResultSummary(publication.summary, work.id, publication) : publication.summary
  const suffix = [
    ...(links.length ? [links.join("\n")] : []),
    ...(more ? [`[${workResultMoreAttachmentsLabel(more.count)}，点击查看](${moreHref})`] : []),
    ...(publication.finalMessageId
      ? [`[查看原任务结果](${historyHref(publication.finalMessageId)})`]
      : [])
  ].join("\n\n")
  const withLinks = (text: string) => [text, ...(suffix ? [suffix] : [])].join("\n\n")
  const content = withLinks(summary)
  try {
    prepareMainThread()
    if (publication.responseMessageId) {
      completeBotResultMessage(task.threadId, publication.responseMessageId,
        publication.responseText ?? publication.summary, content, written ?? undefined,
        summary !== publication.summary ? withLinks(publication.summary) : undefined)
    } else {
      persistBotResultMessage(task.threadId, publication.id, content, task.createdAt, written)
    }
    if (!host.acknowledgeWorkResultPublication(task.id)) return
  } catch (error) {
    if (signal.aborted || error instanceof BotError) throw error
    throw new RetryableBotWorkPublicationError({ cause: error })
  }
  const ready = publication.kind === "ready"
  const reported = publication.kind === "reported"
  await announceBotResultMessage({
    threadId: task.threadId,
    id: publication.responseMessageId ?? publication.id,
    content,
    attention: ready || reported
      ? "task-complete"
      : publication.kind === "needs_user"
        ? "interaction"
        : "task-error",
    notificationTitle: `${bot.name} · ${ready ? "任务成果可查看" : reported ? "任务结果已回传" : "任务需要你查看"}`,
    notificationBody: summary,
    ...(ready ? { petTitle: work.title } : {})
  })
}
