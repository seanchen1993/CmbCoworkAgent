import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { promisify } from "node:util"
import { join, resolve } from "node:path"

const run = promisify(execFile)
export const AUTOBIZ_KANBAN_SOURCE = "C:\\ai\\autobiz_kanban"
export const AUTOBIZ_KANBAN_COMMIT = "8db1ec937d6ed3d271cb9dc540310d6633c91e70"

export interface AutobizValidationResult {
  passed: boolean
  feature?: string
  checkpoint?: string
  sourceCommit: string
  compiler: "passed" | "failed"
  validator: "passed" | "failed"
  reason: string
}

const PYTHON = process.env.CMB_AUTOBIZ_PYTHON || "python"

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
source, workspace, expected, state_path, requested = sys.argv[1:]
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
try:
    commit = subprocess.check_output(['git','-C',source,'rev-parse','HEAD'], text=True).strip()
    if commit != expected: raise RuntimeError('AUTOBIZ_SOURCE_CHANGED:'+commit)
    with open(state_path, encoding='utf-8') as f: state = json.load(f)
    features = state.get('features') or {}
    feature = requested or (next(iter(features)) if len(features) == 1 else None)
    if not feature or feature not in features: raise RuntimeError('AUTOBIZ_FEATURE_MISSING')
    record = features[feature]
    if isinstance(record, str): raise RuntimeError('AUTOBIZ_FEATURE_RECORD_INVALID')
    checkpoint = record.get('currentCheckpoint') or record.get('checkpoint') or record.get('currentNode') or record.get('node')
    if not checkpoint: raise RuntimeError('AUTOBIZ_CHECKPOINT_MISSING')
    compiler = load(os.path.join(source,'board_core','workflow_compiler.py'), 'mods_compiler')
    contracts = load(os.path.join(source,'board_core','contracts.py'), 'mods_contracts')
    profile = record.get('workflowProfile') or record.get('profile')
    config_path = os.path.join(workspace,'.autobizdevops','config.json')
    compiler.load_record_effective_board_config(config_path, source, workspace, record)
    contracts.load_record_workflow_contracts(source, record, workspace=workspace)
    artifact = load(os.path.join(source,'skills','autodev','hooks','artifact_check.py'), 'mods_artifact_check')
    skill = record.get('currentSkill') or record.get('skill') or checkpoint
    slug = record.get('featureSlug') or record.get('slug') or feature
    pre_code, pre_msg = artifact.run_precheck(source, workspace, skill, slug, workflow_record=record)
    post_code, post_msg = artifact.run_postcheck(source, workspace, skill, slug, workflow_record=record)
    ok = int(pre_code) == 0 and int(post_code) == 0
    print(json.dumps({'passed':ok,'feature':feature,'checkpoint':checkpoint,'sourceCommit':commit,'compiler':'passed','validator':'passed' if ok else 'failed','reason':str(post_msg or pre_msg)}, ensure_ascii=False))
except Exception as e:
    print(json.dumps({'passed':False,'sourceCommit':locals().get('commit', ''),'compiler':'failed','validator':'failed','reason':str(e)[:4000]}, ensure_ascii=False))
    sys.exit(0)
`
  try {
    await access(statePath)
    const { stdout } = await run(PYTHON, ["-c", script, AUTOBIZ_KANBAN_SOURCE, root, AUTOBIZ_KANBAN_COMMIT, statePath, feature || ""], {
      cwd: root, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, signal
    })
    const line = stdout.trim().split(/\r?\n/).at(-1) || ""
    const result = JSON.parse(line) as AutobizValidationResult
    if (result.sourceCommit !== AUTOBIZ_KANBAN_COMMIT)
      throw new Error("AUTOBIZ_SOURCE_CHANGED")
    return result
  } catch (error) {
    if (signal?.aborted) throw error
    return {
      passed: false, sourceCommit: "", compiler: "failed", validator: "failed",
      reason: error instanceof Error ? error.message.slice(0, 4000) : "AUTOBIZ_VALIDATOR_FAILED"
    }
  }
}
