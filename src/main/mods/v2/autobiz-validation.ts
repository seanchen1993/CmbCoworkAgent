import { execFile } from "node:child_process"
import { access, readdir, readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { join, relative, resolve } from "node:path"
import { AUTOBIZ_KANBAN_COMMIT, withPinnedAutobiz } from "./autobiz-source"
import { commitAutobizState, type AutobizCommitInput } from "./autobiz-state-commit"
export { AUTOBIZ_KANBAN_SOURCE, AUTOBIZ_KANBAN_COMMIT } from "./autobiz-source"

const run = promisify(execFile)

export interface AutobizValidationResult {
  kind?: "autobiz-validator"
  passed: boolean
  feature?: string
  checkpoint?: string
  sourceCommit: string
  compiler: "passed" | "failed"
  validator: "passed" | "failed"
  reason: string
  workflowFingerprint?: string
}

export interface AutobizCheckpointTransition {
  applied: boolean
  duplicate: boolean
  feature: string
  from: string
  to: string
  stateFingerprint: string
  markdownFingerprint?: string
  operationId?: string
  status?: "committed" | "not-applied" | "unknown"
  reason?: string
}

const PYTHON = process.env.CMB_AUTOBIZ_PYTHON || "python"

/**
 * Fingerprint workspace-owned workflow overlays before accepting a validator
 * result. The pinned compiler source is immutable, while .autobizdevops/
 * workflow.d is intentionally live and may be edited by another process.
 */
export async function fingerprintAutobizWorkflow(workspace: string): Promise<string> {
  const root = resolve(workspace)
  const overlayRoot = join(root, ".autobizdevops", "workflow.d")
  const files: string[] = []
  const visit = async (directory: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }
  await visit(overlayRoot)
  files.sort((left, right) => left.localeCompare(right))
  if (files.length > 512) throw Error("AUTOBIZ_WORKFLOW_LIMIT")
  const digest = createHash("sha256")
  let bytes = 0
  for (const path of files) {
    const data = await readFile(path)
    bytes += data.byteLength
    if (bytes > 8 * 1024 * 1024) throw Error("AUTOBIZ_WORKFLOW_LIMIT")
    digest.update(relative(overlayRoot, path).replaceAll("\\", "/"))
    digest.update("\0")
    digest.update(data)
    digest.update("\0")
  }
  return digest.digest("hex")
}

/**
 * Runs the pinned workflow compiler and the upstream artifact validator in a
 * separate process. The script only reads state and artifacts; it never calls
 * inspect_state (which repairs state as a side effect).
 */
export async function runAutobizValidator(
  workspace: string,
  feature?: string,
  signal?: AbortSignal,
  timeoutMs = 120_000
): Promise<AutobizValidationResult> {
  const root = resolve(workspace)
  const statePath = join(root, ".autobizdevops", "state.json")
  const script = `
import json, os, sys, importlib.util, subprocess
from pathlib import Path
source, workspace, expected, state_path, requested = sys.argv[1:]
sys.path.insert(0, source)
sys.path.insert(0, os.path.join(source, 'skills', 'autodev', 'hooks'))
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod; spec.loader.exec_module(mod); return mod
try:
    commit = expected
    with open(state_path, encoding='utf-8') as f: state = json.load(f)
    features = state.get('features') or {}
    feature = requested or (next(iter(features)) if len(features) == 1 else None)
    if not feature or feature not in features: raise RuntimeError('AUTOBIZ_FEATURE_MISSING')
    if not __import__('re').fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', feature): raise RuntimeError('AUTOBIZ_FEATURE_INVALID')
    record = features[feature]
    if isinstance(record, str): raise RuntimeError('AUTOBIZ_FEATURE_RECORD_INVALID')
    checkpoint = record.get('checkpoint')
    if not checkpoint: raise RuntimeError('AUTOBIZ_CHECKPOINT_MISSING')
    if checkpoint == 'needs_fix' or record.get('status') == 'blocked':
        raise RuntimeError('AUTOBIZ_CHECKPOINT_BLOCKED')
    compiler = load(os.path.join(source,'board_core','workflow_compiler.py'), 'mods_compiler')
    contracts = load(os.path.join(source,'board_core','contracts.py'), 'mods_contracts')
    profile = record.get('workflowProfile') or record.get('profile')
    config_path = os.path.join(source,'board_core','board_config.json')
    compiler.load_record_effective_board_config(Path(config_path), repo_root=Path(source), workspace=Path(workspace), record=record)
    workflow_contracts = contracts.load_record_workflow_contracts(Path(source), record, workspace=Path(workspace))
    artifact = load(os.path.join(source,'skills','autodev','hooks','artifact_check.py'), 'mods_artifact_check')
    skill = workflow_contracts.end_checkpoint_to_skill.get(checkpoint) or workflow_contracts.start_checkpoint_to_skill.get(checkpoint)
    if not skill: raise RuntimeError('AUTOBIZ_SKILL_MISSING:'+str(checkpoint))
    slug = feature
    pre_code, pre_msg = artifact.run_precheck(Path(source), Path(workspace), skill, slug, workflow_record=record)
    post_code, post_msg = artifact.run_postcheck(Path(source), Path(workspace), skill, slug, workflow_record=record)
    ok = int(pre_code) == 0 and int(post_code) == 0
    print(json.dumps({'kind':'autobiz-validator','passed':ok,'feature':feature,'checkpoint':checkpoint,'sourceCommit':commit,'compiler':'passed','validator':'passed' if ok else 'failed','reason':str(pre_msg if pre_code else post_msg)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'passed':False,'sourceCommit':locals().get('commit', ''),'compiler':'failed','validator':'failed','reason':str(e)[:4000]}, ensure_ascii=False))
    sys.exit(0)
`
  try {
    await access(statePath)
    const workflowBefore = await fingerprintAutobizWorkflow(root)
    const { stdout } = await withPinnedAutobiz(signal, (source) =>
      run(
        PYTHON,
        [
          "-I",
          "-B",
          "-X",
          "utf8",
          "-c",
          script,
          source,
          root,
          AUTOBIZ_KANBAN_COMMIT,
          statePath,
          feature || ""
        ],
        {
          cwd: source,
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          signal
        }
      )
    )
    const line = stdout.trim().split(/\r?\n/).at(-1) || ""
    const result = JSON.parse(line) as AutobizValidationResult
    if (result.sourceCommit !== AUTOBIZ_KANBAN_COMMIT) throw new Error("AUTOBIZ_SOURCE_CHANGED")
    const workflowAfter = await fingerprintAutobizWorkflow(root)
    if (workflowAfter !== workflowBefore)
      return {
        ...result,
        passed: false,
        validator: "failed",
        workflowFingerprint: workflowAfter,
        reason: "AUTOBIZ_WORKFLOW_CHANGED"
      }
    return { ...result, workflowFingerprint: workflowAfter }
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      passed: false,
      sourceCommit: "",
      compiler: "failed",
      validator: "failed",
      reason: error instanceof Error ? error.message.slice(0, 4000) : "AUTOBIZ_VALIDATOR_FAILED"
    }
  }
}

/** Advances only through the host journal and locked, pinned upstream state adapter. */
export async function advanceAutobizCheckpoint(
  input: AutobizCommitInput
): Promise<AutobizCheckpointTransition> {
  return commitAutobizState(input)
}
