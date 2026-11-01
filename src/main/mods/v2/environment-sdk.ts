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
    overlay?: ReadonlyMap<string, string | undefined>
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
  const own = context.overlay?.has(normalized) === true
  if (!own && !FUNCTION_ENVIRONMENT_READ_NAMES.some((item) => key(item) === normalized))
    throw new ModFunctionError("MODS_ENV_READ_DENIED")
  const actualName = Object.keys(process.env).find((item) => key(item) === normalized)
  const raw = own
    ? context.overlay!.get(normalized)
    : actualName === undefined
      ? undefined
      : process.env[actualName]
  if (raw === undefined) return undefined
  if (Buffer.byteLength(raw) > 32 * 1024) throw new ModFunctionError("MODS_ENV_VALUE_LIMIT")
  const published = await context.publish(raw, context.signal)
  check()
  if (typeof published !== "string" || Buffer.byteLength(published) > 32 * 1024)
    throw new ModFunctionError("MODS_ENV_RESULT")
  return published
}

/** Per-source session overlay. Never changes the Electron host or another plugin's children. */
export class FunctionEnvironmentOverlay {
  readonly values = new Map<string, string | undefined>()

  set(requested: unknown, value: unknown, declared: readonly string[]): { deny?: string } {
    const normalized = key(name(requested))
    if (!declared.some((item) => key(item) === normalized))
      throw new ModFunctionError("MODS_ENV_UNDECLARED")
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(normalized) ||
      /^(?:PATH|PATHEXT|COMSPEC|SHELL|SYSTEMROOT|WINDIR|HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|NODE_.+|ELECTRON_.+|LD_.+|DYLD_.+|BASH_ENV|ENV|BASH_FUNC_.+|PROMPT_COMMAND|JAVA_.+|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|MAVEN_OPTS|GRADLE_OPTS|DOTNET_.+|CORECLR_.+|COR_.+|PYTHON.+|RUBY.+|PERL.+|CLASSPATH|PSMODULEPATH|PSEXECUTIONPOLICYPREFERENCE|GCONV_PATH|GLIBC_TUNABLES|OPENSSL_CONF|OPENSSL_MODULES|GIT_CONFIG.*|GIT_EXEC_PATH|GIT_SSH.*|GIT_ASKPASS|SSH_ASKPASS|.*(?:TOKEN|PASSWORD|SECRET|API_KEY|CREDENTIAL).*)$/i.test(
        normalized
      )
    )
      return { deny: "此环境变量由宿主管理，不能通过插件修改。" }
    if (
      value !== undefined &&
      (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 32 * 1024)
    )
      throw new ModFunctionError("MODS_ENV_VALUE_LIMIT")
    const proposed = new Map(this.values).set(normalized, value as string | undefined)
    if (
      proposed.size > 128 ||
      [...proposed].reduce(
        (n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v ?? ""),
        0
      ) >
        32 * 1024
    )
      throw new ModFunctionError("MODS_ENV_VALUE_LIMIT")
    this.values.set(normalized, value as string | undefined)
    return {}
  }

  snapshot(): Readonly<Record<string, string | null>> {
    return Object.freeze(Object.fromEntries([...this.values].map(([k, v]) => [k, v ?? null])))
  }
}
