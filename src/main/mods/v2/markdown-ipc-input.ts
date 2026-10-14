import { ModError } from "../errors"
import {
  validateFunctionMarkdownLinkAction,
  type FunctionMarkdownLinkAction
} from "../../../shared/mods/v2/markdown-links"

function fields(input: unknown, names: readonly string[]): Map<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ModError("MODS_IPC_ARGUMENTS")
  const prototype = Object.getPrototypeOf(input)
  if (prototype !== Object.prototype && prototype !== null) throw new ModError("MODS_IPC_ARGUMENTS")
  const result = new Map<string, unknown>()
  for (const name of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name)
    if (
      typeof name !== "string" ||
      !names.includes(name) ||
      !descriptor?.enumerable ||
      !("value" in descriptor)
    )
      throw new ModError("MODS_IPC_ARGUMENTS")
    result.set(name, descriptor.value)
  }
  if (result.size !== names.length) throw new ModError("MODS_IPC_ARGUMENTS")
  return result
}

function threadId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200)
    throw new ModError("MODS_IPC_ARGUMENTS")
  return value
}

export function functionMarkdownIpcLink(input: unknown): {
  threadId: string
  action: FunctionMarkdownLinkAction
} {
  const values = fields(input, ["threadId", "action"])
  const id = threadId(values.get("threadId"))
  const action = values.get("action")
  validateFunctionMarkdownLinkAction(action)
  return { threadId: id, action }
}

export function functionMarkdownIpcReceipt(input: unknown): {
  threadId: string
  receipt: string
} {
  const values = fields(input, ["threadId", "receipt"])
  const id = threadId(values.get("threadId"))
  const receipt = values.get("receipt")
  if (
    typeof receipt !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(receipt)
  )
    throw new ModError("MODS_IPC_ARGUMENTS")
  return { threadId: id, receipt }
}
