import { EventEmitter } from "node:events"
import type { Worker, WorkerOptions } from "node:worker_threads"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

class FixtureWorker extends EventEmitter {
  request: { type: string; requestId: number; threadId: string } | undefined
  terminations = 0

  unref(): this {
    return this
  }

  postMessage(request: NonNullable<FixtureWorker["request"]>): void {
    this.request = request
  }

  reply(): void {
    if (!this.request) throw Error("Fixture has not received a request")
    this.emit(
      "message",
      this.request.type === "read"
        ? {
            requestId: this.request.requestId,
            ok: true,
            manifests: { kept: this.request.threadId }
          }
        : { type: "complete", requestId: this.request.requestId, stats: { rowCount: 0 } }
    )
  }

  async terminate(): Promise<number> {
    this.terminations++
    return 0
  }
}

const definitions = [
  {
    name: "startup",
    query: "../subagent-transcript-startup/worker?nodeWorker",
    async load() {
      const module = await import("../subagent-transcript-startup/client")
      const client = new module.SubagentTranscriptStartupClient(undefined, () => "fixture.sqlite")
      return {
        read: (id: string, signal?: AbortSignal) => client.read(id, { signal }),
        cancelled: module.SubagentTranscriptStartupCancelledError,
        workerName: "subagent-transcript-startup",
        limits: module.SUBAGENT_TRANSCRIPT_STARTUP_WORKER_RESOURCE_LIMITS,
        expected: [{ kept: "retry-0" }, { kept: "retry-1" }]
      }
    }
  },
  {
    name: "migration",
    query: "../legacy-subagent-migration/legacy-subagent-migration-worker?nodeWorker",
    async load() {
      const module = await import("../legacy-subagent-migration/parser-client")
      const client = new module.LegacySubagentMigrationParserClient(
        undefined,
        () => "fixture.sqlite",
        () => "fixture-content"
      )
      return {
        read: (id: string, signal?: AbortSignal) => client.parse(id, async () => undefined, signal),
        cancelled: module.LegacySubagentMigrationCancelledError,
        workerName: "legacy-subagent-migration",
        limits: module.LEGACY_SUBAGENT_MIGRATION_WORKER_RESOURCE_LIMITS,
        expected: [{ rowCount: 0 }, { rowCount: 0 }]
      }
    }
  }
]

beforeEach(() => vi.resetModules())
afterEach(() => {
  for (const definition of definitions) vi.doUnmock(definition.query)
  vi.resetModules()
})

function workerFixture() {
  const workers: FixtureWorker[] = []
  const construct = vi.fn((options?: WorkerOptions) => {
    void options
    const worker = new FixtureWorker()
    workers.push(worker)
    return worker as unknown as Worker
  })
  return { workers, construct }
}

async function verifyRecoveredAdmission(
  client: Awaited<ReturnType<(typeof definitions)[number]["load"]>>,
  fixture: ReturnType<typeof workerFixture>
) {
  const controllers = [new AbortController(), new AbortController()]
  const failures: string[] = []
  const retries: Promise<unknown>[] = []
  const start = (index: number) => {
    const controller = controllers[index]
    const read = client.read(`retry-${index}`, controller.signal)
    void read.catch((error) => failures.push(String(error)))
    retries.push(read)
  }
  try {
    start(0)
    await vi.waitFor(() => {
      expect(failures).toEqual([])
      expect(fixture.workers.filter((worker) => worker.request)).toHaveLength(1)
    })
    // Keep the first workload active, but let its import finish before importing again.
    // Vitest's manual mock callstack deliberately bypasses concurrent imports of one ID.
    start(1)
    await vi.waitFor(() => {
      expect(failures).toEqual([])
      expect(fixture.workers.filter((worker) => worker.request)).toHaveLength(2)
    })
    expect(fixture.construct).toHaveBeenCalledTimes(2)
    for (const [options] of fixture.construct.mock.calls) {
      expect(options).toEqual({ name: client.workerName, resourceLimits: client.limits })
    }
    fixture.workers.forEach((worker) => worker.reply())
    await expect(Promise.all(retries)).resolves.toEqual(client.expected)
    expect(fixture.workers.every((worker) => worker.terminations === 1)).toBe(true)
  } finally {
    controllers.forEach((controller) => controller.abort())
    fixture.workers
      .filter((worker) => worker.request && worker.terminations === 0)
      .forEach((worker) => worker.reply())
    await Promise.allSettled(retries)
  }
}

describe.each(definitions)("$name bundled worker loading", (definition) => {
  it("does not construct after cancellation during the actual default factory import", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>()
    const fixture = workerFixture()
    const loading = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return { default: fixture.construct }
    })
    vi.doMock(definition.query, loading)
    const client = await definition.load()
    const controller = new AbortController()
    const read = client.read("cancel-during-import", controller.signal)
    const rejected = expect(read).rejects.toBeInstanceOf(client.cancelled)
    try {
      await vi.waitFor(() => expect(loading).toHaveBeenCalledTimes(1))
      await entered.promise
      controller.abort()
      release.resolve()
      await rejected
      expect(fixture.construct).not.toHaveBeenCalled()
      await verifyRecoveredAdmission(client, fixture)
    } finally {
      controller.abort()
      release.resolve()
      await Promise.allSettled([read, rejected])
    }
  })

  it("preserves loading failure and releases both admission slots on the same client", async () => {
    const loadError = new Error("fixture module loading failed")
    const loading = vi.fn(async () => {
      throw loadError
    })
    vi.doMock(definition.query, loading)
    const client = await definition.load()
    const failed = await client.read("failed-load").then(
      () => undefined,
      (error) => error
    )
    expect(failed).toBeInstanceOf(Error)
    expect(failed.cause).toBe(loadError)
    expect(loading).toHaveBeenCalledTimes(1)
    // Only repair the fixture's import cache. Keep the existing client's admission instance.
    vi.doUnmock(definition.query)
    vi.resetModules()
    const fixture = workerFixture()
    vi.doMock(definition.query, () => ({ default: fixture.construct }))
    await verifyRecoveredAdmission(client, fixture)
  })
})

it("only constructs the latest scoped read after a cold import while another read is active", async () => {
  const fixture = workerFixture()
  const query = definitions[0].query
  vi.doMock(query, () => ({ default: fixture.construct }))
  const module = await import("../subagent-transcript-startup/client")
  const client = new module.SubagentTranscriptStartupClient(undefined, () => "fixture.sqlite")
  const reads: Promise<unknown>[] = []
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>()
  try {
    const blocker = client.read("unrelated-active")
    reads.push(blocker)
    void blocker.catch(() => undefined)
    await vi.waitFor(() =>
      expect(fixture.workers.filter((worker) => worker.request)).toHaveLength(1)
    )
    // Simulate a cold loader while preserving this client's real admission and scope maps.
    vi.doUnmock(query)
    vi.resetModules()
    const loading = vi.fn(async () => {
      entered.resolve()
      await release.promise
      return { default: fixture.construct }
    })
    vi.doMock(query, loading)
    const obsolete = client.read("obsolete", { scope: "foreground" })
    reads.push(obsolete)
    const cancelled = expect(obsolete).rejects.toBeInstanceOf(
      module.SubagentTranscriptStartupCancelledError
    )
    reads.push(cancelled)
    await vi.waitFor(() => expect(loading).toHaveBeenCalledTimes(1))
    await entered.promise
    const latest = client.read("latest", { scope: "foreground" })
    reads.push(latest)
    void latest.catch(() => undefined)
    release.resolve()
    await cancelled
    await vi.waitFor(() =>
      expect(fixture.workers.filter((worker) => worker.request)).toHaveLength(2)
    )
    expect(fixture.construct).toHaveBeenCalledTimes(2)
    expect(fixture.workers.map((worker) => worker.request?.threadId)).toEqual([
      "unrelated-active",
      "latest"
    ])
    fixture.workers.forEach((worker) => worker.reply())
    await expect(blocker).resolves.toEqual({ kept: "unrelated-active" })
    await expect(latest).resolves.toEqual({ kept: "latest" })
    expect(fixture.workers.every((worker) => worker.terminations === 1)).toBe(true)
  } finally {
    release.resolve()
    const closing = client.close()
    fixture.workers
      .filter((worker) => worker.request && worker.terminations === 0)
      .forEach((worker) => worker.reply())
    await closing
    await Promise.allSettled(reads)
  }
})
