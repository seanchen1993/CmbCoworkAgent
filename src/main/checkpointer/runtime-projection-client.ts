import { types as nodeTypes } from "node:util"
import { validateFunctionConversationTranscriptStamp } from "../../shared/mods/v2/conversation-transcript"
import type { Worker } from "node:worker_threads"
import type { LegacyTranscriptWriter } from "./legacy-transcript-main-writer"
import type { LegacyTranscriptWriteMessage } from "./legacy-transcript-write-protocol"
import type { CanonicalCheckpointDisplaySelection } from "./function-conversation-canonical-display-worker"
import { existsSync } from "node:fs"
import type {
  CheckpointDatabaseIdentity,
  CheckpointDatabaseFileIdentity
} from "./checkpoint-database-identity"
import type {
  FunctionSessionCheckpoint,
  FunctionSessionMessagePage,
  FunctionSessionPageInput
} from "../../shared/mods/v2/session"
import type {
  PreparedNativeDataSource,
  PreparedNativeDataFacts,
  PreparedNativeSourceRequest,
  PreparedNativeSourceResponse,
  CheckpointRuntimeProjectionStats,
  LegacyCheckpointTranscriptMigrationStats,
  CheckpointRuntimeProjectionWorkerResponse,
  CheckpointRuntimeProjectionWorkerRequest
} from "./runtime-projection-protocol"
import {
  runCheckpointDatabaseOperation,
  runCheckpointDatabaseMaintenance
} from "./checkpoint-database-admission"
import {
  resolveCheckpointDatabaseIdentity,
  assertCheckpointDatabaseFileIdentity,
  assertCheckpointDatabasePathCurrent
} from "./checkpoint-database-identity"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY,
  CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS
} from "./runtime-projection-protocol"

type RuntimeProjectionWorkerFactory = () => Promise<Worker>
type RequestInput<T> = T extends { requestId: number }
  ? Omit<T, "requestId" | "cancellationBuffer" | "legacyWriter">
  : never
type ProjectionRequestInput = RequestInput<CheckpointRuntimeProjectionWorkerRequest>

/** Main-only fixed writer context; this argument never grants native history authority. */
export interface LegacyTranscriptWriterRequestContext {
  readonly actualWorker: Worker
  readonly workerGeneration: number
  readonly requestId: number
  readonly threadId: string
  readonly checkpointNamespace: string
}
export interface LegacyCheckpointTranscriptHostSource {
  readonly assertCurrent: () => void
  readonly createWriter: (context: LegacyTranscriptWriterRequestContext) => LegacyTranscriptWriter
}

/** Captured by a ready native Saver before releasing its first short read lease. */
export interface CheckpointRuntimeProjectionSource {
  readonly identity: CheckpointDatabaseIdentity
  readonly file: CheckpointDatabaseFileIdentity
  readonly assertCurrent: () => void
}

interface PendingRequest {
  worker?: Worker
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  cancellation?: Int32Array
  bootstrapThreadId?: string
  foregroundKey?: string
  assertSource?: () => void
  verifyDisplay?: (tuple: unknown) => unknown
  verifyFile?: () => Promise<void>
}

interface PhysicalRequest {
  readonly requestId: number
  readonly type: ProjectionRequestInput["type"]
  readonly admission: AbortController
  readonly cancellation: Int32Array
  readonly ioDone: Promise<void>
  readonly settled: Promise<void>
  resolveIo(): void
  resolveSettled(): void
  worker?: Worker
  workerGeneration?: number
  writer?: LegacyTranscriptWriter
  writerApi?: typeof import("./legacy-transcript-main-writer")
  posted: boolean
  responseReceived?: boolean
  cancelled: boolean
  ioLeaseDone?: Promise<void>
  finishing?: Promise<void>
  preparedSource?: () => PreparedNativeDataSource
  preparedPulled?: boolean
  preparedSourcePosted?: boolean
  preparedFlight?: Promise<void>
  assertPreparedSource?: () => void
  verifyPreparedFile?: () => Promise<void>
}

interface ProjectionRequestOptions {
  cancellable?: boolean
  bootstrapThreadId?: string
  foregroundKey?: string
  signal?: AbortSignal
  assertSource?: () => void
  verifyDisplay?: (tuple: unknown) => unknown
  checkpointSource?: CheckpointRuntimeProjectionSource
  legacySource?: LegacyCheckpointTranscriptHostSource
  readPreparedSource?: () => PreparedNativeDataSource
  awaitPhysical?: boolean
}

export interface LegacyCheckpointTranscriptBootstrapResult {
  runtimeTuple: unknown | null
  stats: LegacyCheckpointTranscriptMigrationStats
}

function emptyLegacyCheckpointBootstrapResult(): LegacyCheckpointTranscriptBootstrapResult {
  return {
    runtimeTuple: null,
    stats: {
      checkpointId: null,
      totalMessages: 0,
      migratedMessages: 0,
      batches: 0,
      payloadBytes: 0
    }
  }
}

const factsDefine = Object.defineProperty
const factsOwn = Object.getOwnPropertyDescriptor,
  factsKeys = Reflect.ownKeys
const factsPrototype = Object.getPrototypeOf,
  factsObjectPrototype = Object.prototype
const factsArrayPrototype = Array.prototype,
  factsArray = Array.isArray
const factsCreate = Object.create,
  factsFreeze = Object.freeze,
  factsSafeInteger = Number.isSafeInteger
const factsIsProxy = nodeTypes.isProxy
const factsValidateStamp: typeof validateFunctionConversationTranscriptStamp =
  validateFunctionConversationTranscriptStamp
function factsFailure(): never {
  throw Error("PREPARED_NATIVE_FACTS_INVALID")
}
function factsField(value: object, name: string): unknown {
  const field = factsOwn(value, name)
  if (!field || !("value" in field) || !field.enumerable) factsFailure()
  return field.value
}
function factsRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): object {
  if (
    !value ||
    typeof value !== "object" ||
    factsIsProxy(value) ||
    factsArray(value) ||
    (factsPrototype(value) !== factsObjectPrototype && factsPrototype(value) !== null)
  )
    factsFailure()
  const names = factsKeys(value)
  for (let index = 0; index < names.length; index++) {
    const name = names[index]
    if (typeof name !== "string") factsFailure()
    let allowed = false
    for (let field = 0; field < required.length; field++)
      if (required[field] === name) allowed = true
    for (let field = 0; field < optional.length; field++)
      if (optional[field] === name) allowed = true
    if (!allowed) factsFailure()
    factsField(value, name)
  }
  for (let index = 0; index < required.length; index++) factsField(value, required[index])
  return value
}
function factsString(value: unknown): string {
  if (typeof value !== "string" || !value) factsFailure()
  return value
}
function factsInteger(value: unknown): number {
  if (typeof value !== "number" || !factsSafeInteger(value) || value < 0) factsFailure()
  return value
}
function factsParent(value: unknown): string | null {
  return value === null ? null : factsString(value)
}
function factsList<T>(value: unknown, read: (item: unknown) => T): readonly T[] {
  if (
    !value ||
    typeof value !== "object" ||
    factsIsProxy(value) ||
    !factsArray(value) ||
    factsPrototype(value) !== factsArrayPrototype
  )
    factsFailure()
  const length = factsInteger(factsOwn(value, "length")?.value)
  if (factsKeys(value).length !== length + 1) factsFailure()
  const result: T[] = []
  for (let index = 0; index < length; index++) {
    const descriptor = factsCreate(null) as PropertyDescriptor
    descriptor.value = read(factsField(value, `${index}`))
    descriptor.enumerable = true
    descriptor.writable = false
    descriptor.configurable = false
    factsDefine(result, `${index}`, descriptor)
  }
  return factsFreeze(result)
}
type OwnedPreparedFacts = Omit<PreparedNativeDataFacts, "stamped"> & {
  readonly stamped: readonly { readonly ordinal: number; readonly stamp: unknown }[]
}
function validateOwnedFactStamps(value: OwnedPreparedFacts): asserts value is PreparedNativeDataFacts {
  for (let index = 0; index < value.stamped.length; index++)
    factsValidateStamp(value.stamped[index].stamp)
}
/** Own compact data before any await or another message listener can mutate the event object. */
function capturePreparedFacts(input: unknown): PreparedNativeDataFacts {
  const raw = factsRecord(input, [
    "checkpointId",
    "parentCheckpointId",
    "checkpointTs",
    "state",
    "stateDigest",
    "nativeMessageCount",
    "nativeSnapshotDigest",
    "stamped",
    "chainSeal",
    "sealedPlanDigest"
  ])
  const state = factsRecord(factsField(raw, "state"), [
    "version",
    "logicalSessionId",
    "conversationId",
    "branchId",
    "frontier"
  ])
  if (factsField(state, "version") !== 1) factsFailure()
  const messageCount = factsInteger(factsField(raw, "nativeMessageCount"))
  let previousOrdinal = -1
  const stamped = factsList(factsField(raw, "stamped"), (value) => {
    const member = factsRecord(value, ["ordinal", "stamp"])
    const ordinal = factsInteger(factsField(member, "ordinal"))
    if (ordinal <= previousOrdinal || ordinal >= messageCount) factsFailure()
    previousOrdinal = ordinal
    const stamp = factsRecord(
      factsField(member, "stamp"),
      ["conversationId", "branchId", "uuid", "sequence", "door", "messageType", "origin"],
      ["isMeta"]
    )
    const origin = factsRecord(
      factsField(stamp, "origin"),
      ["kind"],
      ["server", "name", "asUser", "event", "model", "tool"]
    )
    const ownedOrigin = factsCreate(null) as Record<string, unknown>
    const originNames = factsKeys(origin)
    for (let index = 0; index < originNames.length; index++) {
      const key = originNames[index]
      const item = factsField(origin, key as string)
      if (typeof item !== "string" && typeof item !== "boolean") factsFailure()
      ownedOrigin[key as string] = item
    }
    const ownedStamp = factsCreate(null) as Record<string, unknown>
    const stampNames = factsKeys(stamp)
    for (let index = 0; index < stampNames.length; index++) {
      const key = stampNames[index]
      const item = key === "origin" ? factsFreeze(ownedOrigin) : factsField(stamp, key as string)
      if (key !== "origin" && typeof item !== "string" && typeof item !== "number" &&
        typeof item !== "boolean") factsFailure()
      ownedStamp[key as string] = item
    }
    return factsFreeze({ ordinal, stamp: factsFreeze(ownedStamp) })
  })
  const chainSeal = factsList(factsField(raw, "chainSeal"), (value) => {
    const row = factsRecord(value, [
      "checkpointId",
      "parentCheckpointId",
      "prefixLength",
      "messageCount",
      "generation",
      "type",
      "rawDigest"
    ])
    return factsFreeze({
      checkpointId: factsString(factsField(row, "checkpointId")),
      parentCheckpointId: factsParent(factsField(row, "parentCheckpointId")),
      prefixLength: factsInteger(factsField(row, "prefixLength")),
      messageCount: factsInteger(factsField(row, "messageCount")),
      generation: factsString(factsField(row, "generation")),
      type: factsString(factsField(row, "type")),
      rawDigest: factsString(factsField(row, "rawDigest"))
    })
  })
  const owned: OwnedPreparedFacts = factsFreeze({
    checkpointId: factsString(factsField(raw, "checkpointId")),
    parentCheckpointId: factsParent(factsField(raw, "parentCheckpointId")),
    checkpointTs: factsString(factsField(raw, "checkpointTs")),
    state: factsFreeze({
      version: 1,
      logicalSessionId: factsString(factsField(state, "logicalSessionId")),
      conversationId: factsString(factsField(state, "conversationId")),
      branchId: factsString(factsField(state, "branchId")),
      frontier: factsInteger(factsField(state, "frontier"))
    }),
    stateDigest: factsString(factsField(raw, "stateDigest")),
    nativeMessageCount: messageCount,
    nativeSnapshotDigest: factsString(factsField(raw, "nativeSnapshotDigest")),
    stamped,
    chainSeal,
    sealedPlanDigest: factsString(factsField(raw, "sealedPlanDigest"))
  })
  // Any callbacks inside the original semantic validator see only the complete frozen copy.
  validateOwnedFactStamps(owned)
  return owned
}

export class CheckpointRuntimeProjectionWorkerUnavailableError extends Error {
  readonly code = "CHECKPOINT_RUNTIME_PROJECTION_WORKER_UNAVAILABLE"

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "CheckpointRuntimeProjectionWorkerUnavailableError"
  }
}

export function isCheckpointRuntimeProjectionCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
}

export function isCheckpointRuntimeProjectionSchemaNotReady(error: unknown): boolean {
  return error instanceof Error && error.name === CHECKPOINT_RUNTIME_PROJECTION_SCHEMA_NOT_READY
}

async function createBundledWorker(): Promise<Worker> {
  try {
    const module = await import("./runtime-projection-worker?nodeWorker")
    return module.default({
      name: "checkpoint-runtime-projection",
      resourceLimits: {
        maxOldGenerationSizeMb: 256,
        maxYoungGenerationSizeMb: 32,
        stackSizeMb: 4
      }
    })
  } catch (error) {
    throw new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Unable to start the bundled checkpoint runtime projection worker",
      { cause: error }
    )
  }
}

export class CheckpointRuntimeProjectionClient {
  private worker: Worker | null = null
  private workerPromise: Promise<Worker> | null = null
  private retiring: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private nextRequestId = 1
  private workerGeneration = 0
  private closing = false
  private shutdownResolve: (() => void) | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private readonly physical = new Map<number, PhysicalRequest>()
  private readonly exits = new WeakMap<Worker, Promise<void>>()
  private readonly projectionRequests = new Map<string, Promise<CheckpointRuntimeProjectionStats>>()
  private readonly tupleRequests = new Map<string, Promise<unknown | null>>()
  private readonly foregroundRequests = new Map<string, number>()

  constructor(
    private readonly workerFactory: RuntimeProjectionWorkerFactory = createBundledWorker
  ) {}

  private takePending(requestId: number): PendingRequest | undefined {
    const pending = this.pending.get(requestId)
    this.pending.delete(requestId)
    if (pending?.foregroundKey && this.foregroundRequests.get(pending.foregroundKey) === requestId)
      this.foregroundRequests.delete(pending.foregroundKey)
    return pending
  }

  private cancel(record: PhysicalRequest, error: Error): void {
    record.cancelled = true
    Atomics.store(record.cancellation, 0, 1)
    record.admission.abort(error)
    if (record.writer) record.writerApi!.cancelLegacyTranscriptWriter(record.writer)
    this.takePending(record.requestId)?.reject(error)
  }

  private async releaseCheckpointIO(record: PhysicalRequest): Promise<void> {
    // A bootstrap owns the original checkpoint source until the Main writer has really
    // drained. Its fixed commands never acquire this gate, so this cannot upgrade a lease.
    if (record.writer) await record.writerApi!.settleLegacyTranscriptWriter(record.writer)
    record.resolveIo()
  }

  private finishPhysical(record: PhysicalRequest): Promise<void> {
    if (record.finishing) return record.finishing
    record.finishing = (async () => {
      await record.preparedFlight
      await this.releaseCheckpointIO(record)
      await record.ioLeaseDone?.catch(() => undefined)
      this.physical.delete(record.requestId)
      if (this.physical.size === 0) this.worker?.unref()
      record.resolveSettled()
    })()
    return record.finishing
  }

  private handleResponse = (
    response: CheckpointRuntimeProjectionWorkerResponse | LegacyTranscriptWriteMessage | PreparedNativeSourceRequest,
    worker: Worker
  ): void => {
    if (response?.type === "shutdown-complete") {
      if (this.worker === worker) this.shutdownResolve?.()
      return
    }
    if (!response || typeof response !== "object") return
    if (response.type === "prepared-native-source-request") {
      const record = this.physical.get(response.requestId)
      if (!record || record.worker !== worker || this.worker !== worker ||
        record.workerGeneration !== this.workerGeneration || !record.posted ||
        record.type !== "prepared-native-data" || !record.preparedSource || record.preparedPulled) {
        this.failWorker(worker, Error("PREPARED_NATIVE_SOURCE_PROTOCOL"))
        return
      }
      record.preparedPulled = true
      record.preparedFlight = (async () => {
        let reply: PreparedNativeSourceResponse
        try {
          record.admission.signal.throwIfAborted()
          record.assertPreparedSource?.()
          const source = record.preparedSource!()
          await record.verifyPreparedFile?.()
          record.admission.signal.throwIfAborted()
          record.assertPreparedSource?.()
          reply = { type: "prepared-native-source-response", requestId: record.requestId,
            ok: true, source }
        } catch (error) {
          this.cancel(record, error instanceof Error ? error : Error(String(error)))
          reply = { type: "prepared-native-source-response", requestId: record.requestId,
            ok: false, error: "PREPARED_NATIVE_SOURCE_CHANGED" }
        }
        if (record.worker !== worker || !this.physical.has(record.requestId)) return
        try { worker.postMessage(reply); record.preparedSourcePosted = reply.ok }
        catch (error) { this.failWorker(worker, error instanceof Error ? error : Error(String(error))) }
      })().catch(error => this.failWorker(worker, error instanceof Error ? error : Error(String(error))))
      return
    }
    if (response.type === "legacy-transcript-write") {
      const record = this.physical.get(response.requestId)
      if (
        !record ||
        record.worker !== worker ||
        !record.posted ||
        !record.writer ||
        !record.writerApi
      ) {
        this.failWorker(worker, Error("LEGACY_TRANSCRIPT_WRITE_PROTOCOL"))
        return
      }
      // The handler owns ACK dispatch as well as queued/native work. Never post a second ACK.
      void record.writerApi
        .handleLegacyTranscriptWriterCommand(record.writer, worker, response)
        .catch((error) =>
          this.failWorker(worker, error instanceof Error ? error : Error(String(error)))
        )
      return
    }
    if (!("requestId" in response)) return
    const record = this.physical.get(response.requestId)
    if (!record || record.worker !== worker || !record.posted) return
    if (record.type === "prepared-native-data" && this.worker !== worker) return
    if (
      response.type !== `${record.type}-result` ||
      !("ok" in response) ||
      typeof response.ok !== "boolean" ||
      record.responseReceived
    )
      return
    if (record.type === "prepared-native-data" && !record.cancelled) {
      try {
        if (!record.preparedPulled || !record.preparedSourcePosted) throw Error("PREPARED_NATIVE_SOURCE_PROTOCOL")
        if (response.ok) {
          const facts = capturePreparedFacts(factsField(response, "facts"))
          response = { type: "prepared-native-data-result", requestId: record.requestId, ok: true, facts }
        } else {
          const error = factsRecord(factsField(response, "error"), ["code", "message"], ["stack"])
          response = { type: "prepared-native-data-result", requestId: record.requestId, ok: false,
            error: { code: factsString(factsField(error, "code")), message: factsString(factsField(error, "message")),
              ...(factsOwn(error, "stack") ? { stack: factsString(factsField(error, "stack")) } : {}) } }
        }
      } catch (error) {
        this.failWorker(worker, error instanceof Error ? error : Error(String(error)))
        return
      }
    }
    record.responseReceived = true
    // A final result proves the Worker has closed this request's SQLite handles. Release
    // checkpoint IO before display verification, which can itself need a fresh read lease.
    if (!record.writer) record.resolveIo()
    const pending = this.pending.get(record.requestId)
    void (async () => {
      try {
        if (record.writer) await this.releaseCheckpointIO(record)
        await record.ioLeaseDone
        if (pending) {
          if (!response.ok) {
            const error = new Error(response.error.message)
            error.name = response.error.code
            if (response.error.stack) error.stack = response.error.stack
            throw error
          }
          record.admission.signal.throwIfAborted()
          if (pending.assertSource && pending.assertSource() !== undefined)
            throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
          let value: unknown
          if (
            response.type === "read-latest-tuple-result" ||
            response.type === "read-latest-runtime-tuple-result"
          )
            value = pending.verifyDisplay
              ? await pending.verifyDisplay(response.tuple)
              : response.tuple
          else if (response.type === "read-session-transcript-result") value = response.transcript
          else if (response.type === "inspect-transcript-presence-result")
            value = response.hasTranscript
          else if (response.type === "bootstrap-legacy-transcript-result")
            value = { runtimeTuple: response.runtimeTuple, stats: response.stats }
          else if (response.type === "prepared-native-data-result") value = response.facts
          else value = response.stats
          await pending.verifyFile?.()
          record.admission.signal.throwIfAborted()
          if (pending.assertSource && pending.assertSource() !== undefined)
            throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
          this.takePending(record.requestId)?.resolve(value)
        }
      } catch (error) {
        this.takePending(record.requestId)?.reject(
          error instanceof Error ? error : Error(String(error))
        )
      } finally {
        await this.finishPhysical(record)
      }
    })().catch((error) =>
      this.failWorker(worker, error instanceof Error ? error : Error(String(error)))
    )
  }

  private failWorker(worker: Worker, error: Error): void {
    if (this.worker !== worker) return
    this.worker = null
    const unavailable = new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Checkpoint runtime projection worker stopped unexpectedly",
      { cause: error }
    )
    for (const record of this.physical.values())
      if (record.worker === worker) this.cancel(record, unavailable)
    // error/postMessage failure does not prove that native SQLite has stopped. A replacement
    // is blocked until actual termination/exit and all associated Main commands have drained.
    const retiring = (async () => {
      await worker.terminate().catch(() => undefined)
      await this.exits.get(worker)
      await Promise.all(
        [...this.physical.values()]
          .filter((record) => record.worker === worker)
          .map((record) => this.finishPhysical(record))
      )
    })()
    this.retiring = retiring
    void retiring.finally(() => {
      if (this.retiring === retiring) this.retiring = null
    })
  }

  private attachWorker(worker: Worker): Worker {
    let resolveExit!: () => void
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve
    })
    this.exits.set(worker, exited)
    worker.on("message", (response) => this.handleResponse(response, worker))
    worker.on("error", (error) => this.failWorker(worker, error))
    worker.on("exit", (code) => {
      resolveExit()
      if (this.worker === worker)
        this.failWorker(worker, new Error(`Runtime projection worker exited: ${code}`))
    })
    this.worker = worker
    this.workerGeneration++
    // Pending promises do not keep a standalone Node host alive.
    if (this.physical.size > 0) worker.ref()
    else worker.unref()
    return worker
  }

  private async getWorker(): Promise<Worker> {
    if (this.retiring) await this.retiring
    if (this.closing)
      throw new CheckpointRuntimeProjectionWorkerUnavailableError(
        "Checkpoint runtime projection client is closing"
      )
    if (this.worker) return this.worker
    if (this.workerPromise) return this.workerPromise
    const startup = this.workerFactory()
      .then(async (worker) => {
        this.attachWorker(worker)
        if (this.closing) {
          this.failWorker(worker, Error("Checkpoint runtime projection client is closing"))
          await this.retiring
          throw new CheckpointRuntimeProjectionWorkerUnavailableError(
            "Checkpoint runtime projection client is closing"
          )
        }
        return worker
      })
      .catch((error) => {
        if (error instanceof CheckpointRuntimeProjectionWorkerUnavailableError) throw error
        throw new CheckpointRuntimeProjectionWorkerUnavailableError(
          "Unable to start the checkpoint runtime projection worker",
          { cause: error }
        )
      })
    this.workerPromise = startup
    try {
      return await startup
    } finally {
      if (this.workerPromise === startup) this.workerPromise = null
    }
  }

  private async request(
    input: ProjectionRequestInput,
    optionsInput: ProjectionRequestOptions = {}
  ): Promise<unknown> {
    const options = Object.freeze({ ...optionsInput })
    options.signal?.throwIfAborted()
    if (options.assertSource && options.assertSource() !== undefined)
      throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
    if (this.closing)
      throw new CheckpointRuntimeProjectionWorkerUnavailableError(
        "Checkpoint runtime projection client is closing"
      )
    if (this.physical.size >= CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS)
      throw Error("CHECKPOINT_QUERY_CAPACITY")
    // Snapshot host-only facts before Worker startup, file resolution or admission can yield.
    const request = { ...input }
    const source = options.checkpointSource
      ? Object.freeze({
          identity: options.checkpointSource.identity,
          file: Object.freeze({ ...options.checkpointSource.file }),
          assertCurrent: options.checkpointSource.assertCurrent
        })
      : undefined
    const legacy = options.legacySource
      ? Object.freeze({
          assertCurrent: options.legacySource.assertCurrent,
          createWriter: options.legacySource.createWriter
        })
      : undefined
    if (request.type === "bootstrap-legacy-transcript" && !legacy)
      throw Error("LEGACY_TRANSCRIPT_SOURCE_CHANGED")
    const assertLegacyCurrent = () => {
      if (legacy && legacy.assertCurrent() !== undefined)
        throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
    }
    assertLegacyCurrent()
    if (request.type === "prepared-native-data" && (!source || !options.readPreparedSource))
      throw Error("PREPARED_NATIVE_SOURCE_PROTOCOL")
    if (legacy && typeof legacy.createWriter !== "function")
      throw Error("LEGACY_TRANSCRIPT_WRITE_PROTOCOL")
    const requestId = this.nextRequestId++
    let resolveIo!: () => void, resolveSettled!: () => void
    const record: PhysicalRequest = {
      requestId,
      type: request.type,
      admission: new AbortController(),
      cancellation: new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
      ioDone: new Promise((resolve) => {
        resolveIo = resolve
      }),
      settled: new Promise((resolve) => {
        resolveSettled = resolve
      }),
      resolveIo: () => resolveIo(),
      resolveSettled: () => resolveSettled(),
      posted: false,
      cancelled: false,
      preparedSource: undefined,
      preparedPulled: false,
      preparedSourcePosted: false,
      preparedFlight: undefined,
      assertPreparedSource: undefined,
      verifyPreparedFile: undefined
    }
    if (options.readPreparedSource) {
      record.assertPreparedSource = () => {
        if (options.assertSource && options.assertSource() !== undefined)
          throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
      }
      record.preparedSource = () => {
        const value = options.readPreparedSource!()
        if (!source || value.file.dev !== source.file.dev || value.file.ino !== source.file.ino ||
          value.file.birthtime !== source.file.birthtime) throw Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
        return { ...value, file: source.file }
      }
    }
    if (this.physical.size === 0) this.worker?.ref()
    this.physical.set(requestId, record)
    if (options.foregroundKey) {
      const previousId = this.foregroundRequests.get(options.foregroundKey)
      const previous = previousId === undefined ? undefined : this.physical.get(previousId)
      if (previous) this.cancel(previous, this.cancelledError())
      this.foregroundRequests.set(options.foregroundKey, requestId)
    }
    const logical = new Promise<unknown>((resolve, reject) => {
      const abort = () =>
        this.cancel(
          record,
          options.signal?.reason instanceof Error ? options.signal.reason : this.cancelledError()
        )
      const cleanup = () => options.signal?.removeEventListener("abort", abort)
      this.pending.set(requestId, {
        resolve: (value) => {
          cleanup()
          resolve(value)
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
        cancellation: record.cancellation,
        bootstrapThreadId: options.bootstrapThreadId,
        foregroundKey: options.foregroundKey,
        assertSource: () => {
          if (options.assertSource && options.assertSource() !== undefined)
            throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
          assertLegacyCurrent()
        },
        verifyDisplay: options.verifyDisplay
      })
      options.signal?.addEventListener("abort", abort, { once: true })
      if (options.signal?.aborted) abort()
    })
    void (async () => {
      try {
        record.admission.signal.throwIfAborted()
        const identity =
          source?.identity ??
          (await resolveCheckpointDatabaseIdentity(request.databasePath, { createParent: false }))
        const file = source?.file ?? identity.capturedFile
        if (!file) throw Error("SQLJS_SAVER_DATABASE_IDENTITY_CHANGED")
        record.admission.signal.throwIfAborted()
        const worker = await this.getWorker()
        record.worker = worker
        record.workerGeneration = this.workerGeneration
        const pending = this.pending.get(requestId)
        if (pending) {
          pending.worker = worker
          pending.verifyFile = async () => {
            await assertCheckpointDatabasePathCurrent(identity)
            await assertCheckpointDatabaseFileIdentity(identity.path, file)
          }
        }
        if (record.preparedSource) record.verifyPreparedFile = async () => {
          await assertCheckpointDatabasePathCurrent(identity)
          await assertCheckpointDatabaseFileIdentity(identity.path, file)
        }
        const work = async () => {
          record.admission.signal.throwIfAborted()
          if (request.type !== "prepared-native-data") source?.assertCurrent()
          assertLegacyCurrent()
          if (options.assertSource && options.assertSource() !== undefined)
            throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
          if (legacy) {
            const api = await import("./legacy-transcript-main-writer")
            record.admission.signal.throwIfAborted()
            assertLegacyCurrent()
            if (this.closing || this.worker !== worker)
              throw new CheckpointRuntimeProjectionWorkerUnavailableError(
                "Checkpoint runtime projection client is closing"
              )
            const context = Object.freeze({
              actualWorker: worker,
              workerGeneration: record.workerGeneration!,
              requestId,
              threadId: request.threadId,
              checkpointNamespace: request.checkpointNs
            })
            const actor = legacy.createWriter(context)
            // Validate the original private actor and fixed target before retaining it.
            api.readLegacyTranscriptWriterData(actor, context)
            record.writerApi = api
            record.writer = actor
          }
          await assertCheckpointDatabasePathCurrent(identity)
          await assertCheckpointDatabaseFileIdentity(identity.path, file)
          if (options.assertSource && options.assertSource() !== undefined)
            throw Error("MODS_CONVERSATION_ASYNC_DISPLAY_SOURCE")
          if (request.type !== "prepared-native-data") source?.assertCurrent()
          assertLegacyCurrent()
          record.admission.signal.throwIfAborted()
          if (this.closing || this.worker !== worker)
            throw new CheckpointRuntimeProjectionWorkerUnavailableError(
              "Checkpoint runtime projection client is closing"
            )
          record.posted = true
          try {
            worker.postMessage({
              ...request,
              databasePath: identity.path,
              requestId,
              cancellationBuffer: record.cancellation.buffer,
              ...(record.writer ? { legacyWriter: record.writer.workerData } : {})
            })
          } catch (error) {
            this.failWorker(worker, error instanceof Error ? error : Error(String(error)))
          }
          await record.ioDone
        }
        const exclusive =
          request.type === "ensure-runtime-projection" ||
          request.type === "read-latest-runtime-tuple" ||
          request.type === "bootstrap-legacy-transcript"
        record.ioLeaseDone = exclusive
          ? runCheckpointDatabaseMaintenance(identity.key, work, record.admission.signal)
          : runCheckpointDatabaseOperation(identity.key, work, undefined, record.admission.signal)
        await record.ioLeaseDone
        if (!record.posted) await this.finishPhysical(record)
      } catch (error) {
        const actual = error instanceof Error ? error : Error(String(error))
        this.takePending(requestId)?.reject(actual)
        if (!record.posted) await this.finishPhysical(record)
        else if (record.worker) this.failWorker(record.worker, actual)
      }
    })()
    return options.awaitPhysical ? logical.finally(() => record.settled) : logical
  }

  private cancelledError(): Error {
    const error = Error("Checkpoint runtime projection request cancelled")
    error.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
    return error
  }

  /** Saver callback lifetime includes actual final/exit, not merely logical cancellation. */
  readPreparedNativeData(databasePath: string, threadId: string, checkpointNs: string,
    checkpointId: string, options: {
      readonly checkpointSource: CheckpointRuntimeProjectionSource
      readonly signal?: AbortSignal
      readonly readSource: () => PreparedNativeDataSource
    }): Promise<PreparedNativeDataFacts> {
    // Prepared data has one Saver guard for the source and the operation.
    const { checkpointSource, signal, readSource } = options
    const assertSource = checkpointSource?.assertCurrent
    if (typeof assertSource !== "function")
      return Promise.reject(Error("PREPARED_NATIVE_SOURCE_PROTOCOL"))
    return this.request({ type: "prepared-native-data", databasePath, threadId, checkpointNs,
      checkpointId }, { checkpointSource, signal, assertSource, readPreparedSource: readSource,
      awaitPhysical: true }) as Promise<PreparedNativeDataFacts>
  }

  ensureRuntimeProjection(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    source?: CheckpointRuntimeProjectionSource
  ): Promise<CheckpointRuntimeProjectionStats> {
    const key = `${databasePath}\u0000${threadId}\u0000${checkpointNs}`
    const existing = source ? undefined : this.projectionRequests.get(key)
    if (existing) return existing
    const request = this.request(
      {
        type: "ensure-runtime-projection",
        databasePath,
        threadId,
        checkpointNs
      },
      source ? { checkpointSource: source, assertSource: source.assertCurrent } : {}
    )
      .then((value) => value as CheckpointRuntimeProjectionStats)
      .finally(() => {
        if (this.projectionRequests.get(key) === request) this.projectionRequests.delete(key)
      })
    if (!source) this.projectionRequests.set(key, request)
    return request
  }

  readLatestTuple(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    options: {
      messageLimit?: number
      messageByteBudget?: number
      foregroundKey?: string | number
      nativeDisplay?: CanonicalCheckpointDisplaySelection
      assertSource?: () => void
      verifyDisplay?: (tuple: unknown) => unknown
    } = {}
  ): Promise<unknown | null> {
    const key = `${databasePath}\u0000${threadId}\u0000${checkpointNs}\u0000${options.messageLimit ?? ""}\u0000${options.messageByteBudget ?? ""}`
    const existing =
      options.foregroundKey === undefined && !options.nativeDisplay
        ? this.tupleRequests.get(key)
        : undefined
    if (existing) return existing
    const request = this.request(
      {
        type: "read-latest-tuple",
        databasePath,
        threadId,
        checkpointNs,
        messageLimit: options.messageLimit,
        messageByteBudget: options.messageByteBudget,
        nativeDisplay: options.nativeDisplay
      },
      {
        ...(options.foregroundKey === undefined
          ? {}
          : {
              foregroundKey: String(options.foregroundKey),
              cancellable: true
            }),
        ...(options.nativeDisplay
          ? {
              cancellable: true,
              assertSource: options.assertSource,
              verifyDisplay: options.verifyDisplay
            }
          : {})
      }
    )
      .then((value) => value ?? null)
      .finally(() => {
        if (this.tupleRequests.get(key) === request) this.tupleRequests.delete(key)
      })
    if (options.foregroundKey === undefined && !options.nativeDisplay)
      this.tupleRequests.set(key, request)
    return request
  }

  readLatestRuntimeTuple(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    foregroundKey?: string | number
  ): Promise<unknown | null> {
    return this.request(
      {
        type: "read-latest-runtime-tuple",
        databasePath,
        threadId,
        checkpointNs
      },
      foregroundKey === undefined ? {} : { cancellable: true, foregroundKey: String(foregroundKey) }
    ).then((value) => value ?? null)
  }

  async readSessionTranscript(
    databasePath: string,
    threadId: string,
    signal: AbortSignal,
    checkpointNs = "",
    projection: "messages" | "turns" | "usage" = "messages"
  ): Promise<FunctionSessionCheckpoint | null> {
    signal.throwIfAborted()
    if (this.pending.size >= CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS)
      return Promise.reject(new Error("CHECKPOINT_QUERY_CAPACITY"))
    return this.request(
      { type: "read-session-transcript", databasePath, threadId, checkpointNs, projection },
      { cancellable: true, signal }
    ) as Promise<FunctionSessionCheckpoint | null>
  }

  async readSessionTranscriptPage(
    databasePath: string,
    threadId: string,
    signal: AbortSignal,
    page: FunctionSessionPageInput,
    checkpointNs = ""
  ): Promise<FunctionSessionMessagePage | null> {
    signal.throwIfAborted()
    if (this.pending.size >= CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS)
      throw new Error("CHECKPOINT_QUERY_CAPACITY")
    return this.request(
      {
        type: "read-session-transcript",
        databasePath,
        threadId,
        checkpointNs,
        projection: "messages",
        page
      },
      { cancellable: true, signal }
    ) as Promise<FunctionSessionMessagePage | null>
  }

  bootstrapLegacyTranscript(
    databasePath: string,
    messageDatabasePath: string,
    threadId: string,
    checkpointNs = "",
    foregroundKey?: string | number,
    source?: LegacyCheckpointTranscriptHostSource
  ): Promise<LegacyCheckpointTranscriptBootstrapResult> {
    return this.request(
      {
        type: "bootstrap-legacy-transcript",
        databasePath,
        messageDatabasePath,
        threadId,
        checkpointNs
      },
      {
        cancellable: true,
        bootstrapThreadId: threadId,
        legacySource: source,
        ...(foregroundKey === undefined ? {} : { foregroundKey: String(foregroundKey) })
      }
    ).then((value) => value as LegacyCheckpointTranscriptBootstrapResult)
  }

  hasTranscript(
    databasePath: string,
    threadId: string,
    checkpointNs = "",
    foregroundKey?: string | number
  ): Promise<boolean> {
    return this.request(
      {
        type: "inspect-transcript-presence",
        databasePath,
        threadId,
        checkpointNs
      },
      foregroundKey === undefined
        ? {}
        : { cancellable: true, foregroundKey: `transcript-presence:${foregroundKey}` }
    ).then(Boolean)
  }

  cancelLegacyTranscriptBootstrap(threadId: string): void {
    for (const record of this.physical.values())
      if (this.pending.get(record.requestId)?.bootstrapThreadId === threadId)
        this.cancel(record, this.cancelledError())
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closing = true
    const unavailable = new CheckpointRuntimeProjectionWorkerUnavailableError(
      "Checkpoint runtime projection worker is shutting down"
    )
    for (const record of this.physical.values()) this.cancel(record, unavailable)
    this.projectionRequests.clear()
    this.tupleRequests.clear()
    this.foregroundRequests.clear()
    this.closePromise = (async () => {
      await this.workerPromise?.catch(() => undefined)
      const worker = this.worker
      if (worker) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout)
            this.shutdownResolve = null
            resolve()
          }
          const timeout = setTimeout(finish, 500)
          this.shutdownResolve = finish
          try {
            worker.postMessage({ type: "shutdown" })
          } catch {
            finish()
          }
        })
        this.failWorker(worker, unavailable)
      }
      await this.retiring
      await Promise.all([...this.physical.values()].map((record) => record.settled))
    })()
    return this.closePromise
  }
}

let defaultClient: CheckpointRuntimeProjectionClient | null = null
let shutdownHookRegistered = false

function getDefaultClient(): CheckpointRuntimeProjectionClient {
  defaultClient ??= new CheckpointRuntimeProjectionClient()
  if (!shutdownHookRegistered) {
    shutdownHookRegistered = true
    process.once("beforeExit", () => {
      const client = defaultClient
      defaultClient = null
      void client?.close()
    })
  }
  return defaultClient
}

export function readPreparedNativeDataInWorker(databasePath: string, threadId: string,
  checkpointNs: string, checkpointId: string,
  options: Parameters<CheckpointRuntimeProjectionClient["readPreparedNativeData"]>[4]
): Promise<PreparedNativeDataFacts> {
  return getDefaultClient().readPreparedNativeData(databasePath, threadId, checkpointNs,
    checkpointId, options)
}

export function ensureCheckpointRuntimeProjectionInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  source?: CheckpointRuntimeProjectionSource
): Promise<CheckpointRuntimeProjectionStats> {
  return getDefaultClient().ensureRuntimeProjection(databasePath, threadId, checkpointNs, source)
}

export function readLatestCheckpointTupleInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  options: {
    messageLimit?: number
    messageByteBudget?: number
    foregroundKey?: string | number
    nativeDisplay?: CanonicalCheckpointDisplaySelection
    assertSource?: () => void
    verifyDisplay?: (tuple: unknown) => unknown
  } = {}
): Promise<unknown | null> {
  // A task does not get a checkpoint database until its first persisted run.
  // Preserve `null` exclusively for that authoritative empty state; once the
  // file exists, worker/SQLite/decoding failures must still reject so callers
  // can distinguish a failed read from an absent checkpoint.
  if (!existsSync(databasePath)) return Promise.resolve(null)
  return getDefaultClient().readLatestTuple(databasePath, threadId, checkpointNs, options)
}

export function readLatestCheckpointRuntimeTupleInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  foregroundKey?: string | number
): Promise<unknown | null> {
  if (!existsSync(databasePath)) return Promise.resolve(null)
  return getDefaultClient().readLatestRuntimeTuple(
    databasePath,
    threadId,
    checkpointNs,
    foregroundKey
  )
}

export async function readFunctionSessionTranscriptInWorker(
  databasePath: string,
  threadId: string,
  signal: AbortSignal,
  projection: "messages" | "turns" | "usage" = "messages"
): Promise<FunctionSessionCheckpoint | null> {
  signal.throwIfAborted()
  if (!existsSync(databasePath)) return Promise.resolve(null)
  return getDefaultClient().readSessionTranscript(databasePath, threadId, signal, "", projection)
}

export async function readFunctionSessionPageInWorker(
  databasePath: string,
  threadId: string,
  signal: AbortSignal,
  page: FunctionSessionPageInput
): Promise<FunctionSessionMessagePage | null> {
  signal.throwIfAborted()
  if (!existsSync(databasePath)) return null
  return getDefaultClient().readSessionTranscriptPage(databasePath, threadId, signal, page)
}

export function bootstrapLegacyCheckpointTranscriptInWorker(
  databasePath: string,
  messageDatabasePath: string,
  threadId: string,
  checkpointNs = "",
  foregroundKey?: string | number,
  source?: LegacyCheckpointTranscriptHostSource
): Promise<LegacyCheckpointTranscriptBootstrapResult> {
  if (!existsSync(databasePath)) {
    return Promise.resolve(emptyLegacyCheckpointBootstrapResult())
  }
  return getDefaultClient().bootstrapLegacyTranscript(
    databasePath,
    messageDatabasePath,
    threadId,
    checkpointNs,
    foregroundKey,
    source
  )
}

export function hasVisibleCheckpointTranscriptInWorker(
  databasePath: string,
  threadId: string,
  checkpointNs = "",
  foregroundKey?: string | number
): Promise<boolean> {
  if (!existsSync(databasePath)) return Promise.resolve(false)
  return getDefaultClient().hasTranscript(databasePath, threadId, checkpointNs, foregroundKey)
}

export function cancelLegacyCheckpointTranscriptBootstrap(threadId: string): void {
  defaultClient?.cancelLegacyTranscriptBootstrap(threadId)
}

export async function closeCheckpointRuntimeProjectionWorker(): Promise<void> {
  const client = defaultClient
  defaultClient = null
  await client?.close()
}
