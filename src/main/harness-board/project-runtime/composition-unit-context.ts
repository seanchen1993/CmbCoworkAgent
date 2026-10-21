import { execFile } from "node:child_process"
import { join } from "node:path"
import { promisify } from "node:util"
import type { PluginMetadata } from "../../types"
import type { FunctionModsManager, RuntimeFunctionGrantScope } from "../../mods/v2/manager"
import type { CompositionUnitContextOptions, CompositionUnitContextSelection } from "../../../shared/project-runtime/composition-api"
import { readPackageExtensionContract } from "../../plugins/extension-contract"
import { prepareExtensionContext } from "../extension-context"
import { getOpenworkDir } from "../../storage"
import { runtimeDigest } from "./safe-files"
import { preflightLegacyCompositionSource } from "./composition-legacy-preflight"
import { captureLegacyCompositionInputs } from "./composition-legacy-inputs"

const execute = promisify(execFile)

/** Only the already-supported reviewed original adapter owns this CLI's list semantics. */
export async function readCompositionUnitContext(input: {
  plugin: PluginMetadata
  packageDigest: string
  workspace: string
  configurationWorkspace: string
  manager: FunctionModsManager
  grantScope: RuntimeFunctionGrantScope
  assertCurrent(): void
  /** Live native ownership; full source/input checks still bracket actual provider execution. */
  assertAuthorityCurrent?(): void
}): Promise<{ view: CompositionUnitContextOptions; assertCurrent(): void }> {
  const assertAuthority = input.assertAuthorityCurrent ?? input.assertCurrent
  assertAuthority()
  const context = readPackageExtensionContract(input.plugin.path)?.context
  if (!context) return { view: { supported: false, required: false, candidates: [], selected: [] }, assertCurrent: input.assertCurrent }
  const configuration = { workspace: input.configurationWorkspace, plugin: input.plugin, scope: input.grantScope }
  await input.manager.prepareRuntimeSourceFacts(configuration)
  assertAuthority()
  input.manager.assertRuntimeSourceReady(configuration)
  await preflightLegacyCompositionSource(input.plugin)
  assertAuthority()
  const inputs = await captureLegacyCompositionInputs(input.plugin, input.packageDigest, input.workspace)
  if (!inputs) throw Error("COMPOSITION_UNIT_CONTEXT_UNSUPPORTED")
  const assertConfiguration = () => {
    assertAuthority()
    input.manager.assertRuntimeSourceReady(configuration)
    inputs.assertAuthorityCurrent()
    assertAuthority()
  }
  const guard = () => {
    input.assertCurrent()
    input.manager.assertRuntimeSourceReady(configuration)
    inputs.assertCurrent()
    input.assertCurrent()
  }
  assertConfiguration()
  const prepared = await prepareExtensionContext({
    sourceRoot: input.plugin.path, workspace: input.workspace,
    dataRoot: join(getOpenworkDir(), "plugin-data"), operation: "session-context",
    invocation: { executable: process.env.CMB_AUTOBIZ_PYTHON || "python", args: [
      "-I", "-B", "-X", "utf8", join(input.plugin.path, "hooks/render_collected_session_context.py"),
      "--list-supported-deploy-ids"
    ] },
    configuration: { directoryBinding: (_name, key) => input.manager.readRetainedDirectoryUserConfig(
      { workspace: input.configurationWorkspace, plugin: input.plugin, scope: input.grantScope }, key, assertConfiguration
    ) }
  })
  if (!prepared) throw Error("COMPOSITION_UNIT_CONTEXT_UNSUPPORTED")
  try {
    if (prepared.recoveryBound)
      throw Error("PROJECT_STAGE_DEBUG_CONTEXT_PROVIDER_NATIVE_EXECUTION_REQUIRED")
    guard()
    const result = await execute(prepared.invocation.executable, prepared.invocation.args, {
      cwd: input.plugin.path, windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024,
      env: { ...process.env, ...prepared.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" }
    })
    guard()
    const candidates: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(candidates) || candidates.length > 10_000 || candidates.some(id =>
      typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 512 ||
      [...id].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)))
      throw Error("COMPOSITION_UNIT_CONTEXT_CATALOG_INVALID")
    const ids = [...new Set(candidates as string[])].sort()
    return {
      view: { supported: true, required: context.knowledge.required, candidates: ids, selected: [],
        contextFingerprint: runtimeDigest(JSON.stringify([input.packageDigest, inputs.fingerprint, ids])) },
      assertCurrent: guard
    }
  } finally { prepared.release() }
}

export function assertCompositionUnitContextSelection(
  options: CompositionUnitContextOptions,
  selected: CompositionUnitContextSelection | undefined
): void {
  if (!options.supported) {
    if (selected) throw Error("COMPOSITION_UNIT_CONTEXT_UNSUPPORTED")
    return
  }
  if (!selected || (options.required && !selected.deployUnitIds.length))
    throw Error("COMPOSITION_UNIT_CONTEXT_REQUIRED: 请先选择此步骤需要的业务上下文。")
  if (selected.contextFingerprint !== options.contextFingerprint ||
      selected.deployUnitIds.some(id => !options.candidates.includes(id)))
    throw Error("COMPOSITION_UNIT_CONTEXT_CHANGED: 知识、参数或候选已变化，请重新确认业务上下文。")
}
