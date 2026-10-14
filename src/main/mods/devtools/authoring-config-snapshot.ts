import { createHash } from "node:crypto"
import { types } from "node:util"
import { FunctionUserConfigValues } from "../v2/user-config-values"

export interface AuthoringAtomicSettings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, expected: string | undefined, value: string): boolean
}
export interface AuthoringConfigBinding {
  workspace: string
  plugin: string
  compiledDigest: string
}
/** Host-only opaque snapshot. Never expose raw/record to renderer, logs or source packages. */
export interface AuthoringConfigSnapshot extends AuthoringConfigBinding {
  schemaVersion: 1
  raw: string | null
  digest: string
  record: ReturnType<FunctionUserConfigValues["read"]>
}
const ABSENT = "\0authoring-config-absent"
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
export function authoringPlainRecord(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    types.isProxy(input) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(input))
  )
    throw Error("AUTHORING_INSTALL_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (
    Reflect.ownKeys(input).some((key) => typeof key !== "string") ||
    Object.values(descriptors).some((row) => !("value" in row) || !row.enumerable)
  )
    throw Error("AUTHORING_INSTALL_INVALID")
  return Object.fromEntries(Object.entries(descriptors).map(([key, row]) => [key, row.value]))
}
export function authoringConfigBinding(input: unknown): AuthoringConfigBinding {
  const row = authoringPlainRecord(input)
  if (
    typeof row.workspace !== "string" ||
    !row.workspace ||
    row.workspace.length > 4096 ||
    row.workspace.includes("\0") ||
    typeof row.plugin !== "string" ||
    !row.plugin ||
    row.plugin.length > 200 ||
    row.plugin.includes("\0") ||
    typeof row.compiledDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.compiledDigest)
  )
    throw Error("AUTHORING_INSTALL_INVALID")
  return { workspace: row.workspace, plugin: row.plugin, compiledDigest: row.compiledDigest }
}
function key(binding: AuthoringConfigBinding) {
  return "function-user-config:" + JSON.stringify([binding.workspace, binding.plugin])
}
function decode(raw: string | null) {
  // Reuse the existing raw-record validator. No protector is supplied, and resolve is never called.
  return new FunctionUserConfigValues({
    getSetting: (_key, fallback = "") => raw ?? fallback,
    setSetting: () => {
      throw Error("AUTHORING_CONFIG_READ_ONLY")
    }
  }).read("", "")
}
function snapshot(binding: AuthoringConfigBinding, raw: string | null): AuthoringConfigSnapshot {
  const record = decode(raw)
  return {
    schemaVersion: 1,
    ...binding,
    raw,
    record,
    digest: hash(JSON.stringify({ ...binding, raw }))
  }
}
export function readAuthoringConfigSnapshot(input: unknown): AuthoringConfigSnapshot {
  const row = authoringPlainRecord(input),
    binding = authoringConfigBinding(row)
  if (
    row.schemaVersion !== 1 ||
    !(row.raw === null || typeof row.raw === "string") ||
    (typeof row.raw === "string" && Buffer.byteLength(row.raw) > 512 * 1024)
  )
    throw Error("AUTHORING_CONFIG_SNAPSHOT_INVALID")
  const result = snapshot(binding, row.raw)
  // record is a convenience projection; raw is the sole restorable payload.
  if (row.digest !== result.digest) throw Error("AUTHORING_CONFIG_SNAPSHOT_INVALID")
  return result
}
export function captureRawFunctionConfigSnapshot(
  store: Pick<AuthoringAtomicSettings, "getSetting">,
  bindingInput: AuthoringConfigBinding,
  assertCurrent: () => void
): AuthoringConfigSnapshot {
  const binding = authoringConfigBinding(bindingInput)
  assertCurrent()
  const raw = store.getSetting(key(binding), ABSENT)
  const result = snapshot(binding, raw === ABSENT ? null : raw)
  assertCurrent()
  return result
}

/** Caller proves current scope, selected compiled identity and explicit restore intent in its guard. */
export function restoreRawFunctionConfigSnapshot(
  store: AuthoringAtomicSettings,
  input: {
    snapshot: AuthoringConfigSnapshot
    expectedCurrent: AuthoringConfigSnapshot
    targetCompiledDigest: string
    assertCurrent: () => void
  }
) {
  const row = authoringPlainRecord(input)
  const restore = readAuthoringConfigSnapshot(row.snapshot)
  const current = readAuthoringConfigSnapshot(row.expectedCurrent)
  const assertCurrent = row.assertCurrent
  if (
    typeof assertCurrent !== "function" ||
    typeof store.compareAndSetSetting !== "function" ||
    restore.workspace !== current.workspace ||
    restore.plugin !== current.plugin ||
    restore.compiledDigest !== row.targetCompiledDigest ||
    current.record.revision === Number.MAX_SAFE_INTEGER
  )
    throw Error("AUTHORING_CONFIG_SNAPSHOT_BINDING")
  const next = { ...restore.record, revision: current.record.revision + 1 }
  const encoded = JSON.stringify(next)
  decode(encoded)
  assertCurrent()
  if (!store.compareAndSetSetting(key(restore), current.raw ?? undefined, encoded))
    throw Error("AUTHORING_CONFIG_CHANGED")
  // If this throws, the caller must journal partial/unknown; never claim the effect was rolled back.
  assertCurrent()
  if (store.getSetting(key(restore), ABSENT) !== encoded)
    throw Error("AUTHORING_CONFIG_COMMIT_UNCONFIRMED")
  return snapshot(authoringConfigBinding(restore), encoded)
}
