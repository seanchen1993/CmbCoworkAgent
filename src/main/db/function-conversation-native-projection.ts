import { createHash } from "node:crypto"
import { types } from "node:util"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { matchesThreadIncarnation, type ThreadIncarnation } from "../services/thread-incarnation"
import type { FunctionConversationRef, FunctionConversationRow } from "./function-conversation-store"
import { FUNCTION_CONVERSATION_PROJECTION_COLUMNS, functionConversationProjectionStamp,
  readFunctionConversationRawProjection, readFunctionConversationProjectionReceipt,
  type FunctionConversationProjectionColumns } from "./function-conversation-projection-receipt"
import type { NativeSqliteAdapter, NativeSqliteValue } from "./native-sqlite-adapter"
import { readFunctionNativeFinalExecution,
  type FunctionNativeFinalExecutionReceipt } from "./function-conversation-final-execution"
import { readStoredFunctionConversationProjection,
  withFunctionConversationProjectionReadScope } from "./function-conversation-projection-read"
import { assertFunctionNativeHumanProjectionVariant,
  functionNativeHumanProjectionFreshColumns, functionNativeHumanProjectionKind,
  type FunctionNativeHumanProjectionVariant } from "./function-conversation-native-human-projection"
import { assertFunctionNativeToolSideProjection, assertFunctionNativeToolSideProjectionFresh,
  type FunctionNativeToolSideProjection } from "./function-conversation-native-tool-side-projection"

declare const receiptBrand: unique symbol
declare const claimBrand: unique symbol
export interface FunctionNativeProjectionReceipt { readonly [receiptBrand]: true }
export interface FunctionNativeProjectionClaim { readonly [claimBrand]: true }
export interface FunctionNativeProjectionFacts {
  readonly uuid: string
  readonly role: "user" | "assistant" | "system" | "tool"
  readonly providerSourceId: string
  readonly providerOccurrence: number
  readonly toolCallId?: string
  readonly status?: string
  readonly name?: string
}
export interface FunctionNativeProjectionBinding {
  readonly facts: FunctionNativeProjectionFacts
  seal(): void
  flush(): void | Promise<void>
  captureAliases(): object
  /** Check the same producer source, cancellation and destination identity in full before aliases. */
  assertAliases(receipt: object): void
  /** Only an actual model-return factory can supply this private candidate receipt. */
  finalExecution?(row: FunctionConversationRow): FunctionNativeFinalExecutionReceipt
}
export interface FunctionNativeProjectionPreparation {
  readonly kind: "insert" | "adopt"
  readonly expected: FunctionConversationProjectionColumns
  readonly original: FunctionConversationProjectionColumns | undefined
  readonly facts: FunctionNativeProjectionFacts
  readonly claim: FunctionNativeProjectionClaim
}
type SqlRow = Record<string, NativeSqliteValue>
interface Baseline {
  readonly columns: FunctionConversationProjectionColumns | undefined
  readonly fragments: readonly SqlRow[]
  readonly state: SqlRow | undefined
}
interface Captured {
  readonly occurrence: object
  readonly binding: FunctionNativeProjectionBinding
  readonly facts: FunctionNativeProjectionFacts
  readonly aliases: object
  baseline: Baseline | undefined
  prepared: boolean
  released: boolean
}
interface Prepared {
  readonly captured: Captured
  readonly row: FunctionConversationRow
  readonly expectedDigest: string
  readonly finalExecution?: FunctionNativeFinalExecutionReceipt
  claimed: boolean
}

function fail(code = "MODS_CONVERSATION_PROJECTION_CONFLICT"): never {
  throw new ModFunctionError(code)
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value) fail()
  return value
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail()
  return value
}
function query(db: NativeSqliteAdapter, sql: string, args: readonly unknown[] = []): SqlRow[] {
  const result = db.exec(sql, args)[0]
  return result ? result.values.map(values => Object.fromEntries(
    result.columns.map((name, index) => [name, values[index]]))) : []
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}
function sync(operation: () => void): void {
  const result: unknown = operation()
  if (result && typeof (result as { then?: unknown }).then === "function")
    fail("MODS_CONVERSATION_ASYNC_TRANSACTION")
}
function copyData(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))) return value
  if (!value || typeof value !== "object" || types.isProxy(value) || ancestors.has(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) fail()
  ancestors.add(value)
  try {
    const result: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : {}
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === "length") continue
      if (typeof key !== "string") fail()
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
      Object.defineProperty(result, key, { value: copyData(descriptor.value, ancestors),
        enumerable: true, writable: false, configurable: false })
    }
    return Object.freeze(result)
  } finally { ancestors.delete(value) }
}
function pinRef(value: FunctionConversationRef): FunctionConversationRef {
  const copied = copyData(value) as FunctionConversationRef
  for (const key of ["logicalSessionId", "conversationId", "branchId", "threadId", "workspace"])
    text(Object.getOwnPropertyDescriptor(copied, key)?.value)
  if (typeof copied.checkpointNamespace !== "string" ||
    !["main", "child"].includes(copied.kind)) fail()
  integer(copied.incarnation.legacyCreatedAt)
  if (copied.incarnation.token !== null) text(copied.incarnation.token)
  return copied
}
function sameRef(a: FunctionConversationRef, b: FunctionConversationRef): boolean {
  return a.logicalSessionId === b.logicalSessionId && a.conversationId === b.conversationId &&
    a.branchId === b.branchId && a.threadId === b.threadId && a.workspace === b.workspace &&
    a.kind === b.kind && a.checkpointNamespace === b.checkpointNamespace &&
    a.incarnation.token === b.incarnation.token &&
    a.incarnation.legacyCreatedAt === b.incarnation.legacyCreatedAt
}
function pinColumns(input: FunctionConversationProjectionColumns): FunctionConversationProjectionColumns {
  if (!input || typeof input !== "object" || types.isProxy(input) ||
    Reflect.ownKeys(input).length !== FUNCTION_CONVERSATION_PROJECTION_COLUMNS.length) fail()
  const result = {} as Record<typeof FUNCTION_CONVERSATION_PROJECTION_COLUMNS[number], NativeSqliteValue>
  for (const key of FUNCTION_CONVERSATION_PROJECTION_COLUMNS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) fail()
    const value: unknown = descriptor.value
    if (!(value === null || typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value)))) fail()
    result[key] = value
  }
  integer(result.ordinal); integer(result.created_at)
  if (integer(result.stream_authority) > 7) fail()
  if (result.provider_occurrence !== null && integer(result.provider_occurrence) < 1) fail()
  for (const key of ["start_at", "end_at"] as const)
    if (result[key] !== null) integer(result[key])
  for (const key of ["is_error", "recovery_integrity"] as const)
    if (result[key] !== null && result[key] !== 0 && result[key] !== 1) fail()
  for (const key of ["content_json", "prompt_origin_json", "function_row_json", "tool_calls_json"] as const) {
    const encoded = result[key]
    if (encoded !== null) {
      if (typeof encoded !== "string") fail()
      try { JSON.parse(encoded) } catch { fail() }
    }
  }
  if (typeof result.content_json !== "string" || typeof result.function_row_json !== "string") fail()
  const content: unknown = JSON.parse(result.content_json)
  if (!(typeof content === "string" || Array.isArray(content))) fail()
  for (const key of ["provider_source_id", "reasoning", "tool_call_id", "name", "status",
    "goal_id", "active_window_id"] as const)
    if (result[key] !== null && typeof result[key] !== "string") fail()
  if (result.content_priority !== null && (typeof result.content_priority !== "number" ||
    result.content_priority <= 0)) fail()
  return Object.freeze(result)
}
function digest(columns: FunctionConversationProjectionColumns): string {
  return hash(JSON.stringify(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key => columns[key])))
}
function parts(db: NativeSqliteAdapter, threadId: string, uuid: string) {
  const fragments = query(db, `SELECT * FROM thread_message_fragments
    WHERE thread_id=? AND message_id=? ORDER BY fragment_id`, [threadId, uuid])
  for (const row of fragments) {
    if (Object.keys(row).length !== 5 || row.thread_id !== threadId || row.message_id !== uuid ||
      typeof row.content_text !== "string") fail()
    integer(row.fragment_id); integer(row.created_at)
    Object.freeze(row)
  }
  const states = query(db, `SELECT * FROM thread_message_fragment_states
    WHERE thread_id=? AND message_id=?`, [threadId, uuid])
  if (states.length > 1) fail()
  const state = states[0]
  if (state) {
    if (Object.keys(state).length !== 4 || state.thread_id !== threadId || state.message_id !== uuid) fail()
    integer(state.total_chars); integer(state.updated_at); Object.freeze(state)
  }
  return { fragments: Object.freeze(fragments), state }
}
function sameBaseline(a: Baseline, b: Baseline): boolean {
  return (a.columns ? !!b.columns && digest(a.columns) === digest(b.columns) : !b.columns) &&
    JSON.stringify(a.fragments) === JSON.stringify(b.fragments) &&
    JSON.stringify(a.state) === JSON.stringify(b.state)
}

/** The caller is a real producer factory. No JSON field can create occurrence or alias provenance. */
export function createFunctionConversationNativeProjectionAccess(input: {
  readonly database: NativeSqliteAdapter
  readonly target: FunctionConversationRef
  readonly threadId: string
  readonly incarnation: ThreadIncarnation
  readonly producer: object
  readonly run: object
  readonly signal: AbortSignal
  /** Only the actual input presentation factory can mint this private adapter. */
  readonly humanProjection?: FunctionNativeHumanProjectionVariant
  readonly toolSideProjection?: FunctionNativeToolSideProjection
  assertCurrent(): void
  bindOccurrence(occurrence: object): FunctionNativeProjectionBinding
}) {
  const database = input.database, target = pinRef(input.target), threadId = text(input.threadId)
  const incarnation = copyData(input.incarnation) as ThreadIncarnation
  const signal = input.signal, guardSource = input.assertCurrent.bind(input)
  const bindOccurrence = input.bindOccurrence.bind(input)
  const producer = input.producer, run = input.run
  const humanProjection = input.humanProjection
  const toolSideProjection = input.toolSideProjection
  if (humanProjection && toolSideProjection) fail()
  if (!producer || typeof producer !== "object" || types.isProxy(producer) || !run ||
    typeof run !== "object" || types.isProxy(run)) fail()
  integer(incarnation.legacyCreatedAt)
  if (incarnation.token !== null) text(incarnation.token)
  if (target.kind === "main" ? threadId !== target.threadId : threadId === target.threadId) fail()
  const once = new WeakMap<object, Promise<FunctionNativeProjectionReceipt>>()
  const receipts = new WeakMap<FunctionNativeProjectionReceipt, Captured>()
  const claims = new WeakMap<FunctionNativeProjectionClaim, Prepared>()
  const verifying = new WeakSet<Prepared>()
  const failedVerifications = new WeakSet<Prepared>()
  let closed = false, held = 0
  const guard = () => {
    sync(guardSource)
    if (signal.aborted) fail("MODS_CONVERSATION_SOURCE_RETIRED")
    const row = query(database, "SELECT created_at,metadata FROM threads WHERE thread_id=?", [threadId])[0]
    if (!row || !matchesThreadIncarnation({ created_at: Number(row.created_at),
      metadata: typeof row.metadata === "string" ? row.metadata : null }, incarnation))
      fail("MODS_CONVERSATION_THREAD_CHANGED")
  }
  const read = (facts: FunctionNativeProjectionFacts): Baseline => {
    const columns = readFunctionConversationRawProjection(database, threadId, facts.uuid)
    if (columns) {
      if (columns.function_row_json !== null) fail("MODS_CONVERSATION_MIGRATION_REQUIRED")
      assertFacts(columns, facts)
    }
    const fragments = parts(database, threadId, facts.uuid)
    if (!columns && (fragments.fragments.length || fragments.state)) fail()
    return { columns, ...fragments }
  }
  const assertProvider = (facts: FunctionNativeProjectionFacts) => {
    if (query(database, `SELECT message_id FROM thread_messages WHERE thread_id=? AND role=?
      AND COALESCE(provider_source_id,message_id)=? AND COALESCE(provider_occurrence,1)=?
      AND message_id<>? LIMIT 1`, [threadId, facts.role, facts.providerSourceId,
      facts.providerOccurrence, facts.uuid]).length) fail()
  }
  function assertFacts(columns: FunctionConversationProjectionColumns, facts: FunctionNativeProjectionFacts) {
    if (columns.thread_id !== threadId || columns.message_id !== facts.uuid || columns.role !== facts.role ||
      (columns.provider_source_id ?? facts.uuid) !== facts.providerSourceId ||
      (columns.provider_occurrence ?? 1) !== facts.providerOccurrence ||
      columns.tool_call_id !== (facts.toolCallId ?? null) || columns.status !== (facts.status ?? null) ||
      columns.name !== (facts.name ?? null)) fail()
  }
  const assertHuman = (captured: Captured, row?: FunctionConversationRow) => {
    if (!humanProjection) return
    if (captured.facts.role !== "user" || captured.binding.finalExecution) fail()
    assertFunctionNativeHumanProjectionVariant(humanProjection, {
      producer, run, occurrence: captured.occurrence, target, threadId, uuid: captured.facts.uuid
    }, row)
  }
  const humanFresh = (captured: Captured) => humanProjection
    ? functionNativeHumanProjectionFreshColumns(humanProjection, {
      producer, run, occurrence: captured.occurrence, target, threadId, uuid: captured.facts.uuid
    }, captured.baseline?.columns) : undefined
  const assertToolSide = (captured: Captured, row?: FunctionConversationRow) => {
    if (!toolSideProjection) return
    assertFunctionNativeToolSideProjection(toolSideProjection, {
      producer, run, occurrence: captured.occurrence, target, threadId,
      uuid: captured.facts.uuid, role: captured.facts.role
    }, row)
  }
  const assertFreshToolSide = (captured: Captured) => {
    if (!toolSideProjection) return
    assertFunctionNativeToolSideProjectionFresh(toolSideProjection, {
      producer, run, occurrence: captured.occurrence, target, threadId,
      uuid: captured.facts.uuid, role: captured.facts.role
    }, captured.baseline?.columns)
  }
  const capturedGuard = (captured: Captured) => {
    assertHuman(captured)
    assertToolSide(captured)
    sync(() => captured.binding.assertAliases(captured.aliases))
    assertProvider(captured.facts); guard()
    assertHuman(captured)
    assertToolSide(captured)
  }
  const baselineGuard = (captured: Captured) => {
    capturedGuard(captured)
    if (!captured.baseline || !sameBaseline(captured.baseline, read(captured.facts))) fail()
    capturedGuard(captured)
  }
  const release = (captured: Captured) => {
    if (!captured.released) { captured.released = true; held -= 1 }
  }
  const actualExpected = (prepared: Prepared) => {
    capturedGuard(prepared.captured)
    assertFinal(prepared)
    const actual = readFunctionConversationRawProjection(database, threadId, prepared.row.uuid)
    const stream = parts(database, threadId, prepared.row.uuid)
    if (!actual || digest(actual) !== prepared.expectedDigest || stream.fragments.length || stream.state) fail()
    capturedGuard(prepared.captured)
    return actual
  }
  const getClaim = (claim: FunctionNativeProjectionClaim) => {
    const prepared = claims.get(claim)
    if (!prepared) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
    return prepared
  }
  const finalColumns = (receipt: FunctionNativeFinalExecutionReceipt, captured: Captured,
    row: FunctionConversationRow) => readFunctionNativeFinalExecution(receipt, {
      producer, run, occurrence: captured.occurrence, target, uuid: row.uuid,
      nativePayload: row.nativePayload
    })
  const assertFinal = (prepared: Prepared) => {
    assertHuman(prepared.captured, prepared.row)
    assertToolSide(prepared.captured, prepared.row)
    if (prepared.finalExecution) finalColumns(prepared.finalExecution, prepared.captured, prepared.row)
  }
  guard()
  return Object.freeze({
    capture(occurrence: object): Promise<FunctionNativeProjectionReceipt> {
      const prior = once.get(occurrence)
      if (prior) return prior
      if (closed || !occurrence || typeof occurrence !== "object" || held >= 256)
        return Promise.reject(new ModFunctionError("MODS_CONVERSATION_PROJECTION_UNAVAILABLE"))
      let resolve!: (receipt: FunctionNativeProjectionReceipt) => void
      let reject!: (error: unknown) => void
      const promise = new Promise<FunctionNativeProjectionReceipt>((yes, no) => { resolve = yes; reject = no })
      once.set(occurrence, promise); held += 1
      let binding: FunctionNativeProjectionBinding, facts: FunctionNativeProjectionFacts
      try {
        guard()
        const original = bindOccurrence(occurrence)
        if (!original || typeof original !== "object" || types.isProxy(original)) fail()
        const descriptor = Object.getOwnPropertyDescriptor(original, "facts")
        if (!descriptor || !("value" in descriptor)) fail()
        facts = copyData(descriptor.value) as FunctionNativeProjectionFacts
        const method = <K extends "seal" | "flush" | "captureAliases" | "assertAliases">(key: K):
          FunctionNativeProjectionBinding[K] => {
          const field = Object.getOwnPropertyDescriptor(original, key)
          if (!field || !("value" in field) || typeof field.value !== "function") fail()
          return field.value.bind(original) as FunctionNativeProjectionBinding[K]
        }
        const finalField = Object.getOwnPropertyDescriptor(original, "finalExecution")
        if (finalField && (!("value" in finalField) || typeof finalField.value !== "function")) fail()
        binding = Object.freeze({ facts, seal: method("seal"), flush: method("flush"),
          captureAliases: method("captureAliases"), assertAliases: method("assertAliases"),
          ...(finalField ? { finalExecution: finalField.value.bind(original) as
            NonNullable<FunctionNativeProjectionBinding["finalExecution"]> } : {}) })
        text(facts.uuid); text(facts.providerSourceId)
        if (!facts.providerOccurrence || !["user", "assistant", "system", "tool"].includes(facts.role)) fail()
        integer(facts.providerOccurrence)
        for (const key of ["toolCallId", "status", "name"] as const)
          if (facts[key] !== undefined) text(facts[key])
        if (facts.role === "tool" && !facts.toolCallId) fail()
        sync(() => binding.seal())
      } catch (error) { held -= 1; reject(error); return promise }
      let work: void | Promise<void>
      try { work = binding.flush() } catch (error) { held -= 1; reject(error); return promise }
      Promise.resolve(work).then(() => {
        guard()
        const aliases = binding.captureAliases()
        if (!aliases || typeof aliases !== "object") fail()
        const captured: Captured = { occurrence, binding, facts, aliases, baseline: undefined,
          prepared: false, released: false }
        capturedGuard(captured); captured.baseline = read(facts); baselineGuard(captured)
        assertFreshToolSide(captured)
        const fresh = humanFresh(captured)
        if (humanProjection && !captured.baseline.columns && !fresh)
          fail("MODS_CONVERSATION_HUMAN_WRITE_INTENT_REQUIRED")
        const receipt = Object.freeze({}) as FunctionNativeProjectionReceipt
        receipts.set(receipt, captured); resolve(receipt)
      }).catch(error => { held -= 1; reject(error) })
      return promise
    },
    prepare(receipt: FunctionNativeProjectionReceipt, request: {
      readonly database: NativeSqliteAdapter
      readonly target: FunctionConversationRef
      readonly row: FunctionConversationRow
      readonly protectedColumns: FunctionConversationProjectionColumns
    }): FunctionNativeProjectionPreparation {
      const captured = receipts.get(receipt)
      if (closed || !captured || captured.prepared || !captured.baseline)
        fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      captured.prepared = true
      const ref = pinRef(request.target), row = copyData(request.row) as FunctionConversationRow
      const columns = pinColumns(request.protectedColumns)
      if (request.database !== database || !database.inTransaction || !sameRef(ref, target) ||
        row.uuid !== captured.facts.uuid || row.branchId !== target.branchId) fail()
      baselineGuard(captured); assertFacts(columns, captured.facts)
      assertHuman(captured, row)
      assertToolSide(captured, row)
      assertFreshToolSide(captured)
      if (columns.function_row_json !== JSON.stringify(functionConversationProjectionStamp(target, row))) fail()
      const baseline = captured.baseline.columns
      const freshHuman = humanFresh(captured)
      let execution: FunctionNativeFinalExecutionReceipt | undefined
      let final: Readonly<{ tool_calls_json: string | null }> | undefined
      if (captured.binding.finalExecution) {
        execution = captured.binding.finalExecution(row)
        final = finalColumns(execution, captured, row)
      }
      let expected = columns
      if (baseline) {
        const changes = new Set(humanProjection
          ? ["content_json", "function_row_json"]
          : ["content_json", "reasoning", "is_error", "content_priority",
            "stream_authority", "recovery_integrity", "function_row_json"])
        expected = Object.freeze(Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key =>
          [key, changes.has(key) ? columns[key] : baseline[key]]))) as FunctionConversationProjectionColumns
        if (humanProjection) expected = Object.freeze({ ...expected,
          recovery_integrity: baseline.recovery_integrity === 1 && columns.recovery_integrity === 1
            ? 1 : baseline.recovery_integrity === null ? null : 0 })
      } else {
        if (humanProjection) {
          if (!freshHuman) fail("MODS_CONVERSATION_HUMAN_WRITE_INTENT_REQUIRED")
          const toolSide = functionNativeHumanProjectionKind(humanProjection) === "tool-side"
          expected = Object.freeze(Object.fromEntries(FUNCTION_CONVERSATION_PROJECTION_COLUMNS.map(key =>
            [key, key === "function_row_json" || key === "ordinal" || toolSide &&
              (key === "content_json" || key === "created_at" || key === "recovery_integrity")
              ? columns[key] : key === "content_json" ? JSON.stringify("")
                : key === "recovery_integrity" ? 0 : freshHuman[key]]))) as
            FunctionConversationProjectionColumns
          if (toolSide && (expected.created_at !== row.createdAt ||
            expected.recovery_integrity !== 0 && expected.recovery_integrity !== 1)) fail()
        }
        const ordinal = integer(expected.ordinal)
        const bucket = query(database, "SELECT next_ordinal FROM thread_message_buckets WHERE thread_id=?", [threadId])[0]
        const maximum = query(database, "SELECT COALESCE(MAX(ordinal),-1) AS ordinal FROM thread_messages WHERE thread_id=?", [threadId])[0]
        if (!bucket || bucket.next_ordinal !== ordinal || !maximum ||
          typeof maximum.ordinal !== "number" || ordinal < maximum.ordinal + 1) fail()
      }
      if (final) expected = Object.freeze({ ...expected, tool_calls_json: final.tool_calls_json })
      baselineGuard(captured)
      assertHuman(captured, row)
      assertToolSide(captured, row)
      if (!database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
      const claim = Object.freeze({}) as FunctionNativeProjectionClaim
      claims.set(claim, { captured, row, expectedDigest: digest(expected),
        ...(execution ? { finalExecution: execution } : {}), claimed: false })
      return Object.freeze({ kind: baseline ? "adopt" : "insert", expected, original: baseline,
        facts: captured.facts, claim })
    },
    claim(claim: FunctionNativeProjectionClaim): void {
      const prepared = getClaim(claim)
      if (prepared.claimed || closed || !database.inTransaction)
        fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      prepared.claimed = true
      assertFinal(prepared)
      baselineGuard(prepared.captured)
      if (!database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
    },
    assertPrepared(claim: FunctionNativeProjectionClaim): void {
      const prepared = getClaim(claim)
      if (!prepared.claimed) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      assertFinal(prepared)
      capturedGuard(prepared.captured)
      const current = readFunctionConversationRawProjection(database, threadId, prepared.row.uuid)
      if (current && digest(current) === prepared.expectedDigest) actualExpected(prepared)
      else baselineGuard(prepared.captured)
    },
    verify(claim: FunctionNativeProjectionClaim): void {
      const prepared = getClaim(claim)
      if (!prepared.claimed) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      if (verifying.has(prepared)) {
        failedVerifications.add(prepared)
        fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      }
      if (failedVerifications.has(prepared)) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
      if (database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
      verifying.add(prepared)
      try {
        let expectedChecked = false
        withFunctionConversationProjectionReadScope(database, scope => {
          const columns = readStoredFunctionConversationProjection(database, { threadId, incarnation,
            messageId: prepared.row.uuid, assertCurrent() {
              capturedGuard(prepared.captured)
              assertFinal(prepared)
              // Keep the original expected-row/empty-fragments check before seal decoding.
              // The seal's two full guards and final callback-free B read cover this exact
              // synchronous verification; no successful authority survives into another call.
              if (!expectedChecked) {
                const actual = readFunctionConversationRawProjection(database, threadId, prepared.row.uuid)
                const stream = parts(database, threadId, prepared.row.uuid)
                if (!actual || digest(actual) !== prepared.expectedDigest || stream.fragments.length || stream.state) fail()
                expectedChecked = true
              }
            } }, scope)
          // The private prepared row is the expected canonical source. These final reads contain
          // no source callbacks; the scope then rereads every raw field and the ledger at B.
          const actual = readFunctionConversationProjectionReceipt(database, {
            target, row: prepared.row, threadId, incarnation, assertCurrent: () => undefined })
          if (digest(columns) !== prepared.expectedDigest || digest(actual) !== prepared.expectedDigest)
            fail()
          if (closed || signal.aborted || database.inTransaction)
            fail("MODS_CONVERSATION_NOT_COMMITTED")
          if (failedVerifications.has(prepared)) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
        })
        if (closed || signal.aborted) fail("MODS_CONVERSATION_SOURCE_RETIRED")
        if (database.inTransaction) fail("MODS_CONVERSATION_NOT_COMMITTED")
        if (!verifying.has(prepared) || failedVerifications.has(prepared) ||
          claims.get(claim) !== prepared) fail("MODS_CONVERSATION_PROJECTION_CLAIM")
        prepared.captured.baseline = undefined
        release(prepared.captured)
      } catch (error) {
        failedVerifications.add(prepared)
        throw error
      } finally {
        verifying.delete(prepared)
      }
    },
    close(): void { closed = true }
  })
}
