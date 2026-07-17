import { createHash } from "crypto"
import { describe, expect, it } from "vitest"
import { getBundledBuiltinModelApiKey } from "./builtin-credential"

describe("bundled built-in model credential", () => {
  it("decrypts the expected fallback without storing it as plaintext", () => {
    const value = getBundledBuiltinModelApiKey()

    expect(value).toMatch(/^sk-[a-f0-9]{32}$/)
    expect(
      createHash("sha256")
        .update(value ?? "")
        .digest("hex")
    ).toBe("873e672443ff41ceb479482131852e18461c0b6d37088930a04ca320357b7af7")
  })
})
