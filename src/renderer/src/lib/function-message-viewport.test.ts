import { describe, expect, it } from "vitest"
import {
  checkedFunctionMessageViewport,
  type FunctionMessageViewport
} from "./function-message-viewport"

const viewport = (): FunctionMessageViewport => ({
  top: 1000,
  height: 400,
  layoutWidth: 700,
  pieces: [
    { text: "protected visible text", top: 1000, left: 0, width: 700, font: "14px sans-serif" }
  ]
})

describe("protected message reading windows", () => {
  it("retains the validated primitive snapshot without rereading accessors", () => {
    const original = viewport()
    let reads = 0
    Object.defineProperty(original.pieces[0], "text", {
      get: () => (++reads === 1 ? "protected visible text" : "RAW_CHANGED")
    })
    expect(checkedFunctionMessageViewport(original, "protected visible text")?.pieces[0].text).toBe(
      "protected visible text"
    )
    expect(reads).toBe(1)
  })
  it("clones only inert text and finite geometry from the protected host body", () => {
    const original = { ...viewport(), html: "<a>forbidden</a>", action: () => {} }
    Object.assign(original.pieces[0], { href: "https://invalid.test" })
    const retained = checkedFunctionMessageViewport(
      original,
      "prefix protected visible text suffix"
    )!
    expect(retained).toEqual(viewport())
    original.pieces[0].text = "RAW_CHANGED"
    expect(retained.pieces[0].text).toBe("protected visible text")
    expect(JSON.stringify(retained)).not.toMatch(/html|href|action/)
  })

  it("rejects unprotected text, excessive characters, invalid geometry and piece counts", () => {
    expect(checkedFunctionMessageViewport(viewport(), "different protected text")).toBeUndefined()
    const large = viewport()
    large.pieces[0].text = "x".repeat(8193)
    expect(checkedFunctionMessageViewport(large, large.pieces[0].text)).toBeUndefined()
    expect(
      checkedFunctionMessageViewport({ ...viewport(), top: Infinity }, "protected visible text")
    ).toBeUndefined()
    expect(
      checkedFunctionMessageViewport(
        { ...viewport(), layoutWidth: 100001 },
        "protected visible text"
      )
    ).toBeUndefined()
    const many = viewport()
    many.pieces = Array.from({ length: 65 }, () => many.pieces[0])
    expect(checkedFunctionMessageViewport(many, "protected visible text")).toBeUndefined()
  })
})
