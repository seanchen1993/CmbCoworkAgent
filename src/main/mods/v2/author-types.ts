import { relative } from "node:path"
import { createHash } from "node:crypto"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"
import { resolveModFile } from "../loader"
import { normalizePluginRelativePath } from "../../plugins/manifest"

export interface FunctionAuthorTypes {
  scope: "authoring-subset"
  entry: string
  nouns: string[]
  state: Record<string, string[]>
  diagnostics: Array<{ code: string; message: string }>
  dependencyRegistry: false
}
const declarations = new Map<string, FunctionAuthorTypes>()

/** The pinned upstream contract is closed: imports/references are not a dependency resolver. */
export async function readFunctionAuthorTypes(
  root: string,
  declaration: unknown,
  dependencies: unknown
): Promise<{ metadata: FunctionAuthorTypes; source: string }> {
  const clean = typeof declaration === "string" ? normalizePluginRelativePath(declaration) : null
  if (!clean || !clean.endsWith(".d.ts")) throw Error("MODS_TYPES_PATH")
  const file = resolveModFile(root, clean)
  const opened = await openStableFileHandle(root, file)
  let source: string
  try {
    source = (await readStableFileHandleBounded(opened, 262144)).toString("utf8")
  } finally {
    await opened.handle.close()
  }
  const cacheKey = createHash("sha256")
    .update(JSON.stringify([clean, source, dependencies ?? null]))
    .digest("hex")
  const cached = declarations.get(cacheKey)
  if (cached) return { metadata: structuredClone(cached), source }
  // Most plugins have no declared author contract and never load this parser.
  const ts = await import("typescript")
  const node = ts.createSourceFile(clean, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS)
  const parsed = node as typeof node & {
    parseDiagnostics: readonly import("typescript").Diagnostic[]
  }
  if (parsed.parseDiagnostics.length) throw Error("MODS_TYPES_SYNTAX")
  const preprocessed = ts.preProcessFile(source, true, true)
  if (
    preprocessed.referencedFiles.length ||
    preprocessed.typeReferenceDirectives.length ||
    preprocessed.libReferenceDirectives.length
  )
    throw Error("MODS_TYPES_CLOSED_CONTRACT")
  const metadata: FunctionAuthorTypes = {
    scope: "authoring-subset",
    entry: relative(root, file).replace(/\\/g, "/"),
    nouns: [],
    state: Object.create(null),
    diagnostics: [],
    dependencyRegistry: false
  }
  const unsupported = (message: string) =>
    metadata.diagnostics.push({ code: "MODS_TYPES_DECLARATION_UNVERIFIED", message })
  const key = (name: import("typescript").PropertyName | undefined) =>
    name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined
  const visit = (item: import("typescript").Node): void => {
    if (
      ts.isImportDeclaration(item) ||
      ts.isImportEqualsDeclaration(item) ||
      ts.isImportTypeNode(item) ||
      (ts.isExportDeclaration(item) && item.moduleSpecifier)
    )
      throw Error("MODS_TYPES_CLOSED_CONTRACT")
    if (ts.isModuleDeclaration(item)) {
      if (!ts.isStringLiteral(item.name) ||
        (item.name.text !== "devclaw-mods" && item.name.text !== "claude-code"))
        throw Error("MODS_TYPES_MODULE")
      if (item.body && ts.isModuleBlock(item.body))
        for (const declaration of item.body.statements) {
          if (!ts.isInterfaceDeclaration(declaration)) continue
          if (declaration.name.text === "EngineInterface")
            for (const member of declaration.members) {
              const name = key(member.name)
              if (name) metadata.nouns.push(name)
              else unsupported("Computed engine noun is not checked")
            }
          if (declaration.name.text === "PluginState")
            for (const member of declaration.members) {
              const name = key(member.name)
              if (
                !name ||
                !ts.isPropertySignature(member) ||
                !member.type ||
                !ts.isTypeLiteralNode(member.type)
              ) {
                unsupported("State registry requires literal plugin and key names")
                continue
              }
              const keys: string[] = []
              for (const field of member.type.members) {
                const name = key(field.name)
                if (name) keys.push(name)
                else unsupported("Computed state key is not checked")
              }
              metadata.state[name] = [...new Set([...(metadata.state[name] ?? []), ...keys])].sort()
            }
        }
    }
    ts.forEachChild(item, visit)
  }
  visit(node)
  metadata.nouns = [...new Set(metadata.nouns)].sort()
  if (
    dependencies !== undefined &&
    dependencies !== null &&
    (typeof dependencies !== "object" || Object.keys(dependencies).length > 0)
  )
    metadata.diagnostics.push({
      code: "MODS_TYPES_DEPENDENCIES_UNRESOLVED",
      message:
        "Enabled-plugin dependency type aggregation is not implemented; this contract does not prove its providers are installed."
    })
  if (declarations.size >= 32) declarations.delete(declarations.keys().next().value!)
  declarations.set(cacheKey, structuredClone(metadata))
  return { metadata, source }
}
