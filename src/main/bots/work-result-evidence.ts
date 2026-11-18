import { createHash } from "node:crypto"
import { basename, dirname, isAbsolute } from "node:path"
import type { BotDeliveredFile } from "../../shared/bots/file-delivery"
import { MAX_ATTACHMENT_FILE_BYTES } from "../../shared/file-attachment"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"

const PAGE_SIZE = 8
const TEXT_PAGE_SIZE = 6_000

export interface BotResultEvidenceBinding {
  botId: string
  workId: string
  threadId: string
  executionTaskId: string
  reviewTaskId: string
}

/** Only Host-confirmed records enter this catalogue. Text must already be projected. */
export type BotResultEvidence =
  | {
      kind: "text"
      sourceTaskId: string
      messageId: string
      label: string
      text: string
      truncated?: boolean
    }
  | {
      kind: "snapshot"
      sourceTaskId: string
      callId: string
      fileIndex: number
      file: BotDeliveredFile
      root: string
    }

type ParseSnapshot = (input: {
  filename: string
  bytes: Uint8Array
  maxChars: number
  signal: AbortSignal
}) => Promise<{ text: string; truncated: boolean } | null>

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const stale = () => new Error("本次核查的证据已失效或不可访问。")

function describe(scope: string, entry: BotResultEvidence) {
  const reference = entry.kind === "text"
    ? { sourceTaskId: entry.sourceTaskId, messageId: entry.messageId }
    : { sourceTaskId: entry.sourceTaskId, callId: entry.callId, fileIndex: entry.fileIndex }
  return {
    id: hash(JSON.stringify([scope, entry.kind, reference])),
    kind: entry.kind,
    label: (entry.kind === "text" ? entry.label : entry.file.name).slice(0, 160),
    ...(entry.kind === "snapshot" ? { fileId: hash(entry.file.filePath) } : {}),
    reference
  }
}

function encodeCursor(scope: string, offset: number): string {
  return `${scope}.${offset}`
}

function decodeCursor(cursor: string | undefined, scope: string, length: number): number {
  if (cursor === undefined) return 0
  const match = /^([a-f0-9]{64})\.([1-9][0-9]{0,9})$/.exec(cursor)
  const offset = Number(match?.[2])
  if (match?.[1] !== scope || offset >= length) throw stale()
  return offset
}

async function readSnapshotBytes(root: string, file: BotDeliveredFile, signal: AbortSignal) {
  const path = file.attachmentPath
  const digest = path && basename(dirname(path))
  if (!path || !isAbsolute(path) || !isAbsolute(root) || !digest || !/^[a-f0-9]{64}$/.test(digest))
    return null
  signal.throwIfAborted()
  const opened = await openStableFileHandle(root, path)
  try {
    if (opened.size !== file.size) return null
    const bytes = await readStableFileHandleBounded(opened, MAX_ATTACHMENT_FILE_BYTES)
    signal.throwIfAborted()
    return createHash("sha256").update(bytes).digest("hex") === digest ? bytes : null
  } finally {
    await opened.handle.close()
  }
}

/** The loader must recheck the live review, execution lineage and caller authority on each access. */
export function createBotResultEvidenceReader(
  binding: BotResultEvidenceBinding,
  loadAuthorizedEvidence: (binding: Readonly<BotResultEvidenceBinding>) => readonly BotResultEvidence[] | null,
  parseSnapshot?: ParseSnapshot
) {
  const owner = Object.freeze({ ...binding })
  const scope = hash(JSON.stringify([owner.botId, owner.workId, owner.threadId, owner.executionTaskId, owner.reviewTaskId]))
  const load = () => {
    const entries = loadAuthorizedEvidence(owner)
    if (!entries) throw stale()
    return entries
  }
  const lookup = (id: string) => {
    const matches = load().filter(entry => describe(scope, entry).id === id)
    if (matches.length !== 1) throw stale()
    return matches[0]
  }

  return {
    reference(id: string) { return describe(scope, lookup(id)) },
    // Adjacent pages requested synchronously share one authorized load. Reads
    // still reload on every access, including after asynchronous file parsing.
    list(cursor?: string, pageCount: 1 | 2 | 3 = 1) {
      const items = load().map(entry => describe(scope, entry))
      const pageScope = hash(JSON.stringify([scope, items.map(item => item.id)]))
      const offset = decodeCursor(cursor, pageScope, items.length)
      const next = offset + PAGE_SIZE * pageCount
      return {
        items: items.slice(offset, next),
        ...(next < items.length ? { nextCursor: encodeCursor(pageScope, next) } : {})
      }
    },
    async read(id: string, options: { cursor?: string; signal: AbortSignal }) {
      const { cursor, signal } = options
      signal.throwIfAborted()
      const entry = lookup(id)
      const evidence = describe(scope, entry)
      if (entry.kind === "text") {
        const pageScope = hash(JSON.stringify([id, hash(entry.text), entry.truncated === true]))
        const offset = decodeCursor(cursor, pageScope, entry.text.length)
        const next = offset + TEXT_PAGE_SIZE
        return {
          status: "ok" as const,
          evidence,
          text: entry.text.slice(offset, next),
          truncated: Boolean(entry.truncated || next < entry.text.length),
          ...(next < entry.text.length ? { nextCursor: encodeCursor(pageScope, next) } : {})
        }
      }

      if (cursor !== undefined) throw stale()
      const { root } = entry
      const file = { ...entry.file }
      const assertCurrent = () => {
        signal.throwIfAborted()
        const current = lookup(id)
        if (current.kind !== "snapshot" || current.root !== root ||
            current.file.attachmentPath !== file.attachmentPath || current.file.size !== file.size ||
            current.file.name !== file.name)
          throw stale()
      }
      const unavailable = (reason: "missing_version" | "too_large" | "unreadable") =>
        ({ status: "unavailable" as const, evidence, reason })
      if (!file.attachmentPath) return unavailable("missing_version")
      if (file.size > MAX_ATTACHMENT_FILE_BYTES) return unavailable("too_large")
      if (!parseSnapshot) return unavailable("unreadable")
      let bytes: Uint8Array | null
      try {
        bytes = await readSnapshotBytes(root, file, signal)
      } catch {
        bytes = null
      }
      assertCurrent()
      if (!bytes) return unavailable("unreadable")
      let result
      try {
        result = await parseSnapshot({ filename: file.name, bytes, maxChars: TEXT_PAGE_SIZE, signal })
      } catch {
        result = null
      }
      assertCurrent()
      return result
        ? {
            status: "ok" as const,
            evidence,
            text: result.text.slice(0, TEXT_PAGE_SIZE),
            truncated: result.truncated || result.text.length > TEXT_PAGE_SIZE
          }
        : unavailable("unreadable")
    }
  }
}

export type BotResultEvidenceSummary = ReturnType<ReturnType<typeof createBotResultEvidenceReader>["list"]>["items"][number]
export type BotResultEvidenceRead = Awaited<ReturnType<ReturnType<typeof createBotResultEvidenceReader>["read"]>>
