import { expect, it } from "vitest"
import { botProfileTitleSchema } from "./bot-profile-line"

it("permits empty clearing and single-line labels without changing the submitted semantics", () => {
  for (const title of ["", " ", "  质量检查  ", "x".repeat(200)])
    expect(botProfileTitleSchema.parse(title)).toBe(title)
})
it("rejects every line separator and NUL, including boundary separators that trim would conceal", () => {
  for (const separator of ["\r", "\n", "\r\n", "\u2028", "\u2029", "\0"])
    for (const title of [`one${separator}two`, `${separator}one`, `one${separator}`, separator])
      expect(botProfileTitleSchema.safeParse(title).success).toBe(false)
  expect(botProfileTitleSchema.safeParse("x".repeat(201)).success).toBe(false)
})
