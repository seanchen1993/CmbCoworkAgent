import { describe, expect, it } from "vitest"
import { TraceTailContentBuffer } from "./tail-buffer"

describe("bounded trace tail snapshots", () => {
  it("does not invoke getters or toJSON while checking a rejected payload", () => {
    const buffer = new TraceTailContentBuffer(1024)
    let reads = 0
    const payload = {
      get secret() {
        reads += 1
        return "secret"
      }
    }
    buffer.remember("getter", payload)
    buffer.remember("serializer", {
      toJSON() {
        reads += 1
        return "secret"
      }
    })
    expect(reads).toBe(0)
    expect(buffer.has("getter")).toBe(false)
    expect(buffer.has("serializer")).toBe(false)
  })

  it("stops traversing oversized tool arguments before serialization", () => {
    const buffer = new TraceTailContentBuffer(1024)
    let reads = 0
    const payload = new Proxy(
      Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [String(i), i])),
      {
        getOwnPropertyDescriptor(target, key) {
          reads += 1
          return Reflect.getOwnPropertyDescriptor(target, key)
        }
      }
    )
    buffer.remember("large", payload)
    expect(buffer.has("large")).toBe(false)
    expect(reads).toBeLessThan(200)
  })

  it("retains an independent snapshot instead of mutable tool arguments", () => {
    const buffer = new TraceTailContentBuffer(1024)
    const value = { path: "/before", nested: { values: [1, 2] } }
    buffer.remember("args", value)
    value.path = "/after"
    value.nested.values.push(3)
    expect(buffer.take("args")).toEqual({ path: "/before", nested: { values: [1, 2] } })
  })

  it("does not resurrect evicted references when identical content returns", () => {
    const buffer = new TraceTailContentBuffer(5)
    buffer.remember("old", "first")
    buffer.remember("middle", "other")
    buffer.remember("new", "first")
    expect(buffer.take("old")).toBeUndefined()
    expect(buffer.take("middle")).toBeUndefined()
    expect(buffer.take("new")).toBe("first")
    expect(buffer.sizeBytes).toBe(5)
  })

  it("removes superseded content even when its replacement cannot fit", () => {
    const buffer = new TraceTailContentBuffer(8)
    buffer.remember("key", "before")
    buffer.remember("key", "oversized replacement")
    expect(buffer.take("key")).toBeUndefined()
    expect(buffer.sizeBytes).toBe(0)
    expect(buffer.count).toBe(0)
  })

  it("does not conflate a JSON-looking string and an object", () => {
    const buffer = new TraceTailContentBuffer(1024)
    buffer.remember("text", '{"x":1}')
    buffer.remember("object", { x: 1 })
    expect(buffer.take("text")).toBe('{"x":1}')
    expect(buffer.take("object")).toEqual({ x: 1 })
  })

  it("bounds the reference index even when every entry shares the same bytes", () => {
    const buffer = new TraceTailContentBuffer(1024)
    for (let i = 0; i < 5000; i += 1) buffer.remember(String(i), "shared")
    expect(buffer.has("0")).toBe(false)
    expect(buffer.has("4999")).toBe(true)
    expect(buffer.count).toBe(1)
    expect(buffer.sizeBytes).toBe(6)
  })
})
