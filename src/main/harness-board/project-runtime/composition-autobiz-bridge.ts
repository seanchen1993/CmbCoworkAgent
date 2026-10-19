import { execFile } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { getOpenworkDir } from "../../storage"
import type { PluginMetadata } from "../../types"
import type { CompositionInternalProject } from "./composition-internal-projects"
import type { CompositionLegacyDependencies } from "./composition-legacy-adapter"
import {
  parseStageCheckContracts,
  parseStageCheckReceipt,
  type StageCheckReceipt
} from "../../../shared/project-runtime/stage-check-receipt"
import { AUTOBIZ_STATE_COMMIT_PYTHON } from "../../mods/v2/autobiz-state-commit-python"
import { runAutobizTransitionProcess } from "../../mods/v2/autobiz-transition-process"
import { readRuntimeScopedFile, runtimeDigest, runtimeDirectory } from "./safe-files"
import { readRuntimeScopedFileAsync } from "./safe-files-async"

const execute = promisify(execFile)
export const AUTOBIZ_STAGE_CHECK_DECLARATION = {
  apiVersion: "devclaw.stage-check-adapter/v1",
  adapter: "autobiz-v1"
} as const

/** Python cannot read Electron's virtual archive paths. Packaged resources must be real files. */
export function autobizBridgeResourcePath(bundleDirectory: string): string {
  return join(
    bundleDirectory,
    "../resources/project-composition/autobiz/devclaw_stage_checks.py"
  ).replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2")
}

function bridgePath(): string {
  for (const path of [
    autobizBridgeResourcePath(__dirname),
    join(__dirname, "../../../../examples/autobiz-stage-checks/devclaw_stage_checks.py")
  ]) {
    if (existsSync(path)) return path
  }
  throw Error("COMPOSITION_AUTOBIZ_BRIDGE_MISSING")
}

/** Opt-in compatibility check only; no script execution and no changes to the original plugin. */
export async function validateAutobizCompositionAdapterDeclaration(
  plugin: Pick<PluginMetadata, "path">,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const file = await readRuntimeScopedFileAsync(plugin.path, "devclaw.stage-checks.json", 1024)
  if (!file.bytes) throw Error("COMPOSITION_STAGE_CHECK_ADAPTER_REQUIRED")
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes))
  if (
    !value ||
    Object.keys(value).length !== 2 ||
    value.apiVersion !== AUTOBIZ_STAGE_CHECK_DECLARATION.apiVersion ||
    value.adapter !== AUTOBIZ_STAGE_CHECK_DECLARATION.adapter
  )
    throw Error("COMPOSITION_STAGE_CHECK_ADAPTER_UNSUPPORTED")
  for (const path of [
    "hooks/state_checkpoint.py",
    "hooks/update_checkpoint.py",
    "board_core/contracts.py",
    "board_core/state_store.py",
    "skills/autodev/hooks/artifact_check.py"
  ]) {
    if (!(await readRuntimeScopedFileAsync(plugin.path, path, 1024 * 1024)).bytes)
      throw Error("COMPOSITION_AUTOBIZ_ORIGINAL_ENTRY_MISSING")
  }
  signal?.throwIfAborted()
}

const CONTRACT_SCRIPT = `
import importlib.util, json, sys
from pathlib import Path
bridge_path, source, workspace, feature = sys.argv[1:]
spec=importlib.util.spec_from_file_location('devclaw_bridge',bridge_path)
bridge=importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
root=Path(workspace)
state=json.loads((root/'.autobizdevops'/'state.json').read_text(encoding='utf-8'))
workflow=bridge.compiled(Path(source),root,state['features'][feature])
print(bridge.canonical(bridge.contract_values(workflow,feature)))
`

export async function readAutobizCompositionContracts(record: CompositionInternalProject) {
  await validateAutobizCompositionAdapterDeclaration(record.plugin)
  const { stdout } = await execute(
    process.env.CMB_AUTOBIZ_PYTHON || "python",
    [
      "-I",
      "-B",
      "-X",
      "utf8",
      "-c",
      CONTRACT_SCRIPT,
      bridgePath(),
      record.plugin.path,
      record.workspace,
      record.featureId
    ],
    { windowsHide: true, cwd: record.plugin.path, maxBuffer: 256 * 1024, timeout: 15000 }
  )
  return parseStageCheckContracts(JSON.parse(stdout))
}

/** Reuse the proven two-file locked commit protocol, with a host-owned evidence observer. */
function transitionScript(): string {
  const substitutions: Array<[string, string]> = [
    [
      "source, workspace, feature, old, new, expected, operation, receipt_json, journal_root = sys.argv[1:]",
      "source, workspace, feature, old, new, expected, operation, receipt_json, journal_root, bridge_path = sys.argv[1:]"
    ],
    [
      "update = load(os.path.join(source,'hooks','update_checkpoint.py'),'mods_update')",
      "bridge = load(bridge_path,'devclaw_bridge')\n        observer, stage_checks = bridge.install_original_postcheck(Path(source))\n        update = load(os.path.join(source,'hooks','update_checkpoint.py'),'mods_update')"
    ],
    ["prefix='prepared-',dir=source", "prefix='prepared-',dir=journal_root"],
    [
      "result = update.prepare_checkpoint_update(workspace=workspace,feature=feature,checkpoint=new)",
      "bridge.validate_completed_biz(Path(source),workspace,feature,current.records[feature],stage_checks,target_checkpoint=new)\n        result = update.prepare_checkpoint_update(workspace=workspace,feature=feature,checkpoint=new)"
    ],
    [
      "if not result.ok: fail('; '.join(result.errors))",
      "if not result.ok: fail('; '.join(result.errors))\n        if stage_checks.evidence_errors: fail('COMPOSITION_STAGE_EVIDENCE_UNAVAILABLE')"
    ],
    [
      "'operationId':operation,'evidence':evidence",
      "'operationId':operation,'evidence':evidence,'stageChecks':stage_checks"
    ]
  ]
  let script = AUTOBIZ_STATE_COMMIT_PYTHON
  for (const [before, after] of substitutions) {
    if (script.split(before).length !== 2) throw Error("COMPOSITION_AUTOBIZ_PROTOCOL_CHANGED")
    script = script.replace(before, after)
  }
  return script
}

export const transitionAutobizComposition: NonNullable<
  CompositionLegacyDependencies["transition"]
> = async (record, input) => {
  await validateAutobizCompositionAdapterDeclaration(record.plugin, input.signal)
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.checkpoint) ||
    !/^[a-f0-9]{64}$/.test(input.expectedStateDigest)
  )
    throw Error("PROJECT_CHECKPOINT_INPUT_INVALID")
  const state = readRuntimeScopedFile(record.workspace, ".autobizdevops/state.json", 262144)
  if (!state.bytes || runtimeDigest(state.bytes) !== input.expectedStateDigest)
    return { status: "not-applied", receipts: [], message: "流程状态已更新，请重新读取后再推进。" }
  const from = JSON.parse(state.bytes.toString("utf8")).features?.[record.featureId]?.checkpoint
  if (typeof from !== "string" || from === input.checkpoint)
    return { status: "not-applied", receipts: [], message: "原状态不匹配，未执行阶段推进。" }
  const operationId = runtimeDigest(
    JSON.stringify([
      record.compositionRunId,
      record.unitId,
      record.packageDigest,
      input.expectedStateDigest,
      input.checkpoint
    ])
  )
  const staging = join(getOpenworkDir(), "project-compositions", "transition-staging", operationId)
  mkdirSync(staging, { recursive: true })
  runtimeDirectory(staging)
  let receipts: StageCheckReceipt[] = []
  let prepared: { before: string[]; after: string[] } | undefined
  let acknowledged = false
  let written = false
  try {
    const output = await runAutobizTransitionProcess({
      command: process.env.CMB_AUTOBIZ_PYTHON || "python",
      args: [
        "-I",
        "-B",
        "-X",
        "utf8",
        "-c",
        transitionScript(),
        record.plugin.path,
        record.workspace,
        record.featureId,
        from,
        input.checkpoint,
        input.expectedStateDigest,
        operationId,
        "null",
        staging,
        bridgePath()
      ],
      cwd: record.plugin.path,
      signal: input.signal,
      timeoutMs: 120000,
      operationId,
      verifyEvidence: async () => {
        input.signal?.throwIfAborted()
      },
      prepare: async (message) => {
        const value = message as {
          stageChecks?: unknown[]
          evidence?: { before: string[]; after: string[] }
        }
        if (
          !Array.isArray(value.stageChecks) ||
          value.stageChecks.length > 32 ||
          value.evidence?.before?.[0] !== input.expectedStateDigest ||
          value.evidence.after?.length !== 2 ||
          !value.evidence.after.every((hash) => /^[a-f0-9]{64}$/.test(hash))
        )
          throw Error("COMPOSITION_AUTOBIZ_PROTOCOL_INVALID")
        receipts = value.stageChecks.map(parseStageCheckReceipt)
        await input.validateReceipts(receipts)
        prepared = value.evidence
        acknowledged = true
      },
      written: (message) => {
        const value = message as { stateFingerprint?: string; markdownFingerprint?: string }
        if (
          !prepared ||
          value.stateFingerprint !== prepared.after[0] ||
          value.markdownFingerprint !== prepared.after[1]
        )
          throw Error("COMPOSITION_AUTOBIZ_PROTOCOL_INVALID")
        written = true
      }
    })
    const result = JSON.parse(output)
    if (
      result.operationId !== operationId ||
      result.feature !== record.featureId ||
      result.from !== from ||
      result.to !== input.checkpoint
    )
      throw Error("COMPOSITION_AUTOBIZ_PROTOCOL_INVALID")
    if (result.applied && written && result.stateFingerprint === prepared?.after[0])
      return { status: "committed", stateDigest: result.stateFingerprint, receipts }
    return {
      status: acknowledged ? "unknown" : "not-applied",
      receipts: [],
      message: typeof result.reason === "string" ? result.reason : "原阶段推进未确认完成。"
    }
  } catch (error) {
    return {
      status: acknowledged ? "unknown" : "not-applied",
      receipts: [],
      message: error instanceof Error ? error.message : "阶段推进失败。"
    }
  }
}
