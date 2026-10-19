import { isModObject, ModFunctionError } from "./contracts"
import type { FunctionUserConfig } from "./user-config"

export type UserConfigMigrationChange =
  | { kind: "rename"; from: string; to: string }
  | { kind: "remove"; key: string }
/** Optional DevClaw migration extension. The original Claude userConfig schema stays unchanged. */
export interface FunctionUserConfigSchema {
  version: number
  migrations: Array<{
    fromVersion: number
    toVersion: number
    changes: UserConfigMigrationChange[]
  }>
}
export interface FunctionUserConfigMigrationView {
  fromVersion: number
  toVersion: number
  digest: string
  canApply: boolean
  changes: UserConfigMigrationChange[]
  diagnostics: string[]
}
const fieldKey = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const integer = (value: unknown, minimum: number): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= 65535
const fail = (): never => {
  throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_INVALID")
}
export function parseFunctionUserConfigSchema(
  value: unknown,
  fields?: FunctionUserConfig
): FunctionUserConfigSchema | undefined {
  if (value === undefined) return undefined
  if (
    !fields ||
    !isModObject(value) ||
    !integer(value.version, 1) ||
    Object.keys(value).some((key) => !["version", "migrations"].includes(key)) ||
    !Array.isArray(value.migrations) ||
    value.migrations.length > 32
  )
    return fail()
  const seen = new Set<number>()
  const version = value.version
  let total = 0
  const migrations = value.migrations.map((step) => {
    if (
      !isModObject(step) ||
      Object.keys(step).some((key) => !["fromVersion", "toVersion", "changes"].includes(key)) ||
      !integer(step.fromVersion, 0) ||
      !integer(step.toVersion, 1) ||
      step.toVersion !== step.fromVersion + 1 ||
      step.toVersion > version ||
      seen.has(step.fromVersion) ||
      !Array.isArray(step.changes) ||
      step.changes.length > 64
    )
      return fail()
    seen.add(step.fromVersion)
    const touched = new Set<string>()
    const changes = step.changes.map((change) => {
      if (!isModObject(change) || ++total > 128) return fail()
      if (
        change.kind === "rename" &&
        Object.keys(change).every((key) => ["kind", "from", "to"].includes(key)) &&
        typeof change.from === "string" &&
        typeof change.to === "string" &&
        fieldKey.test(change.from) &&
        fieldKey.test(change.to) &&
        change.from !== change.to &&
        !touched.has(change.from) &&
        !touched.has(change.to)
      ) {
        touched.add(change.from)
        touched.add(change.to)
        return { kind: "rename" as const, from: change.from, to: change.to }
      }
      if (
        change.kind === "remove" &&
        Object.keys(change).every((key) => ["kind", "key"].includes(key)) &&
        typeof change.key === "string" &&
        fieldKey.test(change.key) &&
        !touched.has(change.key)
      ) {
        touched.add(change.key)
        return { kind: "remove" as const, key: change.key }
      }
      return fail()
    })
    return { fromVersion: step.fromVersion, toVersion: step.toVersion, changes }
  })
  return { version: value.version, migrations }
}
