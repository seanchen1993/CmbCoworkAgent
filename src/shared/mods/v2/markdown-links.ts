import { ModFunctionError } from "./contracts"
import { FUNCTION_MARKDOWN_MAX_HREF } from "./markdown"

/** Drawing addresses only. The host must find their current private publication. */
export type FunctionMarkdownLinkAddress =
  | { kind: "pane"; pane: string; generation: string }
  | { kind: "site"; owner: string; pane: string; generation: string }
  | { kind: "client"; pane: string; instance: string; generation: string }

export interface FunctionMarkdownLinkAction {
  address: FunctionMarkdownLinkAddress
  nonce: string
  intentId: string
  href: string
}

/** Added after protected publication; absent from the guest tree and SDK projection. */
export interface FunctionMarkdownLinkSidecar {
  nodePath: readonly number[]
  nonce: string
}

export interface FunctionMarkdownProtectedPreview {
  receipt: string
  title: string
  text: string
}

export type FunctionMarkdownLinkOutcome =
  | { state: "handled" | "opened" | "ignored" }
  | { state: "preview"; preview: FunctionMarkdownProtectedPreview }

function fail(): never {
  throw new ModFunctionError("MODS_UI_MARKDOWN_ACTION_INVALID")
}

function dataFields(value: unknown, keys: readonly string[]): Map<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail()
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) fail()
  const fields = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !keys.includes(key)) fail()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !("value" in descriptor)) fail()
    fields.set(key, descriptor.value)
  }
  if (fields.size !== keys.length) fail()
  return fields
}

function addressText(value: unknown, max = 1024): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    // eslint-disable-next-line no-control-regex -- Addresses cannot carry control sequences.
    !/[\u0000-\u001f\u007f-\u009f]/.test(value)
  )
}

export function validateFunctionMarkdownLinkAction(
  value: unknown
): asserts value is FunctionMarkdownLinkAction {
  const action = dataFields(value, ["address", "nonce", "intentId", "href"])
  const address = dataFields(
    action.get("address"),
    ["kind", "pane", "generation", "owner", "instance"].filter((key) => {
      if (key !== "owner" && key !== "instance") return true
      const source = action.get("address")
      if (!source || typeof source !== "object") return false
      const descriptor = Object.getOwnPropertyDescriptor(source, "kind")
      return (
        descriptor &&
        "value" in descriptor &&
        ((key === "owner" && descriptor.value === "site") ||
          (key === "instance" && descriptor.value === "client"))
      )
    })
  )
  const kind = address.get("kind")
  if (typeof kind !== "string" || !["pane", "site", "client"].includes(kind)) fail()
  for (const key of ["pane", "generation", "owner", "instance"])
    if (address.has(key) && !addressText(address.get(key))) fail()
  if (
    !addressText(action.get("nonce"), 128) ||
    !addressText(action.get("intentId"), 128) ||
    !addressText(action.get("href"), FUNCTION_MARKDOWN_MAX_HREF)
  )
    fail()
}

export function functionMarkdownLinkAddressKey(address: FunctionMarkdownLinkAddress): string {
  return JSON.stringify(
    address.kind === "pane"
      ? [address.kind, address.pane, address.generation]
      : address.kind === "site"
        ? [address.kind, address.owner, address.pane, address.generation]
        : [address.kind, address.pane, address.instance, address.generation]
  )
}
