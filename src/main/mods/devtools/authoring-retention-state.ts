import { createHash } from "node:crypto"
import { types } from "node:util"
import {
  authoringPlainRecord,
  readAuthoringConfigSnapshot,
  type AuthoringAtomicSettings,
  type AuthoringConfigSnapshot
} from "./authoring-config-snapshot"
import {
  readPreparedAuthoringVersion,
  type PreparedAuthoringVersion
} from "./authoring-version-repository"

const KEY = "mods-authoring-retention-v1"
const ABSENT = "\0authoring-retention-absent"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export function readRetirementVersionIds(value: unknown): string[] {
  if (!Array.isArray(value) || types.isProxy(value) || value.length < 1 || value.length > 16)
    throw Error("AUTHORING_RETENTION_INVALID")
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== value.length + 1) throw Error("AUTHORING_RETENTION_INVALID")
  const ids = Array.from({ length: value.length }, (_, index) => {
    const descriptor = descriptors[String(index)]
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      !UUID.test(descriptor.value)
    )
      throw Error("AUTHORING_RETENTION_INVALID")
    return descriptor.value as string
  })
  if (new Set(ids).size !== ids.length) throw Error("AUTHORING_RETENTION_INVALID")
  return ids
}
interface Receipt {
  versionId: string
  installationId: string
  retiredAt: number
  digest: string
}
export interface AuthoringRetentionState {
  schemaVersion: 1
  pending?: { id: string; records: PreparedAuthoringVersion[] }
  configurations: AuthoringConfigSnapshot[]
  receipts: Receipt[]
}
export function retentionDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}
export class AuthoringRetentionStore {
  constructor(private readonly store: AuthoringAtomicSettings) {}
  read() {
    const stored = this.store.getSetting(KEY, ABSENT)
    const raw = stored === ABSENT ? undefined : stored
    if (raw !== undefined && Buffer.byteLength(raw) > 8 * 1024 * 1024)
      throw Error("AUTHORING_RETENTION_LIMIT")
    const value: Record<string, unknown> =
      raw === undefined
        ? { schemaVersion: 1, configurations: [], receipts: [] }
        : authoringPlainRecord(JSON.parse(raw))
    if (
      value.schemaVersion !== 1 ||
      !Array.isArray(value.configurations) ||
      value.configurations.length > 16 ||
      !Array.isArray(value.receipts) ||
      value.receipts.length > 64
    )
      throw Error("AUTHORING_RETENTION_INVALID")
    const configurations = value.configurations.map(readAuthoringConfigSnapshot)
    const receipts = value.receipts.map((input) => {
      const row = authoringPlainRecord(input)
      if (
        typeof row.versionId !== "string" ||
        !UUID.test(row.versionId) ||
        typeof row.installationId !== "string" ||
        !UUID.test(row.installationId) ||
        typeof row.digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.digest) ||
        !Number.isSafeInteger(row.retiredAt) ||
        Number(row.retiredAt) < 0
      )
        throw Error("AUTHORING_RETENTION_INVALID")
      return row as unknown as Receipt
    })
    let pending: AuthoringRetentionState["pending"]
    if (value.pending !== undefined) {
      const row = authoringPlainRecord(value.pending)
      if (
        typeof row.id !== "string" ||
        !UUID.test(row.id) ||
        !Array.isArray(row.records) ||
        !row.records.length ||
        row.records.length > 16
      )
        throw Error("AUTHORING_RETENTION_INVALID")
      const records = row.records.map(readPreparedAuthoringVersion)
      if (new Set(records.map((record) => record.versionId)).size !== records.length)
        throw Error("AUTHORING_RETENTION_INVALID")
      pending = { id: row.id, records }
    }
    return {
      raw,
      value: {
        schemaVersion: 1,
        configurations,
        receipts,
        ...(pending ? { pending } : {})
      } as AuthoringRetentionState
    }
  }
  write(raw: string | undefined, value: AuthoringRetentionState, guard: () => void) {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw Error("AUTHORING_RETENTION_LIMIT")
    guard()
    if (!this.store.compareAndSetSetting(KEY, raw, encoded))
      throw Error("AUTHORING_RETENTION_CHANGED")
    guard()
  }
}
