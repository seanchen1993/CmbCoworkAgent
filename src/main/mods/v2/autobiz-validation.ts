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

export interface AutobizCheckpointTransition {
  applied: boolean
  duplicate: boolean
  feature: string
  from: string
  to: string
  stateFingerprint: string
  reason?: string
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
from pathlib import Path
source, workspace, expected, state_path, requested = sys.argv[1:]
sys.path.insert(0, source)
sys.path.insert(0, os.path.join(source, 'skills', 'autodev', 'hooks'))
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod; spec.loader.exec_module(mod); return mod
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
    config_path = os.path.join(source,'board_core','board_config.json')
    compiler.load_record_effective_board_config(Path(config_path), repo_root=Path(source), workspace=Path(workspace), record=record)
    workflow_contracts = contracts.load_record_workflow_contracts(Path(source), record, workspace=Path(workspace))
    artifact = load(os.path.join(source,'skills','autodev','hooks','artifact_check.py'), 'mods_artifact_check')
    skill = record.get('currentSkill') or record.get('skill') or workflow_contracts.end_checkpoint_to_skill.get(checkpoint) or workflow_contracts.start_checkpoint_to_skill.get(checkpoint)
    if not skill: raise RuntimeError('AUTOBIZ_SKILL_MISSING:'+str(checkpoint))
    slug = record.get('featureSlug') or record.get('slug') or feature
    pre_code, pre_msg = artifact.run_precheck(Path(source), Path(workspace), skill, slug, workflow_record=record)
    post_code, post_msg = artifact.run_postcheck(Path(source), Path(workspace), skill, slug, workflow_record=record)
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

/**
 * Uses the upstream checkpoint preparation and state writer only after a
 * read-only fingerprint and current-checkpoint check. A repeated transition
 * is an idempotent no-op; an external write between validation and commit is
 * rejected and never overwritten.
 */
export async function advanceAutobizCheckpoint(input: {
  workspace: string
  feature: string
  from: string
  to: string
  expectedStateFingerprint: string
  idempotencyKey: string
  signal?: AbortSignal
  timeoutMs?: number
}): Promise<AutobizCheckpointTransition> {
  const script = `
import hashlib, importlib.util, json, os, subprocess, sys
source, workspace, feature, old, new, expected, key = sys.argv[1:]
sys.path.insert(0, source)
sys.path.insert(0, os.path.join(source, 'skills', 'autodev', 'hooks'))
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec); sys.modules[name] = mod; spec.loader.exec_module(mod); return mod
def fingerprint(path): return hashlib.sha256(open(path,'rb').read()).hexdigest()
try:
    commit = subprocess.check_output(['git','-C',source,'rev-parse','HEAD'], text=True).strip()
    if commit != '${AUTOBIZ_KANBAN_COMMIT}': raise RuntimeError('AUTOBIZ_SOURCE_CHANGED')
    state_path = os.path.join(workspace,'.autobizdevops','state.json')
    receipt_path = os.path.join(workspace,'.autobizdevops','.mods-v2-transition-'+hashlib.sha256(key.encode()).hexdigest()+'.json')
    if os.path.isfile(receipt_path):
        receipt = json.load(open(receipt_path, encoding='utf-8'))
        print(json.dumps({**receipt, 'applied':False, 'duplicate':True}))
        raise SystemExit(0)
    update = load(os.path.join(source,'hooks','update_checkpoint.py'), 'mods_update')
    sync = update.check_or_fix_state_sync
    state_store = load(os.path.join(source,'board_core','state_store.py'), 'mods_state_store')
    current = sync(__import__('pathlib').Path(workspace), fix=False)
    if not current.state_exists or current.errors: raise RuntimeError('AUTOBIZ_STATE_NOT_CANONICAL')
    record = current.records.get(feature)
    actual = (record or {}).get('checkpoint')
    before = fingerprint(state_path)
    if before != expected: raise RuntimeError('AUTOBIZ_STATE_CHANGED')
    if actual == new:
        print(json.dumps({'applied':False,'duplicate':True,'feature':feature,'from':old,'to':new,'stateFingerprint':before}))
        raise SystemExit(0)
    if actual != old: raise RuntimeError('AUTOBIZ_CHECKPOINT_CHANGED:'+str(actual))
    result = update.prepare_checkpoint_update(workspace=__import__('pathlib').Path(workspace), feature=feature, checkpoint=new)
    if not result.ok: raise RuntimeError('; '.join(result.errors))
    if fingerprint(state_path) != before: raise RuntimeError('AUTOBIZ_STATE_CHANGED')
    state_store.write_state_records_preserving_raw(__import__('pathlib').Path(workspace), result.records, raw_records=result.raw_records)
    after = fingerprint(state_path)
    verify = sync(__import__('pathlib').Path(workspace), fix=False)
    if not verify.state_exists or verify.errors or (verify.records.get(feature) or {}).get('checkpoint') != new:
        raise RuntimeError('AUTOBIZ_STATE_COMMIT_VERIFY_FAILED')
    receipt = {'applied':True,'duplicate':False,'feature':feature,'from':old,'to':new,'stateFingerprint':after}
    with open(receipt_path, 'x', encoding='utf-8') as handle: json.dump(receipt, handle)
    print(json.dumps(receipt))
except SystemExit: raise
except Exception as e:
    print(json.dumps({'applied':False,'duplicate':False,'feature':feature,'from':old,'to':new,'stateFingerprint':'','reason':str(e)[:4000]}))
`
  const root = resolve(input.workspace)
  try {
    const { stdout } = await run(PYTHON, ["-c", script, AUTOBIZ_KANBAN_SOURCE, root, input.feature, input.from, input.to, input.expectedStateFingerprint, input.idempotencyKey], {
      cwd: root, encoding: "utf8", timeout: input.timeoutMs ?? 120_000, maxBuffer: 256 * 1024, windowsHide: true, signal: input.signal
    })
    return JSON.parse(stdout.trim().split(/\r?\n/).at(-1) || "") as AutobizCheckpointTransition
  } catch (error) {
    if (input.signal?.aborted) throw error
    return { applied: false, duplicate: false, feature: input.feature, from: input.from, to: input.to, stateFingerprint: "", reason: error instanceof Error ? error.message.slice(0, 4000) : "AUTOBIZ_TRANSITION_FAILED" }
  }
}
