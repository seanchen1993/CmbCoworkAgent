import { MODS_API_VERSION, type ModManifest, type ModObject, type ModUiNode } from "./types"

export const MODS_MAX_BYTES = 1024 * 1024
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"])
const events = new Set(["tool.call", "prompt.context", "command.run", "ui.render"])

export function assertModJson(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget = { nodes: 30_000, chars: MODS_MAX_BYTES }
): void {
  if (--budget.nodes < 0) throw new Error("MODS_JSON_NODES")
  if (typeof value === "string" && (budget.chars -= value.length) < 0)
    throw new Error("MODS_JSON_SIZE")
  if (depth > 32) throw new Error("MODS_JSON_DEPTH")
  if (value === null || typeof value === "boolean" || typeof value === "string") return
  if (typeof value === "number" && Number.isFinite(value)) return
  if (typeof value !== "object" || !value) throw new Error("MODS_JSON_TYPE")
  if (seen.has(value)) throw new Error("MODS_JSON_CYCLE")
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("MODS_JSON_PROTOTYPE")
  }
  seen.add(value)
  for (const key of Object.keys(value)) {
    if (unsafeKeys.has(key)) throw new Error("MODS_JSON_KEY")
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !("value" in descriptor)) throw new Error("MODS_JSON_ACCESSOR")
    budget.chars -= key.length
    if (budget.chars < 0) throw new Error("MODS_JSON_SIZE")
    assertModJson(descriptor.value, depth + 1, seen, budget)
  }
  seen.delete(value)
}

export function encodeModJson(value: unknown): string {
  assertModJson(value)
  const text = JSON.stringify(value)
  if (new TextEncoder().encode(text).byteLength > MODS_MAX_BYTES) throw new Error("MODS_JSON_SIZE")
  return text
}

export function parseModJson(text: string): unknown {
  if (new TextEncoder().encode(text).byteLength > MODS_MAX_BYTES) throw new Error("MODS_JSON_SIZE")
  const value: unknown = JSON.parse(text)
  assertModJson(value)
  return value
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MODS_EXPECTED_OBJECT")
  }
  return value as Record<string, unknown>
}

function names(value: unknown, max = 64): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("MODS_EXPECTED_NAMES")
  if (!value.every((name) => typeof name === "string" && name.length > 0 && name.length <= 160)) {
    throw new Error("MODS_INVALID_NAME")
  }
  if (new Set(value).size !== value.length) throw new Error("MODS_DUPLICATE_NAME")
  return value as string[]
}

export function parseModManifest(value: unknown): ModManifest {
  encodeModJson(value)
  const input = object(value)
  if (input.apiVersion !== MODS_API_VERSION) throw new Error("MODS_UNSUPPORTED_API")
  if (typeof input.id !== "string" || !/^[a-z][a-z0-9-]{1,63}$/.test(input.id)) {
    throw new Error("MODS_INVALID_ID")
  }
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) {
    throw new Error("MODS_INVALID_NAME")
  }
  if (typeof input.entry !== "string" || !/\.[cm]?[jt]s$/.test(input.entry)) {
    throw new Error("MODS_INVALID_ENTRY")
  }
  const declaredEvents = names(input.events, 4)
  if (declaredEvents.some((event) => !events.has(event))) throw new Error("MODS_INVALID_EVENT")
  const permissions = object(input.permissions)
  if (typeof permissions.store !== "boolean") throw new Error("MODS_INVALID_STORE_PERMISSION")
  if (input.activation !== "project" && input.activation !== "plugin") {
    throw new Error("MODS_INVALID_ACTIVATION")
  }
  // Trust tier is assigned by the host, never accepted from a plugin manifest.
  if (input.managed !== undefined || input.required !== undefined || input.policy !== undefined) {
    throw new Error("MODS_RESERVED_TRUST_FIELD")
  }
  return {
    apiVersion: MODS_API_VERSION,
    id: input.id,
    name: input.name,
    entry: input.entry,
    events: declaredEvents as ModManifest["events"],
    tools: names(input.tools),
    permissions: {
      readTools: names(permissions.readTools),
      writeTools: names(permissions.writeTools),
      context: names(permissions.context, 8),
      store: permissions.store
    },
    activation: input.activation
  }
}

export function parseModUi(value: unknown): ModUiNode[] {
  if (new TextEncoder().encode(encodeModJson(value)).byteLength > 32_768)
    throw new Error("MODS_UI_BYTES")
  let count = 0
  function visit(input: unknown, depth: number): ModUiNode {
    if (++count > 200 || depth > 8) throw new Error("MODS_UI_LIMIT")
    const node = object(input)
    const text = (key: string): string => {
      if (typeof node[key] !== "string" || node[key].length > 16_000) {
        throw new Error("MODS_UI_TEXT")
      }
      return node[key] as string
    }
    switch (node.type) {
      case "text":
      case "code":
      case "badge":
        return { type: node.type, text: text("text") }
      case "card":
        if (!Array.isArray(node.children)) throw new Error("MODS_UI_CHILDREN")
        return {
          type: "card",
          title: text("title"),
          children: node.children.map((v) => visit(v, depth + 1))
        }
      case "table": {
        const columns = names(node.columns, 12)
        if (!Array.isArray(node.rows) || node.rows.length > 100) throw new Error("MODS_UI_ROWS")
        const rows = node.rows.map((row) => {
          if (
            !Array.isArray(row) ||
            row.length !== columns.length ||
            row.some((cell) => typeof cell !== "string" || cell.length > 2000)
          ) {
            throw new Error("MODS_UI_CELL")
          }
          return row as string[]
        })
        return { type: "table", columns, rows }
      }
      case "button":
        return {
          type: "button",
          label: text("label"),
          command: text("command"),
          args: object(node.args) as ModObject
        }
      default:
        throw new Error("MODS_UI_COMPONENT")
    }
  }
  if (!Array.isArray(value)) throw new Error("MODS_UI_TREE")
  return value.map((node) => visit(node, 0))
}
