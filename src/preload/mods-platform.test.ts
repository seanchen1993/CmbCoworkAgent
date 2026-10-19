import { expect, it, vi } from "vitest"
import { createPlatformBridge } from "./mods-platform"

it("forwards bounded native addresses and explicit selection without exposing arbitrary IPC", async () => {
  const invoke = vi.fn(async () => undefined)
  const api = createPlatformBridge(invoke)
  const address = { key: "native-key", revision: 3 }
  await api.platformSurfaceList("thread")
  await api.platformSurfaceOpen("thread", address, "intent")
  await api.platformSurfaceClose("thread", address)
  await api.platformBehaviorPreview("thread", ["provider/behavior"])
  await api.platformBehaviorApply("thread", "preview", 3)
  expect(invoke.mock.calls).toEqual([
    ["mods:platform-surface-list", { threadId: "thread" }],
    ["mods:platform-surface-open", { threadId: "thread", address, intentId: "intent" }],
    ["mods:platform-surface-close", { threadId: "thread", address }],
    ["mods:platform-behavior-preview", { threadId: "thread", selected: ["provider/behavior"] }],
    ["mods:platform-behavior-apply", { threadId: "thread", previewId: "preview", revision: 3 }]
  ])
  expect(Object.keys(api)).toHaveLength(11)
})
