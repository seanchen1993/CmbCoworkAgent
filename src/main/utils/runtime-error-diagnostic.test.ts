import { describe, expect, it } from "vitest"
import { runtimeErrorDiagnostic } from "./runtime-error-diagnostic"

describe("runtime error diagnostics", () => {
  it("preserves bounded technical failures and ignores rich exception fields", () => {
    const error = Object.assign(new TypeError("Cannot read properties of undefined"), {
      payload: "private source",
      cause: Error("private cause")
    })
    expect(runtimeErrorDiagnostic(error)).toEqual({
      name: "TypeError",
      message: "Cannot read properties of undefined"
    })
    expect(runtimeErrorDiagnostic(Error("x".repeat(1000))).message).toHaveLength(240)
  })
  it("omits credentials, quoted arguments, payloads and subsequent lines", () => {
    for (const message of [
      "Failed: Bearer private-value",
      "Failed: apiKey=private-value",
      'Failed: "private-value"',
      "Failed: https://host/?key=private-value",
      'Failed: {"body":"private-value"}',
      "Failed\nprivate-value"
    ])
      expect(runtimeErrorDiagnostic(Error(message)).message).not.toContain("private-value")
  })
  it("does not serialize arbitrary thrown payloads", () => {
    expect(runtimeErrorDiagnostic({ message: "private-value" }).message).toBe("Non-Error rejection")
  })
})
