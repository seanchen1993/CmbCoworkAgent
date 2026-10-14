import { describe, it, expect } from "vitest"
import { compareInstructionRequest } from "./instruction-request"
describe("instruction request boundary", () => {
  it("requires the whole assembled text, not filenames or a partial paragraph", () => {
    const assembled = "## AGENTS.md\nFollow project rule one.\nFollow project rule two."
    expect(compareInstructionRequest(assembled, "preamble\n" + assembled + "\nother").result).toBe(
      "confirmed"
    )
    expect(
      compareInstructionRequest(assembled, "## AGENTS.md\nFollow project rule one.").result
    ).toBe("modified")
    expect(compareInstructionRequest("", "nothing").result).toBe("unknown")
  })
})
