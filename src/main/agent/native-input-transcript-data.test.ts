import { describe, expect, it } from "vitest"
import { captureNativeInputTranscriptData } from "./native-input-transcript-data"

function write() {
  return { id: "actual-input", role: "user" as const,
    content: [{ type: "text" as const, text: "complete visible body" }],
    created_at: new Date(100), start_at: new Date(80), end_at: new Date(120),
    goal_id: "original-goal", content_mode: "snapshot" as const }
}
describe("original input transcript data without behavior", () => {
  it("copies all ordered data and exact Date values without retaining original addresses", () => {
    const original = write(), data = captureNativeInputTranscriptData(original, original.id)
    const copied = data.copy()
    expect(copied).toEqual(original)
    expect(Object.keys(copied)).toEqual(Object.keys(original))
    expect(copied.created_at).not.toBe(original.created_at)
    expect(copied.content).not.toBe(original.content)
    expect(data.matches(original)).toBe(true)
    copied.created_at.setTime(999)
    expect(original.created_at.getTime()).toBe(100)
    expect(data.matches(original)).toBe(true)
    expect(data.digest).toMatch(/^[a-f0-9]{64}$/)
  })
  it.each(["content", "date", "descriptor", "key", "prototype"] as const)(
    "detects later original %s mutation without a same-address shortcut", kind => {
      const original = write(), data = captureNativeInputTranscriptData(original, original.id)
      if (kind === "content") original.content[0].text = "changed"
      else if (kind === "date") original.created_at.setTime(101)
      else if (kind === "descriptor") Object.defineProperty(original, "id", { writable: false })
      else if (kind === "key") Object.defineProperty(original, "extra", { value: true })
      else Object.setPrototypeOf(original, null)
      expect(data.matches(original)).toBe(false)
    })
  it.each(["getter", "toJSON", "proxy", "date-getter", "date-method"] as const)(
    "rejects original %s with zero foreign behavior", kind => {
      const original = write()
      let behavior = 0, value: unknown = original
      if (kind === "getter") Object.defineProperty(original, "content", {
        enumerable: true, get: () => { behavior++; return "secret" } })
      else if (kind === "toJSON") Object.defineProperty(original, "toJSON", {
        enumerable: true, value: () => { behavior++; return {} } })
      else if (kind === "proxy") value = new Proxy(original, {
        ownKeys: () => { behavior++; return [] },
        getPrototypeOf: () => { behavior++; return Object.prototype } })
      else Object.defineProperty(original.created_at, kind === "date-getter" ? "time" : "toJSON", {
        enumerable: true, get: () => { behavior++; return 100 } })
      expect(() => captureNativeInputTranscriptData(value, original.id)).toThrow()
      expect(behavior).toBe(0)
    })
  it.each(["function_row", "function_row_invalid", "prompt_origin", "ordinal", "unknown"])(
    "rejects public or unsupported original field %s", field => {
      const original = { ...write(), [field]: true }
      expect(() => captureNativeInputTranscriptData(original, original.id)).toThrow()
    })
  it("rejects delta modes, sparse arrays and UUID or role mismatch", () => {
    expect(() => captureNativeInputTranscriptData({ ...write(), content_mode: "delta" },
      "actual-input")).toThrow()
    expect(() => captureNativeInputTranscriptData({ ...write(), content: new Array(2) },
      "actual-input")).toThrow()
    expect(() => captureNativeInputTranscriptData(write(), "foreign-id")).toThrow()
    expect(() => captureNativeInputTranscriptData({ ...write(), role: "assistant" },
      "actual-input")).toThrow()
  })
})
