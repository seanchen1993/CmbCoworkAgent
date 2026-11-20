import { describe, expect, it } from "vitest"
import { LatestRequestGate } from "./latest-request-gate"
import { CurrentRequestCoalescer } from "./current-request-coalescer"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("CurrentRequestCoalescer", () => {
  it("coalesces a duplicate create while sandbox preparation is pending", async () => {
    const gate = new LatestRequestGate()
    const coalescer = new CurrentRequestCoalescer<{ success: boolean }>()
    const sandbox = deferred()
    let gitCreateCount = 0
    let rollbackCount = 0

    const create = (): Promise<{ success: boolean }> =>
      coalescer.run({
        scope: "thread",
        requestKey: "c:/repo\0feature/test",
        begin: () => gate.begin("thread"),
        isCurrent: (generation) => gate.isCurrent("thread", generation),
        finish: (generation) => gate.finish("thread", generation),
        run: async (generation) => {
          gitCreateCount += 1
          await sandbox.promise
          if (!gate.isCurrent("thread", generation)) {
            rollbackCount += 1
            return { success: false }
          }
          return { success: true }
        }
      })

    const first = create()
    const duplicate = create()
    expect(duplicate).toBe(first)
    await Promise.resolve()
    expect(gitCreateCount).toBe(1)

    sandbox.resolve()
    await expect(first).resolves.toEqual({ success: true })
    await expect(duplicate).resolves.toEqual({ success: true })
    expect(rollbackCount).toBe(0)
    expect(gate.retainedKeyCount).toBe(0)
    expect(coalescer.retainedScopeCount).toBe(0)
  })

  it("keeps different requests as latest-intent operations", async () => {
    const gate = new LatestRequestGate()
    const coalescer = new CurrentRequestCoalescer<string>()
    const firstSandbox = deferred()
    const secondSandbox = deferred()

    const create = (requestKey: string, sandbox: ReturnType<typeof deferred>): Promise<string> =>
      coalescer.run({
        scope: "thread",
        requestKey,
        begin: () => gate.begin("thread"),
        isCurrent: (generation) => gate.isCurrent("thread", generation),
        finish: (generation) => gate.finish("thread", generation),
        run: async (generation) => {
          await sandbox.promise
          return gate.isCurrent("thread", generation) ? requestKey : "superseded"
        }
      })

    const first = create("feature/a", firstSandbox)
    const second = create("feature/b", secondSandbox)
    secondSandbox.resolve()
    await expect(second).resolves.toBe("feature/b")
    firstSandbox.resolve()
    await expect(first).resolves.toBe("superseded")
    expect(gate.retainedKeyCount).toBe(0)
    expect(coalescer.retainedScopeCount).toBe(0)
  })
})
