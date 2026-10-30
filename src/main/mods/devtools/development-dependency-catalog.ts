import { lstatSync, readdirSync } from "node:fs"
import {
  assertDependencyDirectory,
  dependencySourceIndex,
  type DependencySourceLocation
} from "./dependency-source-index"
import { join } from "node:path"
import { parseClawActionExports } from "../../../shared/mods/claw-actions"
import { parseClawComponentExports } from "../../../shared/mods/claw-components"
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
  discovery: {
    appliesTo: "declared-actions",
    action: "project_actions",
    id: "current project draft",
    localActionId: "check id"
  },
  componentDiscovery:
    "Inspect actual installed components and runtime readiness; Surface components are discovered through the extension-view catalog after preparation.",
  source:
    "Inspect availability and nextStep for the real catalog sourceId. For authoring-prepare, call dependency_prepare(sourceId): the Host pins every file, saves, checks and prepares original native reuse in one bounded operation. Native-source-set-required entries use their explicit original source-set import route; do not retry dependency_prepare past its budget. Read catalog assetPath pages only when reviewing/editing source; project_read addresses saved project drafts, not catalog assets.",
  prepare: [
    "dependency_prepare(sourceId) for unchanged bundled source",
    "end the turn for original native confirmation"
  ],
  confirmation:
    "End this turn and wait for original native installation/permission confirmation. A Function trial is optional; it is not needed before request_reuse.",
  resume:
    "After confirmation, follow the source's declared actions/components. For actions, re-read project_actions and inspect actual schemas/identity; patch composition/source.json provider plugin/actionId, preserve Hooks/knowledge/config/checks, then project_compile with the actual latest revision. Execution actions can be separately bound with project_bind_action; config is not input. For components, verify installed selection/runtime readiness and prepare/open any declared Surface through the extension-view catalog. Component-only sources require no project action binding or project compilation. Companion files used by project Skills/workflows must also be copied into the current project source and declared in resources. Installing a provider does not supply project-relative files.",
  unavailable:
    "If no actual source fits, author an ordinary Function Mod with the required public claw.actions and/or claw.components and on.capability using catalog types. Do not invent a provider, bypass consent or weaken checks.",
  businessValidation: {
    discoverInstalled: { action: "project_actions", query: "evidence-validation" },
    bundledSourceId: "evidence-validation",
    scope:
      "Exact source quotations and unchanged upstream summary/citations; no truth, entailment or causality claim.",
    contracts:
      "sources={sources:[{id,text}]}; summary/report={summary,citations:[{sourceId,quote}]}. Read source README and actual installed schemas before binding.",
    checks:
      "Use native composition action checks with artifact-reference-v1 and maxBytes:28000. Declare the source artifact in summary inputs, and both source+summary artifacts in report inputs. config.sourceArtifactId selects the real source artifact; check-report also needs config.summaryArtifactId. These are artifact IDs, not filesystem paths.",
    confirmation:
      "Discover installed once; if unavailable prepare this bundled source once and end the turn for native confirmation. Resume by rereading project_actions after confirmation. Do not poll discovery, invent a provider or repeatedly prepare installation.",
    proof:
      "The independent Mod reads actual Host-declared files through authorized fs.read. Run the original project trial: bad quotes/changed report fields must block its native gate. Schema tests or a model-supplied passed:true do not prove business validation."
  }
})

/** This root is selected by the Host build, never by a tool argument or author source. */
export function bundledDependencySourcesRoot(mainDirectory: string) {
  return join(mainDirectory, "../resources/native-compositions").replace(
    /\.asar([\\/]out[\\/]resources[\\/]native-compositions)$/,
    ".asar.unpacked$1"
  )
}

function assertLocationCurrent(root: string, location: DependencySourceLocation) {
  const current = dependencySourceIndex(root).find((entry) => entry.sourceId === location.sourceId)
  if (JSON.stringify(current) !== JSON.stringify(location))
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_CHANGED")
  assertDependencyDirectory(root, location.relative)
}

/** Directory metadata only; source bytes are read when preparation is actually requested. */
function sourcePreparation(
  directory: string,
  location: DependencySourceLocation,
  explicitMods: boolean
) {
  let files = 0
  let bytes = 0
  let oversized = false
  let visited = 0
  const scan = (relative: string, depth: number) => {
    if (depth > 8) {
      oversized = true
      return
    }
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      if (++visited > 512) {
        oversized = true
        return
      }
      if (entry.name === ".git" || entry.name === "node_modules") continue
      if (entry.isSymbolicLink()) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNSAFE")
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) scan(path, depth + 1)
      else {
        const size = lstatSync(join(directory, path)).size
        files++
        bytes += size
        if (
          size > AUTHORING_BUNDLE_LIMITS.fileBytes ||
          files > AUTHORING_BUNDLE_LIMITS.files ||
          bytes > AUTHORING_BUNDLE_LIMITS.totalBytes
        )
          oversized = true
      }
      if (oversized) return
    }
  }
  scan("", 0)
  return oversized || !explicitMods
    ? {
        availability: "native-source-set-required" as const,
        preparationReason: oversized
          ? "Source exceeds the bounded Function authoring bundle; dependency_prepare is unavailable."
          : "This package uses implicit Mod registration; use its original source-set installation, or explicitly author a Function package before dependency_prepare.",
        ...(location.sourceSet
          ? {
              nextStep: {
                kind: "native" as const,
                entry: "创造者 → 保存为插件并复用 → 选择作者源码目录",
                sourceSet: location.sourceSet,
                selection:
                  "Import the declared source-set, then select this dependency's original install/permission confirmation. Project advancement is separate."
              }
            }
          : {}),
        sourceBudget: AUTHORING_BUNDLE_LIMITS
      }
    : {
        availability: "authoring-prepare" as const,
        nextStep: { action: "dependency_prepare" as const, sourceId: location.sourceId }
      }
}

function descriptor(root: string, location: DependencySourceLocation) {
  const { sourceId } = location
  const directory = assertDependencyDirectory(root, location.relative)
  const pluginFile = readRuntimeScopedFile(directory, "plugin.json", 16000)
  const manifestFile = readRuntimeScopedFile(directory, "mods/manifest.json", 64 * 1024)
  if (!pluginFile.bytes || !manifestFile.bytes) return
  const plugin = JSON.parse(pluginFile.bytes.toString("utf8"))
  if (
    typeof plugin.name !== "string" ||
    typeof plugin.version !== "string" ||
    (plugin.mods !== undefined && plugin.mods !== "mods/manifest.json")
  )
    return
  const manifest = JSON.parse(manifestFile.bytes.toString("utf8"))
  if (manifest.apiVersion !== "cmb.mods/v2") return
  const actions = parseClawActionExports(manifest.claw)
  const components = parseClawComponentExports(manifest.claw)
  if (!actions.length && !components.length) return
  const preparation = sourcePreparation(directory, location, plugin.mods === "mods/manifest.json")
  return {
    sourceId,
    ...preparation,
    plugin: plugin.name,
    version: plugin.version,
    description: typeof plugin.description === "string" ? plugin.description.slice(0, 300) : "",
    actions: actions.map((action) => ({ actionId: action.id, name: action.name.slice(0, 96) })),
    components: components.map((component) => ({
      id: component.id,
      name: component.name.slice(0, 96),
      description: component.description?.slice(0, 300)
    })),
    assetPath: sourceId,
    installed: false,
    grantsAuthority: false,
    schemaAssetPath: `${sourceId}/mods/manifest.json`
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
  const location = dependencySourceIndex(root).find((entry) => entry.sourceId === input.sourceId)
  const entry = location && descriptor(root, location)
  if (!location || !entry) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE")
  if (entry.availability !== "authoring-prepare")
    throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_NATIVE_IMPORT_REQUIRED")
  const source = sourceBundle(assertDependencyDirectory(root, location.relative))
  assertLocationCurrent(root, location)
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
  const locations = dependencySourceIndex(root)
  const cursor = input.cursor ?? 0
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("DEVELOPMENT_CATALOG_CURSOR")
  if (!input.assetPath) {
    const sources = locations.flatMap((location) => {
      const item = descriptor(root, location)
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
  const location = locations.find((entry) => entry.sourceId === sourceId)
  const entry = location && descriptor(root, location)
  if (!location || !entry) throw Error("DEVELOPMENT_DEPENDENCY_SOURCE_UNAVAILABLE")
  if (entry.availability !== "authoring-prepare")
    return { section: "project-dependencies", ...entry }
  const bundle = sourceBundle(assertDependencyDirectory(root, location.relative))
  assertLocationCurrent(root, location)
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
