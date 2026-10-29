import { describe, expect, it } from "vitest"
import { projectChatVirtualWindow } from "./chat-virtual-window"

describe("chat virtual measured window", () => {
  it("keeps absolute measured row identities through prepend, append and prefix release", () => {
    const initial = projectChatVirtualWindow(null, "chat", ["a", "b", "c"])
    const prepended = projectChatVirtualWindow(initial, "chat", [
      "older-1",
      "older-2",
      "a",
      "b",
      "c"
    ])
    expect(prepended.key).toBe(initial.key)
    expect(prepended.firstItemIndex + 3).toBe(initial.firstItemIndex + 1)
    const appended = projectChatVirtualWindow(prepended, "chat", [...prepended.identities, "d"])
    expect(appended.key).toBe(initial.key)
    expect(appended.firstItemIndex).toBe(prepended.firstItemIndex)
    const released = projectChatVirtualWindow(appended, "chat", ["a", "b", "c", "d"])
    expect(released.key).toBe(initial.key)
    expect(released.firstItemIndex + 1).toBe(initial.firstItemIndex + 1)
  })

  it("does not reuse measurements across reordered, internally edited or unrelated windows", () => {
    const initial = projectChatVirtualWindow(null, "chat", ["a", "b", "c"])
    for (const identities of [
      ["b", "a", "c"],
      ["a", "new", "c"],
      ["a", "c"],
      ["x", "y"]
    ]) {
      expect(projectChatVirtualWindow(initial, "chat", identities).key).not.toBe(initial.key)
    }
    expect(projectChatVirtualWindow(initial, "other-chat", initial.identities).key).not.toBe(
      initial.key
    )
  })

  it("clears stale measurements after empty history or an exhausted index margin", () => {
    const initial = projectChatVirtualWindow(null, "chat", ["a", "b"])
    const empty = projectChatVirtualWindow(initial, "chat", [])
    expect(empty.key).not.toBe(initial.key)
    expect(projectChatVirtualWindow(empty, "chat", ["a", "b"]).key).not.toBe(initial.key)
    const exhausted = projectChatVirtualWindow({ ...initial, firstItemIndex: 1 }, "chat", [
      "older",
      "a",
      "b"
    ])
    expect(exhausted.firstItemIndex).toBeGreaterThan(1)
    expect(exhausted.key).not.toBe(initial.key)
  })

  it("does not assign a released historical prefix's sizes to a restored latest page", () => {
    const historical = projectChatVirtualWindow(null, "chat", [
      ...Array.from({ length: 872 }, (_, index) => `message-${index}`),
      ...Array.from({ length: 320 }, (_, index) => `message-${1680 + index}`)
    ])
    const latest = projectChatVirtualWindow(
      historical,
      "chat",
      Array.from({ length: 500 }, (_, index) => `message-${1500 + index}`)
    )

    // A net trim of 692 would reuse message-692's measured slot for message-1500,
    // although only the tail starting at message-1680 is common to both windows.
    expect(latest.key).not.toBe(historical.key)
    expect(latest.firstItemIndex).toBe(10_000)
    expect(latest.identities.at(-1)).toBe("message-1999")
  })

  it("preserves an unchanged projection and rejects ambiguous overlapping identities", () => {
    const initial = projectChatVirtualWindow(null, "chat", ["user:id", "tool:id:occurrence-1"])
    expect(projectChatVirtualWindow(initial, "chat", [...initial.identities])).toBe(initial)
    expect(projectChatVirtualWindow(initial, "chat", ["tool:id:occurrence-2"])).not.toBe(initial)
    expect(projectChatVirtualWindow(initial, "chat", ["user:id", "user:id"]).key).not.toBe(
      initial.key
    )
  })
})
