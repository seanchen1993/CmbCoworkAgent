import { describe, expect, it } from "vitest"
import { editorNavigationScopeKey } from "./developer-editor"

describe("native editor thread birth identity", () => {
  it("unifies DB epochs, native Date and canonical ISO without changing the token", () => {
    const epoch = 1793541870927
    for (const token of [null, "current-token", "  exact token  "])
      for (const birth of [epoch, new Date(epoch), new Date(epoch).toISOString()])
        expect(editorNavigationScopeKey(birth, token)).toBe(JSON.stringify([epoch, token]))
    expect(editorNavigationScopeKey(0, null)).toBe("[0,null]")
    expect(editorNavigationScopeKey(8_640_000_000_000_000, null)).not.toBeNull()
  })

  it("rejects malformed timestamps and missing or invalid tokens", () => {
    for (const birth of [
      undefined,
      null,
      false,
      NaN,
      Infinity,
      -1,
      0.5,
      Number.MAX_SAFE_INTEGER,
      8_640_000_000_000_001,
      new Date(NaN),
      "2026-11-01",
      "1793541870927",
      "2026-11-01T00:00:00Z",
      "2026-11-01T00:00:00.000+00:00",
      " 2026-11-01T00:00:00.000Z"
    ])
      expect(editorNavigationScopeKey(birth, null)).toBeNull()
    for (const token of [undefined, "", 1, false, {}, []])
      expect(editorNavigationScopeKey(1, token)).toBeNull()
  })

  it("never invokes object coercion or overridden Date accessors", () => {
    let calls = 0
    const object = {
      valueOf() {
        calls++
        return 1
      },
      toString() {
        calls++
        return "1970-01-01T00:00:00.001Z"
      }
    }
    expect(editorNavigationScopeKey(object, null)).toBeNull()
    const date = new Date(1)
    date.getTime = () => {
      calls++
      throw Error("override must not run")
    }
    date.toJSON = () => {
      calls++
      throw Error("override must not run")
    }
    expect(editorNavigationScopeKey(date, null)).toBe("[1,null]")
    const proxy = new Proxy(
      {},
      {
        get() {
          calls++
          throw Error("proxy must not run")
        }
      }
    )
    expect(editorNavigationScopeKey(proxy, null)).toBeNull()
    expect(calls).toBe(0)
  })

  it("keeps changed births and tokens distinct, including legacy null tokens", () => {
    const original = editorNavigationScopeKey(new Date(1), "token")
    expect(editorNavigationScopeKey(2, "token")).not.toBe(original)
    expect(editorNavigationScopeKey(1, "other")).not.toBe(original)
    expect(editorNavigationScopeKey(1, null)).not.toBe(original)
  })
})
