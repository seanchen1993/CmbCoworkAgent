import { describe, expect, it } from "vitest"
import { PluginCatalogGate } from "./catalog-gate"
import { withPluginCatalogMutation } from "./catalog-mutation"

describe("plugin catalog admission", () => {
  it("holds an explicit Flow scope through asynchronous disposal", async () => {
    const gate = new PluginCatalogGate()
    let finish!: () => void
    const scope = await gate.run(
      async () => ({
        dispose: () =>
          new Promise<void>((resolve) => {
            finish = resolve
          })
      }),
      true
    )
    expect(gate.activityCount).toBe(1)
    const closing = scope.dispose()
    expect(gate.activityCount).toBe(1)
    finish()
    await closing
    expect(gate.activityCount).toBe(0)
  })

  it("refuses active work and retains occupancy until actual finally", async () => {
    const gate = new PluginCatalogGate()
    let finish!: () => void
    const running = gate.run(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    expect(() =>
      gate.commit(
        () => {},
        () => {}
      )
    ).toThrow("PLUGIN_CATALOG_BUSY")
    finish()
    await running
    expect(
      gate.commit(
        () => {},
        () => "applied"
      )
    ).toBe("applied")
  })

  it("retains streams through yielded cleanup and releases exactly once", async () => {
    const gate = new PluginCatalogGate()
    async function* operation() {
      try {
        yield "work"
      } finally {
        yield "cleanup"
      }
    }
    const stream = await gate.run(async () => operation())
    await stream.next()
    expect(await stream.return(undefined as never)).toEqual({ done: false, value: "cleanup" })
    expect(() =>
      gate.commit(
        () => {},
        () => {}
      )
    ).toThrow("PLUGIN_CATALOG_BUSY")
    await stream.next()
    expect(gate.activityCount).toBe(0)
    await stream.return(undefined as never)
    expect(gate.activityCount).toBe(0)
  })

  it("blocks reentrant admissions during the idle check and commit", () => {
    const gate = new PluginCatalogGate()
    gate.commit(
      () => {
        expect(() => gate.retain()).toThrow("PLUGIN_CATALOG_APPLYING")
      },
      () => {
        expect(() =>
          gate.commit(
            () => {},
            () => {}
          )
        ).toThrow("PLUGIN_CATALOG_APPLYING")
      }
    )
    const release = gate.retain()
    release()
    release()
    expect(gate.activityCount).toBe(0)
  })

  it("reopens admission after failed external idle checks, writes and operations", async () => {
    const gate = new PluginCatalogGate()
    expect(() =>
      gate.commit(
        () => {
          throw Error("task busy")
        },
        () => {}
      )
    ).toThrow("task busy")
    expect(() =>
      gate.commit(
        () => {},
        () => {
          throw Error("disk")
        }
      )
    ).toThrow("disk")
    await expect(
      gate.run(async () => {
        throw Error("runtime")
      })
    ).rejects.toThrow("runtime")
    expect(gate.activityCount).toBe(0)
    expect(
      gate.commit(
        () => {},
        () => true
      )
    ).toBe(true)
  })

  it("serializes different writer entry points and releases after failure", async () => {
    const events: string[] = []
    let finish!: () => void
    const first = withPluginCatalogMutation(async () => {
      events.push("first")
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      throw Error("failed write")
    })
    const second = withPluginCatalogMutation(async () => {
      events.push("second")
    })
    await Promise.resolve()
    expect(events).toEqual(["first"])
    finish()
    await expect(first).rejects.toThrow("failed write")
    await second
    expect(events).toEqual(["first", "second"])
  })
})
