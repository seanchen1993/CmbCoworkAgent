import { describe, expect, it } from "vitest"
import { parseModCommandInput } from "./command-input"
describe("explicit Mods command input", () => {
  it("keeps ordinary conversation and goal input outside command execution", () => {
    expect(parseModCommandInput("please /mod quality:run")).toBeNull()
    expect(parseModCommandInput("/goal test")).toBeNull()
    expect(parseModCommandInput("/module test")).toBeNull()
  })
  it("parses an explicit namespace command and bounded plain JSON", () => {
    expect(parseModCommandInput("/mod quality:run")).toEqual({ command: "quality:run", args: {} })
    expect(parseModCommandInput('/mod quality:run {"path":"a b"}')).toEqual({
      command: "quality:run",
      args: { path: "a b" }
    })
    for (const input of [
      "/mod",
      "/mod quality:run []",
      "/mod quality:run null",
      '/mod quality:run {"__proto__":{}}',
      "/mod quality:run " + "x".repeat(16000)
    ])
      expect(() => parseModCommandInput(input)).toThrow()
  })
})
