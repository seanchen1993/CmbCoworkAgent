import { describe, expect, it } from "vitest"
import { getHiddenEndpoint } from "./hidden-endpoints"

describe("hidden endpoints", () => {
  it("decrypts every managed endpoint into a valid URL", () => {
    const values = [
      getHiddenEndpoint("modelMinimax"),
      getHiddenEndpoint("modelDeepseek"),
      getHiddenEndpoint("taskCards"),
      getHiddenEndpoint("skillEvalDoc"),
      getHiddenEndpoint("knowledgeGuide")
    ]

    expect(values).toHaveLength(5)
    expect(new Set(values).size).toBe(values.length)
    for (const value of values) {
      expect(new URL(value).protocol).toMatch(/^https?:$/)
    }
  })
})
