import { describe, expect, it } from "vitest"
import { LatestRequestGate } from "./latest-request-gate"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("LatestRequestGate", () => {
  it("prevents an older sandbox preparation from committing after a newer request", async () => {
    const gate = new LatestRequestGate()
    const oldSandbox = deferred()
    const newSandbox = deferred()
    let workspace = "initial"

    const run = async (next: string, sandbox: ReturnType<typeof deferred>): Promise<void> => {
      const generation = gate.begin("thread")
      try {
        await sandbox.promise
        if (!gate.isCurrent("thread", generation)) return
        workspace = next
      } finally {
        gate.finish("thread", generation)
      }
    }

    const oldRequest = run("A", oldSandbox)
    const newRequest = run("B", newSandbox)
    newSandbox.resolve()
    await newRequest
    oldSandbox.resolve()
    await oldRequest

    expect(workspace).toBe("B")
    expect(gate.retainedKeyCount).toBe(0)
  })

  it("keeps recent-workspace on B when watcher A completes after watcher B", async () => {
    const gate = new LatestRequestGate()
    const watcherA = deferred()
    const watcherB = deferred()
    let boundWorkspace = "initial"
    let recentWorkspace = "initial"

    const run = async (next: string, watcher: ReturnType<typeof deferred>): Promise<void> => {
      const generation = gate.begin("thread")
      try {
        if (!gate.isCurrent("thread", generation)) return
        boundWorkspace = next
        await watcher.promise
        if (gate.isCurrent("thread", generation) && boundWorkspace === next) {
          recentWorkspace = next
        }
      } finally {
        gate.finish("thread", generation)
      }
    }

    const oldRequest = run("A", watcherA)
    const newRequest = run("B", watcherB)
    watcherB.resolve()
    await newRequest
    watcherA.resolve()
    await oldRequest

    expect(boundWorkspace).toBe("B")
    expect(recentWorkspace).toBe("B")
    expect(gate.retainedKeyCount).toBe(0)
  })

  it("does not let model A's late thread read overwrite the newer model B intent", async () => {
    const gate = new LatestRequestGate()
    const readA = deferredValue<{ model?: string }>()
    const readB = deferredValue<{ model?: string }>()
    let persistedModel = "initial"

    const selectModel = async (
      model: string,
      read: ReturnType<typeof deferredValue<{ model?: string }>>
    ): Promise<void> => {
      const generation = gate.begin("thread")
      try {
        const metadata = await read.promise
        if (!gate.isCurrent("thread", generation) || metadata.model === model) return
        persistedModel = model
      } finally {
        gate.finish("thread", generation)
      }
    }

    const oldSelection = selectModel("A", readA)
    const newSelection = selectModel("B", readB)
    readB.resolve({ model: "initial" })
    await newSelection
    readA.resolve({ model: "initial" })
    await oldSelection

    expect(persistedModel).toBe("B")
  })

  it("keeps an old same-id durable snapshot stale across cleanup and recreation", async () => {
    const gate = new LatestRequestGate()
    const oldRead = deferredValue<string[]>()
    let transcript = ["old-shell"]

    const oldGeneration = gate.begin("fixed-thread-id")
    const oldSnapshot = (async () => {
      const messages = await oldRead.promise
      if (!gate.isCurrent("fixed-thread-id", oldGeneration)) return false
      transcript = messages
      return true
    })()

    // Permanent cleanup invalidates the old continuation without resetting the
    // process-wide counter. A same-id replacement can then start at a fresh token.
    const cleanupGeneration = gate.begin("fixed-thread-id")
    gate.finish("fixed-thread-id", cleanupGeneration)
    const replacementGeneration = gate.begin("fixed-thread-id")
    transcript = ["replacement"]

    oldRead.resolve(["stale-row"])
    await expect(oldSnapshot).resolves.toBe(false)
    expect(gate.isCurrent("fixed-thread-id", replacementGeneration)).toBe(true)
    expect(transcript).toEqual(["replacement"])
  })
})
