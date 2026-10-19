import { lstat, readdir } from "node:fs/promises"
import { join } from "node:path"
import {
  parsePluginCapabilitiesJson,
  PLUGIN_CAPABILITIES_MAX_BYTES,
  type PluginCapability
} from "../../shared/plugin-capabilities"
import {
  isCapabilityUsageAllowed,
  type CapabilityUsageContext
} from "../../shared/mods/capability-usage"
import {
  parseProjectRuntimeManifest,
  type ProjectRuntimeManifest
} from "../../shared/project-runtime"
import { runtimeDigest, runtimeRelativePath } from "../harness-board/project-runtime/safe-files"
import {
  readRuntimeScopedFileAsync,
  runtimeDirectoryAsync,
  runtimeDirectoryIdentityAsync
} from "../harness-board/project-runtime/safe-files-async"
import type { PluginMetadata } from "../types"
import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { projectRuntimeExtensionContract } from "../../shared/project-runtime"
import { assertProjectActionLock } from "../harness-board/project-runtime/action-input"
import { PROJECT_ACTION_LOCK_PATH } from "../../shared/project-runtime/action-bindings"
import { assertProjectAgentResourceClosure } from "./project-agent-resources"

export interface NativeCapabilityCatalogItem extends PluginCapability {
  source: { pluginId: string; name: string; version: string; packageDigest: string }
  identity: string
  entryDigest: string | null
  applicable: boolean
  /** Catalog inspection never issues a runtime capability or approves execution. */
  available: false
  reasons: string[]
  stageIds: string[]
  runtimeMode?: "host" | "legacy"
}

export interface NativeCapabilityCatalog {
  pluginId: string
  status: "declared" | "undeclared" | "invalid"
  packageDigest: string | null
  capabilities: NativeCapabilityCatalogItem[]
  reasons: string[]
  /** Main-owned static compatibility result; never accepted from renderer input. */
  legacyAdapter?: "autobiz-v1"
}

const declaration = "devclaw.capabilities.json"
const runtimeDeclaration = "devclaw.project-runtime.json"
const limits = {
  files: 2048,
  directories: 512,
  depth: 16,
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  milliseconds: 3000
}
const sensitive =
  /^(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.npmrc|\.pypirc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$|\.(?:pem|key|p12|pfx|kdbx)$/i
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)

/** No retained copy or code evaluation. A bounded full-package content fingerprint for previews. */
async function inspectPackage(
  root: string,
  signal?: AbortSignal
): Promise<{ files: Map<string, Buffer>; digest: string }> {
  const directory = await runtimeDirectoryAsync(root)
  const files = new Map<string, Buffer>()
  const digests: Array<[string, string, boolean]> = []
  const directories: string[] = []
  let bytes = 0
  let reservedBytes = 0
  let reservedFiles = 0
  const expires = performance.now() + limits.milliseconds
  const visit = async (relative: string, depth: number) => {
    signal?.throwIfAborted()
    if (depth > limits.depth) throw Error("CAPABILITY_PACKAGE_LIMIT")
    if (performance.now() > expires) throw Error("CAPABILITY_PACKAGE_TIMEOUT")
    const absolute = relative ? join(directory, relative) : directory
    const identity = await runtimeDirectoryIdentityAsync(absolute)
    const names = (await readdir(absolute)).sort()
    if (names.length > limits.files + limits.directories) throw Error("CAPABILITY_PACKAGE_LIMIT")
    const seen = new Set<string>()
    for (const name of names) {
      signal?.throwIfAborted()
      if (performance.now() > expires) throw Error("CAPABILITY_PACKAGE_TIMEOUT")
      if (sensitive.test(name)) throw Error("CAPABILITY_PACKAGE_SENSITIVE_PATH")
      if (seen.has(name.toLowerCase())) throw Error("CAPABILITY_PACKAGE_PATH_COLLISION")
      seen.add(name.toLowerCase())
      const path = relative ? `${relative}/${name}` : name
      runtimeRelativePath(path)
    }
    const inspectEntry = async (name: string): Promise<string | undefined> => {
      signal?.throwIfAborted()
      if (performance.now() > expires) throw Error("CAPABILITY_PACKAGE_TIMEOUT")
      const path = relative ? `${relative}/${name}` : name
      const stat = await lstat(join(directory, path))
      if (stat.isSymbolicLink()) throw Error("CAPABILITY_PACKAGE_LINK")
      if (stat.isDirectory()) {
        if (directories.length >= limits.directories) throw Error("CAPABILITY_PACKAGE_LIMIT")
        directories.push(path)
        return path
      } else {
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          reservedFiles >= limits.files ||
          reservedBytes + stat.size > limits.totalBytes
        )
          throw Error("CAPABILITY_PACKAGE_LIMIT")
        // Reserve before awaiting so concurrent reads cannot each consume the remaining budget.
        reservedFiles++
        reservedBytes += stat.size
        const file = await readRuntimeScopedFileAsync(directory, path, limits.fileBytes, signal)
        if (!file.bytes) throw Error("CAPABILITY_PACKAGE_CHANGED")
        bytes += file.bytes.length
        if (bytes > limits.totalBytes) throw Error("CAPABILITY_PACKAGE_LIMIT")
        if (performance.now() > expires) throw Error("CAPABILITY_PACKAGE_TIMEOUT")
        files.set(path, file.bytes)
        digests.push([
          path,
          runtimeDigest(file.bytes),
          process.platform !== "win32" && (stat.mode & 0o111) !== 0
        ])
        return undefined
      }
    }
    for (let offset = 0; offset < names.length; offset += 8) {
      // Always settle the whole bounded group, including failures/cancellation. Never recurse
      // inside workers: nesting parallel visits would multiply the descriptor/read limit.
      const group = await Promise.allSettled(names.slice(offset, offset + 8).map(inspectEntry))
      for (const result of group) if (result.status === "rejected") throw result.reason
      for (const result of group)
        if (result.status === "fulfilled" && result.value !== undefined)
          await visit(result.value, depth + 1)
    }
    if (
      (await runtimeDirectoryIdentityAsync(absolute)) !== identity ||
      JSON.stringify((await readdir(absolute)).sort()) !== JSON.stringify(names)
    )
      throw Error("CAPABILITY_PACKAGE_CHANGED")
  }
  await visit("", 0)
  signal?.throwIfAborted()
  if (performance.now() > expires) throw Error("CAPABILITY_PACKAGE_TIMEOUT")
  // Use the retained host snapshot format so preview identity survives admission unchanged.
  directories.sort()
  digests.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return {
    files,
    digest: runtimeDigest(JSON.stringify({ version: 1, directories, files: digests }))
  }
}

/** Caller supplies an installed host-owned identity, never renderer/plugin-provided metadata. */
export async function readNativeCapabilityCatalog(
  plugin: Pick<PluginMetadata, "id" | "name" | "version" | "path" | "enabled">,
  context: CapabilityUsageContext,
  signal?: AbortSignal
): Promise<NativeCapabilityCatalog> {
  const result: NativeCapabilityCatalog = {
    pluginId: plugin.id,
    status: "invalid",
    packageDigest: null,
    capabilities: [],
    reasons: []
  }
  try {
    signal?.throwIfAborted()
    isCapabilityUsageAllowed("universal", context)
    const observed = await readRuntimeScopedFileAsync(
      plugin.path,
      declaration,
      PLUGIN_CAPABILITIES_MAX_BYTES,
      signal
    )
    signal?.throwIfAborted()
    if (!observed.bytes)
      return {
        ...result,
        status: "undeclared",
        reasons: ["未声明独立能力；原有单插件项目入口可继续使用。"]
      }
    const parsed = parsePluginCapabilitiesJson(decode(observed.bytes))
    const snapshot = await inspectPackage(plugin.path, signal)
    if (!snapshot.files.get(declaration)?.equals(observed.bytes))
      throw Error("CAPABILITY_PACKAGE_CHANGED")
    const board = snapshot.files.get("board_core/board_config.json")
    if (board) assertProjectAgentResourceClosure(JSON.parse(decode(board)),
      path => snapshot.files.get(path))
    const manifests = [
      ".codex-plugin/plugin.json",
      ".claude-plugin/plugin.json",
      "plugin.json"
    ].flatMap((path) => (snapshot.files.has(path) ? [snapshot.files.get(path)!] : []))
    if (!manifests.length) throw Error("CAPABILITY_PLUGIN_MANIFEST_MISSING")
    for (const bytes of manifests) {
      if (bytes.length > 256 * 1024) throw Error("CAPABILITY_PLUGIN_MANIFEST_LIMIT")
      const metadata = JSON.parse(decode(bytes))
      if (!metadata || metadata.name !== plugin.name || metadata.version !== plugin.version)
        throw Error("CAPABILITY_PLUGIN_IDENTITY_CHANGED")
    }
    result.packageDigest = snapshot.digest
    const stageChecks = snapshot.files.get("devclaw.stage-checks.json")
    if (stageChecks && stageChecks.length <= 1024) {
      try {
        const declaration = JSON.parse(decode(stageChecks))
        if (
          declaration &&
          Object.keys(declaration).length === 2 &&
          declaration.apiVersion === "devclaw.stage-check-adapter/v1" &&
          declaration.adapter === "autobiz-v1" &&
          isReviewedAutobizProtocol({
            files: [...snapshot.files].map(([path, bytes]) => ({ path, bytes }))
          })
        )
          result.legacyAdapter = "autobiz-v1"
      } catch {
        /* Malformed adapter declarations never grant compatibility. */
      }
    }
    const runtimeByPath = new Map<string, ProjectRuntimeManifest>()
    const runtimeErrors = new Set<string>()
    const runtimeDiagnostics = new Map<string, string>()
    const runtimePaths = new Set([
      runtimeDeclaration,
      ...parsed.capabilities.filter((item) => item.kind === "flow").map((item) => item.entry)
    ])
    for (const path of runtimePaths) {
      const bytes = snapshot.files.get(path)
      if (!bytes) continue
      try {
        if (bytes.length > 65536) throw Error("CAPABILITY_RUNTIME_LIMIT")
        const rawRuntime = JSON.parse(decode(bytes))
        const runtime = parseProjectRuntimeManifest(rawRuntime)
        const extension = projectRuntimeExtensionContract(rawRuntime)
        if (extension?.verifiedArtifacts && (runtime.mode !== "legacy" ||
          result.legacyAdapter !== "autobiz-v1"))
          throw Error("EXTENSION_CONTRACT_VERIFIED_ARTIFACTS_ADAPTER_UNSUPPORTED")
        if (extension?.context?.provider?.entry &&
          !snapshot.files.get(extension.context.provider.entry)?.length)
          throw Error("EXTENSION_CONTRACT_PROVIDER_MISSING")
        if (extension?.context?.provider?.actionId) {
          const bytes = snapshot.files.get(PROJECT_ACTION_LOCK_PATH)
          if (runtime.mode !== "host" || !bytes || !assertProjectActionLock(runtime,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))).bindings.some(
              binding => binding.id === extension.context!.provider!.actionId))
            throw Error("EXTENSION_CONTRACT_ACTION_PROVIDER_MISSING")
        }
        if (runtime.plugin.id !== plugin.name || runtime.plugin.version !== plugin.version)
          throw Error("CAPABILITY_RUNTIME_IDENTITY")
        runtimeByPath.set(path, runtime)
      } catch (error) {
        runtimeErrors.add(path)
        if (error instanceof Error && error.message.startsWith("EXTENSION_CONTRACT_"))
          runtimeDiagnostics.set(path, error.message.slice(0, 256))
      }
    }
    result.capabilities = parsed.capabilities.map((item) => {
      const bytes = snapshot.files.get(item.entry)
      const applicable = isCapabilityUsageAllowed(item.usage, context)
      const reasons: string[] = []
      if (!plugin.enabled) reasons.push("来源插件未启用。")
      if (!applicable) reasons.push("该能力不适用于当前场景。")
      if (item.kind === "flow" && runtimeDiagnostics.has(item.entry))
        reasons.push(runtimeDiagnostics.get(item.entry)!)
      else if (item.kind === "skill" && runtimeDiagnostics.size)
        reasons.push(...new Set(runtimeDiagnostics.values()))
      const stages = [...runtimeByPath.values()]
        .flatMap((runtime) => runtime.stages)
        .filter((stage) => stage.skill === item.entry)
        .map((stage) => stage.id)
      let runtimeMode: "host" | "legacy" | undefined
      if (item.kind === "skill") {
        if (!bytes || !/(?:^|\/)SKILL\.md$/.test(item.entry) || bytes.length > 256 * 1024)
          reasons.push("技能入口必须是包内真实 SKILL.md 文件，且不超过 256 KiB。")
        else {
          try {
            if (!decode(bytes).trim()) reasons.push("技能入口为空。")
          } catch {
            reasons.push("技能入口不是有效 UTF-8 文本。")
          }
        }
        if (stages.length || runtimeErrors.size)
          reasons.push("需要项目流程上下文；阶段与原检查不可绕过。")
        else reasons.push("需宿主验证独立依赖和必需 Hook；作者声明不构成执行授权。")
      } else {
        const runtime = runtimeByPath.get(item.entry)
        if (!runtime) reasons.push("流程入口缺失或不是与来源身份一致的有效运行声明。")
        else {
          runtimeMode = runtime.mode
          if (runtime.stages.some((stage) => stage.skill && !snapshot.files.has(stage.skill)))
            reasons.push("流程引用的阶段技能文件缺失。")
          reasons.push(
            runtime.mode === "legacy"
              ? "需注册原引擎适配器并验证独立状态根、原检查与完整终态。"
              : "需宿主流程适配器验证阶段检查、审批、产物和完整终态。"
          )
        }
      }
      if (item.dependsOn.length) reasons.push("组合预览必须验证全部必要依赖，目录不自动授权依赖。")
      return {
        ...item,
        source: {
          pluginId: plugin.id,
          name: plugin.name,
          version: plugin.version,
          packageDigest: snapshot.digest
        },
        identity: JSON.stringify([plugin.id, snapshot.digest, item.id]),
        entryDigest: bytes ? runtimeDigest(bytes) : null,
        applicable,
        available: false as const,
        reasons,
        stageIds: [...new Set(stages)],
        ...(runtimeMode ? { runtimeMode } : {})
      }
    })
    // A preview must not combine files from two package revisions.
    if ((await inspectPackage(plugin.path, signal)).digest !== snapshot.digest)
      throw Error("CAPABILITY_PACKAGE_CHANGED")
    return { ...result, status: "declared" }
  } catch (error) {
    signal?.throwIfAborted()
    return {
      ...result,
      status: "invalid",
      capabilities: [],
      packageDigest: null,
      legacyAdapter: undefined,
      reasons: [error instanceof Error ? error.message : "能力清单读取失败。"]
    }
  }
}
