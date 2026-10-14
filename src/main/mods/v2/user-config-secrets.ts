import type { FunctionConfigValue } from "../../../shared/mods/v2/config"
import type { FunctionUserConfigField } from "../../../shared/mods/v2/user-config"
import { validateFunctionUserConfigValue } from "../../../shared/mods/v2/user-config"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"

export interface FunctionSecretProtector {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
  getSelectedStorageBackend?(): string
}

/** Main-process OS storage only; errors never include plaintext or protector diagnostics. */
export class FunctionUserConfigSecrets {
  constructor(
    private readonly protector?: FunctionSecretProtector,
    private readonly platform = process.platform
  ) {}

  available(): boolean {
    try {
      if (!this.protector?.isEncryptionAvailable()) return false
      if (
        this.platform === "linux" &&
        !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          this.protector.getSelectedStorageBackend?.() ?? ""
        )
      )
        return false
      return (
        typeof this.protector.encryptString === "function" &&
        typeof this.protector.decryptString === "function"
      )
    } catch {
      return false
    }
  }

  open(
    workspace: string,
    plugin: string,
    key: string,
    field: FunctionUserConfigField,
    sealed: string
  ): FunctionConfigValue {
    if (!this.available()) throw new ModFunctionError("MODS_SECRET_STORAGE_UNAVAILABLE")
    try {
      if (sealed.length > 512 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(sealed)) throw Error()
      const bytes = Buffer.from(sealed, "base64")
      if (bytes.toString("base64") !== sealed) throw Error()
      const text = this.protector!.decryptString(bytes)
      if (typeof text !== "string" || Buffer.byteLength(text) > 256 * 1024) throw Error()
      const value = parseModJson(text)
      if (
        !isModObject(value) ||
        value.version !== 1 ||
        value.workspace !== workspace ||
        value.plugin !== plugin ||
        value.key !== key ||
        !Object.hasOwn(value, "value") ||
        Object.keys(value).some(
          (key) =>
            !["version", "workspace", "plugin", "key", "type", "multiple", "value"].includes(key)
        )
      )
        throw Error()
      if (value.type !== field.type || value.multiple !== (field.multiple === true))
        throw new ModFunctionError("MODS_SECRET_SCHEMA_CHANGED")
      validateFunctionUserConfigValue(key, field, value.value)
      return value.value as FunctionConfigValue
    } catch (error) {
      if (error instanceof ModFunctionError && error.code === "MODS_SECRET_SCHEMA_CHANGED")
        throw error
      throw new ModFunctionError("MODS_SECRET_STORAGE_INVALID")
    }
  }

  seal(
    workspace: string,
    plugin: string,
    key: string,
    field: FunctionUserConfigField,
    value: FunctionConfigValue
  ): string {
    if (!this.available()) throw new ModFunctionError("MODS_SECRET_STORAGE_UNAVAILABLE")
    try {
      const text = encodeModJson({
        version: 1,
        workspace,
        plugin,
        key,
        type: field.type,
        multiple: field.multiple === true,
        value
      })
      if (Buffer.byteLength(text) > 256 * 1024) throw Error()
      const encrypted = this.protector!.encryptString(text)
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > 384 * 1024)
        throw Error()
      // Verify the actual OS operation before any durable commit; a silent encryptor is not success.
      const sealed = encrypted.toString("base64")
      if (encodeModJson(this.open(workspace, plugin, key, field, sealed)) !== encodeModJson(value))
        throw Error()
      return sealed
    } catch {
      throw new ModFunctionError("MODS_SECRET_STORAGE_FAILED")
    }
  }
}
