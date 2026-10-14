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

type ConfigRecord = { revision: number; values: ModObject; sealed?: Record<string, string> }

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
      Object.keys(parsed).some((key) => !["revision", "values", "sealed"].includes(key)) ||
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
      ...(parsed.sealed === undefined ? {} : { sealed: parsed.sealed as Record<string, string> })
    }
  }

  resolve(workspace: string, plugin: string, schema: FunctionUserConfig): ModObject {
    const current = this.read(workspace, plugin)
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
    assertLive: () => void
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
      encodeModJson(current.sealed ?? {}) === encodeModJson(sealed)
    )
      return { revision: current.revision, values: structuredClone(values), changed: false }
    if (current.revision === Number.MAX_SAFE_INTEGER)
      throw new ModFunctionError("MODS_USER_CONFIG_STORE")
    const next = { revision: current.revision + 1, values, ...protectedFields }
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
    assertLive: () => void
  ) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!field?.sensitive) throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    if (!this.secrets.available()) throw new ModFunctionError("MODS_SECRET_STORAGE_UNAVAILABLE")
    assertLive()
    const current = this.read(workspace, plugin)
    if (current.revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const { values, sealed } = this.clean(current, schema)
    if (action.operation === "clear") delete sealed[key]
    else {
      this.validateKind(key, field, action.value)
      const encrypted = this.secrets.seal(workspace, plugin, key, field, action.value)
      Object.defineProperty(sealed, key, { value: encrypted, enumerable: true, configurable: true })
    }
    return this.commit(workspace, plugin, current, values, sealed, expectedRevision, assertLive)
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

  save(
    workspace: string,
    plugin: string,
    schema: FunctionUserConfig,
    key: string,
    value: FunctionConfigValue,
    expectedRevision: number,
    assertLive: () => void
  ) {
    const field = Object.hasOwn(schema, key) ? schema[key] : undefined
    if (!field || !writableFunctionUserConfig(field))
      throw new ModFunctionError("MODS_USER_CONFIG_DIALOG_REQUIRED")
    this.validateKind(key, field, value)
    assertLive()
    const current = this.read(workspace, plugin)
    if (current.revision !== expectedRevision)
      throw new ModFunctionError("MODS_CONFIG_VALUE_CHANGED")
    const { values, sealed } = this.clean(current, schema)
    delete sealed[key]
    return this.commit(
      workspace,
      plugin,
      current,
      { ...values, [key]: structuredClone(value) },
      sealed,
      expectedRevision,
      assertLive
    )
  }
}
