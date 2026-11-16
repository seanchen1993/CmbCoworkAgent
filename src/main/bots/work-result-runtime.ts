import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { AsyncLocalStorageProviderSingleton } from "@langchain/core/singletons"
import { BotError, type BotDefinition, type BotTask } from "../../shared/bots/contracts"
import { botWorkFollowsGlobalModel, botWorkModelRoutingMode } from "../../shared/bots/model-policy"
import { botWorkAttachmentHref, botWorkHistoryHref, botWorkHref } from "../../shared/bots/work-history"
import { getThreadMessagesByIds } from "../db"
import { readThreadMessagesPageInWorker } from "../thread-message-hydration/client"
import {
  getAvailableModelConfigOrDefault,
  getModelConfigByRef,
  toModelRef
} from "../models/registry"
import { samplingFields, topKModelKwargs } from "../models/sampling-params"
import { getGlobalRoutingMode } from "../storage"
import { resolveModel } from "../routing"
import { getLocalThreadRunLease } from "../agent/thread-run-lease"
import type { LocalBotHost } from "./host"
import { createBotResultEvidenceReader, type BotResultEvidence } from "./work-result-evidence"
import { BOT_WORK_REVIEW_BASE_CATALOGUE, reviewBotWorkResult, type BotWorkResultDecision } from "./work-result-review"
import { includeWorkResultAnswers, projectWorkResultProcess } from "./work-result-process"
import { verifiedWorkResultThread } from "./work-result-thread"
import { botHistoryMessageBody } from "./work-history"
import { announceBotResultMessage, persistBotResultMessage } from "./work-result-publication"
import { botSnapshotSourceRoot } from "./attachment-storage"
import { BOT_WORK_RESULT_COMMAND_EVIDENCE_BASE, RetryableBotWorkPublicationError, hasWorkCommandOutput, workResultMoreAttachmentsLabel, workResultServiceReadAllowance, type BotWorkResultCommandReference } from "./work-result-settlement"
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

async function reviewModel(
  bot: BotDefinition,
  threadId: string,
  linked: boolean,
  metadata: Record<string, unknown>
) {
  const requested = linked
    ? !botWorkFollowsGlobalModel(metadata) && typeof metadata.model === "string"
      ? metadata.model
      : undefined
    : (bot.modelRef ?? undefined)
  const routingMode = linked
    ? (botWorkModelRoutingMode(metadata) ?? getGlobalRoutingMode())
    : bot.modelRef
      ? "pinned"
      : getGlobalRoutingMode()
  if (linked && botWorkModelRoutingMode(metadata) === "pinned") {
    const pinned = getModelConfigByRef(requested)
    // Match the normal work entry: a deleted explicit pin must not resolve
    // through a legacy model-name alias to a different provider configuration.
    if (!pinned || toModelRef(pinned) !== requested)
      throw new Error("此任务固定的模型配置已不存在，请重新选择模型后继续。")
  }
  const fallback = getAvailableModelConfigOrDefault()
  const selected = await resolveModel({
    taskSource: "chat",
    threadId,
    requestedModelId: requested ?? (fallback ? toModelRef(fallback) : undefined),
    routingMode,
    ...(routingMode === "auto" ? { continuation: "resume" as const } : {})
  })
  const config = getModelConfigByRef(selected.resolvedModelId)
  if (!config?.apiKey?.trim()) throw new Error("原任务模型暂不可用。")
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey,
    configuration: { baseURL: config.baseUrl },
    maxTokens: Math.min(config.maxOutputTokens ?? 2500, 2500),
    maxRetries: 0,
    timeout: 20_000,
    ...samplingFields(config.model, { temperature: config.temperature, topP: config.topP }),
    // Match the Runtime's text-only helpers so reasoning does not consume the decision budget.
    modelKwargs: {
      ...topKModelKwargs(config.model, config.topK),
      chat_template_kwargs: { enable_thinking: false },
      ...(/deepseek/i.test(config.model) ? { thinking: { type: "disabled" } } : {})
    }
  })
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

export async function runPrivateWorkResultReview(
  host: LocalBotHost,
  bot: BotDefinition,
  task: BotTask,
  signal: AbortSignal
): Promise<void> {
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
  const defaultAttachments = original.defaultAttachments
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
        label: earlier ? "同一请求较早回合的前台命令" : "本轮前台命令",
        // This bounded observation is complete as an exit-code record. Any
        // omitted output is explicitly marked inside it, and cannot be inferred.
        text: JSON.stringify(receipt),
        failed: receipt.exitCode !== 0,
        readinessCandidate: receipt.exitCode === 0 && !receipt.excerpt &&
          (receipt.exactCommand === true || hasWorkCommandOutput(receipt.output)) })
    }
  }
  const reviewSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
  const decision = await AsyncLocalStorageProviderSingleton.getInstance()
    .run(undefined, async () => {
      const previousInputs = original.previousProcesses ?? []
      const [model, page, previousPages] = await Promise.all([
        reviewModel(bot, original.work.threadId, Boolean(original.work.conversation), original.metadata),
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
      reviewSignal.throwIfAborted()
      current()
      // These receipts were observed within the authorized tool invocation,
      // independently of how many rows or bytes of the transcript fit below.
      addForegroundCommands(executionEvidence, false)
      for (const sourceId of [...(original.earlierForegroundCommandIds ?? [])].reverse())
        addForegroundCommands(original.evidence.find(item => item.taskId === sourceId), true)
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
      const process = includeWorkResultAnswers(latest, previous)
      const first = reader.list()
      const second = first.nextCursor ? reader.list(first.nextCursor) : undefined
      const serviceAllowance = workResultServiceReadAllowance(original.services)
      const extra = serviceAllowance && second?.nextCursor ? reader.list(second.nextCursor) : undefined
      const listed = [...first.items, ...(second?.items ?? []), ...(extra?.items ?? [])]
      const catalogue = listed.slice(0, BOT_WORK_REVIEW_BASE_CATALOGUE + serviceAllowance)
      const defaultAttachmentIds = catalogue.filter(item => item.kind === "snapshot" &&
        defaultAttachments.some(ref => ref.sourceTaskId === item.reference.sourceTaskId &&
          ref.callId === item.reference.callId && ref.fileIndex === item.reference.fileIndex)).map(item => item.id)
      const decide = (policy: Pick<typeof original, "settlingForServices" | "remainingRepairs" | "services">) => reviewBotWorkResult(
        {
          requests: original.requests,
          outcome: original.outcome,
          process,
          remainingRepairs: policy.remainingRepairs,
          catalogue,
          commandEvidenceIds: catalogue.filter(item => item.kind === "text" &&
            commandReferences.has(referenceKey(item.reference.sourceTaskId, item.reference.messageId!))).map(item => item.id),
          attachmentDefaults: {
            ids: defaultAttachmentIds,
            unlisted: defaultAttachments.length - defaultAttachmentIds.length
          },
          services: policy.services,
          settlingForServices: policy.settlingForServices,
          catalogueTruncated:
            Boolean((extra ?? second)?.nextCursor) || listed.length > catalogue.length ||
            original.commands.length >= BOT_WORK_RESULT_COMMAND_EVIDENCE_BASE + serviceAllowance ||
            foregroundEvidence.length >= 8 ||
            original.evidence.filter((execution) => execution.finalMessageId).length >
              MAX_RESULT_TEXT_RECORDS
        },
        async (request, signal) => {
          current()
          const response = await model.invoke(
            [new SystemMessage(request.system), new HumanMessage(request.data)],
            { signal }
          )
          return typeof response.content === "string"
            ? response.content
            : response.content
                .flatMap((block) =>
                  typeof block === "object" &&
                  block.type === "text" &&
                  typeof block.text === "string"
                    ? [block.text]
                    : []
                )
                .join("")
        },
        async (id, signal) => {
          const read = await reader.read(id, { signal })
          if (read.status === "ok" && !read.truncated && read.evidence.kind === "text") {
            const ref = commandReferences.get(referenceKey(read.evidence.reference.sourceTaskId,
              read.evidence.reference.messageId!))
            if (ref) inspectedCommands.set(id, { ...ref, evidenceId: id })
          }
          return read
        },
        reviewSignal
      )
      const decision = await decide(original)
      // A user can request or cancel handoff while review is in flight.
      // Reconsider once under the same lease and deadline if its policy changed.
      const policy = current()
      const changedPolicy = (candidate: typeof policy) =>
        Boolean(candidate.settlingForServices) !== Boolean(original.settlingForServices)
      if (!reviewSignal.aborted && changedPolicy(policy) &&
          !(decision?.kind === "ready" && host.canPublishReadyWorkReview(task.id, decision,
            decision.evidenceIds.flatMap(id => inspectedCommands.get(id) ?? [])))) {
        const reconsidered = await decide(policy).catch(() => null)
        if (!changedPolicy(current())) {
          const alternative = reconsidered?.kind !== "repair" ? reconsidered : null
          return { decision, catalogue, alternative }
        }
        // A failed transport or invalid second verdict does not erase the
        // first report. The commit revalidates its actual service dependencies.
        const firstConclusion = decision?.kind !== "repair" ? decision : null
        return { decision: reconsidered ?? firstConclusion, catalogue,
          alternative: reconsidered ? firstConclusion : null }
      }
      return { decision, catalogue }
    })
    .catch(() => null)
  current()
  const { decision: verdict, catalogue, alternative } = decision ?? { decision: null, catalogue: [] }
  const selectedAttachments = (verdict: BotWorkResultDecision | null) =>
    !verdict || verdict.kind === "repair"
      ? []
      : catalogue.flatMap((item) => {
          const { sourceTaskId, callId, fileIndex } = item.reference
          return verdict.attachments?.includes(item.id) &&
            typeof callId === "string" &&
            typeof fileIndex === "number"
            ? [{ sourceTaskId, callId, fileIndex }]
            : []
        })
  const citedServiceChecks = new Set([
    ...Object.values(verdict && verdict.kind !== "repair" ? verdict.serviceChecks ?? {} : {}),
    ...Object.values(alternative?.serviceChecks ?? {})
  ])
  const checks = [...citedServiceChecks].flatMap(id => inspectedCommands.get(id) ?? [])
  const attachments = selectedAttachments(verdict)
  if (alternative && (alternative.serviceChecks || verdict?.kind === "ready"))
    host.commitWorkResultReview(task.id, verdict, attachments, checks,
      { decision: alternative, attachments: selectedAttachments(alternative) })
  else if (checks.length) host.commitWorkResultReview(task.id, verdict, attachments, checks)
  else host.commitWorkResultReview(task.id, verdict, attachments)
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
    written = getThreadMessagesByIds(task.threadId, [task.requestId])[0] ?? null
    const pending = host.workResultPublication(task.id, !written)
    if (!pending) throw new BotError("CONFLICT", "原结果交付身份已变化。")
    publication = pending
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
  const content = [
    publication.summary,
    ...(links.length ? [links.join("\n")] : []),
    ...(more ? [`[${workResultMoreAttachmentsLabel(more.count)}，点击查看](${moreHref})`] : []),
    ...(publication.finalMessageId
      ? [`[查看原任务结果](${historyHref(publication.finalMessageId)})`]
      : [])
  ].join("\n\n")
  try {
    prepareMainThread()
    persistBotResultMessage(task.threadId, publication.id, content, task.createdAt, written)
    if (!host.acknowledgeWorkResultPublication(task.id)) return
  } catch (error) {
    if (signal.aborted || error instanceof BotError) throw error
    throw new RetryableBotWorkPublicationError({ cause: error })
  }
  const ready = publication.kind === "ready"
  await announceBotResultMessage({
    threadId: task.threadId,
    id: publication.id,
    content,
    attention: ready
      ? "task-complete"
      : publication.kind === "needs_user"
        ? "interaction"
        : "task-error",
    notificationTitle: `${bot.name} · ${ready ? "任务成果可查看" : "任务需要你查看"}`,
    notificationBody: publication.summary,
    ...(ready ? { petTitle: work.title } : {})
  })
}
