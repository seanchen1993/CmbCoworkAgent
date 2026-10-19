import type { ModJson, ModObject } from "../../../shared/mods/types"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import { encodeModJson, parseModJson } from "../../../shared/mods/validation"
import {
  PLATFORM_CAPABILITY_API,
  type PlatformCapabilityDescriptor,
  type PlatformCapabilityRef
} from "../../../shared/mods/v2/platform-capabilities"
import { validateToolSchema } from "./tool-schema"
import { FUNCTION_SDK_METHODS } from "./sdk-capabilities"

export function platformError(code: string): never {
  throw new ModFunctionError(code)
}
export function platformRecord(value: unknown, fields: readonly string[]): ModObject {
  if (!isModObject(value) || Object.keys(value).some((key) => !fields.includes(key)))
    platformError("MODS_PLATFORM_ARGUMENTS")
  return value
}
export function platformId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.:-]{0,127}$/.test(value))
    platformError("MODS_PLATFORM_ID")
  return value
}
export function platformVersion(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)
  )
    platformError("MODS_PLATFORM_VERSION")
  return value
}
export function platformCopy<T>(value: T): T {
  return parseModJson(encodeModJson(value)) as T
}
export function platformRef(value: unknown): PlatformCapabilityRef {
  const row = platformRecord(value, ["provider", "id", "version"])
  return {
    provider: platformId(row.provider),
    id: platformId(row.id),
    version: platformVersion(row.version)
  }
}
export function platformCurrent(value: unknown): void {
  if (platformRecord(value, ["kind"]).kind !== "current") platformError("MODS_PLATFORM_TARGET")
}
function schema(value: unknown): void {
  if (!isModObject(value) || value.type !== "object") platformError("MODS_PLATFORM_SCHEMA")
  validateToolSchema(value, { allowReservedKeys: true })
}
export function platformDescriptor(value: unknown): PlatformCapabilityDescriptor {
  const row = platformRecord(value, [
    "apiVersion",
    "id",
    "version",
    "title",
    "scope",
    "stateSchema",
    "actions",
    "presentation"
  ])
  if (
    row.apiVersion !== PLATFORM_CAPABILITY_API ||
    typeof row.title !== "string" ||
    !row.title.trim() ||
    row.title.length > 200 ||
    !["conversation", "workspace"].includes(String(row.scope)) ||
    !Array.isArray(row.actions) ||
    row.actions.length > 32 ||
    (row.presentation !== undefined &&
      (!isModObject(row.presentation) || encodeModJson(row.presentation).length > 16000))
  )
    platformError("MODS_PLATFORM_DESCRIPTOR")
  platformId(row.id)
  platformVersion(row.version)
  schema(row.stateSchema)
  const ids = new Set<string>()
  for (const input of row.actions) {
    const action = platformRecord(input, [
      "id",
      "title",
      "inputSchema",
      "outputSchema",
      "requiredPermissions",
      "cancellable",
      "idempotency"
    ])
    const id = platformId(action.id)
    if (
      ids.has(id) ||
      typeof action.title !== "string" ||
      !action.title ||
      action.title.length > 200 ||
      typeof action.cancellable !== "boolean" ||
      action.idempotency !== "keyed" ||
      !Array.isArray(action.requiredPermissions) ||
      action.requiredPermissions.length > 32 ||
      new Set(action.requiredPermissions).size !== action.requiredPermissions.length ||
      action.requiredPermissions.some(
        (permission) =>
          typeof permission !== "string" ||
          !(FUNCTION_SDK_METHODS as readonly string[]).includes(permission)
      )
    )
      platformError("MODS_PLATFORM_DESCRIPTOR")
    ids.add(id)
    schema(action.inputSchema)
    schema(action.outputSchema)
  }
  if (encodeModJson(row).length > 64000) platformError("MODS_PLATFORM_DESCRIPTOR_LIMIT")
  return platformCopy(row) as unknown as PlatformCapabilityDescriptor
}
export function platformRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    platformError("MODS_PLATFORM_REVISION")
  return value
}
export function platformJson(value: unknown): ModJson {
  return parseModJson(encodeModJson(value)) as ModJson
}
export function platformRegistrationCapabilities(
  registrations: readonly import("../../../shared/mods/v2/contracts").FunctionRegistration[]
): string[] {
  return [
    ...new Set(
      registrations.flatMap((registration) =>
        registration.platformCapability
          ? [
              "platform.act",
              ...platformDescriptor(registration.platformCapability).actions.flatMap(
                (action) => action.requiredPermissions
              )
            ]
          : [`event:${registration.pattern}`]
      )
    )
  ]
}
