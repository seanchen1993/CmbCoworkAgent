import { createHash, randomUUID } from "crypto"
import { createReadStream } from "fs"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "fs/promises"
import { join } from "path"
import { getSubagentTranscriptContentDir } from "../storage"
import {
  SUBAGENT_TRANSCRIPT_INLINE_BYTES,
  SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT,
  SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES,
  fingerprintSubagentTranscriptContent,
  isSubagentTranscriptBlobRef,
  projectSubagentDescription,
  projectSubagentTranscriptStartupContent,
  projectSubagentTranscriptContentForStorage,
  type SubagentTranscriptBlobKind,
  type SubagentTranscriptBlobRef
} from "../../shared/subagent-transcript-storage"

type UnknownRecord = Record<string, unknown>

type StoredBlobEnvelope = {
  v: 1
  kind: SubagentTranscriptBlobKind
  value: unknown
}

export type CompactedSubagentTranscripts = {
  manifests: Record<string, unknown>
  changed: boolean
}

export const SUBAGENT_TRANSCRIPT_HYDRATION_CONCURRENCY = 16
export const SUBAGENT_TRANSCRIPT_PAGE_HYDRATION_BYTES = 32 * 1024 * 1024

let contentMutationTail: Promise<void> = Promise.resolve()
let transcriptReferenceEpoch = 0
let activeExternalContentMutations = 0
const verifiedStreamingBlobs = new Map<string, { mtimeMs: number; size: number }>()
const activeBlobReadPins = new Map<string, number>()

export function acquireSubagentTranscriptBlobReadPin(
  ref: SubagentTranscriptBlobRef
): () => void {
  activeBlobReadPins.set(ref.sha256, (activeBlobReadPins.get(ref.sha256) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const remaining = (activeBlobReadPins.get(ref.sha256) ?? 1) - 1
    if (remaining > 0) activeBlobReadPins.set(ref.sha256, remaining)
    else activeBlobReadPins.delete(ref.sha256)
  }
}

export function isSubagentTranscriptBlobReadPinned(hash: string): boolean {
  return (activeBlobReadPins.get(hash) ?? 0) > 0
}

export function withSubagentTranscriptContentMutationLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const run = contentMutationTail.catch(() => undefined).then(operation)
  contentMutationTail = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function getSubagentTranscriptReferenceEpoch(): number {
  return transcriptReferenceEpoch
}

export function advanceSubagentTranscriptReferenceEpoch(): number {
  transcriptReferenceEpoch += 1
  return transcriptReferenceEpoch
}

export function hasActiveSubagentTranscriptExternalMutation(): boolean {
  return activeExternalContentMutations > 0
}

/**
 * Keep GC from quarantining sidecars while a worker is creating them, without
 * holding the global content lock across worker parsing or disk I/O.
 */
export async function beginSubagentTranscriptExternalMutation(): Promise<
  () => Promise<void>
> {
  await withSubagentTranscriptContentMutationLock(async () => {
    activeExternalContentMutations += 1
    advanceSubagentTranscriptReferenceEpoch()
  })
  let released = false
  return async () => {
    if (released) return
    released = true
    await withSubagentTranscriptContentMutationLock(async () => {
      activeExternalContentMutations = Math.max(0, activeExternalContentMutations - 1)
      advanceSubagentTranscriptReferenceEpoch()
    })
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function serializeBlobValue(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? "null" : serialized
}

function blobRefForValue(
  value: unknown,
  kind: SubagentTranscriptBlobKind
): { ref: SubagentTranscriptBlobRef; serializedValue: string } {
  const serializedValue = serializeBlobValue(value)
  return {
    ref: {
      v: 1,
      sha256: createHash("sha256")
        .update(kind)
        .update("\0")
        .update(serializedValue)
        .digest("hex"),
      bytes: Buffer.byteLength(serializedValue, "utf8"),
      kind
    },
    serializedValue
  }
}

function blobPath(ref: SubagentTranscriptBlobRef): string {
  return join(
    getSubagentTranscriptContentDir(),
    ref.sha256.slice(0, 2),
    `${ref.sha256}.json`
  )
}

function blobEnvelopePrefix(kind: SubagentTranscriptBlobKind): string {
  return `{"v":1,"kind":"${kind}","value":`
}

async function verifyBlobForStreaming(
  ref: SubagentTranscriptBlobRef
): Promise<{ path: string; valueStart: number }> {
  const path = blobPath(ref)
  const prefix = Buffer.from(blobEnvelopePrefix(ref.kind), "utf8")
  const details = await stat(path)
  const expectedSize = prefix.byteLength + ref.bytes + 1
  if (!details.isFile() || details.size !== expectedSize) {
    throw new Error("Transcript blob size does not match its manifest")
  }
  const cached = verifiedStreamingBlobs.get(ref.sha256)
  if (cached?.mtimeMs === details.mtimeMs && cached.size === details.size) {
    return { path, valueStart: prefix.byteLength }
  }

  const handle = await open(path, "r")
  try {
    const storedPrefix = Buffer.alloc(prefix.byteLength)
    const prefixRead = await handle.read(storedPrefix, 0, storedPrefix.byteLength, 0)
    const suffix = Buffer.alloc(1)
    const suffixRead = await handle.read(suffix, 0, 1, expectedSize - 1)
    if (
      prefixRead.bytesRead !== prefix.byteLength ||
      !storedPrefix.equals(prefix) ||
      suffixRead.bytesRead !== 1 ||
      suffix[0] !== 0x7d
    ) {
      throw new Error("Invalid transcript blob envelope")
    }
  } finally {
    await handle.close()
  }

  const hash = createHash("sha256").update(ref.kind).update("\0")
  const valueStream = createReadStream(path, {
    start: prefix.byteLength,
    end: prefix.byteLength + ref.bytes - 1
  })
  for await (const chunk of valueStream) hash.update(chunk as Buffer)
  if (hash.digest("hex") !== ref.sha256) {
    throw new Error("Transcript blob integrity check failed")
  }
  verifiedStreamingBlobs.set(ref.sha256, { mtimeMs: details.mtimeMs, size: details.size })
  return { path, valueStart: prefix.byteLength }
}

/** Stream a complete JSON value to a user-selected file without IPC cloning it. */
export async function exportSubagentTranscriptBlobValue(
  ref: SubagentTranscriptBlobRef,
  targetPath: string
): Promise<void> {
  const { path, valueStart } = await verifyBlobForStreaming(ref)
  const output = await open(targetPath, "wx", 0o600)
  let completed = false
  try {
    const valueStream = createReadStream(path, {
      start: valueStart,
      end: valueStart + ref.bytes - 1
    })
    for await (const chunk of valueStream) await output.write(chunk as Buffer)
    await output.sync()
    completed = true
  } finally {
    await output.close().catch(() => undefined)
    if (!completed) await rm(targetPath, { force: true }).catch(() => undefined)
  }
}

export interface SubagentTranscriptTextJournalPage {
  chunks: string[]
  hasMore: boolean
  nextAfterFragmentId?: number
}

/**
 * Stream a string sidecar plus its SQLite suffix journal as one JSON string.
 * Neither the base nor the journal is joined/materialized in JavaScript.
 */
export async function exportSubagentTranscriptTextWithJournal(
  ref: SubagentTranscriptBlobRef,
  targetPath: string,
  loadPage: (afterFragmentId?: number) => SubagentTranscriptTextJournalPage
): Promise<void> {
  if (ref.kind !== "content" && ref.kind !== "reasoning") {
    throw new Error("Only transcript text fields can have a suffix journal")
  }
  const { path, valueStart } = await verifyBlobForStreaming(ref)
  if (ref.bytes < 2) throw new Error("Transcript text blob is not a JSON string")
  const source = await open(path, "r")
  try {
    const quotes = Buffer.alloc(2)
    const first = await source.read(quotes, 0, 1, valueStart)
    const last = await source.read(quotes, 1, 1, valueStart + ref.bytes - 1)
    if (
      first.bytesRead !== 1 ||
      last.bytesRead !== 1 ||
      quotes[0] !== 0x22 ||
      quotes[1] !== 0x22
    ) {
      throw new Error("Transcript text blob is not a JSON string")
    }
  } finally {
    await source.close()
  }

  const output = await open(targetPath, "wx", 0o600)
  let completed = false
  try {
    // Copy the serialized base including its opening quote, but not its closing quote.
    if (ref.bytes > 1) {
      const baseStream = createReadStream(path, {
        start: valueStart,
        end: valueStart + ref.bytes - 2
      })
      for await (const chunk of baseStream) await output.write(chunk as Buffer)
    }
    let afterFragmentId: number | undefined
    while (true) {
      const page = loadPage(afterFragmentId)
      for (const chunk of page.chunks) {
        const serialized = JSON.stringify(chunk)
        await output.write(Buffer.from(serialized.slice(1, -1), "utf8"))
      }
      if (!page.hasMore) break
      if (page.nextAfterFragmentId === undefined) {
        throw new Error("Transcript journal page did not advance")
      }
      afterFragmentId = page.nextAfterFragmentId
    }
    await output.write(Buffer.from('"', "utf8"))
    await output.sync()
    completed = true
  } finally {
    await output.close().catch(() => undefined)
    if (!completed) await rm(targetPath, { force: true }).catch(() => undefined)
  }
}

async function readBlob(ref: SubagentTranscriptBlobRef): Promise<unknown> {
  const raw = await readFile(blobPath(ref), "utf8")
  const envelope = JSON.parse(raw) as unknown
  if (!isRecord(envelope) || envelope.v !== 1 || envelope.kind !== ref.kind) {
    throw new Error("Invalid transcript blob envelope")
  }
  const serializedValue = serializeBlobValue(envelope.value)
  const actualBytes = Buffer.byteLength(serializedValue, "utf8")
  const actualHash = createHash("sha256")
    .update(ref.kind)
    .update("\0")
    .update(serializedValue)
    .digest("hex")
  if (actualBytes !== ref.bytes || actualHash !== ref.sha256) {
    throw new Error("Transcript blob integrity check failed")
  }
  return envelope.value
}

async function writeBlob(
  value: unknown,
  kind: SubagentTranscriptBlobKind
): Promise<SubagentTranscriptBlobRef> {
  const { ref } = blobRefForValue(value, kind)
  const targetPath = blobPath(ref)
  try {
    await readBlob(ref)
    return ref
  } catch {
    // Missing or invalid blobs are replaced atomically below.
  }

  const targetDir = join(getSubagentTranscriptContentDir(), ref.sha256.slice(0, 2))
  await mkdir(targetDir, { recursive: true })
  const temporaryPath = join(targetDir, `.${ref.sha256}.${process.pid}.${randomUUID()}.tmp`)
  const envelope: StoredBlobEnvelope = { v: 1, kind, value }
  await writeFile(temporaryPath, JSON.stringify(envelope), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  })
  try {
    await rename(temporaryPath, targetPath)
  } catch (error) {
    try {
      await readBlob(ref)
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      return ref
    } catch {
      const quarantinedPath = `${targetPath}.corrupt.${randomUUID()}`
      await rename(targetPath, quarantinedPath).catch(() => undefined)
      try {
        await rename(temporaryPath, targetPath)
      } catch {
        throw error
      } finally {
        await rm(temporaryPath, { force: true }).catch(() => undefined)
        await rm(quarantinedPath, { force: true }).catch(() => undefined)
      }
    }
  }
  return ref
}

async function compactMessage(rawMessage: unknown): Promise<{ value: unknown; changed: boolean }> {
  if (!isRecord(rawMessage)) return { value: rawMessage, changed: false }
  const message: UnknownRecord = { ...rawMessage }
  const forceLiveTextSidecars = message.subagent_live_text_bootstrap === true
  const preserveTextJournal = message.subagent_preserve_text_journal === true
  delete message.subagent_live_text_bootstrap
  delete message.subagent_preserve_text_journal
  let changed = false

  const existingContentRef = isSubagentTranscriptBlobRef(message.content_ref, "content")
    ? message.content_ref
    : undefined
  const existingReasoningRef = isSubagentTranscriptBlobRef(
    message.reasoning_ref,
    "reasoning"
  )
    ? message.reasoning_ref
    : undefined

  const fingerprintStringField = async (
    valueKey: "content" | "reasoning",
    projectionKey: "content_is_projection" | "reasoning_is_projection",
    ref: SubagentTranscriptBlobRef | undefined,
    fingerprintKey:
      | "subagent_prompt_fingerprint"
      | "subagent_content_fingerprint"
      | "subagent_reasoning_fingerprint",
    emptyFallback = false
  ): Promise<void> => {
    let fingerprint: string | undefined
    if (ref && message[projectionKey] === true) {
      if (typeof message[fingerprintKey] === "string") return
      try {
        const fullValue = await readBlob(ref)
        if (typeof fullValue === "string") {
          fingerprint = fingerprintSubagentTranscriptContent(fullValue)
        }
      } catch {
        // Keep a missing fingerprint missing rather than fingerprinting a
        // projection and permanently teaching replay dedupe the wrong value.
      }
    } else if (typeof message[valueKey] === "string") {
      fingerprint = fingerprintSubagentTranscriptContent(message[valueKey])
    } else if (emptyFallback) {
      fingerprint = fingerprintSubagentTranscriptContent("")
    }
    if (fingerprint && message[fingerprintKey] !== fingerprint) {
      message[fingerprintKey] = fingerprint
      changed = true
    }
  }

  // Legacy prompt rows predate canonical invocation metadata. Their full
  // prompt is the only safe way to reclaim the correct bucket after checkpoint
  // pruning, so persist its fingerprint before replacing large content with a
  // storage projection.
  if (
    message.role === "user" &&
    typeof message.id === "string" &&
    message.id.startsWith("subagent-prompt-")
  ) {
    await fingerprintStringField(
      "content",
      "content_is_projection",
      existingContentRef,
      "subagent_prompt_fingerprint"
    )
  }
  if (
    !preserveTextJournal &&
    message.role === "assistant" &&
    typeof message.id === "string" &&
    message.id.startsWith("subagent-final-")
  ) {
    await fingerprintStringField(
      "content",
      "content_is_projection",
      existingContentRef,
      "subagent_content_fingerprint",
      true
    )
    await fingerprintStringField(
      "reasoning",
      "reasoning_is_projection",
      existingReasoningRef,
      "subagent_reasoning_fingerprint",
      true
    )
  }
  if (typeof message.subagent_description === "string") {
    const boundedDescription = projectSubagentDescription(message.subagent_description)
    if (boundedDescription !== message.subagent_description) {
      message.subagent_description = boundedDescription
      changed = true
    }
  }

  if (existingContentRef && message.content_is_projection === true) {
    message.content_ref = existingContentRef
    if (typeof message.content === "string") {
      const projected = projectSubagentTranscriptContentForStorage(message.content)
      if (projected !== message.content) {
        message.content = projected
        changed = true
      }
    }
  } else if (message.content !== undefined) {
    const { serializedValue } = blobRefForValue(message.content, "content")
    if (
      forceLiveTextSidecars ||
      Buffer.byteLength(serializedValue, "utf8") > SUBAGENT_TRANSCRIPT_INLINE_BYTES
    ) {
      message.content_ref = await writeBlob(message.content, "content")
      if (typeof message.content === "string") {
        message.content_full_length = message.content.length
        message.content = projectSubagentTranscriptContentForStorage(message.content)
      } else {
        message.content = []
      }
      message.content_is_projection = true
      changed = true
    } else if (message.content_ref !== undefined) {
      delete message.content_ref
      changed = true
    }
  }

  if (existingReasoningRef && message.reasoning_is_projection === true) {
    message.reasoning_ref = existingReasoningRef
    if (typeof message.reasoning === "string") {
      const projected = projectSubagentTranscriptContentForStorage(message.reasoning)
      if (projected !== message.reasoning) {
        message.reasoning = projected
        changed = true
      }
    }
  } else if (typeof message.reasoning === "string") {
    const { serializedValue } = blobRefForValue(message.reasoning, "reasoning")
    if (
      forceLiveTextSidecars ||
      Buffer.byteLength(serializedValue, "utf8") > SUBAGENT_TRANSCRIPT_INLINE_BYTES
    ) {
      message.reasoning_ref = await writeBlob(message.reasoning, "reasoning")
      message.reasoning_full_length = message.reasoning.length
      message.reasoning = projectSubagentTranscriptContentForStorage(message.reasoning)
      message.reasoning_is_projection = true
      changed = true
    } else if (message.reasoning_ref !== undefined) {
      delete message.reasoning_ref
      delete message.reasoning_is_projection
      delete message.reasoning_full_length
      changed = true
    }
  }

  const existingToolCallsRef = isSubagentTranscriptBlobRef(
    message.tool_calls_ref,
    "tool_calls"
  )
    ? message.tool_calls_ref
    : undefined
  if (existingToolCallsRef && message.tool_calls === undefined) {
    message.tool_calls_ref = existingToolCallsRef
  } else if (message.tool_calls !== undefined) {
    const serializedToolCalls = serializeBlobValue(message.tool_calls)
    if (Buffer.byteLength(serializedToolCalls, "utf8") > SUBAGENT_TRANSCRIPT_INLINE_BYTES) {
      message.tool_calls_ref = await writeBlob(message.tool_calls, "tool_calls")
      delete message.tool_calls
      changed = true
    } else if (message.tool_calls_ref !== undefined) {
      delete message.tool_calls_ref
      changed = true
    }
  }

  return { value: message, changed }
}

export async function compactSubagentTranscriptManifests(
  transcripts: unknown
): Promise<CompactedSubagentTranscripts> {
  if (!isRecord(transcripts)) return { manifests: {}, changed: false }
  const manifests: Record<string, unknown> = {}
  let changed = false
  for (const [subagentId, rawMessages] of Object.entries(transcripts)) {
    if (!Array.isArray(rawMessages)) continue
    const messages: unknown[] = []
    for (const rawMessage of rawMessages) {
      const compacted = await compactMessage(rawMessage)
      messages.push(compacted.value)
      changed ||= compacted.changed
    }
    manifests[subagentId] = messages
  }
  return { manifests, changed }
}

export interface SubagentTranscriptManifestPage {
  messages: unknown[]
  hydrateIndexes: number[]
  deferredHydration: boolean
  end: number
  start: number
  nextBefore?: number
  total: number
}

/** Select a bounded manifest page before any sidecar hydration or IPC cloning. */
export function sliceSubagentTranscriptManifestPage(
  rawMessages: unknown,
  before?: number,
  pageSize = 100,
  hydrationByteLimit = SUBAGENT_TRANSCRIPT_PAGE_HYDRATION_BYTES
): SubagentTranscriptManifestPage {
  const messages = Array.isArray(rawMessages) ? rawMessages : []
  const total = messages.length
  const boundedPageSize =
    Number.isSafeInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 1_000) : 100
  const requestedEnd =
    typeof before === "number" && Number.isSafeInteger(before) ? before : total
  const end = Math.max(0, Math.min(total, requestedEnd))
  const boundedHydrationBytes =
    Number.isSafeInteger(hydrationByteLimit) && hydrationByteLimit >= 0
      ? hydrationByteLimit
      : SUBAGENT_TRANSCRIPT_PAGE_HYDRATION_BYTES
  const selected: unknown[] = []
  const hydrateIndexes: number[] = []
  let hydrationBytes = 0
  let start = end
  let deferredHydration = false
  const estimatedHydrationBytes = (value: unknown): number => {
    if (!isRecord(value)) return Buffer.byteLength(serializeBlobValue(value), "utf8")
    if (
      value.subagent_content_delta_journal_omitted === true ||
      value.subagent_reasoning_delta_journal_omitted === true
    ) {
      return Number.MAX_SAFE_INTEGER
    }
    // Count the complete manifest row as well as every value that sidecar
    // hydration can expand. Otherwise a legacy row with tiny content but a
    // multi-megabyte description/alias can bypass the IPC clone budget.
    let bytes = Buffer.byteLength(serializeBlobValue(value), "utf8")
    for (const key of [
      "subagent_content_delta_journal_length",
      "subagent_reasoning_delta_journal_length"
    ] as const) {
      const journalLength = value[key]
      if (typeof journalLength === "number" && Number.isSafeInteger(journalLength)) {
        bytes += Math.max(0, journalLength)
      }
    }
    for (const [field, kind] of [
      ["content", "content"],
      ["reasoning", "reasoning"],
      ["tool_calls", "tool_calls"]
    ] as const) {
      const candidate = value[`${field}_ref`]
      const ref = isSubagentTranscriptBlobRef(candidate, kind) ? candidate : undefined
      if (ref) bytes += ref.bytes
    }
    return bytes
  }
  for (let sourceIndex = end - 1; sourceIndex >= 0; sourceIndex -= 1) {
    if (selected.length >= boundedPageSize) break
    const rawMessage = messages[sourceIndex]
    const messageBytes = estimatedHydrationBytes(rawMessage)
    const canHydrate = hydrationBytes + messageBytes <= boundedHydrationBytes
    if (!canHydrate && selected.length > 0) break
    start = sourceIndex
    selected.unshift(canHydrate ? rawMessage : projectStartupMessage(rawMessage))
    if (canHydrate) {
      hydrationBytes += messageBytes
      hydrateIndexes.unshift(0)
      for (let index = 1; index < hydrateIndexes.length; index += 1) {
        hydrateIndexes[index] += 1
      }
    } else {
      deferredHydration = true
      break
    }
  }
  return {
    messages: selected,
    hydrateIndexes,
    deferredHydration,
    end,
    start,
    ...(start > 0 && { nextBefore: start }),
    total
  }
}

export async function hydrateSubagentTranscriptManifestPage(
  page: SubagentTranscriptManifestPage,
  hydrate: (rawMessage: unknown) => Promise<unknown> = hydrateMessage
): Promise<unknown[]> {
  const hydrated = [...page.messages]
  const results = await mapSubagentTranscriptHydrationBounded(
    page.hydrateIndexes,
    (messageIndex) => hydrate(page.messages[messageIndex])
  )
  page.hydrateIndexes.forEach((messageIndex, resultIndex) => {
    hydrated[messageIndex] = results[resultIndex]
  })
  return hydrated
}

function projectStartupMessage(rawMessage: unknown, omitPreview = false): unknown {
  if (!isRecord(rawMessage)) return rawMessage
  const message: UnknownRecord = {}
  for (const key of [
    "id",
    "role",
    "content",
    "provider_source_id",
    "provider_occurrence",
    "content_priority",
    "content_is_projection",
    "content_full_length",
    "content_ref",
    "reasoning",
    "reasoning_is_projection",
    "reasoning_full_length",
    "reasoning_ref",
    "tool_calls",
    "tool_calls_ref",
    "tool_call_id",
    "name",
    "status",
    "is_error",
    "replaces_message_id",
    "replaces_message_id_prefix",
    "replacement_mode",
    "replaced_message_ids",
    "replaced_message_id_prefixes",
    "compatible_replaced_message_id_prefixes",
    "subagent_tool_call_id",
    "subagent_invocation_scope",
    "subagent_prompt_fingerprint",
    "subagent_content_fingerprint",
    "subagent_reasoning_fingerprint",
    "subagent_startup_projection",
    "subagent_startup_tool_calls_projection",
    "subagent_name",
    "subagent_description",
    "subagent_type",
    "created_at",
    "start_at",
    "end_at"
  ]) {
    if (Object.prototype.hasOwnProperty.call(rawMessage, key)) message[key] = rawMessage[key]
  }
  for (const key of [
    "id",
    "role",
    "provider_source_id",
    "tool_call_id",
    "name",
    "status",
    "replaces_message_id",
    "replaces_message_id_prefix",
    "replacement_mode",
    "subagent_tool_call_id",
    "subagent_invocation_scope",
    "subagent_prompt_fingerprint",
    "subagent_content_fingerprint",
    "subagent_reasoning_fingerprint"
  ] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key] as string)
    } else if (message[key] !== undefined) {
      delete message[key]
    }
  }
  for (const [key, kind] of [
    ["content_ref", "content"],
    ["reasoning_ref", "reasoning"],
    ["tool_calls_ref", "tool_calls"]
  ] as const) {
    if (message[key] !== undefined && !isSubagentTranscriptBlobRef(message[key], kind)) {
      delete message[key]
    }
  }
  for (const key of ["created_at", "start_at", "end_at"] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key] as string)
    } else if (typeof message[key] !== "number") {
      delete message[key]
    }
  }
  for (const key of [
    "provider_occurrence",
    "content_priority",
    "content_full_length",
    "reasoning_full_length"
  ] as const) {
    if (message[key] !== undefined &&
      (typeof message[key] !== "number" || !Number.isSafeInteger(message[key]))) {
      delete message[key]
    }
  }
  for (const key of [
    "content_is_projection",
    "reasoning_is_projection",
    "is_error",
    "subagent_startup_projection",
    "subagent_startup_tool_calls_projection"
  ] as const) {
    if (message[key] !== undefined && typeof message[key] !== "boolean") delete message[key]
  }
  const isPrompt =
    message.role === "user" &&
    ((typeof message.id === "string" && message.id.startsWith("subagent-prompt-")) ||
      typeof message.subagent_tool_call_id === "string")
  const isFinal =
    message.role === "assistant" &&
    ((typeof message.id === "string" && message.id.startsWith("subagent-final-")) ||
      (typeof message.content_priority === "number" && message.content_priority > 0))
  if (
    isPrompt &&
    typeof message.content === "string" &&
    message.content_is_projection !== true &&
    typeof message.subagent_prompt_fingerprint !== "string"
  ) {
    message.subagent_prompt_fingerprint = fingerprintSubagentTranscriptContent(message.content)
  }
  if (isFinal) {
    if (
      typeof message.content === "string" &&
      message.content_is_projection !== true &&
      typeof message.subagent_content_fingerprint !== "string"
    ) {
      message.subagent_content_fingerprint = fingerprintSubagentTranscriptContent(message.content)
    }
    if (
      typeof message.reasoning === "string" &&
      message.reasoning_is_projection !== true &&
      typeof message.subagent_reasoning_fingerprint !== "string"
    ) {
      message.subagent_reasoning_fingerprint = fingerprintSubagentTranscriptContent(
        message.reasoning
      )
    }
  }
  for (const key of ["subagent_name", "subagent_description", "subagent_type"] as const) {
    if (typeof message[key] === "string") {
      message[key] = projectSubagentDescription(message[key] as string)
    }
  }
  for (const key of [
    "replaced_message_ids",
    "replaced_message_id_prefixes",
    "compatible_replaced_message_id_prefixes"
  ] as const) {
    if (Array.isArray(message[key])) {
      message[key] = message[key]
        .filter((value): value is string => typeof value === "string")
        .slice(-8)
        .map((value) => projectSubagentDescription(value))
    }
  }
  let hasStartupProjection =
    message.subagent_startup_projection === true ||
    message.content_is_projection === true ||
    message.reasoning_is_projection === true ||
    isSubagentTranscriptBlobRef(message.content_ref, "content") ||
    isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning") ||
    isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")
  if (isSubagentTranscriptBlobRef(message.content_ref, "content")) {
    message.content_is_projection = true
  }
  if (isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning")) {
    message.reasoning_is_projection = true
  }
  if (typeof message.content === "string") {
    const projected = omitPreview ? "" : projectSubagentTranscriptStartupContent(message.content)
    if (projected !== message.content) {
      message.content_full_length =
        typeof message.content_full_length === "number"
          ? message.content_full_length
          : message.content.length
      message.content = projected
      message.content_is_projection = true
      hasStartupProjection = true
    }
  } else if (message.content !== undefined) {
    message.content = []
    message.content_is_projection = true
    hasStartupProjection = true
  }
  if (typeof message.reasoning === "string") {
    const projected = omitPreview ? "" : projectSubagentTranscriptStartupContent(message.reasoning)
    if (projected !== message.reasoning) {
      message.reasoning_full_length =
        typeof message.reasoning_full_length === "number"
          ? message.reasoning_full_length
          : message.reasoning.length
      message.reasoning = projected
      message.reasoning_is_projection = true
      hasStartupProjection = true
    }
  } else if (message.reasoning !== undefined) {
    delete message.reasoning
    message.reasoning_is_projection = true
    hasStartupProjection = true
  }
  if (message.tool_calls !== undefined) {
    delete message.tool_calls
    message.subagent_startup_tool_calls_projection = true
    hasStartupProjection = true
  }
  if (isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")) {
    message.subagent_startup_tool_calls_projection = true
    hasStartupProjection = true
  }
  if (hasStartupProjection) message.subagent_startup_projection = true
  return message
}

function startupBucket(
  rawMessages: unknown,
  subagentId: string,
  omitPreview = false
): unknown[] {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return []
  const promptIndex = rawMessages.findIndex(
    (message) =>
      isRecord(message) &&
      message.role === "user" &&
      (message.id === `subagent-prompt-${subagentId}` ||
        typeof message.subagent_tool_call_id === "string")
  )
  let finalIndex = -1
  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index]
    if (
      isRecord(message) &&
      message.role === "assistant" &&
      (message.id === `subagent-final-${subagentId}` ||
        ((typeof message.content_priority === "number" && message.content_priority >= 1) &&
          (message.status !== undefined || message.is_error === true)))
    ) {
      finalIndex = index
      break
    }
  }
  const selectedIndexes = new Set<number>()
  if (promptIndex >= 0) selectedIndexes.add(promptIndex)
  if (finalIndex >= 0) selectedIndexes.add(finalIndex)
  if (selectedIndexes.size === 0) {
    selectedIndexes.add(0)
    selectedIndexes.add(rawMessages.length - 1)
  }
  return Array.from(selectedIndexes)
    .sort((left, right) => left - right)
    .map((index) => projectStartupMessage(rawMessages[index], omitPreview))
}

/** Startup needs only card metadata and replay fingerprints, never full rows. */
export function buildSubagentTranscriptStartupManifests(
  transcripts: unknown,
  byteLimit: number = SUBAGENT_TRANSCRIPT_STARTUP_TOTAL_BYTES
): Record<string, unknown> {
  if (!isRecord(transcripts)) return {}
  const candidates = Object.entries(transcripts)
    .slice(0, SUBAGENT_TRANSCRIPT_STARTUP_BUCKET_LIMIT)
    .map(([subagentId, rawMessages], index) => {
      const messages = startupBucket(rawMessages, subagentId)
      const hasFinal = messages.some(
        (message) => isRecord(message) && message.id === `subagent-final-${subagentId}`
      )
      return { subagentId, rawMessages, messages, hasFinal, index }
    })
  candidates.sort((left, right) => {
    if (left.hasFinal !== right.hasFinal) return left.hasFinal ? 1 : -1
    return right.index - left.index
  })

  const accepted = new Map<string, unknown[]>()
  let usedBytes = 2
  for (const candidate of candidates) {
    let messages = candidate.messages
    let entryBytes = Buffer.byteLength(
      JSON.stringify({ [candidate.subagentId]: candidate.messages }),
      "utf8"
    )
    if (usedBytes + entryBytes > Math.max(2, byteLimit)) {
      messages = startupBucket(candidate.rawMessages, candidate.subagentId, true)
      entryBytes = Buffer.byteLength(
        JSON.stringify({ [candidate.subagentId]: messages }),
        "utf8"
      )
    }
    if (usedBytes + entryBytes > Math.max(2, byteLimit)) continue
    // Card/index metadata is irreducible for this bounded startup page. Older
    // buckets remain reachable through the focused transcript page API.
    accepted.set(candidate.subagentId, messages)
    usedBytes += entryBytes
  }
  return Object.fromEntries(
    candidates.flatMap(({ subagentId }) => {
      const messages = accepted.get(subagentId)
      return messages ? [[subagentId, messages] as const] : []
    })
  )
}

function exactReplacementAliases(message: UnknownRecord): Set<string> {
  const exact = new Set<string>()
  if (typeof message.replaces_message_id === "string") exact.add(message.replaces_message_id)
  const replacedIds = Array.isArray(message.replaced_message_ids)
    ? message.replaced_message_ids
    : []
  for (const value of replacedIds) {
    if (typeof value === "string") exact.add(value)
  }
  return exact
}

/** Merge a renderer's dirty, possibly startup-trimmed bucket into its full manifest. */
export function mergeSubagentTranscriptManifestMessages(
  existingMessages: unknown,
  incomingMessages: unknown
): unknown[] {
  const baseline = Array.isArray(existingMessages) ? [...existingMessages] : []
  if (!Array.isArray(incomingMessages)) return baseline
  const baselineIndexesById = new Map<string, number[]>()
  baseline.forEach((message, index) => {
    if (!isRecord(message) || typeof message.id !== "string") return
    const indexes = baselineIndexesById.get(message.id) ?? []
    indexes.push(index)
    baselineIndexesById.set(message.id, indexes)
  })
  const consumedBaselineIndexes = new Set<number>()
  type IncomingNode = {
    active: boolean
    anchorIndexes: Set<number>
    id?: string
    order: number
    value: unknown
  }
  const nodes: IncomingNode[] = []
  const nodeById = new Map<string, IncomingNode>()

  for (const incoming of incomingMessages) {
    if (!isRecord(incoming) || typeof incoming.id !== "string") {
      nodes.push({
        active: true,
        anchorIndexes: new Set<number>(),
        order: nodes.length,
        value: incoming
      })
      continue
    }
    const exact = exactReplacementAliases(incoming)
    const targetIds = new Set([incoming.id, ...exact])
    const matchingNodes = [...targetIds]
      .flatMap((id) => {
        const node = nodeById.get(id)
        return node?.active ? [node] : []
      })
      .filter((node, index, all) => all.indexOf(node) === index)
      .sort((left, right) => left.order - right.order)
    const sameNode = nodeById.get(incoming.id)
    const sameBaselineIndex = (baselineIndexesById.get(incoming.id) ?? []).find(
      (index) => !consumedBaselineIndexes.has(index)
    )
    const existingSame =
      sameNode?.active && isRecord(sameNode.value)
        ? sameNode.value
        : sameBaselineIndex !== undefined && isRecord(baseline[sameBaselineIndex])
          ? (baseline[sameBaselineIndex] as UnknownRecord)
          : undefined
    const persistedIncoming: UnknownRecord = { ...incoming }
    if (
      incoming.subagent_startup_projection === true &&
      existingSame
    ) {
      Object.assign(persistedIncoming, existingSame, incoming)
      const preserveExistingFields = (fields: string[]): void => {
        for (const field of fields) {
          if (Object.prototype.hasOwnProperty.call(existingSame, field)) {
            persistedIncoming[field] = existingSame[field]
          } else {
            delete persistedIncoming[field]
          }
        }
      }
      if (incoming.content_is_projection === true) {
        preserveExistingFields([
          "content",
          "content_is_projection",
          "content_full_length",
          "content_ref",
          "subagent_prompt_fingerprint",
          "subagent_content_fingerprint"
        ])
      }
      if (incoming.reasoning_is_projection === true) {
        preserveExistingFields([
          "reasoning",
          "reasoning_is_projection",
          "reasoning_full_length",
          "reasoning_ref",
          "subagent_reasoning_fingerprint"
        ])
      }
      if (incoming.subagent_startup_tool_calls_projection === true) {
        preserveExistingFields(["tool_calls", "tool_calls_ref"])
      }
    }
    delete persistedIncoming.subagent_startup_projection
    delete persistedIncoming.subagent_startup_tool_calls_projection

    // Prefix arrays are durable recovery hints, not wildcard deletion rules.
    // The renderer records the one actually matched source in
    // `replaced_message_ids`; only those exact aliases are safe to delete here.
    const persistedExact = exactReplacementAliases(persistedIncoming)
    const persistedTargetIds = new Set([persistedIncoming.id as string, ...persistedExact])
    const anchorIndexes = new Set<number>()
    for (const targetId of persistedTargetIds) {
      for (const index of baselineIndexesById.get(targetId) ?? []) {
        consumedBaselineIndexes.add(index)
        anchorIndexes.add(index)
      }
    }
    const primaryNode = matchingNodes[0]
    const node: IncomingNode =
      primaryNode ?? {
        active: true,
        anchorIndexes: new Set<number>(),
        id: persistedIncoming.id as string,
        order: nodes.length,
        value: persistedIncoming
      }
    if (!primaryNode) nodes.push(node)
    for (const matchingNode of matchingNodes) {
      for (const index of matchingNode.anchorIndexes) node.anchorIndexes.add(index)
      if (matchingNode !== node) matchingNode.active = false
      if (matchingNode.id) nodeById.delete(matchingNode.id)
    }
    for (const index of anchorIndexes) node.anchorIndexes.add(index)
    node.id = persistedIncoming.id as string
    node.value = persistedIncoming
    nodeById.set(node.id, node)
  }

  const survivors = baseline.filter((_, index) => !consumedBaselineIndexes.has(index))
  const survivorsBeforeIndex = new Array<number>(baseline.length + 1)
  let survivorCount = 0
  for (let index = 0; index <= baseline.length; index += 1) {
    survivorsBeforeIndex[index] = survivorCount
    if (index < baseline.length && !consumedBaselineIndexes.has(index)) survivorCount += 1
  }
  const activeNodes = nodes.filter((node) => node.active).sort((a, b) => a.order - b.order)
  const preferredGaps = new Array<number>(activeNodes.length)
  let nextAnchoredGap = survivors.length
  for (let index = activeNodes.length - 1; index >= 0; index -= 1) {
    const anchorIndexes = [...activeNodes[index].anchorIndexes]
    if (anchorIndexes.length > 0) {
      const anchorIndex = Math.min(...anchorIndexes)
      nextAnchoredGap = survivorsBeforeIndex[anchorIndex] ?? survivors.length
    }
    preferredGaps[index] = nextAnchoredGap
  }
  const nodesByGap = new Map<number, unknown[]>()
  let previousGap = 0
  activeNodes.forEach((node, index) => {
    const gap = Math.min(
      survivors.length,
      Math.max(previousGap, preferredGaps[index] ?? survivors.length)
    )
    previousGap = gap
    const gapNodes = nodesByGap.get(gap) ?? []
    gapNodes.push(node.value)
    nodesByGap.set(gap, gapNodes)
  })
  const merged: unknown[] = []
  for (let gap = 0; gap <= survivors.length; gap += 1) {
    merged.push(...(nodesByGap.get(gap) ?? []))
    if (gap < survivors.length) merged.push(survivors[gap])
  }
  return merged
}

async function hydrateMessage(rawMessage: unknown): Promise<unknown> {
  if (!isRecord(rawMessage)) return rawMessage
  const message: UnknownRecord = { ...rawMessage }
  const contentJournal =
    typeof message.subagent_content_delta_journal === "string"
      ? message.subagent_content_delta_journal
      : ""
  const reasoningJournal =
    typeof message.subagent_reasoning_delta_journal === "string"
      ? message.subagent_reasoning_delta_journal
      : ""
  delete message.subagent_content_delta_journal
  delete message.subagent_reasoning_delta_journal
  delete message.subagent_content_delta_journal_length
  delete message.subagent_reasoning_delta_journal_length
  delete message.subagent_content_delta_journal_omitted
  delete message.subagent_reasoning_delta_journal_omitted
  const contentRef = isSubagentTranscriptBlobRef(message.content_ref, "content")
    ? message.content_ref
    : undefined
  if (contentRef) {
    try {
      const content = await readBlob(contentRef)
      message.content =
        typeof content === "string" && contentJournal ? `${content}${contentJournal}` : content
      delete message.content_is_projection
    } catch (error) {
      console.warn("[SubagentTranscriptStore] Failed to hydrate content blob:", error)
    }
  }
  const reasoningRef = isSubagentTranscriptBlobRef(message.reasoning_ref, "reasoning")
    ? message.reasoning_ref
    : undefined
  if (reasoningRef) {
    try {
      const reasoning = await readBlob(reasoningRef)
      if (typeof reasoning === "string") {
        message.reasoning = reasoningJournal ? `${reasoning}${reasoningJournal}` : reasoning
        delete message.reasoning_is_projection
      }
    } catch (error) {
      console.warn("[SubagentTranscriptStore] Failed to hydrate reasoning blob:", error)
    }
  }
  const toolCallsRef = isSubagentTranscriptBlobRef(message.tool_calls_ref, "tool_calls")
    ? message.tool_calls_ref
    : undefined
  if (toolCallsRef) {
    try {
      const toolCalls = await readBlob(toolCallsRef)
      if (Array.isArray(toolCalls)) message.tool_calls = toolCalls
    } catch (error) {
      console.warn("[SubagentTranscriptStore] Failed to hydrate tool-calls blob:", error)
    }
  }
  return message
}

/** Map in stable order while bounding simultaneous blob reads below common fd limits. */
export async function mapSubagentTranscriptHydrationBounded<T, R>(
  values: readonly T[],
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (values.length === 0) return []
  const results = new Array<R>(values.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(SUBAGENT_TRANSCRIPT_HYDRATION_CONCURRENCY, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(values[index], index)
      }
    }
  )
  await Promise.all(workers)
  return results
}

export async function hydrateSubagentTranscriptManifests(
  transcripts: unknown,
  hydrate: (rawMessage: unknown) => Promise<unknown> = hydrateMessage
): Promise<Record<string, unknown>> {
  if (!isRecord(transcripts)) return {}
  const hydrated: Record<string, unknown> = {}
  const jobs: Array<{ subagentId: string; messageIndex: number; rawMessage: unknown }> = []
  for (const [subagentId, rawMessages] of Object.entries(transcripts)) {
    if (!Array.isArray(rawMessages)) continue
    hydrated[subagentId] = new Array<unknown>(rawMessages.length)
    rawMessages.forEach((rawMessage, messageIndex) => {
      jobs.push({ subagentId, messageIndex, rawMessage })
    })
  }
  const hydratedMessages = await mapSubagentTranscriptHydrationBounded(
    jobs,
    ({ rawMessage }) => hydrate(rawMessage)
  )
  jobs.forEach(({ subagentId, messageIndex }, jobIndex) => {
    const bucket = hydrated[subagentId] as unknown[]
    bucket[messageIndex] = hydratedMessages[jobIndex]
  })
  return hydrated
}

export function collectSubagentTranscriptBlobHashes(value: unknown): Set<string> {
  const hashes = new Set<string>()
  const visit = (candidate: unknown): void => {
    if (isSubagentTranscriptBlobRef(candidate)) {
      hashes.add(candidate.sha256)
      return
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item)
      return
    }
    if (!isRecord(candidate)) return
    for (const nested of Object.values(candidate)) visit(nested)
  }
  visit(value)
  return hashes
}

export interface SubagentTranscriptBlobGcCandidate {
  path: string
  prefixPath: string
  hash?: string
}

/** Perform the directory walk and all stats outside the global content lock. */
export async function scanSubagentTranscriptBlobGcCandidates(
  referencedHashes: ReadonlySet<string>,
  graceMs: number = 5 * 60_000
): Promise<SubagentTranscriptBlobGcCandidate[]> {
  const root = getSubagentTranscriptContentDir()
  const cutoff = Date.now() - Math.max(0, graceMs)
  const candidates: SubagentTranscriptBlobGcCandidate[] = []
  const prefixes = await readdir(root, { withFileTypes: true }).catch(() => [])
  for (const prefix of prefixes) {
    if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue
    const prefixPath = join(root, prefix.name)
    const files = await readdir(prefixPath, { withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile()) continue
      const match = /^([a-f0-9]{64})\.json$/.exec(file.name)
      if (match && referencedHashes.has(match[1])) continue
      if (
        !match &&
        !/^\.[a-f0-9]{64}\..+\.tmp$/.test(file.name) &&
        !/\.corrupt\./.test(file.name) &&
        !/^\.gc\.[a-f0-9]{64}\./.test(file.name)
      ) {
        continue
      }
      const path = join(prefixPath, file.name)
      const details = await stat(path).catch(() => undefined)
      if (!details || details.mtimeMs > cutoff) continue
      candidates.push({ path, prefixPath, ...(match && { hash: match[1] }) })
    }
  }
  return candidates
}

/** Rename canonical candidates out of the dedupe namespace under the lock. */
export async function quarantineSubagentTranscriptBlobGcCandidates(
  candidates: readonly SubagentTranscriptBlobGcCandidate[],
  referencedHashes: ReadonlySet<string>
): Promise<Array<{ path: string; prefixPath: string }>> {
  const quarantined: Array<{ path: string; prefixPath: string }> = []
  for (const candidate of candidates) {
    if (
      candidate.hash &&
      (referencedHashes.has(candidate.hash) ||
        isSubagentTranscriptBlobReadPinned(candidate.hash))
    ) {
      continue
    }
    const quarantinePath = candidate.hash
      ? join(candidate.prefixPath, `.gc.${candidate.hash}.${randomUUID()}`)
      : candidate.path
    if (quarantinePath !== candidate.path) {
      try {
        await rename(candidate.path, quarantinePath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
        throw error
      }
    }
    quarantined.push({ path: quarantinePath, prefixPath: candidate.prefixPath })
  }
  return quarantined
}

/** Delete quarantined names and empty prefix directories without holding the lock. */
export async function removeQuarantinedSubagentTranscriptBlobs(
  quarantined: readonly { path: string; prefixPath: string }[]
): Promise<number> {
  const removedResults = await mapSubagentTranscriptHydrationBounded(
    quarantined,
    async (candidate) => {
      await rm(candidate.path, { force: true })
      return 1
    }
  )
  await Promise.all(
    [...new Set(quarantined.map((candidate) => candidate.prefixPath))].map((prefixPath) =>
      rm(prefixPath, { recursive: false }).catch(() => undefined)
    )
  )
  return removedResults.reduce((total, value) => total + value, 0)
}

export async function pruneUnreferencedSubagentTranscriptBlobs(
  referencedHashes: ReadonlySet<string>,
  graceMs: number = 5 * 60_000
): Promise<number> {
  const candidates = await scanSubagentTranscriptBlobGcCandidates(referencedHashes, graceMs)
  const quarantined = await quarantineSubagentTranscriptBlobGcCandidates(
    candidates,
    referencedHashes
  )
  return removeQuarantinedSubagentTranscriptBlobs(quarantined)
}
