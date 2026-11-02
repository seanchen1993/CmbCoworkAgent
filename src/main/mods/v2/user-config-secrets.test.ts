import { expect, it, vi } from "vitest"
import { FunctionUserConfigSecrets } from "./user-config-secrets"
import type { FunctionUserConfigField } from "../../../shared/mods/v2/user-config"
import { testSecretProtector as protector } from "../../../../tests/support/mods-secret-protector"

const field: FunctionUserConfigField = {
  type: "string",
  title: "Token",
  description: "Help",
  sensitive: true
}

it.each(["win32", "linux", "darwin"] as const)(
  "uses authenticated fixture storage on %s",
  (platform) => {
    const secrets = new FunctionUserConfigSecrets(protector(), platform)
    const sealed = secrets.seal("project", "plugin", "token", field, "private-fixture")
    expect(secrets.open("project", "plugin", "token", field, sealed)).toBe("private-fixture")
    expect(() =>
      new FunctionUserConfigSecrets(protector(), platform).open(
        "project",
        "plugin",
        "token",
        field,
        sealed
      )
    ).toThrow("MODS_SECRET_STORAGE_INVALID")
  }
)

it("round-trips typed confidential values without storing plaintext, binding all actual identities", () => {
  const secrets = new FunctionUserConfigSecrets(protector(), "win32")
  const sealed = secrets.seal("project", "plugin", "token", field, "private-fixture")
  expect(sealed).not.toContain("private-fixture")
  expect(secrets.open("project", "plugin", "token", field, sealed)).toBe("private-fixture")
  for (const [workspace, plugin, key] of [
    ["other", "plugin", "token"],
    ["project", "other", "token"],
    ["project", "plugin", "other"]
  ])
    expect(() => secrets.open(workspace, plugin, key, field, sealed)).toThrow(
      "MODS_SECRET_STORAGE_INVALID"
    )
  expect(() =>
    secrets.open("project", "plugin", "token", { ...field, multiple: true }, sealed)
  ).toThrow("MODS_SECRET_SCHEMA_CHANGED")
  expect(secrets.open("project", "plugin", "token", { ...field, title: "New help" }, sealed)).toBe(
    "private-fixture"
  )
})

it("rejects unavailable or insecure backends without attempting encryption", () => {
  for (const backend of [undefined, "basic_text", "unknown", "unrecognized-backend"]) {
    const storage = {
      ...protector(),
      getSelectedStorageBackend: () => backend!,
      encryptString: vi.fn()
    }
    const secrets = new FunctionUserConfigSecrets(storage, "linux")
    expect(secrets.available()).toBe(false)
    expect(() => secrets.seal("w", "p", "token", field, "private-fixture")).toThrow(
      "MODS_SECRET_STORAGE_UNAVAILABLE"
    )
    expect(storage.encryptString).not.toHaveBeenCalled()
  }
  expect(
    new FunctionUserConfigSecrets(
      { ...protector(), getSelectedStorageBackend: () => "gnome_libsecret" },
      "linux"
    ).available()
  ).toBe(true)
  expect(new FunctionUserConfigSecrets(undefined, "win32").available()).toBe(false)
})

it("contains OS diagnostics, rejects corrupt ciphertext and cannot confirm a silent encryptor", () => {
  const broken = {
    ...protector(),
    encryptString: () => {
      throw Error("private-fixture")
    }
  }
  expect(() =>
    new FunctionUserConfigSecrets(broken).seal("w", "p", "token", field, "private-fixture")
  ).toThrow(/^MODS_SECRET_STORAGE_FAILED$/)
  const secrets = new FunctionUserConfigSecrets(protector())
  expect(() => secrets.open("w", "p", "token", field, "not base64")).toThrow(
    /^MODS_SECRET_STORAGE_INVALID$/
  )
  const sealed = secrets.seal("w", "p", "token", field, "private-fixture")
  const tampered = Buffer.from(sealed, "base64")
  tampered[tampered.length - 1] ^= 1
  expect(() => secrets.open("w", "p", "token", field, tampered.toString("base64"))).toThrow(
    /^MODS_SECRET_STORAGE_INVALID$/
  )
  const silent = new FunctionUserConfigSecrets({
    ...protector(),
    encryptString: () => Buffer.from("empty")
  })
  expect(() => silent.seal("w", "p", "token", field, "private-fixture")).toThrow(
    /^MODS_SECRET_STORAGE_FAILED$/
  )
})
