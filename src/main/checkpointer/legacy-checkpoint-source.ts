import { createHash } from "node:crypto"
import { parseJsonValue } from "../../shared/thread-message-content"
import { isLosslessTranscriptPayload } from "../../shared/transcript-recovery-integrity"
import { getMessageProviderOccurrenceIdentity } from "../../shared/message-role-collision"
import { projectChatSearchPlan } from "../../shared/chat-search-index"
import { createThreadSearchMessagePlan } from "../../shared/thread-search-projection"
export { NATIVE_DURABLE_CHECKPOINT_ID } from "./runtime-projection-protocol"

interface LegacyCheckpointPayload {
  messageId: string
  providerSourceId: string | null
  providerOccurrence: number | null
  role: string
  contentJson: string
  reasoning: string | null
  toolCallsJson: string | null
  toolCallId: string | null
  name: string | null
  status: string | null
  isError: number | null
}

export function legacyCheckpointProviderIdentity(
  message: Pick<LegacyCheckpointPayload, "messageId" | "role" | "providerSourceId" | "providerOccurrence">
): string {
  return getMessageProviderOccurrenceIdentity({
    id: message.messageId, role: message.role, provider_source_id: message.providerSourceId ?? undefined,
    provider_occurrence: message.providerOccurrence ?? undefined
  })
}

/** Follow the same surviving-row rule as fork replay. A rolled-back merge can make its source live again. */
export function legacyCheckpointReplayRowSql(thread: string, key: string): string {
  return `(
    WITH RECURSIVE replay(key) AS (
      SELECT ${key} WHERE ${key} IS NOT NULL
      UNION
      SELECT merge.target_key FROM replay
      JOIN thread_fork_replay_merges AS merge ON merge.thread_id = ${thread} AND merge.source_key = replay.key
      WHERE NOT EXISTS (SELECT 1 FROM thread_messages
        WHERE thread_id = ${thread} AND fork_replay_key = replay.key)
      LIMIT 64
    )
    SELECT live.rowid FROM replay
    JOIN thread_messages AS live ON live.thread_id = ${thread} AND live.fork_replay_key = replay.key
    LIMIT 1
  )`
}

export function legacyPublicationSources(primary: unknown, merged: unknown): string[] {
  const checkpoints = typeof merged === "string" ? parseJsonValue(merged) : undefined
  return [...new Set([primary, ...(Array.isArray(checkpoints) ? checkpoints : [])]
    .filter((checkpoint): checkpoint is string => typeof checkpoint === "string"))]
}

/** Hash every durable field used to recreate a checkpoint message. */
export function beginLegacyCheckpointContentHash(message: LegacyCheckpointPayload) {
  return createHash("sha256").update(JSON.stringify([
    message.messageId, message.providerSourceId, message.providerOccurrence, message.role,
    message.contentJson, message.reasoning, message.toolCallsJson, message.toolCallId,
    message.name, message.status, message.isError
  ]))
}

function orderedRecoveryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(orderedRecoveryJson)
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, orderedRecoveryJson(record[key])]))
  }
  return value
}

/** Recovery compares the message reconstructed by persistedMessageToRuntimeMessage. */
export function beginLegacyCheckpointRecoveryHash(message: LegacyCheckpointPayload) {
  const body = parseJsonValue(message.contentJson)
  const tools = message.toolCallsJson === null ? undefined : parseJsonValue(message.toolCallsJson)
  if (!isLosslessTranscriptPayload(body, tools) || (message.toolCallsJson !== null && !Array.isArray(tools)))
    return null
  let fields: unknown[] = []
  if (message.role === "assistant") {
    fields = [legacyCheckpointProviderIdentity(message), message.reasoning || null,
      Array.isArray(tools) && tools.length ? orderedRecoveryJson(tools) : null]
  } else if (message.role === "tool") {
    if (!message.toolCallId) return null
    const status = message.status === "success" || message.status === "error" ? message.status : null
    // The live stream derives the failure bit from status. The source can carry either.
    fields = [message.toolCallId, message.name || null, status, status === "error" || Boolean(message.isError)]
  }
  const hash = createHash("sha256").update(JSON.stringify([
    "checkpoint-message-v1", message.messageId, message.role, fields,
    typeof body === "string" ? "text" : "structured"
  ]))
  // UTF-16 keeps the hash independent of fragment cuts, even inside a surrogate pair.
  return hash.update(typeof body === "string" ? body : JSON.stringify(orderedRecoveryJson(body)), "utf16le")
}

export type LegacyOverlapPayload = Pick<LegacyCheckpointPayload,
  "messageId" | "role" | "providerSourceId" | "providerOccurrence" | "contentJson" | "toolCallsJson" | "reasoning">

interface SearchSourceProof {
  length: number
  digest: string
  rollingHash?: number
}

export interface LegacyOverlapProof {
  identity: string
  body: SearchSourceProof[]
  summaries: SearchSourceProof[]
  digest: string
}

export interface PreparedLegacyOverlap {
  proof(): LegacyOverlapProof | null
  covers(proof: LegacyOverlapProof): boolean
}

function overlapSearchSources(message: LegacyOverlapPayload, fragments: readonly string[]) {
  const content = parseJsonValue(message.contentJson)
  if (content === undefined) return null
  const plan = createThreadSearchMessagePlan(message.role, content, fragments, message.toolCallsJson, message.reasoning)
  const projected = plan ? projectChatSearchPlan(plan, true) : []
  if (plan?.truncated) return null
  const body: string[] = []
  const summaries: string[] = []
  for (const source of projected) {
    if (!source.text) continue
    const target = source.kind === "summary" ? summaries : body
    target.push(source.text.toLowerCase())
  }
  return { body, summaries }
}

function searchSourceDigest(value: string): string {
  return createHash("sha256").update(value, "utf16le").digest("hex")
}

const SEARCH_SOURCE_HASH_BASE = 16_777_619
const SEARCH_SOURCE_MAX_SCAN_UNITS = 4 * 1024 * 1024

function searchSourceRollingHash(value: string, length = value.length): number {
  let hash = 0
  for (let index = 0; index < length; index += 1) {
    hash = (Math.imul(hash, SEARCH_SOURCE_HASH_BASE) + value.charCodeAt(index)) >>> 0
  }
  return hash
}

function searchSourceHashFactor(length: number): number {
  let factor = 1
  let base = SEARCH_SOURCE_HASH_BASE
  for (let exponent = length - 1; exponent > 0; exponent = Math.floor(exponent / 2)) {
    if (exponent % 2) factor = Math.imul(factor, base)
    base = Math.imul(base, base)
  }
  return factor
}

export function rebindLegacyOverlapProof(proof: LegacyOverlapProof | null,
  previousIdentity: string, identity: string): LegacyOverlapProof | null {
  if (!proof || proof.identity !== previousIdentity || proof.identity === identity) return proof
  return { ...proof, identity, digest: searchSourceDigest(JSON.stringify([identity, proof.body, proof.summaries])) }
}

export function createLegacyOverlapProof(message: LegacyOverlapPayload, fragments: readonly string[] = []): LegacyOverlapProof | null {
  return prepareLegacyOverlap(message, fragments).proof()
}

function isSearchSourceProof(value: unknown): value is SearchSourceProof {
  const proof = value as Partial<SearchSourceProof> | null
  return Boolean(proof && Number.isSafeInteger(proof.length) && Number(proof.length) > 0 && typeof proof.digest === "string")
}

export const MAX_LEGACY_OVERLAP_PROOFS = 8

export function decodeLegacyOverlapProofs(raw: unknown): Array<LegacyOverlapProof | null> {
  const decoded = parseJsonValue(raw)
  if (!Array.isArray(decoded) || !decoded.length || decoded.length > MAX_LEGACY_OVERLAP_PROOFS + 1) return [null]
  return decoded.map((value) => value && typeof value.identity === "string" && typeof value.digest === "string" &&
    Array.isArray(value.body) && value.body.every(isSearchSourceProof) &&
    Array.isArray(value.summaries) && value.summaries.every(isSearchSourceProof) ? value : null)
}

function containsSearchSources(current: readonly string[], expected: readonly SearchSourceProof[]): boolean {
  const covered = new Map<number, Array<readonly [number, number]>>()
  let scanBudget = SEARCH_SOURCE_MAX_SCAN_UNITS
  let digestBudget = 64
  let attempts = 4096

  const available = (index: number, first: number, end: number) =>
    !covered.get(index)?.some(([left, right]) => first < right && end > left)

  function *matches(proof: SearchSourceProof): Generator<readonly [number, number, number]> {
    // Reserve exact blocks before considering a span inside a longer block.
    for (const exact of [true, false]) {
      for (const [index, text] of current.entries()) {
        if (text.length < proof.length || (text.length === proof.length) !== exact) continue
        if (available(index, 0, proof.length) && searchSourceDigest(text.slice(0, proof.length)) === proof.digest)
          yield [index, 0, proof.length]
      }
    }
    if (!Number.isSafeInteger(proof.rollingHash)) return
    const factor = searchSourceHashFactor(proof.length)
    for (const [index, text] of current.entries()) {
      if (text.length <= proof.length || text.length > scanBudget) continue
      scanBudget -= text.length
      let hash = searchSourceRollingHash(text, proof.length)
      for (let start = 1; start + proof.length <= text.length; start += 1) {
        const end = start + proof.length
        const remainder = hash - Math.imul(text.charCodeAt(start - 1), factor)
        hash = (Math.imul(remainder, SEARCH_SOURCE_HASH_BASE) + text.charCodeAt(end - 1)) >>> 0
        if (hash !== proof.rollingHash || !available(index, start, end)) continue
        if (digestBudget <= 0) return
        digestBudget -= 1
        if (searchSourceDigest(text.slice(start, end)) === proof.digest) yield [index, start, end]
      }
    }
  }

  function assign(offset: number): boolean {
    if (offset === expected.length) return true
    if (attempts <= 0) return false
    for (const [index, start, end] of matches(expected[offset])) {
      if (attempts <= 0) return false
      attempts -= 1
      const ranges = covered.get(index) ?? []
      ranges.push([start, end])
      covered.set(index, ranges)
      if (assign(offset + 1)) return true
      ranges.pop()
    }
    return false
  }

  return assign(0)
}

export function coversLegacyOverlap(message: LegacyOverlapPayload, fragments: readonly string[], proof: LegacyOverlapProof): boolean {
  return prepareLegacyOverlap(message, fragments).covers(proof)
}

export function prepareLegacyOverlap(message: LegacyOverlapPayload, fragments: readonly string[]): PreparedLegacyOverlap {
  const identity = legacyCheckpointProviderIdentity(message)
  const sources = overlapSearchSources(message, fragments)
  return {
    proof() {
      if (!sources) return null
      const toProofs = (texts: readonly string[]) => texts.map((text) => ({
        length: text.length, digest: searchSourceDigest(text), rollingHash: searchSourceRollingHash(text)
      }))
        .sort((a, b) => b.length - a.length || a.digest.localeCompare(b.digest))
      const body = toProofs(sources.body)
      const summaries = toProofs(sources.summaries)
      return { identity, body, summaries, digest: searchSourceDigest(JSON.stringify([identity, body, summaries])) }
    },
    covers(proof) {
      return Boolean(sources && identity === proof.identity && containsSearchSources(sources.body, proof.body) &&
        containsSearchSources(sources.summaries, proof.summaries))
    }
  }
}

export function ensureLegacyCheckpointSourceIds(
  run: (sql: string) => unknown,
  hasColumn: (table: string, column: string) => boolean
): void {
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_parents (
    thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, parent_checkpoint_id TEXT,
    PRIMARY KEY (thread_id, checkpoint_id)
  )`)
  run(`CREATE TRIGGER IF NOT EXISTS delete_legacy_checkpoint_transcript_parents AFTER DELETE ON threads
    BEGIN DELETE FROM legacy_checkpoint_transcript_parents WHERE thread_id = OLD.thread_id; END`)
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_sources (
    thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, verified_at INTEGER NOT NULL,
    transcript_revision TEXT,
    PRIMARY KEY (thread_id, checkpoint_id)
  )`)
  if (!hasColumn("legacy_checkpoint_transcript_sources", "transcript_revision")) {
    run("ALTER TABLE legacy_checkpoint_transcript_sources ADD COLUMN transcript_revision TEXT")
  }
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_source_ids (
    thread_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL, message_id TEXT NOT NULL,
    source_index INTEGER NOT NULL, content_key TEXT, physical_replay_key TEXT,
    PRIMARY KEY (thread_id, checkpoint_id, message_id)
  )`)
  if (!hasColumn("legacy_checkpoint_transcript_source_ids", "content_key")) {
    run("ALTER TABLE legacy_checkpoint_transcript_source_ids ADD COLUMN content_key TEXT")
  }
  if (!hasColumn("legacy_checkpoint_transcript_source_ids", "physical_replay_key")) {
    run("ALTER TABLE legacy_checkpoint_transcript_source_ids ADD COLUMN physical_replay_key TEXT")
  }
  if (!hasColumn("thread_messages", "fork_replay_key")) {
    run("ALTER TABLE thread_messages ADD COLUMN fork_replay_key TEXT")
  }
  run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_messages_fork_replay_key
    ON thread_messages(thread_id, fork_replay_key) WHERE fork_replay_key IS NOT NULL`)
  run(`CREATE TABLE IF NOT EXISTS thread_fork_replay_merges (
    thread_id TEXT NOT NULL REFERENCES threads(thread_id) ON DELETE CASCADE,
    source_key TEXT NOT NULL, target_key TEXT NOT NULL,
    PRIMARY KEY (thread_id, source_key)
  )`)
  run(`CREATE INDEX IF NOT EXISTS legacy_checkpoint_source_order
    ON legacy_checkpoint_transcript_source_ids (thread_id, checkpoint_id, source_index)`)
  run(`CREATE INDEX IF NOT EXISTS legacy_checkpoint_source_replay_key
    ON legacy_checkpoint_transcript_source_ids(thread_id, checkpoint_id, physical_replay_key)
    WHERE physical_replay_key IS NOT NULL`)
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_transcript_imports (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, content_key TEXT NOT NULL,
    previous_content_key TEXT, provider_content_key TEXT, payload_content_key TEXT,
    rewrite_progress TEXT, source_turn_key TEXT, partial_version INTEGER, owned_by_migration INTEGER NOT NULL DEFAULT 1,
    published_checkpoint_id TEXT, source_declared_occurrence INTEGER, merged_checkpoint_ids TEXT, field_content_keys TEXT,
    PRIMARY KEY (thread_id, message_id)
  )`)
  if (!hasColumn("legacy_checkpoint_transcript_imports", "previous_content_key"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN previous_content_key TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "provider_content_key"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN provider_content_key TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "payload_content_key"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN payload_content_key TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "rewrite_progress"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN rewrite_progress TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "source_turn_key"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN source_turn_key TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "partial_version"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN partial_version INTEGER")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "owned_by_migration"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN owned_by_migration INTEGER NOT NULL DEFAULT 1")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "published_checkpoint_id"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN published_checkpoint_id TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "source_declared_occurrence"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN source_declared_occurrence INTEGER")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "merged_checkpoint_ids"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN merged_checkpoint_ids TEXT")
  if (!hasColumn("legacy_checkpoint_transcript_imports", "field_content_keys"))
    run("ALTER TABLE legacy_checkpoint_transcript_imports ADD COLUMN field_content_keys TEXT")
  for (const [event, row] of [["INSERT", "NEW"], ["DELETE", "OLD"]]) {
    run(`CREATE TRIGGER IF NOT EXISTS legacy_native_publication_${event.toLowerCase()}
      AFTER ${event} ON thread_messages BEGIN
        DELETE FROM legacy_checkpoint_transcript_imports
          WHERE thread_id = ${row}.thread_id AND message_id = ${row}.message_id AND owned_by_migration = 0;
      END`)
  }
  run(`CREATE INDEX IF NOT EXISTS idx_legacy_checkpoint_active_rewrites
    ON legacy_checkpoint_transcript_imports(thread_id, message_id) WHERE rewrite_progress IS NOT NULL`)
  run(`CREATE INDEX IF NOT EXISTS idx_legacy_checkpoint_partial_imports
    ON legacy_checkpoint_transcript_imports(thread_id, message_id) WHERE partial_version IS NOT NULL`)
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_retired_fragments (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, generation TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id, generation)
  )`)
  run(`CREATE TRIGGER IF NOT EXISTS delete_legacy_checkpoint_retired_fragments AFTER DELETE ON threads
    BEGIN DELETE FROM legacy_checkpoint_retired_fragments WHERE thread_id = OLD.thread_id; END`)
  run(`CREATE TABLE IF NOT EXISTS legacy_checkpoint_search_overlaps (
    thread_id TEXT NOT NULL, message_id TEXT NOT NULL, message_version INTEGER NOT NULL,
    structure_epoch INTEGER NOT NULL DEFAULT 0, projection_proof TEXT,
    PRIMARY KEY (thread_id, message_id)
  )`)
  if (!hasColumn("legacy_checkpoint_search_overlaps", "projection_proof")) {
    run("ALTER TABLE legacy_checkpoint_search_overlaps ADD COLUMN projection_proof TEXT")
  }
  if (!hasColumn("legacy_checkpoint_search_overlaps", "structure_epoch")) {
    run("ALTER TABLE legacy_checkpoint_search_overlaps ADD COLUMN structure_epoch INTEGER NOT NULL DEFAULT 0")
  }
  run(`CREATE TRIGGER IF NOT EXISTS delete_legacy_checkpoint_transcript_sources AFTER DELETE ON threads
    BEGIN
      DELETE FROM legacy_checkpoint_transcript_sources WHERE thread_id = OLD.thread_id;
      DELETE FROM legacy_checkpoint_transcript_source_ids WHERE thread_id = OLD.thread_id;
      DELETE FROM legacy_checkpoint_transcript_imports WHERE thread_id = OLD.thread_id;
    END`)
  run(`CREATE TRIGGER IF NOT EXISTS delete_legacy_checkpoint_search_overlaps AFTER DELETE ON threads
    BEGIN
      DELETE FROM legacy_checkpoint_search_overlaps WHERE thread_id = OLD.thread_id;
    END`)
}
