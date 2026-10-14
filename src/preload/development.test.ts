import { describe, expect, it, vi } from "vitest"
import { createDevelopmentBridge } from "./development"

describe("development preload bridge", () => {
  it("forwards scoped actions without sending a model message or installing", async () => {
    const invoke = vi.fn(async (channel: string, input: unknown) => {
      void channel
      void input
      return {}
    })
    const api = createDevelopmentBridge(invoke, () => () => {})
    await api.status({ threadId: "thread" })
    await api.setEnabled({ threadId: "thread", expectedWorkspace: "workspace", enabled: true })
    await api.approve({
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "component",
      revision: 2,
      digest: "digest"
    })
    await api.stop({ threadId: "thread", expectedWorkspace: "workspace", id: "component" })
    await api.promote({
      threadId: "thread",
      expectedWorkspace: "workspace",
      id: "draft",
      revision: 2
    })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "mods:development:status",
      "mods:development:set-enabled",
      "mods:development:approve",
      "mods:development:stop",
      "mods:development:promote"
    ])
    expect(invoke.mock.calls[2][1]).toMatchObject({ revision: 2, digest: "digest" })
  })
  it("forwards only a thread change and exposes owned unsubscribe", () => {
    let deliver: (payload: unknown) => void = () => {}
    const unsubscribe = vi.fn(),
      callback = vi.fn()
    const subscribe = vi.fn((_channel: string, listener: (payload: unknown) => void) => {
      deliver = listener
      return unsubscribe
    })
    const api = createDevelopmentBridge(async () => undefined, subscribe)
    const close = api.onChanged(callback)
    deliver(null)
    deliver({ other: "thread" })
    deliver({ threadId: 7 })
    deliver({ threadId: "thread", raw: "must not forward" })
    expect(callback.mock.calls).toEqual([[{ threadId: "thread" }]])
    expect(subscribe.mock.calls[0][0]).toBe("mods:development-changed")
    close()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
