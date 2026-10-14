import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { Lexer, type Token } from "marked"
import { isModObject, ModFunctionError } from "../../../shared/mods/v2/contracts"
import type { ModJson, ModObject } from "../../../shared/mods/types"

export interface FunctionAncestorsRequest {
  names: string[]
  of?: string
  below?: string
}

export type FunctionAncestorPart = ModObject & { path: string; content: string }
export type FunctionAncestor = ModObject & {
  dir: string
  name: string
  content: string
  parts: FunctionAncestorPart[]
}

const MAX_FILES = 128
const MAX_BYTES = 256 * 1024
const MAX_DEPTH = 5

export function functionAncestorsRequest(value: unknown): FunctionAncestorsRequest {
  if (
    !isModObject(value) ||
    Object.keys(value).some((key) => !["names", "of", "below"].includes(key)) ||
    !Array.isArray(value.names) ||
    !value.names.length ||
    value.names.length > 16 ||
    value.names.some(
      (name) =>
        typeof name !== "string" ||
        !/^[\w.-]+\.md$/i.test(name) ||
        name.includes("..") ||
        name.length > 128
    ) ||
    [value.of, value.below].some(
      (path) =>
        path !== undefined &&
        (typeof path !== "string" ||
          !path ||
          path.length > 8192 ||
          [...path].some((character) => character.charCodeAt(0) < 32))
    )
  )
    throw new ModFunctionError("MODS_FS_ANCESTORS_ARGUMENT")
  return {
    names: [...new Set(value.names as string[])],
    ...(typeof value.of === "string" ? { of: value.of } : {}),
    ...(typeof value.below === "string" ? { below: value.below } : {})
  }
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Markdown text imports only: code, inline code and HTML are not instruction imports. */
function includes(text: string): string[] {
  const found = new Set<string>()
  const visit = (tokens: Token[]): void => {
    for (const token of tokens) {
      if (["code", "codespan", "html"].includes(token.type)) continue
      if (token.type === "text" && "text" in token && typeof token.text === "string") {
        for (const match of token.text.matchAll(/(?:^|\s)@((?:[^\s\\]|\\ )+)/g)) {
          const path = match[1].split("#", 1)[0].replaceAll("\\ ", " ")
          if (path && !path.startsWith("@") && /^(?:\.\/|~\/|\/|[a-zA-Z0-9._-])/.test(path))
            found.add(path)
        }
      }
      if ("tokens" in token && Array.isArray(token.tokens)) visit(token.tokens)
      if ("items" in token && Array.isArray(token.items)) visit(token.items)
    }
  }
  visit(Lexer.lex(text, { gfm: false }))
  return [...found]
}

/** Bounded project-root adaptation. Reads and publication remain owned by ProjectFunctionFiles. */
export async function readFunctionAncestors(
  request: FunctionAncestorsRequest,
  context: {
    workspace: string
    signal: AbortSignal
    assertLive(): void
    canonical(path: string): Promise<string>
    read(path: string): Promise<string>
  }
): Promise<FunctionAncestor[]> {
  const input = functionAncestorsRequest(request)
  const root = resolve(context.workspace)
  const check = () => {
    context.signal.throwIfAborted()
    context.assertLive()
  }
  const bounded = (path: string): string => {
    const resolved = resolve(root, path)
    if (!inside(root, resolved)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    return resolved
  }
  check()
  const end = input.of ? dirname(bounded(input.of)) : root
  const below = input.below ? bounded(input.below) : undefined
  if (below && (end === below || !inside(below, end))) return []
  const directories: string[] = []
  for (let current = end; ; current = dirname(current)) {
    if (current === below) break
    if (!inside(root, current)) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
    if (directories.length >= 64) throw new ModFunctionError("MODS_FS_ANCESTORS_LIMIT")
    directories.unshift(current)
    if (current === root) break
  }
  let bytes = 0,
    files = 0
  const visited = new Set<string>()
  const load = async (path: string, depth: number): Promise<FunctionAncestorPart[]> => {
    check()
    const requested = bounded(path)
    if (depth >= MAX_DEPTH) throw new ModFunctionError("MODS_FS_ANCESTORS_DEPTH")
    let canonical: string
    let content: string
    try {
      canonical = bounded(await context.canonical(requested))
      check()
      const key = process.platform === "win32" ? canonical.toLowerCase() : canonical
      if (visited.has(key)) return []
      visited.add(key)
      if (++files > MAX_FILES) throw new ModFunctionError("MODS_FS_ANCESTORS_LIMIT")
      content = await context.read(requested)
      check()
    } catch (error) {
      check()
      if (
        (error as { code?: string })?.code === "ENOENT" ||
        (error as { code?: string })?.code === "MODS_FS_NOT_FOUND"
      )
        return []
      throw error
    }
    if (typeof content !== "string") throw new ModFunctionError("MODS_FS_ANCESTORS_RESULT")
    bytes += Buffer.byteLength(content)
    if (bytes > MAX_BYTES) throw new ModFunctionError("MODS_FS_ANCESTORS_LIMIT")
    if (!content.trim()) return []
    const parts: FunctionAncestorPart[] = [{ path: requested, content }]
    for (const include of includes(content)) {
      if (include.startsWith("~/")) throw new ModFunctionError("MODS_FS_OUTSIDE_PROJECT")
      parts.push(...(await load(resolve(dirname(canonical), include), depth + 1)))
    }
    return parts
  }
  const found: FunctionAncestor[] = []
  for (const dir of directories)
    for (const name of input.names) {
      const parts = await load(resolve(dir, name), 0)
      if (parts.length)
        found.push({ dir, name, parts, content: parts.map((part) => part.content).join("\n\n") })
    }
  check()
  return found
}

export function validateFunctionAncestorsResult(value: ModJson | undefined): void {
  if (
    !Array.isArray(value) ||
    value.length > MAX_FILES ||
    value.some(
      (entry) =>
        !isModObject(entry) ||
        typeof entry.dir !== "string" ||
        typeof entry.name !== "string" ||
        typeof entry.content !== "string" ||
        !Array.isArray(entry.parts) ||
        entry.parts.length > MAX_FILES ||
        entry.parts.some(
          (part) =>
            !isModObject(part) || typeof part.path !== "string" || typeof part.content !== "string"
        ) ||
        entry.content !== entry.parts.map((part) => (part as ModObject).content).join("\n\n")
    )
  )
    throw new ModFunctionError("MODS_SDK_RESULT", "MODS_SDK_RESULT: fs.ancestors")
}
