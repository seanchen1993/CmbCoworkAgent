"""App-only sample authorship, invoked exclusively through actual native execute tools.

The original fixed workflow owns scheduling, provisioning, stage receipts, merges and
aggregation. This helper writes ordinary sample deliverables and calls original public
writers. It never writes checkpoint/manifest/receipt/approval fields or runs an engine.
No claim of LLM semantic quality, enterprise CI, or remote acceptance is made.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
sys.dont_write_bytecode = True

def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def lifecycle(plugin: Path, workspace: Path, feature: str, action: str) -> dict:
    sys.path.insert(0, str(plugin))
    base = workspace / ".autobizdevops/features" / feature
    if not base.is_dir():
        raise ValueError("original_feature_initialization_required")
    if action == "metadata":
        from board_core.contracts import load_record_workflow_contracts
        record = json.loads((workspace / ".autobizdevops/state.json").read_text("utf-8"))["features"][feature]
        contracts = load_record_workflow_contracts(plugin, record, workspace=workspace)
        return {"checkpoint": record["checkpoint"], "nodes": [node["id"] for node in contracts.nodes],
                "skills": [{"skill": skill, "checkpoints": list(contract.checkpoints)}
                           for skill, contract in contracts.skill_contracts.items()]}
    if action == "prd":
        from hooks.implementation_scope import write_scope
        from hooks.ui_context_writer import main as ui_writer
        write(base / "PRD.md", """# 需求摘要

## 当前实现范围
- 实现范围：backend_only
## 1.需求概述
### 1.1.背景、痛点、改进思路及价值
演示两个可独立实现和验证的后台计算能力，保护输入知识和原流程检查。
## 2.需求解析
### 2.6. 功能清单
| 类型 | 功能名称 | 功能描述 |
| --- | --- | --- |
| 新增 | cap | 对整数加一 |
| 新增 | next | 对整数乘二 |
#### 2.6.1. 功能详情
##### FR1: 整数计算
###### 验收标准
输入2时，加一得到3，乘二得到4；负数同样按整数运算。
### 2.7. 外部资料与实现约束
无
## 当前已确认结论
使用两个独立Python函数与真实本地测试。
## 问题清单与处理状态
| 序号 | 重要性 | 检查项 | 处理状态 |
| --- | --- | --- | --- |
| 1 | P2 - 优化建议 | 执行边界 | 已确认仅本地样本 |
## 待确认事项
无（本轮已全部消解）。
## 假设与风险
本样本不代表企业业务认可或远程模型生成质量。
## 历次讨论记录
2026-10-17：受控验收确定后台计算范围。
## 讨论补充资料
采用已装载的本地知识来源。
""")
        write_scope(base, "backend_only", source="user_confirmed")
        code = ui_writer(["init", "--workspace", str(workspace), "--feature", feature])
        if code != 0:
            raise ValueError("original_ui_context_writer_rejected_sample")
    elif action == "specs":
        from hooks.ui_context_writer import main as ui_writer
        if not (base / "PRD.md").is_file():
            raise ValueError("missing_prd_input")
        write(base / "proposal.md", """# Proposal: 本地计算能力
## Why
以可观察的小型后台能力验证模块组合。
## What Changes
增加加一和乘二函数，分别交付和测试。
## Capabilities
### New Capabilities
- `cap`: 整数加一。
- `next`: 整数乘二。
### Modified Capabilities
- 无
### Removed Capabilities
- 无
## Impact
仅受控本地计算仓库。
## Out of Scope
不访问企业服务。
## Decision Log
以真实本地测试验证。
## Open Questions
无。
""")
        for name, number, behavior in (("cap", "001", "输入2返回3，输入-1返回0"),
                                      ("next", "002", "输入2返回4，输入-1返回-2")):
            write(base / f"specs/{name}/spec.md", f"""# {name}
## ADDED Requirements
### Requirement REQ-{number}: 整数计算
#### Scenario SCN-{number}: 正数和负数计算
- **WHEN** 调用本地计算函数
- **THEN** {behavior}。
""")
        for operation in ("confirm", "lock"):
            if ui_writer([operation, "--workspace", str(workspace), "--feature", feature]) != 0:
                raise ValueError("original_ui_context_confirmation_failed")
    elif action == "design":
        from hooks.design_contract_lock import sync_design_contract_lock
        if not (base / "specs/cap/spec.md").is_file() or not (base / "specs/next/spec.md").is_file():
            raise ValueError("missing_specs_input")
        write(base / "design.md", """# Design: 本地计算
## Context / 输入上下文
读取proposal及cap/next规格，保留知识中的负数测试要求。
## Code Evidence
新增cap.py和next.py；两个模块独立，无共享可变状态。
## Spec Traceability
REQ-001/SCN-001对应加一；REQ-002/SCN-002对应乘二。
## API Decisions
x-auto-no-http-api: true
无HTTP接口。
## Data Decisions
x-auto-no-sql: true
无数据库。
## Technical Design
| ID | Decision |
| --- | --- |
| D-001 | 纯Python整数函数，各模块独立测试，合并后执行联合测试。 |
## Risks / Open Questions
仅验证受控样本；无外部副作用。
""")
        result = sync_design_contract_lock(workspace, feature)
        if not result.ok:
            raise ValueError(json.dumps(result.errors, ensure_ascii=False))
    elif action == "cicd":
        evidence = base / "evidence/EVIDENCE.jsonl"
        if not evidence.is_file() or not evidence.stat().st_size:
            raise ValueError("real_code_evidence_required")
        write(base / "CICD_CHECKLIST.md", "# 本地交付检查\n已执行两模块及合并后的本地测试；证据引用evidence/EVIDENCE.jsonl。\n")
        write(base / "PR_BODY.md", "# 受控计算交付\n两个独立worktree实现并合并，原检查和知识边界保持。\n")
    else:
        raise ValueError("unsupported_sample_step")
    return {"prepared": action, "feature": feature, "stateWritten": False,
            "checksApproved": False}


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True,
                            encoding="utf-8", timeout=60)
    return result.stdout.strip()


def checked(value: dict) -> dict:
    if value.get("success") is False or value.get("ok") is False:
        raise RuntimeError(json.dumps(value, ensure_ascii=False))
    return value


def prepare_plan(workspace: Path, feature: str, knowledge: str) -> dict:
    from hooks import plan_writer

    feature_dir = workspace / ".autobizdevops/features" / feature
    feature_dir.mkdir(parents=True, exist_ok=True)
    if (feature_dir / "plan.json").exists():
        raise ValueError("sample_plan_already_exists_no_overwrite")
    repo = workspace / "repositories/creator-code"
    repo.mkdir(parents=True, exist_ok=False)
    git(repo, "init", "-b", "main")
    git(repo, "config", "user.email", "creator-sample@example.invalid")
    git(repo, "config", "user.name", "Controlled creator integration")
    (repo / ".gitignore").write_text("__pycache__/\n*.pyc\n.cmbdevclaw/\n", encoding="utf-8")
    (repo / "README.md").write_text("# Controlled backend sample\nKnowledge context SHA256: " +
        hashlib.sha256(knowledge.encode()).hexdigest() + "\n", encoding="utf-8")
    (repo / "pyproject.toml").write_text('[project]\nname="creator-code-sample"\nversion="0.0.1"\n', encoding="utf-8")
    git(repo, "add", ".")
    git(repo, "commit", "-m", "Initialize controlled backend sample")
    body = {"schemaVersion": "autodev.plan.v2", "featureId": feature, "tasks": []}
    for index, stem in ((1, "cap"), (2, "next")):
        outcome = "Integer input returns its successor" if index == 1 else "Integer input returns its double"
        body["tasks"].append({"id": f"T{index:03d}", "outcome": outcome,
            "workspace": "default", "dependsOn": [],
            "refs": {"requirements": [f"specs/{stem}/spec.md#REQ-{index:03d}"],
                "scenarios": [f"specs/{stem}/spec.md#SCN-{index:03d}"], "api": [],
                "data": [], "design": [], "decisions": ["D-001"]},
            "implementationPoints": [outcome, "Reject boolean and non-integer inputs"],
            "testPoints": ["Positive integers", "Negative integers", "Boolean and text rejection"],
            "verification": {"intent": "Public Python function result and invalid type boundaries"}})
    input_file = feature_dir / "app-code-plan-input.json"
    write_json(input_file, body)
    commands = []
    for argv in (["prepare-plan", "--workspace", str(workspace), "--feature", feature,
                  "--code-workspace", str(repo), "--body-file", str(input_file)],
                 ["publish-plan", "--workspace", str(workspace), "--feature", feature]):
        completed = subprocess.run([sys.executable, "-B", plan_writer.__file__, *argv],
            capture_output=True, encoding="utf-8", errors="replace", timeout=60)
        if completed.returncode:
            raise ValueError("original_plan_writer_rejected:" + completed.stdout + completed.stderr)
        commands.append({"argv": argv, "stdout": completed.stdout, "exitCode": completed.returncode})
    root = json.loads((feature_dir / "plan.json").read_text(encoding="utf-8"))
    result = {"phase": "prepared", "workspace": str(workspace), "feature": feature,
        "repository": str(repo), "taskSetDigest": root["taskSetDigest"],
        "knowledgeSha256": hashlib.sha256(knowledge.encode()).hexdigest(),
        "taskStatuses": ["todo", "todo"], "executed": False, "originalPlanWriter": commands}
    write_json(feature_dir / "app-code-plan.json", result)
    return result


def bash_test(worktree: Path, test_name: str, *, expected: int = 0) -> dict:
    bash = os.environ.get("GIT_BASH_PATH", r"C:\Program Files\Git\bin\bash.exe")
    python = Path(sys.executable).as_posix()
    argv = [python, "-m", "unittest", test_name, "-v"]
    result = subprocess.run([bash, "-c", " ".join(shlex.quote(arg) for arg in argv)],
        cwd=worktree, encoding="utf-8", errors="replace", capture_output=True, timeout=60,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUTF8": "1"})
    if result.returncode != expected:
        raise RuntimeError(f"actual_bash_test_exit:{result.returncode}:" + result.stdout + result.stderr)
    return {"argv": argv, "exitCode": result.returncode, "stdout": result.stdout + result.stderr,
        "cwd": str(worktree)}


def batch_context(workspace: Path, feature: str, run_id: str, batch_id: str) -> tuple:
    from hooks.parallel_runtime import load_manifest
    manifest = load_manifest(workspace, feature, run_id)
    batch = manifest["batches"][batch_id]
    path = Path(batch["worktreePath"]).resolve(strict=True)
    branch = git(path, "symbolic-ref", "--quiet", "--short", "HEAD")
    if (branch != batch["branchName"] or path == workspace.resolve()
            or not (path / ".git").is_file()
            or Path(git(path, "rev-parse", "--show-toplevel")).resolve() != path):
        raise ValueError("real_batch_worktree_required")
    tasks = batch.get("taskIds", [])
    if len(tasks) != 1 or tasks[0] not in {"T001", "T002"}:
        raise ValueError("explicit_single_sample_task_required")
    index = int(tasks[0][1:])
    return path, branch, tasks[0], index


def implementation(workspace: Path, feature: str, run_id: str, batch_id: str) -> dict:
    from hooks.parallel_batch_scheduler import mark_batch
    from hooks.parallel_runtime import acquire_lease, check_lease, release_lease
    from hooks.task_runner import start_task, finish_implementation
    from hooks.worktree_manager import seal_parallel_batch
    worktree, branch, task_id, index = batch_context(workspace, feature, run_id, batch_id)
    token = acquire_lease(workspace, feature, run_id, batch_id, ttl_seconds=600)["ownerToken"]
    checked(mark_batch(workspace, feature, run_id, batch_id, "running",
                       worktreePath=str(worktree), branchName=branch))
    started = start_task(workspace, feature, task_id, worktree,
        parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    filename, function, operation = ("cap.py", "successor", "value + 1") if index == 1 else (
        "next.py", "double", "value * 2")
    code = (f"def {function}(value):\n"
            '    if isinstance(value, bool) or not isinstance(value, int):\n'
            '        raise ValueError("integer required")\n'
            f"    return {operation}\n")
    if (worktree / filename).exists():
        raise ValueError("sample_implementation_replay_forbidden")
    (worktree / filename).write_text(code, encoding="utf-8")
    # Actual Bash production-only compilation; no test assets exist at this point.
    bash = os.environ.get("GIT_BASH_PATH", r"C:\Program Files\Git\bin\bash.exe")
    compile_argv = [Path(sys.executable).as_posix(), "-m", "py_compile", filename]
    compile_result = subprocess.run([bash, "-c", " ".join(shlex.quote(a) for a in compile_argv)],
        cwd=worktree, capture_output=True, encoding="utf-8", timeout=30)
    if compile_result.returncode:
        raise ValueError(compile_result.stdout + compile_result.stderr)
    ok, receipt = finish_implementation(workspace, feature, task_id, worktree,
        started["runId"], no_code_change_why=None, supporting_files=[],
        parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    if not ok or not check_lease(workspace, feature, run_id, batch_id, token):
        raise ValueError(json.dumps(receipt, ensure_ascii=False))
    sealed = checked(seal_parallel_batch(workspace, feature, run_id, batch_id, worktree,
                                         token, purpose="review"))
    release_lease(workspace, feature, run_id, batch_id, token, final_status="sealed")
    return {"batchId": batch_id, "status": "success", "tasksCompleted": 1, "tasksTotal": 1,
        "worktreePath": str(worktree), "branchName": branch, "commitSha": sealed["commitSha"],
        "compile": {"argv": compile_argv, "exitCode": compile_result.returncode,
                    "stdout": compile_result.stdout + compile_result.stderr},
        "actualGitWorktree": {"path": str(worktree), "branch": branch,
                              "gitFile": (worktree / ".git").read_text("utf-8")},
        "implementationEvidenceId": receipt.get("implementationEvidenceId")}


def utest(workspace: Path, feature: str, run_id: str, batch_id: str) -> dict:
    from hooks.parallel_runtime import acquire_lease, release_lease
    from hooks.parallel_batch_stage import start_stage, complete_stage, gate_batch
    from hooks.worktree_manager import seal_parallel_batch
    from hooks.run_utest_command import execute_utest_command
    worktree, branch, task_id, index = batch_context(workspace, feature, run_id, batch_id)
    token = acquire_lease(workspace, feature, run_id, batch_id, ttl_seconds=600)["ownerToken"]
    checked(start_stage(workspace, feature, run_id, batch_id, "test"))
    module, function, positive, negative = ("cap", "successor", 3, 0) if index == 1 else (
        "next", "double", 4, -2)
    test_name = f"test_app_{index}"
    test_file = test_name + ".py"
    body = (f"import unittest\nfrom {module} import {function}\nclass Delivery(unittest.TestCase):\n"
            f"    def test_valid(self):\n        self.assertEqual({function}(2), {positive})\n"
            f"        self.assertEqual({function}(-1), {negative})\n"
            '    def test_invalid(self):\n        for value in (True, "4", None):\n'
            f"            with self.assertRaises(ValueError): {function}(value)\n")
    path = worktree / test_file
    if path.exists():
        raise ValueError("sample_test_replay_forbidden")

    def record(actual: dict) -> dict:
        # Only the original runner writes evidence, using the actual Bash exit/output.
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".log", delete=False) as log:
            log.write(actual["stdout"])
            log_path = Path(log.name)
        try:
            return execute_utest_command(workspace=str(workspace), feature=feature,
                argv=actual["argv"], kind="test", task_id=task_id, test_files=[test_file],
                code_workspace=str(worktree), run_id=run_id, batch_id=batch_id,
                record_only=True, recorded_exit_code=actual["exitCode"],
                recorded_output_file=str(log_path))
        finally:
            log_path.unlink(missing_ok=True)

    failed = None
    if index == 1:
        path.write_text(body.replace(f"self.assertEqual({function}(2), {positive})",
                                    f"self.assertEqual({function}(2), 999)"), encoding="utf-8")
        execution = bash_test(worktree, test_name, expected=1)
        rejected = record(execution)
        gate = gate_batch(workspace, feature, run_id, batch_id)
        if rejected.get("ok") is not False or gate.get("success") is not False:
            raise ValueError("real_failed_test_was_not_rejected")
        failed = {"execution": execution, "originalRecord": rejected, "gate": gate}
    path.write_text(body, encoding="utf-8")
    execution = bash_test(worktree, test_name)
    test = checked(record(execution))
    sealed = checked(seal_parallel_batch(workspace, feature, run_id, batch_id, worktree, token))
    stage = checked(complete_stage(workspace, feature, run_id, batch_id, "test", metadata={
        "batchCommit": sealed["commitSha"], "testEvidenceIds": [test["evidenceId"]],
        "worktreePath": str(worktree), "branchName": branch, "actualBashExecution": execution}))
    release_lease(workspace, feature, run_id, batch_id, token, final_status="sealed")
    return {"batchId": batch_id, "status": "success", "testStatus": "passed",
        "worktreePath": str(worktree), "branchName": branch, "commitSha": sealed["commitSha"],
        "testEvidenceIds": [test["evidenceId"]], "stageEvidenceId": stage["evidenceId"],
        "negativeFailedTest": failed}


def e2e(workspace: Path, feature: str, run_id: str, worktree: Path) -> dict:
    from hooks.parallel_merge_train import finish_e2e
    # Distinct end-to-end scenario, not a repeat of Batch UTest: compose both delivered APIs.
    argv = [Path(sys.executable).as_posix(), "-c",
            "from cap import successor; from next import double; "
            "assert double(successor(2)) == 6; assert successor(double(-2)) == -3; "
            "print('APP_REAL_E2E_COMPOSED_SUCCESS')"]
    bash = os.environ.get("GIT_BASH_PATH", r"C:\Program Files\Git\bin\bash.exe")
    actual = subprocess.run([bash, "-c", " ".join(shlex.quote(a) for a in argv)], cwd=worktree,
                            encoding="utf-8", capture_output=True, timeout=30)
    if actual.returncode:
        raise ValueError(actual.stdout + actual.stderr)
    return checked(finish_e2e(workspace, feature, run_id, passed=True, metadata={
        "actualBashExecution": {"argv": argv, "exitCode": actual.returncode,
            "stdout": actual.stdout + actual.stderr, "cwd": str(worktree)},
        "environment": {"version": sys.version,
            "seedDataDigest": hashlib.sha256(b"app-integer-boundary-sample-v1").hexdigest(),
            "dependencies": {"python": sys.version.split()[0], "database": "none", "MQ": "none"}},
        "scenarios": ["double(successor(2)) == 6", "successor(double(-2)) == -3"]}))


def archive(workspace: Path, feature: str) -> dict:
    # Invoked after the original update_checkpoint archived command has succeeded.
    state = json.loads((workspace / ".autobizdevops/state.json").read_text("utf-8"))
    row = state["features"][feature]
    if row["checkpoint"] != "archived":
        raise ValueError("original_archived_checkpoint_required")
    source = workspace / ".autobizdevops/features" / feature
    destination = workspace / ".autobizdevops/archive" / (feature + "-iter1")
    if not source.is_dir() or destination.exists():
        raise ValueError("fresh_archive_source_and_target_required")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(source), str(destination))
    return {"archivedPath": str(destination), "originalCheckpoint": row["checkpoint"],
            "sourceRemoved": not source.exists()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prd", "specs", "design", "plan", "cicd",
                                           "implement", "utest", "e2e", "archive"])
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--knowledge-text-file", type=Path)
    parser.add_argument("--run-id")
    parser.add_argument("--batch-id", choices=["B001", "B002"])
    parser.add_argument("--worktree", type=Path)
    args = parser.parse_args()
    plugin = args.plugin_root.resolve(strict=True)
    workspace = args.workspace.resolve(strict=True)
    if not args.feature.replace("-", "").isalnum():
        raise ValueError("explicit_sample_feature_required")
    sys.path.insert(0, str(plugin))
    if args.action == "plan":
        if not args.knowledge_text_file:
            raise ValueError("explicit_knowledge_required")
        result = prepare_plan(workspace, args.feature, args.knowledge_text_file.read_text("utf-8"))
    elif args.action in {"implement", "utest"}:
        if not args.run_id or not args.batch_id:
            raise ValueError("real_original_run_and_batch_required")
        result = (implementation if args.action == "implement" else utest)(
            workspace, args.feature, args.run_id, args.batch_id)
    elif args.action == "e2e":
        if not args.run_id or not args.worktree:
            raise ValueError("original_e2e_worktree_required")
        result = e2e(workspace, args.feature, args.run_id, args.worktree.resolve(strict=True))
    elif args.action == "archive":
        result = archive(workspace, args.feature)
    else:
        result = lifecycle(plugin, workspace, args.feature, args.action)
    print("APP_SAMPLE_RESULT=" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()

