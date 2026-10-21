import type { ModObject } from "../../../shared/mods/types"
import { ModFunctionError, isModObject } from "../../../shared/mods/v2/contracts"
import type { FunctionConfigValue } from "../../../shared/mods/v2/config"
import {
  writableFunctionUserConfig,
  validateFunctionUserConfigValue,
  resolveFunctionUserConfig,
  type FunctionUserConfig
} from "../../../shared/mods/v2/user-config"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import type { ModControlStore } from "../control-store"
import { FunctionUserConfigSecrets, type FunctionSecretProtector } from "./user-config-secrets"
import type { SensitiveFunctionUserConfigAction } from "../../../shared/mods/v2/user-config-view"

import type { FunctionUserConfigSchema } from "../../../shared/mods/v2/user-config-schema"
import {
  assertUserConfigSchemaCurrent,
  prepareUserConfigMigration,
  userConfigSchemaDigest,
  userConfigRecordDigest,
  type UserConfigRecord as ConfigRecord
} from "./user-config-migration"

/** Main-only recovery material. Sealed values remain bound to their original workspace. */
export interface NativeStageUserConfiguration {
  workspace: string
  plugin: string
  schema: FunctionUserConfig
  declaration?: FunctionUserConfigSchema
  record: ConfigRecord
  identity: { savedRevision: number; storedRecordDigest: string; schemaVersion: number }
}

/** Ordinary values and opaque OS-encrypted fields share one durable revision. */
export class FunctionUserConfigValues {
  private readonly secrets: FunctionUserConfigSecrets
  constructor(
    private readonly store: Pick<ModControlStore, "getSetting" | "setSetting">,
    protector?: FunctionSecretProtector
  ) {
    this.secrets = new FunctionUserConfigSecrets(protector)
  }

  private key(workspace: string, plugin: string): string {
    return "function-user-config:" + JSON.stringify([workspace, plugin])
  }

  read(workspace: string, plugin: string): ConfigRecord {
    const raw = this.store.getSetting(this.key(workspace, plugin), '{"revision":0,"values":{}}')
    if (Buffer.byteLength(raw) > 512 * 1024) throw new ModFunctionError("MODS_USER_CONFIG_STORE")
    let parsed
    try {
      parsed = parseModJson(raw)
    } catch {
      throw new ModFunctionError("MODS_USER_CONFIG_STORE")
    }
    if (
      !isModObject(parsed) ||
      !Number.isSafeInteger(parsed.revision) ||
      Number(parsed.revision) < 0 ||
      !isModObject(parsed.values) ||
      Object.keys(parsed).some(
        (key) => !["revision", "values", "sealed", "schemaVersion", "schemaDigest"].includes(key)
      ) ||
      (parsed.schemaVersion === undefined) !== (parsed.schemaDigest === undefined) ||
      (parsed.schemaVersion !== undefined &&
        (!Number.isSafeInteger(parsed.schemaVersion) ||
          Number(parsed.schemaVersion) < 1 ||
          Number(parsed.schemaVersion) > 65535 ||
          typeof parsed.schemaDigest !== "string" ||
          !/^[a-f0-9]{64}$/.test(parsed.schemaDigest))) ||
      (parsed.sealed !== undefined &&
        (!isModObject(parsed.sealed) ||
          Object.keys(parsed.sealed).length > 64 ||
          Object.values(parsed.sealed).some(
            (value) => typeof value !== "string" || !value.length || value.length > 512 * 1024
          ))) ||
      Buffer.byteLength(encodeModJson({ revision: parsed.revision, values: parsed.values })) >
        256 * 1024
    )
      throw new ModFunctionError("MODS_USER_CONFIG_STORE")
    return {
      revision: Number(parsed.revision),
      values: parsed.values,
      ...(parsed.sealed === undefined ? {} : { sealed: parsed.sealed as Record<string, string> }),
      ...(parsed.schemaVersion === undefined
        ? {}
        : {
            schemaVersion: Number(parsed.schemaVersion),
            schemaDigest: String(parsed.schemaDigest)
          })
    }
  }

  captureStageRecovery(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    declaration?: FunctionUserConfigSchema
  ): NativeStageUserConfiguration {
    const identity = this.identity(workspace, plugin)
    const original = this.read(workspace, plugin)
    this.resolve(workspace, plugin, schema, declaration)
    const values: ModObject = {},
      sealed: Record<string, string> = {}
    for (const [key, field] of Object.entries(schema)) {
      if (field.sensitive) {
        if (Object.hasOwn(original.values, key))
          throw new ModFunctionError("MODS_SECRET_STORAGE_INVALID")
        if (original.sealed && Object.hasOwn(original.sealed, key))
          sealed[key] = original.sealed[key]
      } else if (Object.hasOwn(original.values, key))
        values[key] = structuredClone(original.values[key])
    }
    if (JSON.stringify(this.identity(workspace, plugin)) !== JSON.stringify(identity))
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    return structuredClone({
      workspace,
      plugin,
      schema,
      ...(declaration ? { declaration } : {}),
      record: {
        revision: original.revision,
        values,
        ...(Object.keys(sealed).length ? { sealed } : {}),
        ...(original.schemaVersion === undefined
          ? {}
          : {
              schemaVersion: original.schemaVersion,
              schemaDigest: original.schemaDigest
            })
      },
      identity
    })
  }

  private recoveryValues(snapshot: NativeStageUserConfiguration, overrides: ModObject): ModObject {
    const values = structuredClone(snapshot.record.values)
    for (const [key, field] of Object.entries(snapshot.schema)) {
      if (field.sensitive && snapshot.record.sealed && Object.hasOwn(snapshot.record.sealed, key))
        values[key] = this.secrets.open(
          snapshot.workspace,
          snapshot.plugin,
          key,
          field,
          snapshot.record.sealed[key]
        )
    }
    for (const [key, value] of Object.entries(overrides)) {
      const field = Object.hasOwn(snapshot.schema, key) ? snapshot.schema[key] : undefined
      if (!field || field.type !== "directory" || field.sensitive || field.multiple)
        throw new ModFunctionError("MODS_USER_CONFIG_INVALID")
      this.validateKind(key, field, value as FunctionConfigValue)
      values[key] = value
    }
    return resolveFunctionUserConfig(snapshot.schema, values)
  }

  /** Native creation after explicit recovery review. Re-seals secrets, transfers no grants. */
  forkStageRecovery(
    snapshot: NativeStageUserConfiguration,
    targetWorkspace: string,
    overrides: ModObject,
    assertLive: () => void
  ) {
    const guard = () => {
      assertLive()
      if (
        targetWorkspace === snapshot.workspace ||
        JSON.stringify(this.identity(snapshot.workspace, snapshot.plugin)) !==
          JSON.stringify(snapshot.identity)
      )
        throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    }
    guard()
    const target = this.read(targetWorkspace, snapshot.plugin)
    if (
      target.revision !== 0 ||
      Object.keys(target.values).length ||
      Object.keys(target.sealed ?? {}).length ||
      target.schemaVersion !== undefined
    )
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const resolved = this.recoveryValues(snapshot, overrides)
    const values: ModObject = {},
      sealed: Record<string, string> = {}
    for (const [key, field] of Object.entries(snapshot.schema)) {
      if (!Object.hasOwn(resolved, key)) continue
      if (field.sensitive)
        sealed[key] = this.secrets.seal(
          targetWorkspace,
          snapshot.plugin,
          key,
          field,
          resolved[key] as FunctionConfigValue
        )
      else values[key] = structuredClone(resolved[key])
    }
    guard()
    this.commit(
      targetWorkspace,
      snapshot.plugin,
      target,
      values,
      sealed,
      0,
      guard,
      snapshot.declaration
        ? {
            schemaVersion: snapshot.declaration.version,
            schemaDigest: userConfigSchemaDigest(snapshot.schema)
          }
        : undefined
    )
    return this.identity(targetWorkspace, snapshot.plugin)
  }

  stageRecoveryMatches(
    snapshot: NativeStageUserConfiguration,
    targetWorkspace: string,
    overrides: ModObject
  ): boolean {
    try {
      return (
        encodeModJson(
          this.resolve(targetWorkspace, snapshot.plugin, snapshot.schema, snapshot.declaration)
        ) === encodeModJson(this.recoveryValues(snapshot, overrides))
      )
    } catch {
      return false
    }
  }

  resolve(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    declaration?: FunctionUserConfigSchema
  ): ModObject {
    const current = this.read(workspace, plugin)
    assertUserConfigSchemaCurrent(current, schema, declaration)
    const values: ModObject = {}
    for (const [key, field] of Object.entries(schema)) {
      if (field.sensitive) {
        // A legacy plaintext value is never interpreted as a confidential saved value.
        if (
          !Object.hasOwn(current.values, key) &&
          current.sealed &&
          Object.hasOwn(current.sealed, key)
        ) {
          const value = this.secrets.open(workspace, plugin, key, field, current.sealed[key])
          Object.defineProperty(values, key, { value, enumerable: true, configurable: true })
        }
      } else if (Object.hasOwn(current.values, key)) {
        Object.defineProperty(values, key, {
          value: current.values[key],
          enumerable: true,
          configurable: true
        })
      }
    }
    return resolveFunctionUserConfig(schema, values)
  }

  presence(workspace: string, plugin: string, schema: FunctionUserConfig, key: string) {
    const current = this.read(workspace, plugin),
      field = schema[key]
    const editable = this.secrets.available()
    if (!editable) return { editable, state: "unavailable" as const }
    if (
      !Object.hasOwn(current.values, key) &&
      current.sealed &&
      Object.hasOwn(current.sealed, key)
    ) {
      try {
        this.secrets.open(workspace, plugin, key, field, current.sealed[key])
        return { editable, state: "saved" as const }
      } catch (error) {
        return {
          editable,
          state:
            error instanceof ModFunctionError && error.code === "MODS_SECRET_SCHEMA_CHANGED"
              ? ("changed" as const)
              : ("invalid" as const)
        }
      }
    }
    return {
      editable,
      state: Object.hasOwn(field, "default") ? ("default" as const) : ("unset" as const)
    }
  }

  private clean(current: ConfigRecord, schema: FunctionUserConfig) {
    const values = { ...current.values },
      sealed = { ...current.sealed }
    for (const key of Object.keys(sealed))
      if (!Object.hasOwn(schema, key) || !schema[key].sensitive) delete sealed[key]
    for (const [key, field] of Object.entries(schema))
      if (field.sensitive && Object.hasOwn(values, key)) {
        delete values[key]
        delete sealed[key]
      }
    return { values, sealed }
  }

  private commit(
    workspace: string,
    plugin: string,
    current: ConfigRecord,
    values: ModObject,
    sealed: Record<string, string>,
    expectedRevision: number,
    assertLive: () => void,
    metadata?: Pick<ConfigRecord, "schemaVersion" | "schemaDigest">
  ) {
    assertLive()
    if (
      current.revision !== expectedRevision ||
      this.read(workspace, plugin).revision !== expectedRevision
    )
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const protectedFields = Object.keys(sealed).length ? { sealed } : {}
    if (
      encodeModJson(current.values) === encodeModJson(values) &&
      encodeModJson(current.sealed ?? {}) === encodeModJson(sealed) &&
      current.schemaVersion === (metadata?.schemaVersion ?? current.schemaVersion) &&
      current.schemaDigest === (metadata?.schemaDigest ?? current.schemaDigest)
    )
      return { revision: current.revision, values: structuredClone(values), changed: false }
    if (current.revision === Number.MAX_SAFE_INTEGER)
      throw new ModFunctionError("MODS_USER_CONFIG_STORE")
    const next = {
      revision: current.revision + 1,
      values,
      ...protectedFields,
      ...((metadata?.schemaVersion ?? current.schemaVersion) === undefined
        ? {}
        : {
            schemaVersion: metadata?.schemaVersion ?? current.schemaVersion,
            schemaDigest: metadata?.schemaDigest ?? current.schemaDigest
          })
    }
    const encoded = encodeModJson(next)
    if (
      Buffer.byteLength(encodeModJson({ revision: next.revision, values })) > 256 * 1024 ||
      Buffer.byteLength(encoded) > 512 * 1024 ||
      Object.keys(sealed).length > 64
    )
      throw new ModFunctionError("MODS_USER_CONFIG_STORE_LIMIT")
    assertLive()
    if (this.read(workspace, plugin).revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    this.store.setSetting(this.key(workspace, plugin), encoded)
    if (encodeModJson(this.read(workspace, plugin)) !== encoded)
      throw new ModFunctionError("MODS_CONFIG_COMMIT_UNCONFIRMED")
    return { revision: next.revision, values: structuredClone(values), changed: true }
  }

  saveSensitive(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    key: string,
    action: SensitiveFunctionUserConfigAction,
    expectedRevision: number,
    assertLive: () => void,
    declaration?: FunctionUserConfigSchema
  ) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!field?.sensitive) throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    if (!this.secrets.available()) throw new ModFunctionError("MODS_SECRET_STORAGE_UNAVAILABLE")
    assertLive()
    const current = this.read(workspace, plugin)
    if (current.revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    assertUserConfigSchemaCurrent(current, schema, declaration)
    const { values, sealed } = this.clean(current, schema)
    if (action.operation === "clear") delete sealed[key]
    else {
      this.validateKind(key, field, action.value)
      const encrypted = this.secrets.seal(workspace, plugin, key, field, action.value)
      Object.defineProperty(sealed, key, { value: encrypted, enumerable: true, configurable: true })
    }
    return this.commit(
      workspace,
      plugin,
      current,
      values,
      sealed,
      expectedRevision,
      assertLive,
      declaration
        ? { schemaVersion: declaration.version, schemaDigest: userConfigSchemaDigest(schema) }
        : undefined
    )
  }

  private validateKind(
    key: string,
    field: FunctionUserConfig[string],
    value: FunctionConfigValue
  ): void {
    if (
      (field.type === "boolean" && typeof value !== "boolean") ||
      (field.type === "number" && typeof value !== "number") ||
      (field.type === "string" &&
        (field.multiple ? !Array.isArray(value) : typeof value !== "string")) ||
      ((field.type === "file" || field.type === "directory") && typeof value !== "string")
    )
      throw new ModFunctionError("MODS_CONFIG_VALUE_KIND")
    validateFunctionUserConfigValue(key, field, value)
  }

  /** Removing an override restores the current schema default, including an unset required field. */
  reset(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    key: string,
    expectedRevision: number,
    assertLive: () => void,
    declaration?: FunctionUserConfigSchema
  ) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!field || !writableFunctionUserConfig(field))
      throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    assertLive()
    const current = this.read(workspace, plugin)
    assertUserConfigSchemaCurrent(current, schema, declaration)
    const { values, sealed } = this.clean(current, schema)
    delete values[key]
    delete sealed[key]
    return this.commit(
      workspace,
      plugin,
      current,
      values,
      sealed,
      expectedRevision,
      assertLive,
      declaration
        ? { schemaVersion: declaration.version, schemaDigest: userConfigSchemaDigest(schema) }
        : undefined
    )
  }

  save(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    key: string,
    value: FunctionConfigValue,
    expectedRevision: number,
    assertLive: () => void,
    declaration?: FunctionUserConfigSchema
  ) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!field || !writableFunctionUserConfig(field))
      throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    this.validateKind(key, field, value)
    assertLive()
    const current = this.read(workspace, plugin)
    if (current.revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    assertUserConfigSchemaCurrent(current, schema, declaration)
    const { values, sealed } = this.clean(current, schema)
    delete sealed[key]
    return this.commit(
      workspace,
      plugin,
      current,
      { ...values, [key]: structuredClone(value) },
      sealed,
      expectedRevision,
      assertLive,
      declaration
        ? { schemaVersion: declaration.version, schemaDigest: userConfigSchemaDigest(schema) }
        : undefined
    )
  }
  identity(workspace: string, plugin: string) {
    const current = this.read(workspace, plugin)
    return {
      savedRevision: current.revision,
      storedRecordDigest: userConfigRecordDigest(current),
      schemaVersion: current.schemaVersion ?? 0
    }
  }
  migration(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    declaration?: FunctionUserConfigSchema
  ) {
    return prepareUserConfigMigration(
      workspace,
      plugin,
      this.read(workspace, plugin),
      schema,
      declaration,
      (from, to, sealed) => this.secrets.rename(workspace, plugin, from, to, sealed),
      (key, sealed) => {
        this.secrets.open(workspace, plugin, key, schema[key], sealed)
      }
    )
  }
  migrate(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    declaration: FunctionUserConfigSchema | undefined,
    expectedRevision: number,
    expectedDigest: string,
    assertLive: () => void
  ) {
    assertLive()
    const current = this.read(workspace, plugin)
    if (current.revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const migration = this.migration(workspace, plugin, schema, declaration)
    if (!migration || migration.view.digest !== expectedDigest)
      throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_CHANGED")
    if (!migration.view.canApply) throw new ModFunctionError("MODS_USER_CONFIG_MIGRATION_BLOCKED")
    return this.commit(
      workspace,
      plugin,
      current,
      migration.values,
      migration.sealed,
      expectedRevision,
      assertLive,
      { schemaVersion: migration.schemaVersion, schemaDigest: migration.schemaDigest }
    )
  }
}
