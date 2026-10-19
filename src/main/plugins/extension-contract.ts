import {
  parseProjectRuntimeManifest,
  projectRuntimeExtensionContract,
  EXTENSION_BOARD_API_VERSION,
  type ExtensionContract
} from "../../shared/project-runtime"
import {
  probeRuntimeScopedFile,
  readRuntimeScopedFile
} from "../harness-board/project-runtime/safe-files"
import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { readProjectActionLock } from "../harness-board/project-runtime/action-input"
import { AUTOBIZ_CONTEXT_OUTPUT } from "../../shared/project-runtime/autobiz-handoff"
import {
  readPackageProtocolFiles,
  readPackageProtocolFilesAsync,
  capturePackageMetadataGuard
} from "../harness-board/project-runtime/package-snapshots"
import { withSnapshotPathRetention } from "../harness-board/project-runtime/snapshot-retention"
import { hostStateError } from "../harness-board/project-runtime/host-state-protocol"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { assertProjectAgentResourceClosure } from "./project-agent-resources"
import { readAutobizPackageSemantics } from "./business-adapters/autobiz-package-admission"

type PackageReader = (path: string, limit: number) => { present: boolean; bytes?: Buffer }
type ProtocolFiles = Array<{ path: string; bytes: Buffer }>

/** Reads actual bounded package bytes. No UI claim, prompt or loose sidecar grants semantics. */
export function readPackageExtensionContract(
  root: string,
  entry = "devclaw.project-runtime.json"
): ExtensionContract | undefined {
  return readExtensionContract(root, (path, limit) => readRuntimeScopedFile(root, path, limit), entry)
}

function readExtensionContract(
  root: string,
  read: PackageReader,
  entry: string
): ExtensionContract | undefined {
  const file = read(entry, 65_536)
  if (!file.present) return undefined
  const raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)) as unknown
  const contract = projectRuntimeExtensionContract(raw)
  if (contract) {
    const runtime = parseProjectRuntimeManifest(raw)
    if (contract.verifiedArtifacts) {
      const adapter = read("devclaw.stage-checks.json", 1024)
      const declaration = adapter.bytes ? JSON.parse(adapter.bytes.toString("utf8")) : undefined
      if (runtime.mode !== "legacy" || declaration?.apiVersion !== "devclaw.stage-check-adapter/v1" ||
        declaration?.adapter !== "autobiz-v1" || Object.keys(declaration).length !== 2 ||
        !runtime.artifacts.some(output => output.id === AUTOBIZ_CONTEXT_OUTPUT.id &&
          output.path === AUTOBIZ_CONTEXT_OUTPUT.path && output.required))
        throw Error("EXTENSION_CONTRACT_VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
    }
    if (contract.context?.provider?.actionId) {
      if (runtime.mode !== "host" || !readProjectActionLock(root, runtime, read).bindings.some(
        binding => binding.id === contract.context!.provider!.actionId))
        throw Error("EXTENSION_CONTRACT_ACTION_PROVIDER_MISSING")
    } else if (contract.context?.provider?.entry) {
      const provider = read(contract.context.provider.entry, 256 * 1024)
      if (!provider.present || !provider.bytes?.length)
        throw Error("EXTENSION_CONTRACT_PROVIDER_MISSING")
    }
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const version = (raw as Record<string, unknown>).apiVersion
    if (
      typeof version === "string" &&
      version.startsWith("devclaw.project-runtime/") &&
      version !== "devclaw.project-runtime/v1"
    )
      throw Error("EXTENSION_CONTRACT_PROTOCOL_UNSUPPORTED")
    if (Object.hasOwn(raw, "extensionContract")) throw Error("EXTENSION_CONTRACT_V2_REQUIRED")
  }
  return contract
}

/** Validate every declared execution entrance; a secondary flow cannot evade the install/board gate. */
export function assertPackageExtensionCompatibility(root: string): void {
  assertCompatibility(root, (path, limit) => readRuntimeScopedFile(root, path, limit),
    () => readPackageProtocolFiles(root), (path) => probeRuntimeScopedFile(root, path).present)
}

function entries(read: PackageReader): Set<string> {
  const paths = new Set(["devclaw.project-runtime.json"])
  const declaration = read("devclaw.capabilities.json", 65_536)
  if (declaration.present) {
    const capabilities = parsePluginCapabilities(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(declaration.bytes))
    )
    for (const capability of capabilities?.capabilities ?? [])
      if (capability.kind === "flow") paths.add(capability.entry)
  }
  return paths
}

/** Fresh bounded bytes and the same validator; this is never a cached compatibility decision. */
export async function assertPackageExtensionCompatibilityAsync(
  root: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const read = (path: string, limit: number) => readRuntimeScopedFile(root, path, limit)
  const needsProtocol = [...entries(read)].some(entry =>
    readExtensionContract(root, read, entry)?.verifiedArtifacts !== undefined)
  if (!needsProtocol) {
    assertPackageExtensionCompatibility(root)
    return
  }
  await withSnapshotPathRetention([root], async () => {
    const guard = capturePackageMetadataGuard(root)
    const files = await readPackageProtocolFilesAsync(root, signal)
    const observed = new Map(files.map(file => [file.path, file.bytes]))
    const readObserved: PackageReader = (path, limit) => {
      const bytes = observed.get(path)
      if (bytes && bytes.length > limit) hostStateError("FILE_LIMIT")
      return { present: bytes !== undefined, bytes }
    }
    signal?.throwIfAborted()
    guard()
    // Every declaration, provider, action lock and reviewed protocol is validated from the
    // same newly read source. No path fallback can mix these bytes with an older result.
    assertCompatibility(root, readObserved, () => files, (path) => observed.has(path))
    guard()
  })
}

function assertCompatibility(
  root: string,
  read: PackageReader,
  protocolFiles: () => ProtocolFiles,
  present: (path: string) => boolean
): void {
  const entrances = entries(read)
  let rootContract: ExtensionContract | undefined
  const contracts: ExtensionContract[] = []
  for (const entry of entrances) {
    const contract = readExtensionContract(root, read, entry)
    if (contract) contracts.push(contract)
    if (entry === "devclaw.project-runtime.json") rootContract = contract
  }
  const boardPath = "board_core/board_config.json"
  const semantics = readAutobizPackageSemantics(
    (path, limit) => read(path, limit).bytes,
    present(boardPath),
    entrances
  )
  const boardFile: ReturnType<PackageReader> = semantics.boardContext
    ? read(boardPath, 1024 * 1024)
    : { present: false }
  const board = boardFile.present
    ? JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(boardFile.bytes)) : undefined
  if (board !== undefined) assertProjectAgentResourceClosure(board,
    path => read(path, 256 * 1024).bytes)
  // All entrances have already negotiated their original protocol. Preserve the original
  // missing-resource diagnostic before whole-inventory rejection; neither check grants admission.
  for (const contract of contracts) {
    if (contract.verifiedArtifacts && !isReviewedAutobizProtocol({
      files: protocolFiles()
    })) throw Error("EXTENSION_CONTRACT_VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
  }
  if (boardFile.present) {
    if (Number(board?.apiVersion) === EXTENSION_BOARD_API_VERSION && !rootContract)
      throw Error("EXTENSION_CONTRACT_REQUIRED")
    if (rootContract && Number(board?.apiVersion) !== EXTENSION_BOARD_API_VERSION)
      throw Error("EXTENSION_BOARD_VERSION_REQUIRED")
  }
}
