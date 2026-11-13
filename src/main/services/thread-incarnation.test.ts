import { afterEach, describe, expect, it, vi } from "vitest"
import {
  captureThreadIncarnation,
  matchesThreadIncarnation,
  readThreadIncarnationToken,
  THREAD_INCARNATION_METADATA_KEY,
  type ThreadIncarnationRow
} from "./thread-incarnation"

function metadata(token: string, workspacePath = "C:/repo"): string {
  return JSON.stringify({ [THREAD_INCARNATION_METADATA_KEY]: token, workspacePath })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("thread incarnation metadata interpretation", () => {
  it.each(["getter", "replacement"] as const)(
    "keeps the captured interpretation after a late weak-map get %s",
    (attack) => {
      const raw = metadata("first")
      const expected = captureThreadIncarnation({ metadata: raw, created_at: 77 })
      const original = Object.getOwnPropertyDescriptor(WeakMap.prototype, "get")!
      let callbacks = 0
      let result: boolean | undefined
      const replacement = () => {
        callbacks++
        throw Error("Late weak-map callbacks must not run")
      }
      try {
        Object.defineProperty(
          WeakMap.prototype,
          "get",
          attack === "getter"
            ? { configurable: true, get: replacement }
            : { configurable: true, writable: true, value: replacement }
        )
        result = matchesThreadIncarnation({ metadata: raw, created_at: 77 }, expected)
      } finally {
        Object.defineProperty(WeakMap.prototype, "get", original)
      }
      expect(result).toBe(true)
      expect(callbacks).toBe(0)
    }
  )

  it("reuses only the initial text for the same captured incarnation", () => {
    const raw = metadata("first")
    const parse = vi.spyOn(JSON, "parse")
    const expected = captureThreadIncarnation({ metadata: raw, created_at: 77 })
    expect(parse).not.toHaveBeenCalled()

    expect(matchesThreadIncarnation({ metadata: raw, created_at: 77 }, expected)).toBe(true)
    expect(matchesThreadIncarnation({ metadata: raw, created_at: 78 }, expected)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
  })

  it("reads changed text without replacing the initial interpretation", () => {
    const initial = metadata("first")
    const changed = metadata("first", "C:/changed")
    const replacement = metadata("second")
    const parse = vi.spyOn(JSON, "parse")
    const expected = captureThreadIncarnation({ metadata: initial, created_at: 77 })

    expect(matchesThreadIncarnation({ metadata: changed, created_at: 77 }, expected)).toBe(true)
    expect(matchesThreadIncarnation({ metadata: changed, created_at: 77 }, expected)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
    expect(matchesThreadIncarnation({ metadata: replacement, created_at: 77 }, expected)).toBe(
      false
    )
    expect(parse).not.toHaveBeenCalled()
    expect(matchesThreadIncarnation({ metadata: initial, created_at: 77 }, expected)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
  })

  it("matches cloned and independently supplied incarnations against the persisted token", () => {
    const raw = metadata("first")
    const expected = captureThreadIncarnation({ metadata: raw, created_at: 77 })
    const clone = { ...expected }
    const supplied = { token: "first", legacyCreatedAt: 77 }
    const parse = vi.spyOn(JSON, "parse")

    expect(matchesThreadIncarnation({ metadata: raw, created_at: 77 }, clone)).toBe(true)
    expect(matchesThreadIncarnation({ metadata: raw, created_at: 77 }, clone)).toBe(true)
    expect(matchesThreadIncarnation({ metadata: raw, created_at: 77 }, supplied)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
  })

  it("uses the current creation timestamp for legacy rows with unchanged metadata", () => {
    const raw = "{}"
    const parse = vi.spyOn(JSON, "parse")
    const expected = captureThreadIncarnation({ metadata: raw, created_at: 77 })

    expect(matchesThreadIncarnation({ metadata: raw, created_at: 77 }, expected)).toBe(true)
    expect(matchesThreadIncarnation({ metadata: raw, created_at: 78 }, expected)).toBe(false)
    expected.legacyCreatedAt = 78
    expect(matchesThreadIncarnation({ metadata: raw, created_at: 78 }, expected)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
  })

  it("preserves ordinary changes to the expected fields", () => {
    const raw = metadata("first")
    const expected = captureThreadIncarnation({ metadata: raw, created_at: 77 })
    const row = { metadata: raw, created_at: 77 }

    expected.token = "second"
    expect(matchesThreadIncarnation(row, expected)).toBe(false)
    expected.token = null
    expect(matchesThreadIncarnation(row, expected)).toBe(false)
    expected.token = "first"
    expected.legacyCreatedAt = 0
    expect(matchesThreadIncarnation(row, expected)).toBe(true)
  })

  it("reads metadata and creation time once before the original expected-field comparisons", () => {
    const initial = metadata("first")
    const changed = metadata("first", "C:/changed")
    const expected = captureThreadIncarnation({ metadata: initial, created_at: 77 })
    const trace: string[] = []
    let raw = initial
    const row: ThreadIncarnationRow = {
      get metadata() {
        trace.push("metadata")
        return raw
      },
      get created_at() {
        trace.push("created_at")
        return 77
      }
    }
    Object.defineProperty(expected, "token", {
      configurable: true,
      get() {
        trace.push("expected.token")
        return "first"
      }
    })
    const originalParse = JSON.parse
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      trace.push("parse")
      return originalParse(text, reviver)
    })

    expect(matchesThreadIncarnation(row, expected)).toBe(true)
    expect(trace).toEqual([
      "metadata",
      "created_at",
      "expected.token",
      "expected.token",
      "expected.token"
    ])
    trace.length = 0
    raw = changed
    expect(matchesThreadIncarnation(row, expected)).toBe(true)
    expect(trace).toEqual([
      "metadata",
      "created_at",
      "expected.token",
      "expected.token",
      "expected.token"
    ])
  })

  it("returns false for a missing row without reading the expected fields", () => {
    const expected = {
      get token(): string | null {
        throw Error("Missing rows must not inspect the expected incarnation")
      },
      get legacyCreatedAt(): number {
        throw Error("Missing rows must not inspect the expected incarnation")
      }
    }
    expect(matchesThreadIncarnation(null, expected)).toBe(false)
    expect(matchesThreadIncarnation(undefined, expected)).toBe(false)
  })

  it.each([
    [null, null],
    ["", null],
    ["{broken", null],
    ["null", null],
    ["42", null],
    ["[]", null],
    ["{}", null],
    ['{"cmb_thread_incarnation":""}', null],
    ['{"cmb_thread_incarnation":"first","cmb_thread_incarnation":"last"}', "last"],
    ['{"cmb_thread_incarnation":"first","cmb_thread_incarnation":null}', null],
    ['{"cmb_thread_incarnati\\u006fn":"esc\\u0061ped"}', "escaped"]
  ])("keeps JSON token semantics for %s", (raw, expected) => {
    expect(readThreadIncarnationToken(raw)).toBe(expected)
  })

  it("uses captured parsing and only an own token when Main globals are replaced", () => {
    const original = Object.getOwnPropertyDescriptor(
      Object.prototype,
      THREAD_INCARNATION_METADATA_KEY
    )
    let actual: Array<string | null> = []
    const parser = vi.spyOn(JSON, "parse").mockImplementation(() => ({
      [THREAD_INCARNATION_METADATA_KEY]: "forged"
    }))
    const array = vi.spyOn(Array, "isArray").mockReturnValue(true)
    try {
      Object.defineProperty(Object.prototype, THREAD_INCARNATION_METADATA_KEY, {
        configurable: true,
        get() {
          throw Error("Inherited metadata must not execute")
        }
      })
      actual = [
        readThreadIncarnationToken('{"own":true}'),
        readThreadIncarnationToken(metadata("actual-captured-token"))
      ]
    } finally {
      if (original)
        Object.defineProperty(Object.prototype, THREAD_INCARNATION_METADATA_KEY, original)
      else delete (Object.prototype as Record<string, unknown>)[THREAD_INCARNATION_METADATA_KEY]
      parser.mockRestore()
      array.mockRestore()
    }
    expect(actual).toEqual([null, "actual-captured-token"])
  })

  it("bounds the exact-text decoding memo and retains no row or match verdict", async () => {
    vi.resetModules()
    const parser = vi.spyOn(JSON, "parse")
    const fresh = await import("./thread-incarnation")
    const first = metadata("memo-first")
    expect(fresh.readThreadIncarnationToken(first)).toBe("memo-first")
    expect(fresh.readThreadIncarnationToken(first)).toBe("memo-first")
    expect(parser).toHaveBeenCalledTimes(1)
    for (let index = 0; index < 8; index++)
      fresh.readThreadIncarnationToken(metadata(`memo-${index}`))
    const count = parser.mock.calls.length
    fresh.readThreadIncarnationToken(first)
    expect(parser).toHaveBeenCalledTimes(count + 1)
    const huge = metadata("huge", "x".repeat(300_000))
    fresh.readThreadIncarnationToken(huge)
    fresh.readThreadIncarnationToken(huge)
    expect(parser).toHaveBeenCalledTimes(count + 3)
    const row = { metadata: first, created_at: 11 }
    const captured = fresh.captureThreadIncarnation(row)
    expect(
      fresh.matchesThreadIncarnation({ ...row, metadata: metadata("new-incarnation") }, captured)
    ).toBe(false)
    expect(fresh.matchesThreadIncarnation({ ...row, created_at: 12 }, captured)).toBe(true)
  })
})
