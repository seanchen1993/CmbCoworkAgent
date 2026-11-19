import type { NativeSqliteAdapter } from "../db/native-sqlite-adapter"
import { publishedThreadMessageFragmentsSql } from "../db/thread-message-fragment-storage"
import { legacySearchProjectionIssue } from "../checkpointer/runtime-projection-protocol"
import type { Message, ThreadMessageSearchMatch, ThreadMessageSearchOptions, ThreadMessageSearchPage } from "../types"
import { createChatSearchPlanQueryFilter, iterateChatSearchLocations, projectChatSearchPlan } from "../../shared/chat-search-index"
import type { ChatSearchLocation } from "../../shared/chat-search-types"
import { THREAD_SEARCH_QUERY_LIMIT } from "../../shared/thread-search-types"
import { createThreadSearchMessagePlan, THREAD_SEARCH_REASONING_BYTE_LIMIT } from "../../shared/thread-search-projection"
import { isMessageRole, parseJsonValue } from "../../shared/thread-message-content"
import { SEARCH_VISIBLE_MESSAGE_ID_SQL } from "./message-visibility-sql"
import { THREAD_MESSAGE_BEFORE_CURSOR_SQL, threadMessageBeforeCursorBindings } from "../thread-message-hydration/order-sql"

type ThreadMessageRole = Message["role"]

export const DEFAULT_THREAD_MESSAGE_SEARCH_LIMIT = 50
export const MAX_THREAD_MESSAGE_SEARCH_LIMIT = 100
export const THREAD_MESSAGE_SEARCH_SCAN_LIMIT = 32
export const THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET = 512 * 1024
export const THREAD_MESSAGE_SEARCH_QUERY_LIMIT = THREAD_SEARCH_QUERY_LIMIT
export const THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT = 320
export const THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET = 128 * 1024

function normalizeThreadMessageSearchLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || limit === undefined || limit <= 0) {
    return DEFAULT_THREAD_MESSAGE_SEARCH_LIMIT
  }
  return Math.min(MAX_THREAD_MESSAGE_SEARCH_LIMIT, Math.max(1, Math.floor(limit)))
}

interface ThreadMessageSearchCandidate {
  messageId: string
  ordinal: number
  role: ThreadMessageRole
  createdAt: number
  contentJson: string
  toolCallsJson: string | null
  toolCallsTruncated: boolean
  reasoningSample: string | null
  reasoningOmitted: boolean
}

const boundedSearchReasoning = `CASE WHEN m.role = 'assistant'
  AND octet_length(m.reasoning) <= ${THREAD_SEARCH_REASONING_BYTE_LIMIT} THEN m.reasoning END`
const boundedSearchReasoningBytes = `COALESCE(octet_length(${boundedSearchReasoning}), 0)`

/**
 * Search one bounded durable-transcript window. SQLite reads compact headers
 * first; only a candidate/byte-bounded suffix is projected and inspected. Empty
 * match pages can still carry a cursor, so callers continue toward older messages
 * until `hasMore` is false without one IPC blocking on the whole transcript.
 */
export function searchDurableThreadMessages(
  database: Pick<NativeSqliteAdapter, "prepare">,
  threadId: string,
  rawQuery: string,
  options: ThreadMessageSearchOptions = {},
  checkCancelled: () => void = () => {}
): ThreadMessageSearchPage {
  const normalizedThreadId = typeof threadId === "string" ? threadId.trim() : ""
  const query = typeof rawQuery === "string" ? rawQuery.trim() : ""
  if (query.length > THREAD_MESSAGE_SEARCH_QUERY_LIMIT) {
    throw new RangeError(
      `Thread message search query exceeds ${THREAD_MESSAGE_SEARCH_QUERY_LIMIT} characters`
    )
  }
  if (!normalizedThreadId || !query) {
    return {
      matches: [],
      beforeOrdinal: null,
      beforeMessageId: null,
      hasMore: false,
      scanned: 0,
      truncated: false
    }
  }

  const hasBeforeOrdinal =
    Number.isSafeInteger(options.beforeOrdinal) && (options.beforeOrdinal ?? -1) >= 0
  const normalizedBeforeMessageId = options.beforeMessageId?.trim() ?? ""
  const hasBeforeMessageId = normalizedBeforeMessageId.length > 0
  if (hasBeforeOrdinal !== hasBeforeMessageId) {
    throw new Error(
      "Thread message search cursor requires beforeOrdinal and beforeMessageId together"
    )
  }

  const projection = database.prepare(`SELECT checkpoint_id, search_projection_state
    FROM legacy_checkpoint_transcript_migrations WHERE thread_id = ?`)
  let truncatedRows: boolean
  try {
    projection.bind([normalizedThreadId])
    truncatedRows = projection.step() && Boolean(legacySearchProjectionIssue(projection.getAsObject()))
  } finally {
    projection.free()
  }

  const cursorPredicate = hasBeforeOrdinal
    ? THREAD_MESSAGE_BEFORE_CURSOR_SQL
    : ""
  const cursorBindings: Array<string | number> = hasBeforeOrdinal
    ? [
        normalizedThreadId,
        ...threadMessageBeforeCursorBindings(normalizedThreadId, normalizedBeforeMessageId, options.beforeOrdinal!)
      ]
    : [normalizedThreadId]

  // Read only compact headers here. The extra row establishes whether another
  // bounded scan window exists without touching its content_json value.
  const candidateStatement = database.prepare(
    `SELECT
       m.message_id,
       m.ordinal,
       1024 + octet_length(m.content_json) + ${boundedSearchReasoningBytes} AS estimated_bytes,
       COALESCE(octet_length(m.tool_calls_json), 0) AS tool_bytes,
       EXISTS (SELECT 1 FROM thread_message_fragments AS part
         WHERE part.thread_id = m.thread_id AND part.message_id = m.message_id
           AND ${publishedThreadMessageFragmentsSql("part", "m")}) AS has_fragments
     FROM thread_messages AS m
     WHERE m.thread_id = ? AND ${SEARCH_VISIBLE_MESSAGE_ID_SQL}
       ${cursorPredicate}
     ORDER BY m.ordinal DESC, m.message_id DESC
     LIMIT ?`
  )
  candidateStatement.bind([...cursorBindings, THREAD_MESSAGE_SEARCH_SCAN_LIMIT + 1])
  const candidateHeaders: Array<{
    messageId: string
    ordinal: number
    contentBytes: number
    toolBytes: number
    hasFragments: boolean
  }> = []
  try {
    while (candidateStatement.step()) {
      checkCancelled()
      const row = candidateStatement.getAsObject() as {
        message_id?: unknown
        ordinal?: unknown
        estimated_bytes?: unknown
        tool_bytes?: unknown
        has_fragments?: unknown
      }
      if (typeof row.message_id !== "string") continue
      candidateHeaders.push({
        messageId: row.message_id,
        ordinal: Number(row.ordinal) || 0,
        contentBytes: Math.max(0, Number(row.estimated_bytes) || 0),
        toolBytes: Math.max(0, Number(row.tool_bytes) || 0),
        hasFragments: row.has_fragments === 1
      })
    }
  } finally {
    candidateStatement.free()
  }

  const selectedCandidates: Array<(typeof candidateHeaders)[number] & { includeTools: boolean }> = []
  const fragmentHeaders = database.prepare(`SELECT 32 + octet_length(f.content_text) AS bytes
    FROM thread_message_fragments AS f WHERE f.thread_id = ? AND f.message_id = ?
      AND ${publishedThreadMessageFragmentsSql("f")}
    ORDER BY f.fragment_id`)
  let remaining = THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
  try {
    for (const candidate of candidateHeaders.slice(0, THREAD_MESSAGE_SEARCH_SCAN_LIMIT)) {
      let bytes = candidate.contentBytes
      if (bytes <= remaining && candidate.hasFragments) {
        fragmentHeaders.bind([normalizedThreadId, candidate.messageId])
        while (fragmentHeaders.step()) {
          checkCancelled()
          bytes += Number(fragmentHeaders.getAsObject().bytes)
          if (bytes > remaining) break
        }
      }
      if (bytes > remaining) break
      const includeTools = bytes + candidate.toolBytes <= THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET
      const admitted = bytes + (includeTools ? candidate.toolBytes : 0)
      if (admitted > remaining) break
      remaining -= admitted
      selectedCandidates.push({ ...candidate, includeTools })
    }
  } finally {
    fragmentHeaders.free()
  }
  if (selectedCandidates.length === 0) {
    const firstCandidate = candidateHeaders[0]
    const hasMore = candidateHeaders.length > 1
    return {
      matches: [],
      beforeOrdinal: hasMore ? firstCandidate.ordinal : null,
      beforeMessageId: hasMore ? firstCandidate.messageId : null,
      hasMore,
      scanned: firstCandidate ? 1 : 0,
      truncated: truncatedRows || Boolean(firstCandidate)
    }
  }

  const limit = normalizeThreadMessageSearchLimit(options.limit)
  const mayMatch = createChatSearchPlanQueryFilter(query)
  const candidateRowsStatement = database.prepare(
    `WITH selected(message_id, include_tools) AS (
         VALUES ${selectedCandidates.map(() => "(?, ?)").join(",")}
       )
     SELECT
       m.message_id,
       m.ordinal,
       m.role,
       m.created_at,
       m.content_json,
       ${boundedSearchReasoning} AS reasoning_sample,
       m.role = 'assistant' AND
         octet_length(m.reasoning) > ${THREAD_SEARCH_REASONING_BYTE_LIMIT} AS reasoning_omitted,
       CASE WHEN s.include_tools THEN m.tool_calls_json END AS tool_calls_json,
       NOT s.include_tools AS tool_calls_truncated
     FROM selected AS s
     JOIN thread_messages AS m ON m.message_id = s.message_id
     WHERE m.thread_id = ?
     ORDER BY m.ordinal DESC, m.message_id DESC`
  )
  candidateRowsStatement.bind([
    ...selectedCandidates.flatMap(({ messageId, includeTools }) => [messageId, Number(includeTools)]),
    normalizedThreadId
  ])
  const candidates: ThreadMessageSearchCandidate[] = []
  try {
    while (candidateRowsStatement.step()) {
      checkCancelled()
      const row = candidateRowsStatement.getAsObject() as {
        message_id?: unknown
        ordinal?: unknown
        role?: unknown
        created_at?: unknown
        content_json?: unknown
        tool_calls_json?: unknown
        tool_calls_truncated?: unknown
        reasoning_sample?: unknown
        reasoning_omitted?: unknown
      }
      if (
        typeof row.message_id !== "string" ||
        !isMessageRole(row.role) ||
        typeof row.content_json !== "string"
      ) {
        continue
      }
      candidates.push({
        messageId: row.message_id,
        ordinal: Number(row.ordinal) || 0,
        role: row.role,
        createdAt: Number(row.created_at) || 0,
        contentJson: row.content_json,
        toolCallsJson: typeof row.tool_calls_json === "string" ? row.tool_calls_json : null,
        toolCallsTruncated: Number(row.tool_calls_truncated) === 1,
        reasoningSample: typeof row.reasoning_sample === "string" ? row.reasoning_sample : null,
        reasoningOmitted: Number(row.reasoning_omitted) === 1
      })
    }
  } finally {
    candidateRowsStatement.free()
  }

  const headersById = new Map(
    selectedCandidates.map((candidate, index) => [candidate.messageId, { candidate, index }])
  )
  const fragmentStatement = database.prepare(
    `SELECT f.content_text
     FROM thread_message_fragments AS f
     WHERE f.thread_id = ? AND f.message_id = ? AND ${publishedThreadMessageFragmentsSql("f")}
     ORDER BY f.fragment_id ASC`
  )
  const rawMatches: ThreadMessageSearchMatch[] = []
  let inspectedBytes = 0
  let advancedCandidateCount = 0
  let lastAdvancedCandidate: (typeof selectedCandidates)[number] | null = null
  try {
    for (const candidate of candidates) {
      checkCancelled()
      const header = headersById.get(candidate.messageId)
      if (!header) continue
      const baseBytes =
        1024 +
        Buffer.byteLength(candidate.contentJson, "utf8") +
        Buffer.byteLength(candidate.toolCallsJson ?? "", "utf8")
      if (candidate.toolCallsTruncated) truncatedRows = true

      if (baseBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) {
        truncatedRows = true
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }

      if (candidate.role === "tool") {
        // Completed tool details are folded and have no independent message row in the DOM.
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }

      const parsedContent = parseJsonValue(candidate.contentJson)
      const fragments: string[] = []
      let candidateBytes = baseBytes
      // Hydration appends fragments only to string content. Rebuild that same bounded value before
      // applying display filters so a split attachment/internal marker cannot leak into search.
      if (typeof parsedContent === "string") {
        fragmentStatement.bind([normalizedThreadId, candidate.messageId])
        while (fragmentStatement.step()) {
          checkCancelled()
          const row = fragmentStatement.getAsObject() as { content_text?: unknown }
          if (typeof row.content_text !== "string") continue
          candidateBytes += Buffer.byteLength(row.content_text, "utf8")
          if (candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) break
          fragments.push(row.content_text)
        }
      }

      if (candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) {
        truncatedRows = true
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }

      const plan = createThreadSearchMessagePlan(
        candidate.role,
        parsedContent,
        fragments,
        candidate.toolCallsJson,
        candidate.reasoningSample,
        candidate.reasoningOmitted
      )
      if (!plan) {
        advancedCandidateCount = header.index + 1
        lastAdvancedCandidate = header.candidate
        continue
      }

      if (inspectedBytes + candidateBytes > THREAD_MESSAGE_SEARCH_SCAN_BYTE_BUDGET) break
      inspectedBytes += candidateBytes
      const segments = mayMatch(plan) ? projectChatSearchPlan(plan, true) : []
      if (plan.truncated) truncatedRows = true
      const found = iterateChatSearchLocations(segments, query, 1001)
      // Budget individual locations before constructing a possibly oversized first response row.
      const locations: ChatSearchLocation[] = []
      let locationBytes = 0
      for (const location of found) {
        const bytes = Buffer.byteLength(JSON.stringify(location), "utf8") + 1
        if (locationBytes + bytes > 48 * 1024 || locations.length >= 1000) {
          truncatedRows = true
          break
        }
        locations.push(location)
        locationBytes += bytes
      }
      const occurrenceCount = locations.length
      const preview = locations[0]?.context.slice(0, THREAD_MESSAGE_SEARCH_PREVIEW_LIMIT) ?? ""

      advancedCandidateCount = header.index + 1
      lastAdvancedCandidate = header.candidate
      if (occurrenceCount > 0) {
        rawMatches.push({
          messageId: candidate.messageId,
          ordinal: candidate.ordinal,
          role: candidate.role,
          createdAt: candidate.createdAt,
          occurrenceCount,
          locations,
          preview
        })
        if (rawMatches.length >= limit + 1) break
      }
    }
  } finally {
    fragmentStatement.free()
  }

  // Reserve envelope/cursor space, then measure exact JSON bytes for every
  // returned match. This keeps renderer IPC bounded even for escape-heavy text.
  const matches: ThreadMessageSearchMatch[] = []
  let responseBytes = 8 * 1024
  let truncatedMatches = false
  for (const match of rawMatches) {
    if (matches.length >= limit) {
      truncatedMatches = true
      break
    }
    const matchBytes = Buffer.byteLength(JSON.stringify(match), "utf8") + 1
    if (
      matches.length > 0 &&
      responseBytes + matchBytes > THREAD_MESSAGE_SEARCH_RESPONSE_BYTE_BUDGET
    ) {
      truncatedMatches = true
      break
    }
    matches.push(match)
    responseBytes += matchBytes
  }
  if (rawMatches.length > matches.length) truncatedMatches = true

  let beforeOrdinal: number | null = null
  let beforeMessageId: string | null = null
  if (truncatedMatches && matches.length > 0) {
    const lastMatch = matches[matches.length - 1]
    beforeOrdinal = lastMatch.ordinal
    beforeMessageId = lastMatch.messageId
  } else if (lastAdvancedCandidate && candidateHeaders.length > advancedCandidateCount) {
    beforeOrdinal = lastAdvancedCandidate.ordinal
    beforeMessageId = lastAdvancedCandidate.messageId
  }

  return {
    matches,
    beforeOrdinal,
    beforeMessageId,
    hasMore: beforeOrdinal !== null && beforeMessageId !== null,
    scanned: advancedCandidateCount,
    truncated: truncatedRows
  }
}
