import { describe, expect, it } from "vitest"
import {
  deriveFieldPathsFromJsonSchema,
  deriveFieldPathsFromValue,
  hasProjectionOptions,
  projectResultData
} from "./result-projection"

describe("projectResultData", () => {
  it("keeps data unchanged when no projection options are provided", () => {
    const data = { id: "1", name: "Alpha" }
    const result = projectResultData(data)

    expect(result.data).toEqual(data)
    expect(result.metadata.projected).toBe(false)
    expect(result.metadata.truncated).toBe(false)
  })

  it("projects selected object and nested array fields", () => {
    const data = {
      total: 2,
      items: [
        { id: "1", name: "Alpha", status: "done", secret: "x" },
        { id: "2", name: "Beta", status: "open", secret: "y" }
      ]
    }

    const result = projectResultData(data, {
      requiredFields: ["items[].id", "items[].status"],
      maxArrayItems: 1
    })

    expect(result.data).toEqual({
      items: [{ id: "1", status: "done" }]
    })
    expect(result.metadata.projected).toBe(true)
    expect(result.metadata.missingFields).toBeUndefined()
  })

  it("does not read unrelated fields while projecting selected paths", () => {
    let expensiveFieldRead = false
    const data: Record<string, unknown> = {
      items: [
        { id: "1", name: "Alpha", secret: "x" },
        { id: "2", name: "Beta", secret: "y" }
      ]
    }
    Object.defineProperty(data, "expensive", {
      enumerable: true,
      get() {
        expensiveFieldRead = true
        throw new Error("unrelated field should not be read")
      }
    })

    const result = projectResultData(data, {
      requiredFields: ["items[].id"],
      maxArrayItems: 1
    })

    expect(result.data).toEqual({
      items: [{ id: "1" }]
    })
    expect(result.metadata.originalBytesEstimated).toBe(true)
    expect(expensiveFieldRead).toBe(false)
  })

  it("projects selected fields from a root array", () => {
    const result = projectResultData(
      [
        { id: "1", name: "Alpha", secret: "x" },
        { id: "2", name: "Beta", secret: "y" }
      ],
      {
        requiredFields: ["[].id"],
        maxArrayItems: 1
      }
    )

    expect(result.data).toEqual([{ id: "1" }])
    expect(result.metadata.projected).toBe(true)
    expect(result.metadata.missingFields).toBeUndefined()
  })

  it("records missing fields and falls back to a bounded preview when projection is empty", () => {
    const result = projectResultData(
      { id: "1", name: "Alpha" },
      {
        requiredFields: ["items[].id"],
        maxChars: 1000
      }
    )

    expect(result.metadata.missingFields).toEqual(["items[].id"])
    expect(result.metadata.topLevelKeys).toEqual(["id", "name"])
    expect(result.data).toEqual({
      _preview: expect.any(String),
      _availableTopLevelKeys: ["id", "name"]
    })
  })

  it("bounds non-JSON text", () => {
    const result = projectResultData("abcdef", { maxChars: 3 })

    expect(result.data).toContain("abc")
    expect(result.data).toContain("Result truncated")
    expect(result.metadata.truncated).toBe(true)
  })

  it("bounds large structured data without cloning again after truncation", () => {
    let expensiveFieldReads = 0
    const data: Record<string, unknown> = {}
    Object.defineProperty(data, "expensive", {
      enumerable: true,
      get() {
        expensiveFieldReads += 1
        return "abcdef".repeat(1000)
      }
    })

    const result = projectResultData(data, { maxChars: 10 })

    expect(typeof result.data).toBe("string")
    expect(result.metadata.truncated).toBe(true)
    expect(expensiveFieldReads).toBe(1)
  })

  it("limits arrays without required fields", () => {
    const result = projectResultData(
      {
        items: [{ id: "1" }, { id: "2" }, { id: "3" }]
      },
      { maxArrayItems: 2 }
    )

    expect(result.data).toEqual({
      items: [{ id: "1" }, { id: "2" }]
    })
    expect(result.metadata.projected).toBe(true)
  })

  it("handles circular values without throwing", () => {
    const data: Record<string, unknown> = { id: "1" }
    data.self = data

    const result = projectResultData(data, { requiredFields: ["id", "self"] })

    expect(result.data).toEqual({
      id: "1",
      self: {
        id: "1",
        self: "[Circular]"
      }
    })
  })
})

describe("field path hints", () => {
  it("derives field paths from JSON schema", () => {
    const paths = deriveFieldPathsFromJsonSchema({
      type: "object",
      properties: {
        id: { type: "string" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              status: { type: "string" }
            }
          }
        }
      }
    })

    expect(paths).toEqual(["id", "items[].name", "items[].status"])
  })

  it("derives usable field paths from a root array JSON schema", () => {
    const paths = deriveFieldPathsFromJsonSchema({
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" }
        }
      }
    })

    expect(paths).toEqual(["[].id", "[].status"])
  })

  it("derives field paths from a sanitized result example", () => {
    const paths = deriveFieldPathsFromValue({
      ok: true,
      data: {
        items: [{ id: "1", score: 7 }]
      }
    })

    expect(paths).toContain("data.items[].id")
    expect(paths).toContain("data.items[].score")
  })

  it("derives usable field paths from a root array result example", () => {
    const paths = deriveFieldPathsFromValue([{ id: "1", score: 7 }])

    expect(paths).toContain("[].id")
    expect(paths).toContain("[].score")
  })

  it("detects active projection options", () => {
    expect(hasProjectionOptions({})).toBe(false)
    expect(hasProjectionOptions({ maxChars: 100 })).toBe(true)
    expect(hasProjectionOptions({ requiredFields: ["id"] })).toBe(true)
  })
})
