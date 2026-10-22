import { encodeModJson } from "../validation"
import { ModFunctionError } from "./contracts"
import { validateFunctionNativeContent } from "./engine"
import { functionUiSite } from "./sites"
import { validateFunctionTree } from "./ui"
import type { FunctionNativeContent } from "./engine"
import type { FunctionUiSite } from "./sites"
import type { FunctionUiElement } from "./ui"
import type { ModObject } from "../types"
import { functionHostMessageProps } from "./host-message"

/** Protected, passive display data. This DTO never carries an interaction lease. */
export interface FunctionDisplaySnapshotData {
  component: FunctionUiSite
  nativeContent?: FunctionNativeContent
  tree?: FunctionUiElement
  /** Whole host-rendered message, preserving the existing guest input ceiling. */
  hostMessage?: ModObject
}

export interface FunctionDisplaySnapshot {
  scopeId: string
  key: string
  version: string
  /** Retention deadline. Zero forbids caching; live views still require their own current ticket. */
  expiresAt: number
  data: FunctionDisplaySnapshotData
}

/** Reject active UI rather than disguising a live callback as passive cached content. */
export function validateFunctionDisplaySnapshotData(value: FunctionDisplaySnapshotData): void {
  encodeModJson(value)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ModFunctionError("MODS_DISPLAY_DATA_INVALID")
  functionUiSite(value.component)
  if (
    Object.keys(value).some(
      (key) => !["component", "nativeContent", "tree", "hostMessage"].includes(key)
    ) ||
    (!value.nativeContent && !value.tree && !value.hostMessage) ||
    (value.hostMessage !== undefined &&
      (value.nativeContent !== undefined || value.tree !== undefined))
  )
    throw new ModFunctionError("MODS_DISPLAY_DATA_INVALID")
  if (value.hostMessage) functionHostMessageProps(value.component, value.hostMessage)
  const unsafe = new Set([
    "owner",
    "generation",
    "handle",
    "press",
    "client",
    "clients",
    "markdownLinks",
    "callback",
    "action",
    "authority"
  ])
  const passive = (input: unknown): void => {
    if (!input || typeof input !== "object") return
    for (const [key, child] of Object.entries(input)) {
      if (unsafe.has(key)) throw new ModFunctionError("MODS_DISPLAY_DATA_ACTIVE")
      passive(child)
    }
  }
  if (value.nativeContent) {
    validateFunctionNativeContent(value.nativeContent, value.component)
    passive(value.nativeContent)
  }
  if (value.tree) {
    validateFunctionTree(value.tree)
    passive(value.tree)
    const visit = (node: FunctionUiElement | string): void => {
      if (typeof node === "string") return
      if (!["engine", "fragment", "Box", "Text", "Code", "Svg", "Markdown"].includes(node.type))
        throw new ModFunctionError("MODS_DISPLAY_DATA_ACTIVE")
      if (node.type !== "engine") node.children?.forEach(visit)
    }
    visit(value.tree)
  }
}

/** Validate IPC display data without granting an owner, action or callback lifetime. */
export function validateFunctionDisplaySnapshot(
  value: FunctionDisplaySnapshot,
  component: FunctionUiSite,
  expectedRequestId?: string
): void {
  encodeModJson(value)
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["scopeId", "key", "version", "expiresAt", "data"].includes(key)
    ) ||
    typeof value.scopeId !== "string" ||
    !value.scopeId ||
    value.scopeId.length > 4096 ||
    typeof value.key !== "string" ||
    !value.key ||
    value.key.length > 65536 ||
    typeof value.version !== "string" ||
    !value.version ||
    value.version.length > 4096 ||
    !Number.isFinite(value.expiresAt) ||
    value.data?.component !== component
  )
    throw new ModFunctionError("MODS_DISPLAY_DATA_INVALID")
  validateFunctionDisplaySnapshotData(value.data)
  if (value.data.nativeContent)
    validateFunctionNativeContent(value.data.nativeContent, component, expectedRequestId)
}
