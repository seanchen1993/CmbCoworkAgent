import { lstatSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseClawActionExports } from "../../../shared/mods/claw-actions"
import {
  readRuntimeScopedFile,
  runtimeDigest
} from "../../harness-board/project-runtime/safe-files"
import {
  AUTHORING_BUNDLE_LIMITS,
  createAuthoringSourceBundle,
  hasAuthoringTextExtension
} from "./authoring-bundle"

export const PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES = 24000

export const PROJECT_DEPENDENCY_AUTHORING = Object.freeze({
  scope: "bundled-source-data-not-installed-or-authorized",
  discovery: { action: "project_actions", id: "current project draft", localActionId: "check id" },
  source:
    "Select a real catalog sourceId and call dependency_prepare(sourceId). The Host pins every file, saves, checks and prepares original native reuse in one bounded operation. Read catalog assetPath pages only when reviewing/editing source; project_read addresses saved project drafts, not catalog assets.",
  prepare: [
    "dependency_prepare(sourceId) for unchanged bundled source",
    "end the turn for original native confirmation"
  ],
  confirmation:
    "End this turn and wait for original native installation/permission confirmation. A Function trial is optional; it is not needed before request_reuse.",
  resume:
    "Re-read project_actions after confirmation. Inspect the actual schemas/identity; patch composition/source.json provider plugin/actionId, preserve Hooks/knowledge/config/checks, then project_compile with the actual latest revision. Execution actions can be separately bound with project_bind_action; config is not input. Companion files used by project Skills/workflows must also be copied into the current project source and declared in resources. Installing a provider does not supply project-relative files.",
  unavailable:
    "If no actual source/action fits, author an ordinary Function Mod with public claw.actions and on.capability using the catalog types. Do not invent a provider, bypass consent or weaken checks."
})

/** This root is selected by the Host build, never by a tool argument or author source. */
export function bundledDependencySourcesRoot(mainDirectory: string) {
  return join(mainDirectory, "../resources/native-compositions").replace(
    /\.asar([\\/]out[\\/]resources[\\/]native-compositions)$/,
    ".asar.unpacked$1"
  )
}

function sourceDirectories(root: string) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() &&
          !entry.isSymbolicLink() &&
          /^[a-z][a-z0-9-]{0,47}$/.test(entry.name)
      )
      .map((entry) => entry.name)
      .sort()
      .slice(0, 64)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

function descriptor(root: string, sourceId: string) {
  const directory = join(root, sourceId)
  const pluginFile = readRuntimeScopedFile(directory, "plugin.json", 16000)
  const manifestFile = readRuntimeScopedFile(directory, "mods/manifest.json", 64 * 1024)
  if (!pluginFile.bytes || !manifestFile.bytes) return
  const plugin = JSON.parse(pluginFile.bytes.toString("utf8"))
  if (
    typeof plugin.name !== "string" ||
    typeof plugin.version !== "string" ||
    plugin.mods !== "mods/manifest.json"
  )
    return
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"))
  if (manifest.apiVersion !== "cmb.mods/v2") return
  const actions = parseClawActionExports(manifest.claw)
  if (!actions.length) return
  return {
    sourceId,
    plugin: plugin.name,
    version: plugin.version,
    description: typeof plugin.description === "string" ? plugin.description.slice(0, 300) : "",
    actions: actions.map((action) => ({ actionId: action.id, name: action.name.slice(0, 96) })),
    assetPath: sourceId,
    installed: false,
    grantsAuthority: false,
    schemaAssetPath: `${sourceId}/mods/manifest.json`,
    nextStep: { action: "dependency_prepare", sourceId }
  }
}

function sourceBundle(directory: string) {
  const files: Array<{ path: string; text: string }> = []
  let visited = 0
  const scan = (relative: string, depth: number) => {
    if (depth > 8) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_LIMIT")
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      if (++visited > 512) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_LIMIT")
      if (entry.name === ".git" || entry.name === "node_modules") continue
      if (entry.isSymbolicLink()) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNSAFE")
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) scan(path, depth + 1)
      else {
        if (!entry.isFile() || !hasAuthoringTextExtension(path))
          throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_INCOMPLETE")
        if (files.length >= AUTHORING_BUNDLE_LIMITS.files)
          throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_LIMIT")
        const file = readRuntimeScopedFile(directory, path, AUTHORING_BUNDLE_LIMITS.fileBytes)
        if (!file.bytes) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
        files.push({ path, text: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) })
      }
    }
  }
  if (lstatSync(directory).isSymbolicLink()) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNSAFE")
  scan("", 0)
  return createAuthoringSourceBundle(files)
}

/** Exact inert source copy only. Installation and permission consent stay in the original services. */
export function readDevelopmentDependencySource(input: {
  mainDirectory: string
  sourceId: string
  expectedDigest?: string
}) {
  if (input.expectedDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.expectedDigest))
    throw Error("DEVELOPMENT_DEPENDENCY_DIGEST_REQUIRED")
  const root = bundledDependencySourcesRoot(input.mainDirectory)
  if (!sourceDirectories(root).includes(input.sourceId) || !descriptor(root, input.sourceId))
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE")
  const source = sourceBundle(join(root, input.sourceId))
  if (input.expectedDigest !== undefined && source.digest !== input.expectedDigest)
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
  return source
}

/** Uninstalled source has its own namespace and cannot become a project provider or grant. */
export function developmentDependencyCatalogPage(input: {
  mainDirectory: string
  assetPath?: string
  cursor?: number
  expectedDigest?: string
}) {
  const root = bundledDependencySourcesRoot(input.mainDirectory)
  const directories = sourceDirectories(root)
  const cursor = input.cursor ?? 0
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("DEVELOPMENT_CATALOG_CURSOR")
  if (!input.assetPath) {
    const sources = directories.flatMap((sourceId) => {
      const item = descriptor(root, sourceId)
      return item ? [item] : []
    })
    if (cursor > sources.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
    return {
      section: "project-dependencies",
      ...PROJECT_DEPENDENCY_AUTHORING,
      cursor,
      sources: sources.slice(cursor, cursor + 1),
      ...(cursor + 1 < sources.length ? { nextCursor: cursor + 1 } : {})
    }
  }
  const [sourceId, ...segments] = input.assetPath.split("/")
  if (!directories.includes(sourceId) || !descriptor(root, sourceId))
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE")
  const bundle = sourceBundle(join(root, sourceId))
  if (input.expectedDigest !== undefined && input.expectedDigest !== bundle.digest)
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
  const base = {
    section: "project-dependencies",
    sourceId,
    sourceDigest: bundle.digest,
    installed: false,
    grantsAuthority: false,
    executed: false
  }
  if (!segments.length) {
    if (cursor > bundle.files.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
    return {
      ...base,
      cursor,
      totalFiles: bundle.files.length,
      files: bundle.files.slice(cursor, cursor + 12).map((file) => ({
        path: file.path,
        assetPath: `${sourceId}/${file.path}`,
        digest: runtimeDigest(file.text),
        bytes: Buffer.byteLength(file.text)
      })),
      ...(cursor + 12 < bundle.files.length ? { nextCursor: cursor + 12 } : {}),
      nextStep: {
        action: "dependency_prepare",
        sourceId,
        sourceDigest: bundle.digest,
        requiredFields: ["sourceId"]
      },
      next: "Call dependency_prepare(sourceId) for unchanged reuse: Host pins the complete source, saves/checks the exact revision and prepares native confirmation. No file transcription or hand-filled digest is needed. Optional sourceDigest is checked strictly. End the turn when needs-approval; installation and permission remain original user actions. Companion files are inert data to declare and copy into the project source explicitly. Advanced dependency_save plus check/request_reuse remains available."
    }
  }
  const path = segments.join("/")
  const file = bundle.files.find((item) => item.path === path)
  if (!file) throw Error("DEVELOPMENT_DEPENDENCY_ASSET_UNAVAILABLE")
  if (cursor > file.text.length) throw Error("DEVELOPMENT_CATALOG_CURSOR")
  let end = Math.min(file.text.length, cursor + 8000)
  const page = () => ({
    ...base,
    path,
    digest: runtimeDigest(file.text),
    cursor,
    text: file.text.slice(cursor, end),
    totalCharacters: file.text.length,
    ...(end < file.text.length ? { nextCursor: end } : {})
  })
  for (;;) {
    // Preserve complete characters even when the byte envelope requires a shorter page.
    if (end < file.text.length && /[\uD800-\uDBFF]/.test(file.text[end - 1])) end--
    const result = page()
    const bytes = Buffer.byteLength(JSON.stringify({ ok: true, result }))
    if (bytes <= PROJECT_DEPENDENCY_SOURCE_PAGE_BYTES) return result
    if (end <= cursor) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_LIMIT")
    end = cursor + Math.floor((end - cursor) / 2)
  }
}
