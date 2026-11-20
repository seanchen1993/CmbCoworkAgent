import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { setImmediate } from "node:timers/promises"
import {
  coerceMessageLikeToMessage,
  ToolMessage,
  type BaseMessageLike
} from "@langchain/core/messages"
import type { Checkpoint } from "@langchain/langgraph-checkpoint"
import { clearCheckpointSummarizationState } from "../../shared/context-compaction-messages"
import { getCheckpointUserMessageIndex } from "../../shared/checkpoint-transcript"
import { getConversationHistoryDirectory } from "./context-history-path"
import {
  buildSummaryMessage,
  findInitialUserRequestInHistory,
  INITIAL_USER_REQUEST_KEY,
  readSummaryPromptInitialRequest,
  renderConversationHistoryMessages,
  shortenInitialPromptAnchor,
  SummarizationEventSchema,
  SUMMARIZATION_STATE_OWNER_KEY,
  type SummarizationEvent
} from "./context-summarization-middleware"

const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
// Bound the synchronous encoding work for any single record on the main process.
const MAX_ARCHIVE_RECORD_BYTES = 512 * 1024
const ARCHIVE_BATCH_BYTES = 128 * 1024
const ARCHIVE_BATCH_MESSAGES = 64

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$}{()|[\]\\]/g, "\\$&")
}

function encodedPathPattern(value: string): string {
  return escapeRegExp(value).replace(
    /%([0-9A-F]{2})/g,
    (_match, hex: string) =>
      "%" +
      [...hex]
        .map((digit) => (/[A-F]/.test(digit) ? "[" + digit + digit.toLowerCase() + "]" : digit))
        .join("")
  )
}

function archivePathComponentPattern(component: string): string {
  const forms = new Set([escapeRegExp(component)])
  try {
    const fileUrlComponent = pathToFileURL("/" + component, { windows: false }).pathname.slice(1)
    for (const encoded of [encodeURI(component), encodeURIComponent(component), fileUrlComponent]) {
      if (encoded === component) continue
      forms.add(encodedPathPattern(encoded))
    }
  } catch {
    // A malformed Unicode path may still have literal references.
  }
  const escaped = [...forms]
  return escaped.length === 1 ? escaped[0] : "(?:" + escaped.join("|") + ")"
}

function rebaseArchiveReferences(
  text: string,
  source: string | null,
  target: string | null
): string {
  const unavailable = "[fork history archive unavailable]"
  if (!source?.toLowerCase().endsWith(".md")) {
    return !source && target ? text.replaceAll(unavailable, pathToFileURL(target).href) : text
  }
  const windowsDrive = /^[a-z]:[/\\]/i.test(source)
  const windowsUnc =
    source.startsWith("\\\\") || (process.platform === "win32" && source.startsWith("//"))
  const isWindowsPath = windowsDrive || windowsUnc
  const pattern = source
    .split(isWindowsPath ? /[/\\]+/ : "/")
    .map(archivePathComponentPattern)
    .join(isWindowsPath ? "[/\\\\]+" : "/")
  const urlPrefix = "[fF][iI][lL][eE]:" + (windowsDrive ? "///" : windowsUnc ? "" : "//")
  const alternatives = [urlPrefix + pattern, pattern]
  // The native URL also canonicalizes UNC host names through IDNA.
  if (windowsUnc) {
    try {
      alternatives.unshift(encodedPathPattern(pathToFileURL(source, { windows: true }).href))
    } catch {
      // Fall back to a literal UNC path if the host cannot be encoded as a URL.
    }
  }
  const matchingPath = new RegExp("(?:" + alternatives.join("|") + ")", isWindowsPath ? "gi" : "g")
  return text.replace(matchingPath, (match) => {
    if (!target) return unavailable
    if (/^file:/i.test(match)) return pathToFileURL(target).href
    const path =
      match.includes("/") && !match.includes("\\") ? target.replaceAll("\\", "/") : target
    return /%[0-9a-f]{2}/i.test(match) ? encodeURI(path) : path
  })
}

function readSummaryBody(
  event: SummarizationEvent,
  initialRequest: string | null
): { body: string; promptAnchor: string | null } | null {
  const content = event.summaryMessage.content
  if (typeof content !== "string") return null

  const savedPromptAnchor = readSummaryPromptInitialRequest(event.summaryMessage, initialRequest)
  const anchors = new Set([savedPromptAnchor])
  // Earlier inherited events could shorten the displayed anchor before it had
  // its own metadata. Accept only the exact generated historical wrapper.
  if (event.usageStartIndex !== undefined && savedPromptAnchor === initialRequest) {
    anchors.add(shortenInitialPromptAnchor(initialRequest))
  }
  for (const promptAnchor of anchors) {
    const suffix = event.filePath || promptAnchor ? "\n</summary>" : ""
    const wrapper = buildSummaryMessage("", event.filePath, initialRequest, event.archiveIncomplete, promptAnchor)
    const prefix = String(wrapper.content).slice(0, String(wrapper.content).length - suffix.length)
    if (content.startsWith(prefix) && content.endsWith(suffix)) {
      return { body: content.slice(prefix.length, content.length - suffix.length).trim(), promptAnchor }
    }
  }

  // Older checkpoints can carry a separate path even when the message has no link.
  const plainPrefix = "Here is a summary of the conversation to date:\n\n"
  if (content.startsWith(plainPrefix)) {
    return { body: content.slice(plainPrefix.length).trim(), promptAnchor: savedPromptAnchor }
  }

  // Older DeepAgents checkpoints used a different generated archive notice.
  if (event.filePath) {
    const suffix = "\n</summary>"
    const legacyPrefix = [
      "You are in the middle of a conversation that has been summarized.",
      "The full conversation history has been saved to " +
        event.filePath +
        " should you need to refer back to it for details.",
      "A condensed summary follows:",
      "<summary>\n"
    ].join("\n\n")
    if (content.startsWith(legacyPrefix) && content.endsWith(suffix)) {
      return {
        body: content.slice(legacyPrefix.length, content.length - suffix.length).trim(),
        promptAnchor: savedPromptAnchor
      }
    }
    return null
  }
  return { body: content.trim(), promptAnchor: savedPromptAnchor }
}

function* readHistoryMessages(messages: readonly unknown[]) {
  for (const message of messages) yield coerceMessageLikeToMessage(message as BaseMessageLike)
}

async function writeForkHistory(input: {
  workspacePath: string
  threadId: string
  sessionId: string
  messages: readonly unknown[]
  cutoffIndex: number
}): Promise<string> {
  const directory = await getConversationHistoryDirectory(input.workspacePath, input.threadId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error("Fork history destination is not a regular directory.")
  }

  const filePath = join(directory, input.sessionId + ".md")
  const temporaryPath = filePath + ".tmp"
  const file = await open(temporaryPath, "wx", 0o600)
  let published = false
  try {
    const header = "## History inherited at fork\n\n"
    let writtenBytes = Buffer.byteLength(header)
    let batch: string[] = [header]
    let batchBytes = writtenBytes
    let batchMessages = 0
    const flushBatch = async (): Promise<void> => {
      if (batchBytes > 0) await file.writeFile(batch.join(""))
      batch = []
      batchBytes = 0
      batchMessages = 0
      await setImmediate()
    }

    for (let index = 0; index < input.cutoffIndex; index += 1) {
      const message = coerceMessageLikeToMessage(input.messages[index] as BaseMessageLike)
      const maxRecordBytes = Math.min(
        MAX_ARCHIVE_RECORD_BYTES,
        MAX_ARCHIVE_BYTES - writtenBytes - 2
      )
      const entry = renderConversationHistoryMessages([message], maxRecordBytes)
      const entryBytes = entry ? Buffer.byteLength(entry) + 1 : 0
      if (entryBytes > maxRecordBytes + 1) {
        throw new Error("Fork history exceeds its byte limit.")
      }

      if (batchBytes + entryBytes > ARCHIVE_BATCH_BYTES) await flushBatch()
      if (entryBytes > ARCHIVE_BATCH_BYTES) {
        const bytes = Buffer.from(entry + "\n")
        for (let offset = 0; offset < bytes.length; offset += ARCHIVE_BATCH_BYTES) {
          await file.writeFile(bytes.subarray(offset, offset + ARCHIVE_BATCH_BYTES))
        }
      } else if (entry) {
        batch.push(entry, "\n")
        batchBytes += entryBytes
      }
      writtenBytes += entryBytes
      batchMessages += 1
      if (batchMessages >= ARCHIVE_BATCH_MESSAGES) await flushBatch()
    }

    batch.push("\n")
    await file.writeFile(batch.join(""))
    await file.close()
    await rename(temporaryPath, filePath)
    published = true
    return filePath
  } finally {
    if (!published) {
      await file.close().catch(() => undefined)
      await unlink(temporaryPath).catch(() => undefined)
    }
  }
}

/** Rebase the event on a fork-owned checkpoint. Any source file path is only
 * used to identify the generated wrapper and is never an input to filesystem I/O. */
export async function inheritForkSummarization(input: {
  checkpoint: Checkpoint
  persistedMessageCount: number
  readDurableUserHead?: () =>
    | {
        id: string
        createdAt: number
        providerSourceId?: string
        providerOccurrence?: number
      }
    | undefined
  archiveTarget?: { workspacePath: string; threadId: string }
  readSourceArchiveDirectories?: () => Promise<string[]>
}): Promise<void> {
  const state = input.checkpoint.channel_values as Record<string, unknown>
  const savedEvent = state._summarizationEvent
  const savedSessionId = state._summarizationSessionId
  const hasPrivateOwner = state[SUMMARIZATION_STATE_OWNER_KEY] != null
  clearCheckpointSummarizationState(state)

  if (savedEvent == null || hasPrivateOwner || !Array.isArray(state.messages)) return
  const parsed = SummarizationEventSchema.safeParse(savedEvent)
  if (!parsed.success) return
  const event = parsed.data
  const messages: unknown[] = state.messages
  if (
    event.summaryMessage.additional_kwargs?.lc_source !== "summarization" ||
    !Number.isSafeInteger(event.cutoffIndex) ||
    event.cutoffIndex <= 0 ||
    event.cutoffIndex > input.persistedMessageCount ||
    event.cutoffIndex > messages.length
  ) {
    return
  }
  // A cutoff may end immediately before an assistant or user message, but
  // starting the effective tail with a tool result would orphan its call.
  if (event.cutoffIndex < messages.length) {
    try {
      const firstTail = coerceMessageLikeToMessage(messages[event.cutoffIndex] as BaseMessageLike)
      if (ToolMessage.isInstance(firstTail)) return
    } catch {
      return
    }
  }

  const anchor = event.summaryMessage.additional_kwargs?.[INITIAL_USER_REQUEST_KEY]
  const initialRequest = typeof anchor === "string" && anchor.trim() ? anchor : null
  if (event.usageStartIndex === undefined) {
    // Older builds could repair a snapshot to a suffix without clearing the
    // saved cut point. The durable row identity detects a missing prefix even
    // when the user repeated the same text or no text anchor was recorded.
    const durableHead = input.readDurableUserHead?.()
    if (
      durableHead &&
      durableHead.createdAt <= Date.parse(input.checkpoint.ts) &&
      getCheckpointUserMessageIndex(input.checkpoint, durableHead.id) < 0 &&
      !(
        durableHead.providerSourceId &&
        durableHead.providerOccurrence === 1 &&
        getCheckpointUserMessageIndex(input.checkpoint, durableHead.providerSourceId) >= 0
      )
    ) {
      return
    }
    try {
      if (
        initialRequest &&
        findInitialUserRequestInHistory(readHistoryMessages(messages)) !== initialRequest
      )
        return
    } catch {
      return
    }
  }
  const summary = readSummaryBody(event, initialRequest)
  if (!summary?.body) return

  const sessionId = "session_" + randomUUID()
  let filePath: string | null = null
  if (input.archiveTarget) {
    try {
      filePath = await writeForkHistory({
        ...input.archiveTarget,
        sessionId,
        messages,
        cutoffIndex: event.cutoffIndex
      })
    } catch (error) {
      console.warn("[ForkSummarization] Could not rebuild the archive:", error)
    }
  }
  let body = summary.body
  let rebasedInitialRequest = initialRequest
  let rebasedPromptAnchor = summary.promptAnchor
  const rebase = (sourcePath: string | null): void => {
    body = rebaseArchiveReferences(body, sourcePath, filePath)
    if (rebasedInitialRequest) {
      rebasedInitialRequest = rebaseArchiveReferences(rebasedInitialRequest, sourcePath, filePath)
    }
    if (rebasedPromptAnchor) {
      rebasedPromptAnchor = rebaseArchiveReferences(rebasedPromptAnchor, sourcePath, filePath)
    }
  }
  rebase(event.filePath)
  if (
    typeof savedSessionId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(savedSessionId) &&
    [body, rebasedInitialRequest, rebasedPromptAnchor].some((value) => value?.includes(savedSessionId + ".md"))
  ) {
    const directories = await input.readSourceArchiveDirectories?.().catch(() => [])
    for (const directory of directories ?? []) {
      rebase(join(directory, savedSessionId + ".md"))
    }
  }
  state._summarizationEvent = {
    cutoffIndex: event.cutoffIndex,
    summaryMessage: buildSummaryMessage(body, filePath, rebasedInitialRequest, false, rebasedPromptAnchor),
    filePath,
    usageStartIndex: messages.length,
    ...(!filePath && { archiveIncomplete: true })
  } satisfies SummarizationEvent
  state._summarizationSessionId = sessionId
}
