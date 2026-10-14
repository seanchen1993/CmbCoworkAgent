import type { ModObject } from "../types"
import { ModFunctionError } from "./contracts"
import { FUNCTION_UI_SITES, type FunctionUiSite } from "./sites"
import { isModObject } from "./contracts"
import { encodeModJson } from "../validation"
import {
  validateFunctionTree,
  type FunctionUiElement,
  type FunctionUiEngine,
  type FunctionUiNode
} from "./ui"

/** Host-produced data only; integer refs do not carry permission or request authority. */
export interface FunctionNativeContent {
  component: FunctionUiSite | "Pane"
  entries: { ref: number; props: ModObject }[]
  requestId?: string
  nativeUnchanged?: boolean
}

/** IPC shape check only. Real input ownership and publication are enforced by the main process. */
export function validateFunctionNativeContent(
  value: unknown,
  component?: FunctionUiSite | "Pane",
  expectedRequestId?: string
): asserts value is FunctionNativeContent {
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_NATIVE_PUBLICATION")
  }
  if (
    !isModObject(value) ||
    !(value.component === "Pane" || FUNCTION_UI_SITES.some((site) => site === value.component)) ||
    (component !== undefined && value.component !== component) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1 ||
    value.entries.length > 65 ||
    (value.nativeUnchanged !== undefined && typeof value.nativeUnchanged !== "boolean") ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== "string" || !value.requestId || value.requestId.length > 512)) ||
    (expectedRequestId !== undefined && value.requestId !== expectedRequestId) ||
    Object.keys(value).some(
      (key) => !["component", "entries", "requestId", "nativeUnchanged"].includes(key)
    )
  )
    return fail()
  const refs = new Set<number>()
  for (const entry of value.entries) {
    if (
      !isModObject(entry) ||
      typeof entry.ref !== "number" ||
      !Number.isSafeInteger(entry.ref) ||
      entry.ref < 0 ||
      entry.ref > 64 ||
      refs.has(entry.ref) ||
      !isModObject(entry.props) ||
      Object.keys(entry).some((key) => !["ref", "props"].includes(key))
    )
      return fail()
    refs.add(entry.ref)
  }
  if (!refs.has(0)) fail()
  encodeModJson(value)
}

function collectEngineRefs(tree: FunctionUiElement): number[] {
  const refs: number[] = []
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string") return
    if (node.type === "engine") {
      refs.push(node.ref)
      return
    }
    node.children?.forEach(visit)
  }
  visit(tree)
  return refs
}

/** Only transparent structural nodes may surround the one native logical root.
 * Ask ordering must be validated before this helper: empty fragments are not an Ask bypass.
 */
export function functionLogicalEngine(tree: FunctionUiElement): FunctionUiEngine | undefined {
  validateFunctionTree(tree)
  let engine: FunctionUiEngine | undefined
  const visit = (node: FunctionUiElement | string): boolean => {
    if (typeof node === "string") return false
    if (node.type === "engine") {
      if (engine) return false
      engine = node
      return true
    }
    return node.type === "fragment" && node.children.every(visit)
  }
  return visit(tree) ? engine : undefined
}

/** Drawing order, including repeated refs. Resolving unknown refs belongs to the host table. */
export function functionEngineRefs(tree: FunctionUiElement): number[] {
  validateFunctionTree(tree)
  return collectEngineRefs(tree)
}

/** A Client's isolated tree never receives a native rendering delegate. */
export function validateFunctionClientTree(value: unknown): asserts value is FunctionUiElement {
  validateFunctionTree(value)
  if (collectEngineRefs(value).length) throw new ModFunctionError("MODS_UI_CLIENT_ENGINE")
  const visit = (node: FunctionUiElement | string): void => {
    if (typeof node === "string" || node.type === "engine") return
    if (
      node.type === "Markdown" &&
      (node.press || Object.hasOwn(node.props, "pressableLinks"))
    )
      throw new ModFunctionError("MODS_UI_CLIENT_MARKDOWN")
    node.children?.forEach(visit)
  }
  visit(value)
}

// Deliberately narrower than general Box props. New layout features must be reviewed here.
// In particular, fixed dimensions can conceal the actual question controls.
const questionAncestorProps = new Set([
  "key",
  "flexDirection",
  "gap",
  "padding",
  "paddingX",
  "paddingY",
  "margin",
  "marginX",
  "marginY",
  "alignItems",
  "justifyContent",
  "borderStyle"
])

/** Explicit native Ask tree only. Legacy description augmentation is a host operation. */
export function validateFunctionAskTree(value: unknown): asserts value is FunctionUiElement {
  validateFunctionTree(value)
  const fail = (): never => {
    throw new ModFunctionError("MODS_UI_ASK_TREE_INVALID")
  }
  if (collectEngineRefs(value).length !== 1) fail()
  let seenEngine = false
  const visit = (node: FunctionUiElement | string, ancestors: readonly FunctionUiNode[]): void => {
    // Even an empty text or layout node below the actual controls is disallowed.
    if (seenEngine) fail()
    if (typeof node === "string") return
    if (node.type === "Markdown") return
    if (node.type === "engine") {
      if (
        ancestors.some(
          (parent) =>
            parent.type !== "Box" ||
            Object.keys(parent.props).some((key) => !questionAncestorProps.has(key))
        )
      )
        fail()
      seenEngine = true
      return
    }
    // Keep structural nodes in visit order, including empty tails after the real controls.
    const parents = node.type === "fragment" ? ancestors : [...ancestors, node]
    for (const child of node.children ?? []) visit(child, parents)
  }
  visit(value, [])
}
