import { EventEmitter, errorMonitor } from "node:events"
import { runInNewContext } from "node:vm"
import { describe, expect, it, vi } from "vitest"
import {
  installSnapshotWorkerTrace,
  type SnapshotTraceGlobal
} from "../../../tests/support/stream-snapshot-worker-trace"

class FixtureWorker extends EventEmitter {
  constructor(
    readonly threadId: number,
    readonly threadName = "thread-message-hydration"
  ) {
    super()
  }
}

function fixture() {
  const records: Array<Record<string, unknown>> = []
  const subscribers = new Set<(message: unknown) => void>()
  const contents = new EventEmitter()
  const io = { fail: false, attempted: 0 }
  const modules = {
    fs: {
      appendFileSync(filename: string, line: string) {
        expect(filename).toBe("owned.ndjson")
        io.attempted++
        if (io.fail) throw Error("private error must not escape or be recorded")
        records.push(JSON.parse(line))
      }
    },
    diagnostics_channel: {
      subscribe(_name: string, subscriber: (message: unknown) => void) {
        subscribers.add(subscriber)
      },
      unsubscribe(_name: string, subscriber: (message: unknown) => void) {
        subscribers.delete(subscriber)
      }
    },
    events: { errorMonitor },
    worker_threads: { Worker: FixtureWorker }
  }
  const context: SnapshotTraceGlobal & Record<string, unknown> = {
    process: {
      pid: 100,
      hrtime: process.hrtime,
      getBuiltinModule(name: keyof typeof modules) {
        return modules[name]
      }
    }
  }
  const install = runInNewContext(`(${installSnapshotWorkerTrace.toString()})`, context)
  Reflect.apply(install, null, [
    { BrowserWindow: { getAllWindows: () => [{ webContents: contents }] } },
    "owned.ndjson"
  ])
  const api = context.snapshotWorkerTrace
  if (!api) throw Error("Serialized installer did not publish its observer")
  return {
    records,
    subscribers,
    contents,
    io,
    api,
    publish(worker: FixtureWorker) {
      for (const subscriber of subscribers) subscriber({ worker })
    }
  }
}

describe("serialized snapshot Worker observer", () => {
  it("observes fixed catalog and workspace names without admitting unrelated names", () => {
    const f = fixture()
    for (const [id, name] of [
      [10, "plugin-catalog"],
      [11, "workspace-watcher"]
    ] as const) {
      const worker = new FixtureWorker(id, name)
      f.publish(worker)
      worker.emit("online")
      worker.emit("exit", 0)
    }
    f.publish(new FixtureWorker(12, "cmb-native-policy"))
    expect(
      f.records.filter((record) => record.event === "worker-created").map((record) => record.name)
    ).toEqual(["plugin-catalog", "workspace-watcher"])
    expect(f.api.close()).toMatchObject({ detached: true, unknownWorkers: 1 })
    expect(JSON.stringify(f.records)).not.toContain("cmb-native-policy")
  })

  it("records public lifecycle and preserves original listeners and unhandled errors", () => {
    const f = fixture()
    const worker = new FixtureWorker(7, "[worker 7] thread-message-hydration")
    const originalOnline = vi.fn()
    worker.on("online", originalOnline)
    f.publish(worker)
    worker.emit("online")
    expect(() => worker.emit("error", Error("private worker payload"))).toThrow(
      "private worker payload"
    )
    f.api.mark("before-first-crash")
    f.contents.emit("render-process-gone", null, { exitCode: 2 })
    worker.emit("exit", 0)
    const summary = f.api.close()
    expect(summary).toMatchObject({
      detached: true,
      observationFailed: false,
      remainingReferences: 0
    })
    expect(f.records.map((record) => record.event)).toEqual([
      "observer-attached",
      "worker-created",
      "worker-online",
      "worker-error",
      "phase",
      "renderer-gone",
      "worker-exit",
      "observer-detached"
    ])
    expect(f.records.find((record) => record.event === "worker-exit")?.threadId).toBe(7)
    expect(JSON.stringify(f.records)).not.toContain("private worker payload")
    expect(worker.listeners("online")).toEqual([originalOnline])
    expect(worker.listenerCount("error")).toBe(0)
    expect(worker.listenerCount(errorMonitor)).toBe(0)
    expect(f.contents.eventNames()).toEqual([])
    expect(f.subscribers.size).toBe(0)
  })

  it("contains trace I/O failure and bounds attempts without altering the producer", () => {
    const f = fixture()
    f.io.fail = true
    const worker = new FixtureWorker(8)
    expect(() => f.publish(worker)).not.toThrow()
    for (let index = 0; index < 300; index++) worker.emit("online")
    const summary = f.api.close()
    expect(summary.observationFailed).toBe(true)
    expect(summary.dropped).toBeGreaterThan(0)
    expect(f.io.attempted).toBeLessThanOrEqual(256)
    expect(worker.eventNames()).toEqual([])
    expect(f.subscribers.size).toBe(0)
  })

  it("bounds live references and excludes unknown names without recording them", () => {
    const f = fixture()
    f.publish(new FixtureWorker(1, "thread-message-hydration-secret"))
    const workers = Array.from({ length: 65 }, (_unused, index) => new FixtureWorker(index + 2))
    for (const worker of workers) f.publish(worker)
    expect(workers[64].eventNames()).toEqual([])
    const summary = f.api.close()
    expect(summary).toMatchObject({
      detached: true,
      unknownWorkers: 1,
      dropped: 1,
      remainingReferences: 0
    })
    expect(JSON.stringify(f.records)).not.toContain("secret")
    const unmatched = f.records.find((record) => record.event === "unmatched-worker")
    expect(unmatched).toMatchObject({ unknownWorkers: 1 })
    expect(unmatched).not.toHaveProperty("name")
    expect(unmatched).not.toHaveProperty("threadId")
    for (const worker of workers) expect(worker.eventNames()).toEqual([])
  })
})
