import {
  readPreparedNativeDataFacts,
  prepareLegacyCheckpointTranscriptSource,
  readLatestCheckpointRuntimeTuple,
  type DurableLegacyCheckpointMessage,
  type LegacyCheckpointTranscriptBootstrapResult
} from "./runtime-projection-store"
import { prepareLegacyMessageTimeEntries } from "./legacy-message-times"
import {
  LEGACY_TRANSCRIPT_WRITE_PROTOCOL,
  LEGACY_TRANSCRIPT_WRITE_ERRORS,
  legacyTranscriptWriteRowBytes,
  type LegacyTranscriptWriterData,
  type LegacyTranscriptMarker,
  type LegacyTranscriptReadState,
  type LegacyTranscriptWriteCommand,
  type LegacyTranscriptWriteMessage,
  type LegacyTranscriptWriteProgress,
  type LegacyTranscriptWriteResult
} from "./legacy-transcript-write-protocol"
import {
  CHECKPOINT_RUNTIME_PROJECTION_CANCELLED,
  CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS,
  type PreparedNativeDataRequest,
  type PreparedNativeDataFacts,
  type PreparedNativeDataSource,
  type PreparedNativeSourceRequest,
  type PreparedNativeSourceResponse,
  type LegacyCheckpointTranscriptBootstrapRequest
} from "./runtime-projection-protocol"
import { FUNCTION_MOD_RESOURCE_BUDGETS } from "../../shared/mods/v2/resource-budgets"

const limits = FUNCTION_MOD_RESOURCE_BUDGETS.legacyTranscriptBridgeWriter
type Request = Pick<
  LegacyCheckpointTranscriptBootstrapRequest,
  "requestId" | "databasePath" | "threadId" | "checkpointNs" | "cancellationBuffer" | "legacyWriter"
>
interface LegacyJob {
  kind: "legacy"
  request: Request
  cancellation: Int32Array
  sequence: number
  resolve(value: LegacyCheckpointTranscriptBootstrapResult): void
  reject(error: unknown): void
}
interface PreparedJob {
  kind: "prepared"
  request: PreparedNativeDataRequest
  cancellation: Int32Array
  resolve(value: PreparedNativeDataFacts): void
  reject(error: unknown): void
  source?: { resolve(value: PreparedNativeDataSource): void; reject(error: unknown): void }
}
type Job = LegacyJob | PreparedJob
interface AwaitingWrite {
  data: LegacyTranscriptWriterData
  sequence: number
  resolve(value: LegacyTranscriptWriteResult): void
  reject(error: unknown): void
}
function fail(code = "LEGACY_TRANSCRIPT_WRITE_PROTOCOL"): never {
  throw Object.assign(Error(code), { code })
}
function cancelled(): Error {
  const error = Error("Checkpoint runtime projection request cancelled")
  error.name = CHECKPOINT_RUNTIME_PROJECTION_CANCELLED
  return error
}
function own(value: unknown, name: string): unknown {
  if (!value || typeof value !== "object") return undefined
  const field = Object.getOwnPropertyDescriptor(value, name)
  return field && "value" in field ? field.value : undefined
}
function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) fail()
  return Number(value)
}
function marker(value: unknown): LegacyTranscriptMarker | null {
  if (value === null) return null
  const checkpointId = own(value, "checkpointId"),
    status = own(value, "status")
  if (
    typeof checkpointId !== "string" ||
    !checkpointId ||
    !(status === "migrating" || status === "complete")
  )
    fail()
  const totalMessages = count(own(value, "totalMessages"))
  const nextIndex = count(own(value, "nextIndex")),
    fragmentIndex = count(own(value, "fragmentIndex"))
  if (
    nextIndex > totalMessages ||
    (status === "complete" && (nextIndex !== totalMessages || fragmentIndex !== 0))
  )
    fail()
  return { checkpointId, totalMessages, nextIndex, fragmentIndex, status }
}
function readState(value: unknown): LegacyTranscriptReadState {
  const ordinary = own(value, "ordinary")
  if (typeof ordinary !== "boolean") fail()
  return { ordinary, marker: marker(own(value, "marker")) }
}
function progress(value: unknown): LegacyTranscriptWriteProgress {
  const fragmentOwned = own(value, "fragmentOwned")
  if (!(fragmentOwned === undefined || typeof fragmentOwned === "boolean")) fail()
  return {
    marker: marker(own(value, "marker")),
    inserted: count(own(value, "inserted")),
    ...(fragmentOwned === undefined ? {} : { fragmentOwned })
  }
}
function rowHeader(message: DurableLegacyCheckpointMessage) {
  const { contentFragments: _fragments, ...row } = message
  return row
}

/** Serializes only the full legacy source. Other Worker read handlers remain available. */
export class LegacyTranscriptWorkerDriver {
  private readonly queue: Job[] = []
  private readonly awaiting = new Map<number, AwaitingWrite>()
  private active: Job | undefined
  private closing = false
  private readonly drained: Promise<void>
  private resolveDrained!: () => void

  constructor(private readonly postWrite: (message: LegacyTranscriptWriteMessage) => void,
    private readonly postPreparedSource: (message: PreparedNativeSourceRequest) => void = () => fail()) {
    this.drained = new Promise((resolve) => {
      this.resolveDrained = resolve
    })
  }

  enqueue(input: Request): Promise<LegacyCheckpointTranscriptBootstrapResult> {
    if (this.closing) return Promise.reject(cancelled())
    if (
      this.queue.length + (this.active ? 1 : 0) >=
      CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS
    )
      return Promise.reject(Error("CHECKPOINT_QUERY_CAPACITY"))
    // Snapshot the exact original request before the read-state ACK yields to Main.
    const writer = input.legacyWriter
    const data = Object.freeze({
      protocol: writer?.protocol,
      nonce: writer?.nonce,
      workerGeneration: writer?.workerGeneration,
      requestId: writer?.requestId
    })
    if (
      data.protocol !== LEGACY_TRANSCRIPT_WRITE_PROTOCOL ||
      typeof data.nonce !== "string" ||
      !data.nonce ||
      !Number.isSafeInteger(data.workerGeneration) ||
      data.workerGeneration < 0 ||
      data.requestId !== input.requestId ||
      !Number.isSafeInteger(input.requestId)
    )
      return Promise.reject(Error("LEGACY_TRANSCRIPT_WRITE_PROTOCOL"))
    const request = Object.freeze({
      requestId: input.requestId,
      databasePath: input.databasePath,
      threadId: input.threadId,
      checkpointNs: input.checkpointNs,
      cancellationBuffer: input.cancellationBuffer,
      legacyWriter: data
    })
    return new Promise((resolve, reject) => {
      const job: LegacyJob = {
        kind: "legacy",
        request,
        cancellation: new Int32Array(request.cancellationBuffer),
        sequence: 0,
        resolve,
        reject
      }
      this.queue.push(job)
      this.pump()
    })
  }

  /** Only small metadata is queued; the sole active job requests its sealed body once. */
  enqueuePrepared(input: PreparedNativeDataRequest): Promise<PreparedNativeDataFacts> {
    if (this.closing) return Promise.reject(cancelled())
    if (this.queue.length + (this.active ? 1 : 0) >= CHECKPOINT_RUNTIME_PROJECTION_MAX_PHYSICAL_REQUESTS)
      return Promise.reject(Error("CHECKPOINT_QUERY_CAPACITY"))
    if (!Number.isSafeInteger(input.requestId) || !input.checkpointId || !input.threadId)
      return Promise.reject(Error("PREPARED_NATIVE_SOURCE_PROTOCOL"))
    const request = Object.freeze({ ...input })
    return new Promise((resolve, reject) => {
      this.queue.push({ kind: "prepared", request,
        cancellation: new Int32Array(request.cancellationBuffer), resolve, reject })
      this.pump()
    })
  }

  acceptPreparedSource(wire: PreparedNativeSourceResponse): boolean {
    const job = this.active
    if (!job || job.kind !== "prepared" || wire.type !== "prepared-native-source-response" ||
      wire.requestId !== job.request.requestId || !job.source) return false
    const pending = job.source
    job.source = undefined
    if (wire.ok === true) pending.resolve(wire.source)
    else pending.reject(Error("PREPARED_NATIVE_SOURCE_CHANGED"))
    return true
  }

  /** Unknown/late ACKs never release a different request's one outstanding write. */
  acceptAcknowledgement(wire: unknown): boolean {
    if (own(wire, "type") !== "legacy-transcript-write-ack") return false
    const requestId = own(wire, "requestId")
    if (typeof requestId !== "number") return false
    const pending = this.awaiting.get(requestId)
    if (
      !pending ||
      own(wire, "protocol") !== pending.data.protocol ||
      own(wire, "nonce") !== pending.data.nonce ||
      own(wire, "workerGeneration") !== pending.data.workerGeneration ||
      own(wire, "sequence") !== pending.sequence
    )
      return false
    const ok = own(wire, "ok")
    if (!(ok === true || ok === false)) return false
    if (ok === false) {
      const code = own(own(wire, "error"), "code")
      if (
        typeof code !== "string" ||
        !LEGACY_TRANSCRIPT_WRITE_ERRORS.includes(
          code as (typeof LEGACY_TRANSCRIPT_WRITE_ERRORS)[number]
        )
      )
        return false
      this.awaiting.delete(requestId)
      pending.reject(
        code === "LEGACY_TRANSCRIPT_WRITE_CANCELLED"
          ? cancelled()
          : Object.assign(Error(code), { code })
      )
    } else {
      this.awaiting.delete(requestId)
      pending.resolve(own(wire, "result") as LegacyTranscriptWriteResult)
    }
    return true
  }

  /** Cancellation is logical until the original Main ACK and the active task actually settle. */
  shutdown(): Promise<void> {
    this.closing = true
    for (const job of this.queue) Atomics.store(job.cancellation, 0, 1)
    if (this.active) {
      Atomics.store(this.active.cancellation, 0, 1)
      if (this.active.kind === "prepared" && this.active.source) {
        this.active.source.reject(cancelled())
        this.active.source = undefined
      }
    }
    this.pump()
    this.maybeDrained()
    return this.drained
  }

  private assertCurrent(job: Job): void {
    if (Atomics.load(job.cancellation, 0) !== 0) throw cancelled()
  }
  private maybeDrained(): void {
    if (this.closing && !this.active && !this.queue.length && !this.awaiting.size)
      this.resolveDrained()
  }
  private pump(): void {
    if (this.active) return
    const job = this.queue.shift()
    if (!job) {
      this.maybeDrained()
      return
    }
    this.active = job
    const result = job.kind === "legacy"
      ? this.run(job).then(job.resolve, job.reject)
      : this.runPrepared(job).then(job.resolve, job.reject)
    void result
      .finally(() => {
        this.active = undefined
        this.pump()
      })
  }
  private async command(
    job: LegacyJob,
    command: LegacyTranscriptWriteCommand
  ): Promise<LegacyTranscriptWriteResult> {
    this.assertCurrent(job)
    const { legacyWriter: data, requestId } = job.request
    if (this.awaiting.has(requestId)) fail()
    const sequence = ++job.sequence
    const result = await new Promise<LegacyTranscriptWriteResult>((resolve, reject) => {
      this.awaiting.set(requestId, { data, sequence, resolve, reject })
      try {
        this.postWrite({ ...data, type: "legacy-transcript-write", sequence, command })
      } catch (error) {
        this.awaiting.delete(requestId)
        reject(error)
      }
    })
    this.assertCurrent(job)
    return result
  }

  private async runPrepared(job: PreparedJob): Promise<PreparedNativeDataFacts> {
    this.assertCurrent(job)
    const source = await new Promise<PreparedNativeDataSource>((resolve, reject) => {
      job.source = { resolve, reject }
      try { this.postPreparedSource({ type: "prepared-native-source-request", requestId: job.request.requestId }) }
      catch (error) { job.source = undefined; reject(error) }
    })
    this.assertCurrent(job)
    return readPreparedNativeDataFacts(job.request, source)
  }

  private async run(job: LegacyJob): Promise<LegacyCheckpointTranscriptBootstrapResult> {
    this.assertCurrent(job)
    const request = job.request
    const state = readState(await this.command(job, { kind: "read-state" }))
    this.assertCurrent(job)
    const source = prepareLegacyCheckpointTranscriptSource(
      request.databasePath,
      request.threadId,
      request.checkpointNs,
      state,
      request.cancellationBuffer
    )
    if (source.kind === "empty")
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
    let migratedMessages = 0,
      batches = 0
    if (source.kind === "source") {
      const totalMessages = source.messages.length
      let current = state.marker
      let complete =
        source.complete &&
        current?.status === "complete" &&
        current.checkpointId === source.checkpointId &&
        current.totalMessages === totalMessages
      if (!source.complete) {
        current = progress(
          await this.command(job, {
            kind: "reserve",
            checkpointId: source.checkpointId,
            totalMessages
          })
        ).marker
        if (
          !current ||
          current.checkpointId !== source.checkpointId ||
          current.totalMessages !== totalMessages
        )
          fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
        while (current && current.nextIndex < totalMessages) {
          const index = current.nextIndex,
            message = source.messages[index]
          const fragmentIndex = current.fragmentIndex
          let result: LegacyTranscriptWriteProgress
          if (message.contentFragments) {
            const fragments: string[] = []
            let next = fragmentIndex,
              bytes = legacyTranscriptWriteRowBytes(message)
            while (
              next < message.contentFragments.length &&
              fragments.length < limits.rowsPerBatch
            ) {
              const fragment = message.contentFragments[next]
              const size = Buffer.byteLength(fragment, "utf8") + 256
              if (fragments.length > 0 && bytes + size > limits.batchBytes) break
              fragments.push(fragment)
              bytes += size
              next++
            }
            result = progress(
              await this.command(job, {
                kind: "copy",
                mode: "fragments",
                checkpointId: source.checkpointId,
                totalMessages,
                index,
                fragmentIndex,
                row: rowHeader(message),
                fragments,
                totalFragments: message.contentFragments.length,
                nextFragmentIndex: next,
                complete: next === message.contentFragments.length
              })
            )
          } else {
            if (fragmentIndex !== 0) fail()
            const rows: ReturnType<typeof rowHeader>[] = []
            let bytes = 0,
              next = index
            while (next < totalMessages && rows.length < limits.rowsPerBatch) {
              const message = source.messages[next]
              if (message.contentFragments) break
              const size = legacyTranscriptWriteRowBytes(message)
              if (rows.length > 0 && bytes + size > limits.batchBytes) break
              rows.push(rowHeader(message))
              bytes += size
              next++
            }
            if (!rows.length) fail()
            result = progress(
              await this.command(job, {
                kind: "copy",
                mode: "rows",
                checkpointId: source.checkpointId,
                totalMessages,
                index,
                fragmentIndex,
                rows
              })
            )
          }
          const next = result.marker
          if (
            !next ||
            next.checkpointId !== source.checkpointId ||
            next.totalMessages !== totalMessages ||
            next.nextIndex < index ||
            (next.nextIndex === index && next.fragmentIndex <= fragmentIndex)
          )
            fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
          current = next
          migratedMessages += result.inserted
          batches++
        }
        if (!current) fail()
        const finished = progress(
          await this.command(job, {
            kind: "finish",
            checkpointId: source.checkpointId,
            totalMessages,
            index: current.nextIndex,
            fragmentIndex: current.fragmentIndex
          })
        ).marker
        if (
          !finished ||
          finished.status !== "complete" ||
          finished.checkpointId !== source.checkpointId ||
          finished.totalMessages !== totalMessages ||
          finished.nextIndex !== totalMessages ||
          finished.fragmentIndex !== 0
        )
          fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
        complete = true
      }
      if (!complete) fail("LEGACY_TRANSCRIPT_WRITE_SOURCE_CHANGED")
      try {
        const timing = own(
          await this.command(job, { kind: "timing-source", checkpointId: source.checkpointId }),
          "timing"
        )
        if (timing !== null) {
          const raw = own(timing, "source"),
            timingToken = own(timing, "timingToken")
          if (typeof raw !== "string" || typeof timingToken !== "string" || !timingToken) fail()
          const timingEntry = prepareLegacyMessageTimeEntries(raw, source.messages, () =>
            this.assertCurrent(job)
          )
          for (
            let index = 0;
            index < totalMessages || (index === 0 && totalMessages === 0);
            index += limits.rowsPerBatch
          ) {
            const end = Math.min(index + limits.rowsPerBatch, totalMessages)
            const entries = Array.from({ length: end - index }, (_, offset) =>
              timingEntry(index + offset)
            )
            const result = await this.command(job, {
              kind: "timing-page",
              checkpointId: source.checkpointId,
              timingToken,
              index,
              complete: end === totalMessages,
              entries
            })
            if (
              own(result, "nextIndex") !== end ||
              own(result, "complete") !== (end === totalMessages)
            )
              fail()
          }
        }
      } catch (error) {
        // An already complete transcript remains readable after native enrollment. Only the
        // optional timing write's exact native refusal is deferred; no source/IO/cancel error is.
        if (own(error, "code") !== "MODS_CONVERSATION_MIGRATION_REQUIRED") throw error
      }
    }
    this.assertCurrent(job)
    const runtimeTuple = readLatestCheckpointRuntimeTuple(
      request.databasePath,
      request.threadId,
      request.checkpointNs,
      request.cancellationBuffer
    )
    this.assertCurrent(job)
    return {
      runtimeTuple,
      stats: {
        checkpointId: source.checkpointId,
        totalMessages: source.kind === "source" ? source.messages.length : source.totalMessages,
        migratedMessages,
        batches,
        payloadBytes: source.kind === "source" ? source.payloadBytes : 0
      }
    }
  }
}
