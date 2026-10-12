import { expect, it } from "vitest"
import { BOT_FILE_CHUNK_BYTES } from "./bot-files"
import { canonicalBotFileBase64Bytes } from "./bot-file-base64"

it("accepts canonical complete and padded groups across every byte value", () => {
  expect(canonicalBotFileBase64Bytes("", 0)).toBe(0)
  for (let byte = 0; byte < 256; byte++)
    for (const bytes of [
      Buffer.from([byte]),
      Buffer.from([byte, 255 - byte]),
      Buffer.from([byte, 128, 255 - byte])
    ])
      expect(canonicalBotFileBase64Bytes(bytes.toString("base64"), 3)).toBe(bytes.length)
})

it("rejects whitespace, URL alphabet, missing/excess/interior padding and nonzero discarded bits", () => {
  for (const raw of [
    "Zg",
    "Zg=",
    "Zg===",
    "Z=g=",
    "Zg==\n",
    " Zg==",
    "Zh==",
    "Zv==",
    "//9=",
    "__8=",
    "-_8=",
    "Ｚg==",
    "====",
    "A==="
  ])
    expect(canonicalBotFileBase64Bytes(raw, 32), raw).toBeNull()
  expect(Buffer.from("Zh==", "base64").toString()).toBe("f")
  expect(canonicalBotFileBase64Bytes("Zg==", 1)).toBe(1)
  expect(canonicalBotFileBase64Bytes("//8=", 2)).toBe(2)
})

it("checks exact decoded capacity and rejects untrusted limits before scanning", () => {
  expect(canonicalBotFileBase64Bytes("Zg==", 0)).toBeNull()
  expect(canonicalBotFileBase64Bytes("Zm8=", 1)).toBeNull()
  expect(canonicalBotFileBase64Bytes("Zm9v", 2)).toBeNull()
  for (const limit of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(canonicalBotFileBase64Bytes("", limit)).toBeNull()
})

it("validates the maximum file chunk without allocating a re-encoded validation string", () => {
  const raw = Buffer.alloc(BOT_FILE_CHUNK_BYTES, 255).toString("base64")
  expect(canonicalBotFileBase64Bytes(raw, BOT_FILE_CHUNK_BYTES)).toBe(BOT_FILE_CHUNK_BYTES)
  expect(canonicalBotFileBase64Bytes(raw, BOT_FILE_CHUNK_BYTES - 1)).toBeNull()
  expect(canonicalBotFileBase64Bytes(raw.slice(0, -1) + "!", BOT_FILE_CHUNK_BYTES)).toBeNull()
})
