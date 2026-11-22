import { describe, expect, it } from "vitest"
import { botBrowserScopeIdentifier, botIdentifier } from "./validation"
import { botImBrowserScope } from "./im-channel"

describe("browser scope IPC validation", () => {
  it("bounds each identity instead of rejecting a valid composite audience", () => {
    const id = "a".repeat(128)
    const values = [id, `work-${id}--${id}`, `group-${id}--${id}`,
      botImBrowserScope(id, id),
      botImBrowserScope(id, id, id, `im-peer-${id}-${id}`)]
    for (const value of values) expect(botBrowserScopeIdentifier(value)).toBe(value)
    expect(() => botIdentifier(values.at(-1))).toThrow()
  })
  it.each([
    null, {}, "", "../bot", "a".repeat(129),
    `im-${"b".repeat(129)}--owner`, `im-binding--${"b".repeat(129)}`,
    "im-binding--owner--", "im-binding--owner--executor--im-peer-root-other",
    "im-binding--owner--executor--im-peer-root-executor--extra",
    `im-binding--owner--executor--im-peer-${"r".repeat(266)}-executor`,
    "im-binding--owner--executor--../executor", "im-binding-- owner",
    "group-one", "group-one--two--three", "work-one--two--three"
  ])("rejects malformed or oversized audiences: %s", (value) => {
    expect(() => botBrowserScopeIdentifier(value)).toThrow()
  })
})
