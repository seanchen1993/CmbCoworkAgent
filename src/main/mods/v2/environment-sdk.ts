import { parse, type AnyNode } from "acorn"
import { ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson } from "../../../shared/mods/types"

export interface FunctionEnvironmentDeclaration {
  read: string[]
  write: string[]
}

export const FUNCTION_ENVIRONMENT_READ_NAMES = Object.freeze([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SHELL",
  "SYSTEMROOT",
  "WINDIR",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS"
])

function key(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name
}

function name(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128 || /[=\0]/.test(value))
    throw new ModFunctionError("MODS_ENV_NAME")
  return value
}

function member(node: AnyNode | undefined): string | undefined {
  if (node?.type !== "MemberExpression") return undefined
  if (!node.computed && node.property.type === "Identifier") return node.property.name
  if (node.computed && node.property.type === "Literal" && typeof node.property.value === "string")
    return node.property.value
  return undefined
}

/** Inspect transformed source, never execute it. Unknown aliases confer no host permission. */
export function discoverFunctionEnvironment(code: string): FunctionEnvironmentDeclaration {
  // The loader has already parsed this transformed source. Most plugins need no second AST walk.
  // Retain parsing for escapes: a computed property can spell "env" using hex or Unicode escapes.
  if (!code.includes("env") && !code.includes("\\")) return { read: [], write: [] }
  const found = { get: new Set<string>(), set: new Set<string>() }
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    const node = value as AnyNode
    if (node.type === "CallExpression") {
      const method = member(node.callee)
      if (
        node.callee.type === "MemberExpression" &&
        (method === "get" || method === "set") &&
        member(node.callee.object) === "env"
      ) {
        const argument = node.arguments[0]
        if (argument?.type !== "Literal" || typeof argument.value !== "string")
          throw new ModFunctionError("MODS_ENV_NAME_LITERAL")
        found[method].add(name(argument.value))
      }
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(parse(code, { ecmaVersion: "latest", sourceType: "module" }))
  if (found.get.size + found.set.size > 128)
    throw new ModFunctionError("MODS_ENV_DECLARATION_LIMIT")
  return { read: [...found.get].sort(), write: [...found.set].sort() }
}

export async function readFunctionEnvironment(
  value: unknown,
  context: {
    declared: readonly string[]
    signal: AbortSignal
    assertLive(): void
    publish(value: ModJson, signal: AbortSignal): Promise<ModJson>
  }
): Promise<string | undefined> {
  const requested = name(value)
  const normalized = key(requested)
  const check = () => {
    context.signal.throwIfAborted()
    context.assertLive()
  }
  check()
  if (!context.declared.some((item) => key(item) === normalized))
    throw new ModFunctionError("MODS_ENV_UNDECLARED")
  if (!FUNCTION_ENVIRONMENT_READ_NAMES.some((item) => key(item) === normalized))
    throw new ModFunctionError("MODS_ENV_READ_DENIED")
  const actualName = Object.keys(process.env).find((item) => key(item) === normalized)
  const raw = actualName === undefined ? undefined : process.env[actualName]
  if (raw === undefined) return undefined
  if (Buffer.byteLength(raw) > 32 * 1024) throw new ModFunctionError("MODS_ENV_VALUE_LIMIT")
  const published = await context.publish(raw, context.signal)
  check()
  if (typeof published !== "string" || Buffer.byteLength(published) > 32 * 1024)
    throw new ModFunctionError("MODS_ENV_RESULT")
  return published
}
