import { isReviewedAutobizProtocol } from "../autobiz-composition-protocol"
import { assertProjectAgentResourceClosure } from "../project-agent-resources"
import {
  probeRuntimeScopedFile,
  readRuntimeScopedFile
} from "../../harness-board/project-runtime/safe-files"
import {
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract
} from "../../../shared/project-runtime"
import { BUSINESS_MOD_MANIFEST } from "../../../shared/business-mods"
import { parsePluginCapabilities } from "../../../shared/plugin-capabilities"
import { parseBusinessModCatalog } from "../business-mod-manifest"

const boardPath = "board_core/board_config.json"
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)
export type AutobizPackageReader = (path: string, limit: number) => Buffer | undefined

export interface AutobizPackageSemantics {
  legacyProject: boolean
  boardContext: boolean
}

function declaresAutobizStageAdapter(bytes: Buffer | undefined): boolean {
  if (!bytes || bytes.length > 1024) return false
  try {
    const declaration: unknown = JSON.parse(decode(bytes))
    return (
      !!declaration &&
      typeof declaration === "object" &&
      !Array.isArray(declaration) &&
      Object.keys(declaration).length === 2 &&
      "apiVersion" in declaration &&
      declaration.apiVersion === "devclaw.stage-check-adapter/v1" &&
      "adapter" in declaration &&
      declaration.adapter === "autobiz-v1"
    )
  } catch {
    return false
  }
}

function hasOptionalAutobizStageDeclaration(read: AutobizPackageReader): boolean {
  try {
    return declaresAutobizStageAdapter(read("devclaw.stage-checks.json", 1024))
  } catch (error) {
    // An oversized optional resource cannot be the exact bounded declaration. Match the
    // in-memory predicate without masking unsafe paths, changed sources or access failures.
    // Explicit verified producers still use their original strict reader and admission.
    if (error instanceof Error && error.message === "PROJECT_HOST_FILE_LIMIT") return false
    throw error
  }
}

function runtimeEntries(read: AutobizPackageReader): string[] {
  const entries = new Set(["devclaw.project-runtime.json"])
  const bytes = read("devclaw.capabilities.json", 65_536)
  if (bytes) {
    if (bytes.length > 65_536) throw Error("AUTOBIZ_PACKAGE_CAPABILITIES_LIMIT")
    const declaration = parsePluginCapabilities(JSON.parse(decode(bytes)))
    for (const capability of declaration?.capabilities ?? [])
      if (capability.kind === "flow") entries.add(capability.entry)
  }
  return [...entries]
}

/** Adapter-owned classification only, never execution admission. All bytes come from one reader.
 * A valid unassembled Host catalog is also Host; malformed runtimes cannot fall back to it.
 * Historical board packages retain legacy protection; Host Python context retains only context. */
export function readAutobizPackageSemantics(
  read: AutobizPackageReader,
  boardPresent: boolean,
  entries: Iterable<string> = runtimeEntries(read)
): AutobizPackageSemantics {
  let hasRuntime = false
  let legacyProject = false
  let entryContext = false
  for (const entry of entries) {
    const bytes = read(entry, 65_536)
    if (!bytes) continue
    if (bytes.length > 65_536) throw Error("AUTOBIZ_PACKAGE_RUNTIME_LIMIT")
    const raw: unknown = JSON.parse(decode(bytes))
    const runtime = parseProjectRuntimeManifest(raw)
    hasRuntime = true
    legacyProject ||= runtime.mode === "legacy"
    entryContext ||= !!projectRuntimeExtensionContract(raw)?.context?.provider?.entry
  }
  if (!hasRuntime) {
    const bytes = read(BUSINESS_MOD_MANIFEST, 256 * 1024)
    if (bytes && bytes.length > 256 * 1024) throw Error("AUTOBIZ_PACKAGE_CATALOG_LIMIT")
    const catalog = bytes ? parseBusinessModCatalog(JSON.parse(decode(bytes))) : undefined
    legacyProject = catalog?.kernel?.runtime?.adapter !== "host-linear-v1"
  }
  // Absent board resources never cause an unrelated stage sidecar to be interpreted.
  const stageContext =
    boardPresent && !legacyProject && !entryContext && hasOptionalAutobizStageDeclaration(read)
  return {
    legacyProject,
    boardContext: boardPresent && (legacyProject || entryContext || stageContext)
  }
}

const rootReader =
  (root: string): AutobizPackageReader =>
  (path, limit) =>
    readRuntimeScopedFile(root, path, limit).bytes

/** The original board's agent resource closure remains part of legacy package admission. */
export function assertAutobizPackageAgentResources(files: ReadonlyMap<string, Buffer>): void {
  const board = files.get(boardPath)
  if (board && readAutobizPackageSemantics((path) => files.get(path), true).boardContext)
    assertProjectAgentResourceClosure(JSON.parse(decode(board)), (path) => files.get(path))
}

export function assertAutobizPackageAgentResourcesFromRoot(root: string): void {
  if (
    !probeRuntimeScopedFile(root, boardPath).present ||
    !readAutobizPackageSemantics(rootReader(root), true).boardContext
  )
    return
  const board = readRuntimeScopedFile(root, boardPath, 1024 * 1024)
  if (board.bytes)
    assertProjectAgentResourceClosure(
      JSON.parse(decode(board.bytes)),
      (path) => readRuntimeScopedFile(root, path, 256 * 1024).bytes
    )
}

/** A stage adapter name alone never substitutes for the reviewed executor inventory. */
export function readReviewedAutobizStageAdapter(
  files: ReadonlyMap<string, Buffer>
): "autobiz-v1" | undefined {
  const bytes = files.get("devclaw.stage-checks.json")
  if (!bytes || bytes.length > 1024) return undefined
  try {
    const declaration = JSON.parse(decode(bytes))
    if (
      declaration &&
      Object.keys(declaration).length === 2 &&
      declaration.apiVersion === "devclaw.stage-check-adapter/v1" &&
      declaration.adapter === "autobiz-v1" &&
      isReviewedAutobizProtocol({
        files: [...files].map(([path, bytes]) => ({ path, bytes }))
      })
    )
      return "autobiz-v1"
  } catch {
    // Malformed or unreviewed declarations never grant compatibility.
  }
  return undefined
}

/** Verified-context export is an existing adapter protocol, not an arbitrary file-read grant. */
export function supportsAutobizVerifiedArtifacts(mode: string, adapter?: string): boolean {
  return mode === "legacy" && adapter === "autobiz-v1"
}

/** A standalone skill cannot strip the original board's dynamically resolved stage context. */
export function hasAutobizBoardContext(root: string): boolean {
  if (!probeRuntimeScopedFile(root, boardPath).present) return false
  return readAutobizPackageSemantics(rootReader(root), true).boardContext
}

/** Old board execution is distinct from a Host provider's board-backed context. */
export function isAutobizLegacyProjectRoot(root: string): boolean {
  const present = probeRuntimeScopedFile(root, boardPath).present
  const semantics = readAutobizPackageSemantics(rootReader(root), present)
  return present && semantics.legacyProject
}
