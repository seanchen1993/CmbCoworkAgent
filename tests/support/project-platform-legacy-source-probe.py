"""Immutable upstream source probe; no model, shell, network or customer project is used."""
import contextlib
import io
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

source, workspace = map(Path, sys.argv[1:])
sys.path.insert(0, str(source))
from hooks.init_workspace import init_workspace, create_feature
from hooks.update_checkpoint import prepare_checkpoint_update, prepare_skip_update, apply_implicit_skip_decisions
from hooks.human_gate_design_done import main as design_gate
from hooks.code_execution_guard import guard
from board_core.state_store import load_state_json_records, write_state_records
from board_core.workflow_compiler import load_record_effective_board_config

workspace.mkdir(parents=True)
captured = io.StringIO()
with patch('subprocess.Popen', side_effect=AssertionError('No external command allowed')), patch('socket.socket', side_effect=AssertionError('No external network allowed')), contextlib.redirect_stdout(captured):
    init_workspace(workspace)
    create_feature(workspace, 'fixture')
    records, errors, exists = load_state_json_records(workspace)
    assert exists and not errors
    record = dict(records['fixture'])
    record.update(checkpoint='design_in_progress', stage='技术设计')
    records['fixture'] = record
    write_state_records(workspace, records)
    before = load_state_json_records(workspace)[0]
    invalid = prepare_checkpoint_update(workspace=workspace, feature='fixture', checkpoint='design_done')
    assert not invalid.ok, 'Missing Design artifacts must reject the original transition'
    after = load_state_json_records(workspace)[0]
    assert before == after, 'Failed original validation must preserve business records'
    invalid_skip = prepare_skip_update(workspace=workspace, feature='fixture', skip_nodes=['not-a-real-node'])
    assert not invalid_skip.ok
    configs = {}
    for label, extra in [('standard', {}), ('lean', {'workflowTemplate':'lean'}),
                         ('dynamic', {'workflowDecisions':{'detail_design_before_code':'enabled'}}),
                         ('skipped', {'workflowSkippedNodes':['dev.design']})]:
        configs[label] = load_record_effective_board_config(repo_root=source, workspace=workspace, record={**record, **extra})

def gate(command):
    output = io.StringIO()
    with patch('sys.stdin', io.StringIO(json.dumps({'tool_name':'execute','tool_input':{'command':command}}))), contextlib.redirect_stdout(output):
        design_gate()
    return json.loads(output.getvalue()) if output.getvalue() else None

worktree = workspace / 'code-worktree'; worktree.mkdir()
feature = workspace / '.autobizdevops' / 'features' / 'fixture'
run = feature / '.task-runs' / 'T1' / 'run.json'; run.parent.mkdir(parents=True, exist_ok=True)
run.write_text(json.dumps({'taskId':'T1','runId':'R1','status':'started','codeWorkspace':str(worktree)}), encoding='utf-8')
os.environ.update(PLUGIN_WORKSPACE=str(workspace.parent), PROJECT_DIR=workspace.name, FEATURE_ID='fixture')
decisions = {command: guard({'tool_name':'execute','tool_input':{'command':command,'cwd':str(worktree)}})
             for command in ['mvn compile -DskipTests', 'mvn test', 'npm run build', 'mvn compile && mvn test']}
assert decisions['mvn compile -DskipTests'] is None
assert all(decisions[c] for c in ['mvn test', 'npm run build', 'mvn compile && mvn test'])
config = json.loads((source / 'hooks/hooks.json').read_text(encoding='utf-8'))
design = gate('python hooks/update_checkpoint.py --checkpoint design_done')
assert design['decision'] == 'human_gate'
assert gate('python hooks/update_checkpoint.py --checkpoint design_done --dry-run') is None
implicit = apply_implicit_skip_decisions(target_checkpoint='code_in_progress', decisions={})
assert implicit == {'detail_design_before_code':'skipped'}
result = {'designGate':design, 'designRejected':not invalid.ok, 'skipRejected':not invalid_skip.ok,
          'businessUnchanged': before == after, 'dynamicDefault':implicit,
          'workflows':configs, 'guard':decisions, 'hookOrder':config['PreToolUse']}
text = json.dumps(result, ensure_ascii=False, sort_keys=True)
for path, label in [(str(source), '<SOURCE>'), (str(workspace), '<WORKSPACE>')]:
    text = text.replace(path.replace('\\','\\\\'), label).replace(path, label)
print(text)
