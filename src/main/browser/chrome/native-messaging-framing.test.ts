import { describe, expect, it } from "vitest"
import { encodeNativeMessage, NativeMessageDecoder } from "./native-messaging-framing"

describe("native messaging framing", () => {
  it("decodes split and coalesced messages", () => {
    const first = encodeNativeMessage({ type: "one", value: 1 })
    const second = encodeNativeMessage({ type: "two", value: 2 })
    const combined = Buffer.concat([first, second])
    const decoder = new NativeMessageDecoder()

    expect(decoder.push(combined.subarray(0, 3))).toEqual([])
    expect(decoder.push(combined.subarray(3, first.length + 2))).toEqual([
      { type: "one", value: 1 }
    ])
    expect(decoder.push(combined.subarray(first.length + 2))).toEqual([{ type: "two", value: 2 }])
  })

  it("rejects oversized messages before allocation", () => {
    const decoder = new NativeMessageDecoder(128)
    const header = Buffer.alloc(4)
    header.writeUInt32LE(129, 0)
    expect(() => decoder.push(header)).toThrow(/payload length is invalid/)
  })
})
