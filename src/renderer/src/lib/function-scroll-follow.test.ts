import { afterEach, expect, it, vi } from "vitest"
import { FunctionScrollFollow } from "./function-scroll-follow"
import type { FunctionPaneSnapshot } from "../../../shared/mods/v2/ui"

class TestNode {
  scrollTop = 900
  scrollHeight = 1000
  clientHeight = 100
  isConnected = true
  firstElementChild = null
  contains(node: unknown) {
    return node === this
  }
}
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  vi.stubGlobal("Node", TestNode)
  vi.stubGlobal("KeyboardEvent", class extends Event {})
  vi.stubGlobal("document", { visibilityState: "visible" })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = vi.fn()
      disconnect = vi.fn()
    }
  )
  const body = new TestNode() as unknown as HTMLElement
  const sections = new Map([["pane", { querySelector: () => body } as unknown as HTMLElement]])
  const follow = new FunctionScrollFollow()
  const sync = (id: string) =>
    follow.sync([{ key: "pane", scrollFollowToken: id } as FunctionPaneSnapshot], sections)
  return { body, follow, sync }
}
it("records person movement while acknowledgement is pending and never re-enables follow afterward", async () => {
  const f = fixture()
  let acknowledge!: () => void
  const response = new Promise<void>((resolve) => {
    acknowledge = resolve
  })
  const waiting = f.follow.acknowledge("pane", "request", f.body, true, () => response)
  const wheel = new Event("wheel")
  Object.defineProperty(wheel, "target", { value: f.body })
  f.body.scrollTop = 700
  f.follow.observe(wheel)
  acknowledge()
  await waiting
  f.sync("request")
  expect(f.body.scrollTop).toBe(700)
  f.follow.close()
})
it("does not let an older failed acknowledgement cancel a newer follow request", async () => {
  const f = fixture()
  let reject!: (error: Error) => void
  const failure = new Promise<void>((_resolve, no) => {
    reject = no
  })
  const old = f.follow.acknowledge("pane", "old", f.body, true, () => failure)
  const rejected = expect(old).rejects.toThrow("old failed")
  await f.follow.acknowledge("pane", "new", f.body, true, async () => undefined)
  reject(Error("old failed"))
  await rejected
  Object.defineProperty(f.body, "scrollHeight", { value: 1200 })
  f.sync("new")
  expect(f.body.scrollTop).toBe(1100)
  f.follow.close()
})
