import { expect, it, vi } from "vitest"
import { createEditorNavigationBridge } from "./developer-editor"
import type { DeveloperEditorEvent } from "../shared/mods/v2/developer-editor"

it("subscribes without launching or accepting navigation and releases the exact event listener", async () => {
  const invoke = vi
    .fn<(channel: string, input: unknown) => Promise<unknown>>()
    .mockResolvedValue(undefined)
  const listeners = new Set<(event: DeveloperEditorEvent) => void>()
  const api = createEditorNavigationBridge(invoke, (callback) => {
    listeners.add(callback)
    return () => {
      listeners.delete(callback)
    }
  })
  const callback = vi.fn()
  const stop = api.onEditorNavigation(callback)
  const event: DeveloperEditorEvent = { kind: "retire", id: "owned" }
  listeners.forEach((listener) => listener(event))
  expect(callback).toHaveBeenCalledExactlyOnceWith(event)
  expect(invoke).not.toHaveBeenCalled()
  stop()
  expect(listeners.size).toBe(0)
  listeners.forEach((listener) => listener(event))
  expect(callback).toHaveBeenCalledTimes(1)
  const ack = {
    id: "owned",
    fingerprint: "sha",
    status: "preview-loaded" as const,
    line: 2,
    column: 3
  }
  await api.editorNavigationAccept("owned")
  await api.editorNavigationAck(ack)
  await api.editorNavigationLaunchExternal("owned")
  await api.editorNavigationClose("owned")
  expect(invoke.mock.calls).toEqual([
    ["mods:editor-navigation-accept", { id: "owned" }],
    ["mods:editor-navigation-ack", ack],
    ["mods:editor-navigation-launch-external", { id: "owned" }],
    ["mods:editor-navigation-close", { id: "owned" }]
  ])
  expect(api).not.toHaveProperty("invoke")
})
