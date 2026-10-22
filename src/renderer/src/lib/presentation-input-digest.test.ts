import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import { presentationInputDigest } from "./presentation-input-digest"

const oracle = (input: string): string => createHash("sha256").update(input, "utf8").digest("hex")

it.each([
  "",
  "abc",
  "中文消息与知识库",
  "😀🚀 mixed 汉字",
  "\ud800",
  "\udc00",
  "before\ud800after",
  "\ud800\ud800\udc00\udc00",
  "\u0000\uffff\r\n",
  ...[55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 10001, 65536].map((size) =>
    Array.from({ length: size }, (_, index) => String.fromCharCode(32 + (index % 95))).join("")
  ),
  "中文😀".repeat(16384)
])("matches the UTF-8 SHA-256 oracle for input %#", (input) => {
  expect(presentationInputDigest(input)).toBe(oracle(input))
  expect(presentationInputDigest(input)).toMatch(/^[a-f0-9]{64}$/)
})

it("keeps independently computed digests stable without retaining prior input", () => {
  const first = presentationInputDigest("first")
  expect(presentationInputDigest("different")).not.toBe(first)
  expect(presentationInputDigest("first")).toBe(first)
  expect(presentationInputDigest("\ud800")).toBe(presentationInputDigest("\ufffd"))
  // JSON inputs retain lone-surrogate identity through JSON.stringify's escaped representation.
  expect(presentationInputDigest(JSON.stringify({ text: "\ud800" }))).not.toBe(
    presentationInputDigest(JSON.stringify({ text: "\ufffd" }))
  )
})
