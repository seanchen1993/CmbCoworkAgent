"""Local contract fixture only, never business acceptance or a checkpoint writer."""
import json,runpy,sys
from pathlib import Path
source=Path(sys.argv[1]); root=Path(sys.argv[2]); mode=sys.argv[3]
sys.path.insert(0,str(source))
from board_core.contracts import load_record_workflow_contracts
records=json.loads((root/'.autobizdevops/state.json').read_text(encoding='utf-8'))['features']
assert len(records)==1
feature,record=next(iter(records.items()))
assert feature=='composition-autobiz'
f=root/'.autobizdevops/features'/feature
v=runpy.run_path(str(source/'tests/test_artifact_contracts.py'))
if mode=='finished-plan':
    (f/'PLAN.md').write_text(v['PLAN_DONE'].replace('API-01','API-01, D-01'),encoding='utf-8')
    (root/'src').mkdir(exist_ok=True)
    (root/'src/order-export.ts').write_text('''export function exportOrders(rows: Array<{ id: string; amount: number }>): string {
  return ["id,amount", ...rows.map(row => `${row.id},${row.amount}`)].join("\\n")
}
// ACTUAL_SOURCE_BYTES_ONLY_20261016
''',encoding='utf-8')
else:
    w=load_record_workflow_contracts(source,record,workspace=root)
    for c in w.skill_contracts.values():
        for a in c.outputs:
            if '*' not in a.path:
                p=f/a.path; p.parent.mkdir(parents=True,exist_ok=True); p.write_text('Local contract fixture only',encoding='utf-8')
    (f/'specs/order-export').mkdir(parents=True,exist_ok=True)
    (f/'proposal.md').write_text(v['PROPOSAL_OK'],encoding='utf-8')
    (f/'specs/order-export/spec.md').write_text(v['SPEC_OK'],encoding='utf-8')
    (f/'design.md').write_text(v['DESIGN_OK'],encoding='utf-8')
    (f/'PLAN.md').write_text(v['PLAN_OK'].replace('API-01','API-01, D-01'),encoding='utf-8')
    (f/'PRD_DISCUSS.md').write_text('''# Local fixture
## 需求摘要
## 已确认结论
## 问题清单
## 待确认事项
## 假设与风险''',encoding='utf-8')
    (f/'PRD.md').write_text('''# 需求正式稿
## 用户故事
ACTUAL_PRD_CONTENT_ONLY_20261016
## 验收口径
Local fixture
## 验收标准
Local fixture
## 关键约束
No external systems''',encoding='utf-8')
    (f/'REQUIREMENTS_EVAL.md').write_text('verdict: PASS',encoding='utf-8')
    (f/'UNIT_TEST_REPORT.md').write_text('Test Plan; Execution Summary; Coverage Matrix; Failure Analysis; Fix Attempts; Commands; Handoff; verdict: PASS; test-output.log; | Source | Requirement | Test | Result |; | ID | Classification | Files Changed |',encoding='utf-8')
print('LOCAL_ARTIFACTS_READY',mode)
