import { expect, it, vi } from "vitest"
import { PassThrough, Readable } from "node:stream"
import { runMacSecretHelper } from "./mac-secret-helper"
import {
  BOT_SECRET_CIPHER_LIMIT,
  BOT_SECRET_FRAME_LIMIT,
  BOT_SECRET_PLAIN_LIMIT,
  decodeSecretBytes,
  readSecretRequest
} from "./mac-secret-protocol"

function request(operation: "protect" | "unprotect", bytes: Buffer): Buffer {
  return Buffer.from(JSON.stringify({ version: 1, operation, data: bytes.toString("base64") }))
}
function fixture() {
  const storage = {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice("encrypted:".length))
  }
  const ready = vi.fn(async () => {}),
    stdout = new PassThrough(),
    output: Buffer[] = []
  stdout.on("data", (bytes: Buffer) => output.push(Buffer.from(bytes)))
  return {
    storage,
    ready,
    output: () => Buffer.concat(output).toString(),
    run: (stdin: Readable, platform: NodeJS.Platform = "darwin") =>
      runMacSecretHelper({ platform, storage, ready, stdin, stdout })
  }
}

it("round trips binary values through the existing safeStorage string contract", async () => {
  const first = fixture(),
    plain = Buffer.from([0, 255, 10, 36, 80])
  const frame = request("protect", plain)
  await first.run(Readable.from([frame.subarray(0, 5), frame.subarray(5)]))
  expect(first.storage.encryptString).toHaveBeenCalledWith(plain.toString("base64"))
  expect(first.ready).toHaveBeenCalledOnce()
  const second = fixture()
  await second.run(Readable.from([request("unprotect", Buffer.from(first.output(), "base64"))]))
  expect(Buffer.from(second.output(), "base64")).toEqual(plain)
  expect(frame.every((value) => value === 0)).toBe(true)
})

it.each([
  "not json",
  "{}",
  JSON.stringify({ version: 2, operation: "protect", data: "YQ==" }),
  JSON.stringify({ version: 1, operation: "reveal", data: "YQ==" }),
  JSON.stringify({ version: 1, operation: "protect", data: "YQ==", path: "escape" }),
  JSON.stringify({ version: 1, operation: "protect", data: "YQ" }),
  JSON.stringify({ version: 1, operation: "protect", data: "" }),
  JSON.stringify({ version: 1, operation: "unprotect", data: "YQ==\n" })
])("refuses malformed input before accessing Keychain: %s", async (value) => {
  const f = fixture()
  await expect(f.run(Readable.from([Buffer.from(value)]))).rejects.toThrow()
  expect(f.storage.isEncryptionAvailable).not.toHaveBeenCalled()
  expect(f.ready).not.toHaveBeenCalled()
  expect(f.output()).toBe("")
})

it("bounds the stream and both decoded directions before calling native storage", async () => {
  const f = fixture()
  await expect(f.run(Readable.from([Buffer.alloc(BOT_SECRET_FRAME_LIMIT + 1)]))).rejects.toThrow()
  for (const [operation, limit] of [
    ["protect", BOT_SECRET_PLAIN_LIMIT],
    ["unprotect", BOT_SECRET_CIPHER_LIMIT]
  ] as const) {
    const bytes = Buffer.alloc(limit, 32)
    expect(readSecretRequest(request(operation, bytes)).bytes.equals(bytes)).toBe(true)
    expect(() => readSecretRequest(request(operation, Buffer.alloc(limit + 1)))).toThrow()
  }
  expect(f.storage.isEncryptionAvailable).not.toHaveBeenCalled()
})

it("does not fall back to plaintext on platform, Keychain or decrypt failures", async () => {
  for (const mode of ["linux", "locked", "denied", "corrupted"] as const) {
    const f = fixture()
    if (mode === "locked") f.storage.isEncryptionAvailable.mockReturnValue(false)
    if (mode === "denied")
      f.storage.encryptString.mockImplementation(() => {
        throw new Error("private")
      })
    if (mode === "corrupted") f.storage.decryptString.mockReturnValue("not base64")
    await expect(
      f.run(
        Readable.from([
          request(mode === "corrupted" ? "unprotect" : "protect", Buffer.from("private"))
        ]),
        mode === "linux" ? "linux" : "darwin"
      )
    ).rejects.toThrow()
    expect(f.output()).toBe("")
  }
})

it("rejects noncanonical base64 and oversized native responses", async () => {
  for (const value of ["Zg", "Zh==", "Zg==\n", "!Zg==", ""]) {
    expect(() => decodeSecretBytes(value, 1024)).toThrow()
  }
  const f = fixture()
  f.storage.encryptString.mockReturnValue(Buffer.alloc(BOT_SECRET_CIPHER_LIMIT + 1))
  await expect(f.run(Readable.from([request("protect", Buffer.from("value"))]))).rejects.toThrow()
  expect(f.output()).toBe("")
})
