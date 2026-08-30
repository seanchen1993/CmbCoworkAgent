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
    ).toBe("1511e4d9acefcedcaf4cf2a1ccdf76b0cc92932d5220c624b425b58e815b7e02")
  })
})
