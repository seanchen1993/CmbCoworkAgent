import { randomBytes } from "node:crypto"
import { isAbsolute } from "node:path"
import {
  MessageChannel,
  receiveMessageOnPort,
  type Worker,
  type WorkerOptions
} from "node:worker_threads"
import { BoundedWorkerAdmission } from "./bounded-worker-admission"
import { WorkspaceProbeError, type WorkspaceProbeRequest } from "./workspace-probe-protocol"

type WorkerFactory = (options: WorkerOptions, signal?: AbortSignal) => Worker | Promise<Worker>
let bundledFactory: WorkerFactory | undefined
const createBundledWorker: WorkerFactory = (options, signal) => {
  if (bundledFactory) return bundledFactory(options)
  return import("./workspace-probe-worker?nodeWorker").then((module) => {
    bundledFactory = module.default
    if (signal?.aborted) throw signal.reason
    if (process.hrtime.bigint() >= (options.workerData as WorkspaceProbeRequest).deadline)
      throw new WorkspaceProbeError("timeout")
    return bundledFactory(options)
  })
}
interface OwnedProbe {
  stop(): void
}

/** Only physical worker exit releases admission. A timed-out native call can remain owned. */
export class WorkspaceProbeClient {
  private readonly admission: BoundedWorkerAdmission
  private readonly owned = new Set<OwnedProbe>()
  private nextId = 0
  private closed = false

  constructor(
    private readonly factory: WorkerFactory = createBundledWorker,
    private readonly timeoutMs = 3_000,
    private readonly maxWorkers = 2,
    maxWaiters = 30
  ) {
    this.admission = new BoundedWorkerAdmission(maxWorkers, maxWaiters, "Workspace probe")
  }

  status() {
    return {
      active: this.admission.activeCount,
      queued: this.admission.waiterCount,
      owned: this.owned.size,
      closed: this.closed
    }
  }

  probe(workspace: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(this.abortError(signal))
    if (this.closed) return Promise.reject(new WorkspaceProbeError("unavailable"))
    const startedAt = process.hrtime.bigint()
    const deadline = startedAt + BigInt(this.timeoutMs) * 1_000_000n
    const id = ++this.nextId
    const generation = id
    const nonce = randomBytes(16).toString("hex")
    const controller = new AbortController()
    const immediate = this.admission.activeCount < this.maxWorkers
    const admission = this.admission.acquire(controller.signal)
    // Observe queue rejection immediately, even while a caller blocks the main event loop.
    void admission.catch(() => undefined)
    return new Promise<string>((resolve, reject) => {
      let settled = false,
        released = false,
        worker: Worker | undefined
      let port: MessageChannel["port1"] | undefined
      let stopRequested = false
      const finish = (error?: unknown, canonical?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        port?.close()
        if (error) reject(error)
        else resolve(canonical!)
      }
      const release = () => {
        if (released) return
        released = true
        this.owned.delete(owner)
        void admission.then(
          (release) => release(),
          () => undefined
        )
      }
      const terminate = () => {
        stopRequested = true
        // A pending/rejected termination is not physical exit and must retain its slot.
        if (worker) {
          try {
            void worker.terminate().catch(() => undefined)
          } catch {
            /* The exit listener still owns the physical slot. */
          }
        }
      }
      const fail = (error: unknown) => {
        finish(error)
        controller.abort()
        terminate()
      }
      const accept = (value: unknown) => {
        if (settled) return
        if (signal?.aborted || this.closed) {
          fail(signal?.aborted ? this.abortError(signal) : new WorkspaceProbeError("unavailable"))
          return
        }
        const response = value as Partial<
          import("./workspace-probe-protocol").WorkspaceProbeResponse
        >
        if (
          !response ||
          response.id !== id ||
          response.generation !== generation ||
          response.nonce !== nonce ||
          response.workspace !== workspace ||
          typeof response.completedAt !== "bigint" ||
          response.completedAt < startedAt ||
          !response.result ||
          typeof response.result !== "object"
        ) {
          fail(new WorkspaceProbeError("unavailable"))
        } else if (response.completedAt > deadline) fail(new WorkspaceProbeError("timeout"))
        else if (
          "canonical" in response.result &&
          typeof response.result.canonical === "string" &&
          isAbsolute(response.result.canonical)
        )
          finish(undefined, response.result.canonical)
        else if (
          "error" in response.result &&
          ["timeout", "not-directory", "unavailable"].includes(response.result.error)
        )
          finish(new WorkspaceProbeError(response.result.error))
        else fail(new WorkspaceProbeError("unavailable"))
      }
      const drain = () => {
        if (!port || settled) return
        const packet = receiveMessageOnPort(port)
        if (packet) accept(packet.message)
      }
      const abort = () => fail(this.abortError(signal))
      const owner: OwnedProbe = { stop: () => fail(new WorkspaceProbeError("unavailable")) }
      this.owned.add(owner)
      const timer = setTimeout(() => {
        // Timers may run before already-queued port callbacks after a blocked main loop.
        drain()
        if (!settled) fail(new WorkspaceProbeError("timeout"))
      }, this.timeoutMs)
      signal?.addEventListener("abort", abort, { once: true })
      const start = () => {
        if (settled || signal?.aborted || this.closed || process.hrtime.bigint() >= deadline) {
          if (!settled)
            fail(signal?.aborted ? this.abortError(signal) : new WorkspaceProbeError("timeout"))
          release()
          return
        }
        const channel = new MessageChannel()
        port = channel.port1
        port.on("message", accept)
        const request: WorkspaceProbeRequest = {
          id,
          generation,
          nonce,
          workspace,
          startedAt,
          deadline,
          port: channel.port2
        }
        const attach = (created: Worker) => {
          worker = created
          worker.once("exit", () => {
            drain()
            if (!settled) finish(new WorkspaceProbeError("unavailable"))
            release()
          })
          worker.on("error", () => fail(new WorkspaceProbeError("unavailable")))
          worker.unref()
          if (stopRequested || settled || this.closed || signal?.aborted) terminate()
        }
        try {
          const created = this.factory(
            {
              name: "workspace-access-probe",
              resourceLimits: {
                maxOldGenerationSizeMb: 16,
                maxYoungGenerationSizeMb: 4,
                stackSizeMb: 2
              },
              workerData: request,
              transferList: [channel.port2]
            },
            controller.signal
          )
          if (created instanceof Promise) {
            void created.then(attach, () => {
              channel.port2.close()
              fail(new WorkspaceProbeError("unavailable"))
              release()
            })
          } else attach(created)
        } catch {
          channel.port2.close()
          fail(new WorkspaceProbeError("unavailable"))
          release()
        }
      }
      // The original admission synchronously reserves an available slot. Start immediately:
      // deferring worker birth to a microtask would repeat the main-loop starvation bug.
      if (immediate) start()
      else
        void admission.then(start, (error) => {
          if (!settled)
            finish(
              controller.signal.aborted
                ? new WorkspaceProbeError("timeout")
                : new WorkspaceProbeError(
                    error?.name === "WORKER_ADMISSION_CAPACITY_EXCEEDED"
                      ? "capacity"
                      : "unavailable"
                  )
            )
          this.owned.delete(owner)
        })
    })
  }

  private abortError(signal?: AbortSignal): Error {
    return signal?.reason instanceof Error
      ? signal.reason
      : new DOMException("Aborted", "AbortError")
  }

  async close(waitMs = 100): Promise<void> {
    this.closed = true
    for (const owner of this.owned) owner.stop()
    const until = Date.now() + waitMs
    while (this.owned.size && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5))
    if (this.owned.size) throw new Error("Workspace probe cleanup remains unconfirmed")
  }
}

const client = new WorkspaceProbeClient()
export const probeWorkspaceDirectory = (workspace: string, signal?: AbortSignal) =>
  client.probe(workspace, signal)
export const closeWorkspaceProbeWorker = () => client.close()
