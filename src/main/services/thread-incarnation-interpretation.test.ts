import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const key = "cmb_thread_incarnation"
beforeEach(() => vi.resetModules())
afterEach(() => vi.restoreAllMocks())

async function interpreted() {
  // Capture a counted, unchanged parser at module initialization. Late replacements
  // must not change this fixed text interpretation or read current database facts for it.
  const parse = vi.spyOn(JSON, "parse")
  const api = await import("./thread-incarnation")
  return {
    ...api,
    calls: (raw: string) => parse.mock.calls.filter(([text]) => text === raw).length
  }
}

describe("bounded exact-text incarnation interpretation", () => {
  it("decodes repeated large text once without retaining a match or a stale row", async () => {
    const api = await interpreted()
    const initial = JSON.stringify({ [key]: "first", payload: "x".repeat(65000) })
    const changed = JSON.stringify({ [key]: "first", payload: "y".repeat(90000) })
    const replaced = JSON.stringify({ [key]: "replacement", payload: "y".repeat(90000) })
    const expected = { token: "first", legacyCreatedAt: 77 }
    let metadata = initial
    let reads = 0
    const row = {
      created_at: 77,
      get metadata() {
        reads++
        return metadata
      }
    }
    for (let index = 0; index < 40; index++)
      expect(api.matchesThreadIncarnation(row, expected)).toBe(true)
    expect(reads).toBe(40)
    expect(api.calls(initial)).toBe(1)
    metadata = changed
    expect(api.matchesThreadIncarnation(row, expected)).toBe(true)
    expect(api.matchesThreadIncarnation(row, expected)).toBe(true)
    expect(api.calls(changed)).toBe(1)
    metadata = replaced
    expect(api.matchesThreadIncarnation(row, expected)).toBe(false)
    metadata = initial
    expected.token = "different expectation"
    expect(api.matchesThreadIncarnation(row, expected)).toBe(false)
    expect(api.matchesThreadIncarnation(null, expected)).toBe(false)
  })

  it("still compares each current creation timestamp for legacy rows", async () => {
    const api = await interpreted()
    const expected = { token: null, legacyCreatedAt: 77 }
    const row = { metadata: "{}", created_at: 77 }
    expect(api.matchesThreadIncarnation(row, expected)).toBe(true)
    row.created_at = 78
    expect(api.matchesThreadIncarnation(row, expected)).toBe(false)
    expect(api.calls("{}")).toBe(1)
  })

  it("preserves JSON duplicate-key, Unicode, invalid and primitive semantics", async () => {
    const api = await interpreted()
    const cases: Array<[string | null, string | null]> = [
      [`{"${key}":"old","${key}":"最后\\u0000\\ud800"}`, "最后\0\ud800"],
      [`{"${key}":"old","${key}":7}`, null],
      [`{"${key}":""}`, null],
      ["[]", null],
      ["null", null],
      ["42", null],
      ["{", null],
      [null, null]
    ]
    for (const [raw, token] of cases) {
      expect(api.readThreadIncarnationToken(raw)).toBe(token)
      expect(api.readThreadIncarnationToken(raw)).toBe(token)
      if (raw !== null) expect(api.calls(raw)).toBe(1)
    }
  })

  it("uses the captured parser without invoking a late parser accessor", async () => {
    const api = await interpreted()
    const raw = JSON.stringify({ [key]: "first" })
    expect(api.readThreadIncarnationToken(raw)).toBe("first")
    const changedRaw = JSON.stringify({ [key]: "actual-replacement" })
    const original = Object.getOwnPropertyDescriptor(JSON, "parse")!
    let parserCalls = 0
    let getterCalls = 0
    try {
      Object.defineProperty(JSON, "parse", {
        configurable: true,
        get() {
          getterCalls++
          return () => {
            parserCalls++
            return { [key]: "changed" }
          }
        }
      })
      expect(api.readThreadIncarnationToken(raw)).toBe("first")
      expect(api.readThreadIncarnationToken(raw)).toBe("first")
      expect(api.readThreadIncarnationToken(changedRaw)).toBe("actual-replacement")
      expect(api.matchesThreadIncarnation({ created_at: 77, metadata: changedRaw },
        { token: "first", legacyCreatedAt: 77 })).toBe(false)
      expect(parserCalls).toBe(0)
      expect(getterCalls).toBe(0)
    } finally {
      Object.defineProperty(JSON, "parse", original)
    }
    expect(api.readThreadIncarnationToken(raw)).toBe("first")
  })

  it("uses own metadata fields and captured array classification", async () => {
    const api = await interpreted()
    const raw = '{"workspace":"local"}'
    expect(api.readThreadIncarnationToken(raw)).toBe(null)
    let reads = 0
    try {
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        get() {
          reads++
          return "inherited"
        }
      })
      expect(api.readThreadIncarnationToken(raw)).toBe(null)
      expect(reads).toBe(0)
    } finally {
      delete (Object.prototype as Record<string, unknown>)[key]
    }
    expect(api.readThreadIncarnationToken(raw)).toBe(null)
    const tagged = JSON.stringify({ [key]: "present" })
    expect(api.readThreadIncarnationToken(tagged)).toBe("present")
    const changedTagged = JSON.stringify({ [key]: "actual-replacement" })
    const original = Object.getOwnPropertyDescriptor(Array, "isArray")!
    try {
      Object.defineProperty(Array, "isArray", { ...original, value: () => true })
      const result = api.readThreadIncarnationToken(tagged)
      const changedResult = api.readThreadIncarnationToken(changedTagged)
      Object.defineProperty(Array, "isArray", original)
      expect(result).toBe("present")
      expect(changedResult).toBe("actual-replacement")
    } finally {
      Object.defineProperty(Array, "isArray", original)
    }
  })

  it("cannot mistake inherited descriptor values for a replaced global JSON data property", async () => {
    const api = await interpreted()
    const raw = JSON.stringify({ [key]: "first" })
    expect(api.readThreadIncarnationToken(raw)).toBe("first")
    const original = Object.getOwnPropertyDescriptor(globalThis, "JSON")!
    const descriptor = { configurable: true, value: original.value }
    let calls = 0
    let result: string | null = null
    try {
      Object.defineProperty(globalThis, "JSON", {
        configurable: true,
        get() {
          calls++
          return { parse: () => ({ [key]: "changed" }) }
        }
      })
      Object.defineProperty(Object.prototype, "value", descriptor)
      result = api.readThreadIncarnationToken(raw)
    } finally {
      delete (Object.prototype as Record<string, unknown>).value
      Object.defineProperty(globalThis, "JSON", original)
    }
    expect(result).toBe("first")
    expect(calls).toBe(0)
  })

  it("bounds retained entries and declines oversized raw text", async () => {
    const api = await interpreted()
    const initial = JSON.stringify({ [key]: "first" })
    expect(api.readThreadIncarnationToken(initial)).toBe("first")
    for (let index = 0; index < 8; index++) {
      api.readThreadIncarnationToken(JSON.stringify({ [key]: "next-" + index }))
    }
    api.readThreadIncarnationToken(initial)
    expect(api.calls(initial)).toBe(2)
    const large = JSON.stringify({ [key]: "large", payload: "x".repeat(300000) })
    expect(api.readThreadIncarnationToken(large)).toBe("large")
    expect(api.readThreadIncarnationToken(large)).toBe("large")
    expect(api.calls(large)).toBe(2)
  })

  it("evicts by total retained bytes before reaching the entry limit", async () => {
    const api = await interpreted()
    const raw = JSON.stringify({ [key]: "first", payload: "x".repeat(200000) })
    api.readThreadIncarnationToken(raw)
    api.readThreadIncarnationToken(JSON.stringify({ [key]: "second", payload: "x".repeat(200000) }))
    api.readThreadIncarnationToken(JSON.stringify({ [key]: "third", payload: "x".repeat(200000) }))
    api.readThreadIncarnationToken(raw)
    expect(api.calls(raw)).toBe(2)
  })
})
