import type {
  PlatformCapabilityInfo,
  PlatformCapabilityRef,
  PlatformCapabilitySource
} from "./platform-capabilities"
import { isModObject, ModFunctionError } from "./contracts"
import { encodeModJson } from "../validation"

export const PLATFORM_BEHAVIOR_API = "devclaw.behavior/v1" as const
export const PLATFORM_BEHAVIOR_POINTS = ["prompt.suggest", "ui.toast"] as const
export type PlatformBehaviorPoint = (typeof PLATFORM_BEHAVIOR_POINTS)[number]
export type PlatformBehaviorPhase = "before" | "policy" | "replace" | "after"
export interface PlatformBehaviorDescriptor {
  type: "behavior"
  apiVersion: typeof PLATFORM_BEHAVIOR_API
  id: string
  title: string
  point: PlatformBehaviorPoint
  phase: PlatformBehaviorPhase
  action: string
  before?: string[]
  after?: string[]
  requires?: string[]
  conflicts?: string[]
}
export interface PlatformBehaviorBinding extends PlatformBehaviorDescriptor {
  key: string
  ref: PlatformCapabilityRef
  source: PlatformCapabilitySource
  available: boolean
}
export interface PlatformBehaviorCatalog {
  revision: number
  bindings: PlatformBehaviorBinding[]
  active: string[]
  errors: string[]
}
export interface PlatformBehaviorPreview {
  previewId: string
  revision: number
  selected: string[]
  order: string[]
  conflicts: string[]
  missing: string[]
  canApply: boolean
}

export function parsePlatformBehavior(value: unknown): PlatformBehaviorDescriptor {
  const fail = (): never => {
    throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_INVALID")
  }
  if (!isModObject(value) || encodeModJson(value).length > 8192) return fail()
  const keys = [
    "type",
    "apiVersion",
    "id",
    "title",
    "point",
    "phase",
    "action",
    "before",
    "after",
    "requires",
    "conflicts"
  ]
  if (
    Object.keys(value).some((key) => !keys.includes(key)) ||
    value.type !== "behavior" ||
    value.apiVersion !== PLATFORM_BEHAVIOR_API ||
    ![value.id, value.action].every(
      (v) => typeof v === "string" && /^[a-z][a-z0-9._-]{0,79}$/.test(v)
    ) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 160 ||
    !PLATFORM_BEHAVIOR_POINTS.includes(value.point as PlatformBehaviorPoint) ||
    !["before", "after", "policy", "replace"].includes(String(value.phase))
  )
    return fail()
  for (const field of ["before", "after", "requires", "conflicts"]) {
    const items = value[field]
    if (
      items !== undefined &&
      (!Array.isArray(items) ||
        items.length > 16 ||
        items.some(
          (item) =>
            typeof item !== "string" || !/^[a-zA-Z0-9._:-]+\/[a-z][a-z0-9._-]{0,79}$/.test(item)
        ))
    )
      return fail()
  }
  return structuredClone(value) as unknown as PlatformBehaviorDescriptor
}

export function platformBehaviorBinding(
  info: PlatformCapabilityInfo
): PlatformBehaviorBinding | undefined {
  if (info.descriptor.presentation?.type !== "behavior") return undefined
  const descriptor = parsePlatformBehavior(info.descriptor.presentation)
  if (!info.descriptor.actions.some((action) => action.id === descriptor.action))
    throw new ModFunctionError("MODS_PLATFORM_BEHAVIOR_ACTION_MISSING")
  return {
    ...descriptor,
    key: `${info.ref.provider}/${descriptor.id}`,
    ref: { ...info.ref },
    source: { ...info.source },
    available: info.available
  }
}
