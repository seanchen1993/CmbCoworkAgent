import { createHash } from "node:crypto"
import type { ModObject } from "../../../shared/mods/types"
import {
  validateFunctionUserConfigValue,
  type FunctionUserConfig
} from "../../../shared/mods/v2/user-config"
import type {
  FunctionUserConfigMigrationView,
  FunctionUserConfigSchema
} from "../../../shared/mods/v2/user-config-schema"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface UserConfigRecord {
  revision: number
  values: ModObject
  sealed?: Record<string, string>
  schemaVersion?: number
  schemaDigest?: string
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)])
        )
      : value
export const userConfigSchemaDigest = (schema: FunctionUserConfig) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical(
          Object.fromEntries(
            Object.entries(schema).map(([key, field]) => {
              const constraints = Object.fromEntries(
                Object.entries(field).filter(([key]) => key !== "title" && key !== "description")
              )
              return [key, constraints]
            })
          )
        )
      )
    )
    .digest("hex")
export const userConfigRecordDigest = (record: UserConfigRecord) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(record)))
    .digest("hex")
export function userConfigMigrationNeeded(
  record: UserConfigRecord,
  fields: FunctionUserConfig,
  declaration?: FunctionUserConfigSchema
): boolean {
  if (!declaration && record.schemaVersion === undefined) return false
  if (
    record.schemaVersion === undefined &&
    !Object.keys(record.values).length &&
    !Object.keys(record.sealed ?? {}).length
  )
    return false // A fresh install has no previous user data to migrate.
  return (
    record.schemaVersion !== (declaration?.version ?? 0) ||
    record.schemaDigest !== userConfigSchemaDigest(fields)
  )
}
export function prepareUserConfigMigration(
  workspace: string,
  plugin: string,
  record: UserConfigRecord,
  fields: FunctionUserConfig,
  declaration: FunctionUserConfigSchema | undefined,
  renameSecret: (from: string, to: string, sealed: string) => string,
  validateSecret: (key: string, sealed: string) => void
) {
  if (!userConfigMigrationNeeded(record, fields, declaration)) return undefined
  const fromVersion = record.schemaVersion ?? 0,
    toVersion = declaration?.version ?? 0
  const changes: FunctionUserConfigMigrationView["changes"] = []
  const diagnostics: string[] = []
  const values = structuredClone(record.values),
    sealed = { ...record.sealed }
  if (!declaration || toVersion <= fromVersion)
    diagnostics.push("Schema changed without a strictly newer declared version")
  let current = fromVersion
  while (declaration && current < toVersion) {
    const step = declaration.migrations.find((item) => item.fromVersion === current)
    if (!step) {
      diagnostics.push(`Missing schema migration from version ${current}`)
      break
    }
    for (const change of step.changes) {
      changes.push(change)
      if (change.kind === "remove") {
        delete values[change.key]
        delete sealed[change.key]
      } else {
        const present = Object.hasOwn(values, change.from) || Object.hasOwn(sealed, change.from)
        // An absent override is an explicit no-op, retaining the target schema default.
        if (!present) continue
        if (Object.hasOwn(values, change.to) || Object.hasOwn(sealed, change.to)) {
          diagnostics.push(`Migration destination already has a saved value: ${change.to}`)
          continue
        }
        if (Object.hasOwn(values, change.from)) {
          Object.defineProperty(values, change.to, {
            value: values[change.from],
            enumerable: true,
            configurable: true
          })
          delete values[change.from]
        }
        if (Object.hasOwn(sealed, change.from)) {
          try {
            Object.defineProperty(sealed, change.to, {
              value: renameSecret(change.from, change.to, sealed[change.from]),
              enumerable: true,
              configurable: true
            })
            delete sealed[change.from]
          } catch {
            diagnostics.push(`Sensitive configuration needs native replacement: ${change.from}`)
          }
        }
      }
    }
    current = step.toVersion
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.hasOwn(fields, key)) {
      diagnostics.push(`Removed field needs an explicit migration: ${key}`)
      continue
    }
    if (fields[key].sensitive) {
      diagnostics.push(`Plaintext cannot become a sensitive saved value: ${key}`)
      continue
    }
    try {
      validateFunctionUserConfigValue(key, fields[key], value)
    } catch {
      diagnostics.push(`Saved value no longer matches the schema: ${key}`)
    }
  }
  for (const key of Object.keys(sealed)) {
    if (!Object.hasOwn(fields, key) || !fields[key].sensitive)
      diagnostics.push(`Sensitive field needs an explicit removal: ${key}`)
    else
      try {
        validateSecret(key, sealed[key])
      } catch {
        diagnostics.push(`Sensitive configuration no longer matches the schema: ${key}`)
      }
  }
  const digest = createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          workspace,
          plugin,
          revision: record.revision,
          record: userConfigRecordDigest(record),
          schema: userConfigSchemaDigest(fields),
          declaration: declaration ?? null,
          changes
        })
      )
    )
    .digest("hex")
  const view: FunctionUserConfigMigrationView = {
    fromVersion,
    toVersion,
    digest,
    canApply: !diagnostics.length,
    changes,
    diagnostics
  }
  return {
    view,
    values,
    sealed,
    schemaVersion: toVersion,
    schemaDigest: userConfigSchemaDigest(fields)
  }
}
export function assertUserConfigSchemaCurrent(
  record: UserConfigRecord,
  fields: FunctionUserConfig,
  declaration?: FunctionUserConfigSchema
) {
  if (userConfigMigrationNeeded(record, fields, declaration))
    throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_REQUIRED")
}
