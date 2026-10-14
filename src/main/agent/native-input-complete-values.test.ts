import { HumanMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"
import { captureNativeMessage } from "./native-message-capture"
import { captureNativeInputCompleteValues } from "./native-input-complete-values"

function fixture(value: unknown) {
  return new HumanMessage({ id: "actual-input", content: "complete original",
    response_metadata: { value } })
}
function verifier(message: HumanMessage) {
  const initial = captureNativeMessage(message)
  const check = captureNativeInputCompleteValues(message, () => undefined)
  if (!check) throw Error("LOSSLESS_INPUT_REQUIRED")
  expect(captureNativeMessage(message).digest).toBe(initial.digest)
  expect(check()).toBe(true)
  return check
}

describe("private complete NativeInput data equality", () => {
  it.each([undefined, null, false, true, "", "full primitive", "\ud800", "\udc00", "😀",
    0, -0, 1, -1, Number.MAX_VALUE])("compares complete primitive %j without normalization", value => {
    const message = fixture(value), check = verifier(message)
    message.response_metadata.value = typeof value === "string" ? value + "changed" : "changed"
    expect(check()).toBe(false)
  })

  it("walks every nested field even when all original object addresses remain the same", () => {
    const child = { content: "unchanged", nested: [{ original: true }, undefined, -0] }
    const message = fixture(child), check = verifier(message)
    child.nested[0] = { original: false }
    expect(check()).toBe(false)
  })

  it.each(["add", "delete", "reorder", "enumerable", "writable", "configurable", "prototype",
    "symbol", "accessor", "proxy", "sparse", "array-key", "negative-zero"] as const)(
    "rejects a later %s change instead of downgrading to a hash", kind => {
      const child = { first: 1, second: 2, entries: [0, 1] }
      const message = fixture(child), check = verifier(message)
      let behavior = 0
      if (kind === "add") Object.defineProperty(child, "added", { value: true })
      else if (kind === "delete") Reflect.deleteProperty(child, "first")
      else if (kind === "reorder") {
        Reflect.deleteProperty(child, "first"); Object.defineProperty(child, "first",
          { value: 1, enumerable: true, writable: true, configurable: true })
      } else if (kind === "enumerable") Object.defineProperty(child, "first", { enumerable: false })
      else if (kind === "writable") Object.defineProperty(child, "first", { writable: false })
      else if (kind === "configurable") Object.defineProperty(child, "first", { configurable: false })
      else if (kind === "prototype") Object.setPrototypeOf(child, null)
      else if (kind === "symbol") Object.defineProperty(child, Symbol("added"), { value: true })
      else if (kind === "accessor") Object.defineProperty(child, "first", {
        enumerable: true, get: () => { behavior++; return 1 } })
      else if (kind === "proxy") message.response_metadata.value = new Proxy(child, {
        ownKeys: () => { behavior++; return [] },
        getPrototypeOf: () => { behavior++; return Object.prototype } })
      else if (kind === "sparse") Reflect.deleteProperty(child.entries, "0")
      else if (kind === "array-key") Object.defineProperty(child.entries, "extra", { value: true })
      else child.entries[0] = -0
      expect(check()).toBe(false)
      expect(behavior).toBe(0)
    })

  it.each(["binary", "media", "truncated", "nonfinite", "sparse", "cycle", "ignored",
    "getter", "proxy", "foreign-prototype"] as const)(
    "leaves original %s data on the full typed-hash path", kind => {
      let value: unknown = { ordinary: true }, behavior = 0
      if (kind === "binary") value = new Uint8Array([1, 2])
      else if (kind === "media") value = { type: "image_url", url: "actual" }
      else if (kind === "truncated") value = { truncated: true, output: "actual" }
      else if (kind === "nonfinite") value = Number.NaN
      else if (kind === "sparse") value = new Array(2)
      else if (kind === "cycle") { const cyclic: unknown[] = []; cyclic.push(cyclic); value = cyclic }
      else if (kind === "ignored") value = { constructor: "ignored by normalized data" }
      else if (kind === "getter") value = Object.defineProperty({}, "value", {
        get: () => { behavior++; return true } })
      else if (kind === "proxy") value = new Proxy({}, {
        ownKeys: () => { behavior++; return [] },
        getPrototypeOf: () => { behavior++; return Object.prototype } })
      else value = new Date(0)
      expect(captureNativeInputCompleteValues(fixture(value), () => undefined)).toBeUndefined()
      expect(behavior).toBe(0)
    })

  it("preserves original bounded-work errors instead of treating them as eligibility failures", () => {
    const error = Error("ORIGINAL_INPUT_CANCELLED")
    expect(() => captureNativeInputCompleteValues(fixture("actual"), () => { throw error }))
      .toThrow(error)
    const message = fixture("actual")
    let stopped = false
    const check = captureNativeInputCompleteValues(message, () => { if (stopped) throw error })
    if (!check) throw Error("LOSSLESS_INPUT_REQUIRED")
    stopped = true
    expect(check).toThrow(error)
  })

  it("counts shared references as expanded nodes before building an oversized worklist", () => {
    const repeated = new Array(256).fill("same immutable value")
    const message = fixture(new Array(4096).fill(repeated))
    expect(captureNativeInputCompleteValues(message, () => undefined)).toBeUndefined()
  })
})
