import type {
  PlatformCapabilityInfo,
  PlatformCapabilityRef,
  PlatformCapabilitySource
} from "./platform-capabilities"
import type { FunctionPaneSnapshot, FunctionUiAction } from "./ui"
import { isModObject, ModFunctionError } from "./contracts"
import { encodeModJson } from "../validation"

export const PLATFORM_SURFACE_API = "devclaw.surface/v1" as const
export const PLATFORM_SURFACE_PLACEMENTS = [
  "page",
  "navigation",
  "sidebar",
  "toolbar",
  "settings"
] as const
export type PlatformSurfacePlacement = (typeof PLATFORM_SURFACE_PLACEMENTS)[number]
export interface PlatformSurfaceDescriptor {
  type: "surface"
  apiVersion: typeof PLATFORM_SURFACE_API
  id: string
  title: string
  placement: PlatformSurfacePlacement
  paneId: string
  openAction: string
  closeAction?: string
  order?: number
  description?: string
}
export interface PlatformSurfaceEntry extends PlatformSurfaceDescriptor {
  key: string
  ref: PlatformCapabilityRef
  source: PlatformCapabilitySource
  enabled: boolean
}
export interface PlatformSurfaceCatalog {
  revision: number
  entries: PlatformSurfaceEntry[]
  errors: string[]
}
export interface PlatformSurfaceAddress {
  key: string
  revision: number
  openId?: string
}
export interface PlatformSurfaceFrame {
  openId: string
  entry: PlatformSurfaceEntry
  pane: FunctionPaneSnapshot | null
}
export interface PlatformSurfaceAction extends PlatformSurfaceAddress {
  action: FunctionUiAction
}

export function parsePlatformSurface(value: unknown): PlatformSurfaceDescriptor {
  const fail = (): never => {
    throw new ModFunctionError("MODS_PLATFORM_SURFACE_INVALID")
  }
  if (!isModObject(value) || encodeModJson(value).length > 8192) return fail()
  const keys = [
    "type",
    "apiVersion",
    "id",
    "title",
    "placement",
    "paneId",
    "openAction",
    "closeAction",
    "order",
    "description"
  ]
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.type !== "surface" ||
    value.apiVersion !== PLATFORM_SURFACE_API ||
    ![value.id, value.paneId, value.openAction].every(
      (v) => typeof v === "string" && /^[a-z][a-z0-9._-]{0,79}$/.test(v)
    ) ||
    (value.closeAction !== undefined &&
      (typeof value.closeAction !== "string" ||
        !/^[a-z][a-z0-9._-]{0,79}$/.test(value.closeAction))) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 160 ||
    !PLATFORM_SURFACE_PLACEMENTS.includes(value.placement as PlatformSurfacePlacement) ||
    (value.description !== undefined &&
      (typeof value.description !== "string" || value.description.length > 1000)) ||
    (value.order !== undefined &&
      (typeof value.order !== "number" ||
        !Number.isSafeInteger(value.order) ||
        Math.abs(value.order) > 10000))
  )
    return fail()
  return structuredClone(value) as unknown as PlatformSurfaceDescriptor
}

export function platformSurfaceEntry(
  info: PlatformCapabilityInfo
): PlatformSurfaceEntry | undefined {
  if (info.descriptor.presentation?.type !== "surface") return undefined
  const descriptor = parsePlatformSurface(info.descriptor.presentation)
  const action = info.descriptor.actions.find((action) => action.id === descriptor.openAction)
  if (!action) throw new ModFunctionError("MODS_PLATFORM_SURFACE_ACTION_MISSING")
  if (
    descriptor.closeAction &&
    !info.descriptor.actions.some((action) => action.id === descriptor.closeAction)
  )
    throw new ModFunctionError("MODS_PLATFORM_SURFACE_ACTION_MISSING")
  return {
    ...descriptor,
    key: JSON.stringify([
      info.ref.provider,
      info.ref.id,
      info.ref.version,
      info.source.digest,
      info.source.generation,
      descriptor.id
    ]),
    ref: { ...info.ref },
    source: { ...info.source },
    enabled: info.available
  }
}
