import { describe, expect, it } from "vitest"
import { HeadTailTextAccumulator } from "./head-tail-text"

describe("HeadTailTextAccumulator", () => {
  it("keeps a stable head and a moving tail with an exact omission count", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("0123456789")
    const result = accumulator.ingest("ABCDEF")

    expect(result).toMatchObject({
      head: "0123",
      tail: "ABCDEF",
      totalChars: 16,
      retainedChars: 10,
      omittedChars: 6,
      truncated: true,
      persistenceMode: "append",
      persistedContent: "ABCDEF"
    })
    expect(result.content).toBe("0123\n\n…[实时预览省略 6 字]…\n\nABCDEF")
  })

  it("deduplicates long cumulative snapshots after the middle is discarded", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    const first = accumulator.ingest("0123456789ABCDEF")
    const same = accumulator.ingest("0123456789ABCDEF")
    const growth = accumulator.ingest("0123456789ABCDEFGHIJ")

    expect(first.persistenceMode).toBe("append")
    expect(same.persistenceMode).toBe("noop")
    expect(growth).toMatchObject({
      persistenceMode: "append",
      persistedContent: "GHIJ",
      head: "0123",
      tail: "EFGHIJ",
      totalChars: 20,
      omittedChars: 10
    })
  })

  it("persists a provider's in-place cumulative revision as a replacement", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("0123456789ABCDEF")
    const result = accumulator.ingest("0123-revised-tail")

    expect(result.persistenceMode).toBe("replace")
    expect(result.persistedContent).toBe("0123-revised-tail")
    expect(result.totalChars).toBe("0123-revised-tail".length)
  })

  it("replaces a shorter explicit snapshot instead of appending it", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("hello world", "snapshot")
    const result = accumulator.ingest("hello", "snapshot")

    expect(result).toMatchObject({
      content: "hello",
      totalChars: 5,
      persistenceMode: "replace",
      persistedContent: "hello"
    })
  })

  it("keeps cumulative semantics after growth when a later snapshot shrinks", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("hello")
    accumulator.ingest("hello world")
    const result = accumulator.ingest("hello")

    expect(result).toMatchObject({
      content: "hello",
      totalChars: 5,
      persistenceMode: "replace"
    })
  })

  it("preserves repeated text when the caller explicitly declares deltas", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("ha", "delta")
    const result = accumulator.ingest("ha", "delta")

    expect(result).toMatchObject({
      content: "haha",
      totalChars: 4,
      persistenceMode: "append",
      persistedContent: "ha"
    })
  })

  it("lets an explicit delta override previously observed snapshot semantics", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("hello", "snapshot")
    const result = accumulator.ingest("hello", "delta")

    expect(result).toMatchObject({
      content: "hellohello",
      totalChars: 10,
      persistenceMode: "append",
      persistedContent: "hello"
    })
  })

  it("allows an explicit empty snapshot to clear prior text", () => {
    const accumulator = new HeadTailTextAccumulator(10, 4)
    accumulator.ingest("hello", "snapshot")
    const result = accumulator.ingest("", "snapshot")

    expect(result).toMatchObject({
      content: "",
      totalChars: 0,
      persistenceMode: "replace",
      persistedContent: ""
    })
  })

  it("never splits a UTF-16 surrogate pair at preview boundaries", () => {
    const accumulator = new HeadTailTextAccumulator(6, 3)
    const result = accumulator.ingest("ab😀cd😀ef")

    expect(result.head.endsWith("\ud83d")).toBe(false)
    expect(result.tail.startsWith("\ude00")).toBe(false)
    expect(result.content).not.toContain("\ufffd")
  })
})
