#!/usr/bin/env python3
"""Controlled local Code sample using the supplied original AutoBiz kernel.

Real Git worktrees, task implementation receipts, Bash tests, original UTest
writers, merge train and E2E are exercised. This proves protocol continuity,
not model-generated code/review quality. No external repository is modified.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.dont_write_bytecode = True


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


def prepare(workspace: Path, feature: str, knowledge: str, production_compile: str | None = None) -> dict:
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
    (repo / ".gitignore").write_text("__pycache__/\n*.pyc\n.cmbdevclaw/\n" +
        ("target/\n" if production_compile else ""), encoding="utf-8")
    (repo / "README.md").write_text("# Controlled backend sample\nKnowledge context SHA256: " +
        hashlib.sha256(knowledge.encode()).hexdigest() + "\n", encoding="utf-8")
    (repo / "pyproject.toml").write_text('[project]\nname="creator-code-sample"\nversion="0.0.1"\n', encoding="utf-8")
    if production_compile == "maven-java":
        (repo / "pom.xml").write_text('''<project xmlns="http://maven.apache.org/POM/4.0.0">
<modelVersion>4.0.0</modelVersion><groupId>controlled.sample</groupId>
<artifactId>original-autobiz-boundary</artifactId><version>1.0.0</version>
<properties><maven.compiler.release>17</maven.compiler.release></properties>
<build><plugins>
<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-resources-plugin</artifactId><version>3.4.0</version></plugin>
<plugin><groupId>org.apache.maven.plugins</groupId><artifactId>maven-compiler-plugin</artifactId><version>3.15.0</version></plugin>
</plugins></build></project>\n''', encoding="utf-8")
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
    input_file = feature_dir / "creator-code-plan-input.json"
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
    write_json(feature_dir / "creator-code-sample.json", result)
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


def run(workspace: Path, feature: str, plugin_root: Path, knowledge: str, expect_observer: bool,
        phase: str = "run", selected_batch: str | None = None,
        production_compile: str | None = None) -> dict:
    from hooks.parallel_batch_scheduler import create_run, schedule
    from hooks.parallel_batch_stage import start_stage, complete_stage, gate_batch
    from hooks.parallel_runtime import acquire_lease, release_lease, load_manifest
    from hooks.worktree_manager import provision_parallel_worktree, seal_parallel_batch
    from hooks.task_runner import start_task, finish_implementation
    from hooks.run_utest_command import execute_utest_command
    from hooks.parallel_merge_train import build_candidate, promote_candidate, begin_e2e, finish_e2e
    from hooks.parallel_evidence_aggregate import aggregate_evidence

    feature_dir = workspace / ".autobizdevops/features" / feature
    prepared = json.loads((feature_dir / "creator-code-sample.json").read_text(encoding="utf-8"))
    if prepared["knowledgeSha256"] != hashlib.sha256(knowledge.encode()).hexdigest():
        raise ValueError("knowledge_context_changed_after_plan")
    if prepared.get("executed"):
        raise ValueError("sample_already_executed_no_replay")
    repo = Path(prepared["repository"])
    repo.relative_to(workspace)
    state_path = feature_dir / "creator-code-run.json"
    begin = phase in {"run", "begin-run"}
    if begin:
        if state_path.exists():
            raise ValueError("sample_run_already_begun_no_replay")
        created = checked(create_run(workspace, feature, max_parallel=2, timeout_seconds=600,
            code_workspaces=[str(repo)], task_card_id="Z990692-294"))
        run_id = created["runId"]
    else:
        runtime = json.loads(state_path.read_text(encoding="utf-8"))
        run_id = runtime["runId"]
    snapshots = []
    observer = plugin_root / "mods/business/autobiz.worktree-progress/inspect.py"
    if observer.is_file() != expect_observer:
        raise ValueError("sample_observer_presence_does_not_match_explicit_expectation")
    def observe(label: str) -> None:
        if not observer.is_file():
            snapshots.append({"label": label, "available": False,
                "reason": "original baseline has no plugin-owned worktree progress inspector"})
            return
        spec = importlib.util.spec_from_file_location("creator_sample_progress", observer)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        for attempt in range(12):
            value = module.collect(workspace, feature, run_id)
            if len(value["rows"]) == 2 and not value["diagnostics"]:
                snapshots.append({"label": label, "value": value})
                return
            time.sleep(0.05)
        raise ValueError("actual_observer_unavailable:" + json.dumps(value))

    if begin:
        worktrees = {}
        for batch_id in ("B001", "B002"):
            worktrees[batch_id] = Path(checked(provision_parallel_worktree(workspace, feature, run_id,
                batch_id))["worktreePath"])
        observe("two-real-worktrees-provisioned")
        missing_test_gate = gate_batch(workspace, feature, run_id, "B001")
        if missing_test_gate.get("success"):
            raise ValueError("negative_missing_stages_accepted")
        schedule_result = schedule(workspace, feature, run_id)
        runtime = {"runId": run_id, "worktrees": {key: str(path) for key, path in worktrees.items()},
            "schedule": schedule_result, "negativeMissingStages": missing_test_gate,
            "observerSnapshots": snapshots.copy(), "expectObserver": expect_observer}
        write_json(state_path, runtime)
        if phase == "begin-run":
            return {"phase": "begun", "executed": False, **runtime}
    else:
        if runtime["expectObserver"] != expect_observer:
            raise ValueError("sample_observer_expectation_changed_after_begin")
        worktrees = {key: Path(path) for key, path in runtime["worktrees"].items()}
        schedule_result = runtime["schedule"]
        missing_test_gate = runtime["negativeMissingStages"]
        snapshots = runtime["observerSnapshots"].copy()
    deliveries = []
    negative_failed_test = None
    indexes = (1, 2) if phase == "run" else (int(selected_batch[1:]),) if phase == "run-batch" else ()
    for index in indexes:
        batch_id, task_id = f"B{index:03d}", f"T{index:03d}"
        batch_receipt_path = feature_dir / "creator-code-receipts" / (batch_id + ".json")
        if batch_receipt_path.exists():
            raise ValueError("sample_batch_already_executed_no_replay:" + batch_id)
        worktree = worktrees[batch_id]
        lease = acquire_lease(workspace, feature, run_id, batch_id, ttl_seconds=600)
        token = lease["ownerToken"]
        started = start_task(workspace, feature, task_id, worktree, parallel_run_id=run_id,
            lease_token=token, workspace_ref="default")
        filename = "cap.py" if index == 1 else "next.py"
        function = "successor" if index == 1 else "double"
        operation = "value + 1" if index == 1 else "value * 2"
        code = (f"def {function}(value):\n"
            '    if isinstance(value, bool) or not isinstance(value, int):\n'
            '        raise ValueError("integer required")\n'
            f"    return {operation}\n")
        if production_compile == "maven-java":
            classname = "Delivery" + filename.split(".")[0].title()
            java_file = worktree / "src/main/java" / (classname + ".java")
            java_file.parent.mkdir(parents=True, exist_ok=True)
            java_file.write_text(f"public class {classname} {{\n"
                "  public static void main(String[] args) {\n"
                "    long value = Long.parseLong(args[0]);\n"
                f"    System.out.println({operation});\n  }}\n}}\n", encoding="utf-8")
            code = ("from pathlib import Path\nimport subprocess\n"
                f"def {function}(value):\n"
                '    if isinstance(value, bool) or not isinstance(value, int):\n'
                '        raise ValueError("integer required")\n'
                f'    source = Path(__file__).parent / "src/main/java/{classname}.java"\n'
                '    return int(subprocess.run(["java", str(source), str(value)], check=True,\n'
                '        capture_output=True, text=True, timeout=30).stdout.strip())\n')
        (worktree / filename).write_text(code, encoding="utf-8")
        observe(f"{batch_id}-implementation-running")
        compile_receipt = None
        if production_compile == "maven-java":
            from hooks.task_runner import prepare_compile, record_compile, TaskRunnerError
            try:
                finish_implementation(workspace, feature, task_id, worktree,
                    started["runId"], no_code_change_why=None, supporting_files=[],
                    parallel_run_id=run_id, lease_token=token, workspace_ref="default")
            except TaskRunnerError as error:
                if "production_compile_result_missing" not in str(error):
                    raise
            else:
                raise ValueError("required_production_compile_gate_was_not_enforced")
            argv = ["mvn", "-o", "-q", "-DskipTests", "compile"]
            attempt = prepare_compile(workspace, feature, task_id, worktree, started["runId"],
                argv=argv, execution_cwd=worktree, parallel_run_id=run_id,
                lease_token=token, workspace_ref="default")
            bash = os.environ.get("GIT_BASH_PATH", r"C:\Program Files\Git\bin\bash.exe")
            compiled = subprocess.run([bash, "-c", " ".join(shlex.quote(a) for a in argv)],
                cwd=worktree, capture_output=True, text=True, encoding="utf-8", timeout=90)
            log_path = feature_dir / (batch_id + "-actual-production-compile.log")
            log_path.write_text(compiled.stdout + compiled.stderr, encoding="utf-8")
            compile_receipt = record_compile(workspace, feature, task_id, worktree,
                started["runId"], attempt_id=attempt["attemptId"], exit_code=compiled.returncode,
                log_exit_code=0, output_file=log_path, parallel_run_id=run_id,
                lease_token=token, workspace_ref="default")
            if not compile_receipt.get("passed"):
                raise ValueError("real_production_compile_failed:" + log_path.read_text("utf-8"))
        ok, implementation = finish_implementation(workspace, feature, task_id, worktree,
            started["runId"], no_code_change_why=None, supporting_files=[],
            parallel_run_id=run_id, lease_token=token, workspace_ref="default")
        if not ok:
            raise RuntimeError(json.dumps(implementation))
        sealed = checked(seal_parallel_batch(workspace, feature, run_id, batch_id, worktree,
            token, purpose="review"))
        release_lease(workspace, feature, run_id, batch_id, token, final_status="sealed")
        metadata = {"batchCommit": sealed["commitSha"], "implementationEvidenceId":
            implementation.get("implementationEvidenceId")}
        # Match the original fixed Workflow: register completed preparation
        # and implementation only after the actual implementation is sealed.
        start_stage(workspace, feature, run_id, batch_id, "prepare")
        complete_stage(workspace, feature, run_id, batch_id, "prepare", metadata=metadata)
        start_stage(workspace, feature, run_id, batch_id, "implement")
        complete_stage(workspace, feature, run_id, batch_id, "implement", metadata=metadata)
        start_stage(workspace, feature, run_id, batch_id, "review")
        actual = (worktree / filename).read_text(encoding="utf-8")
        assert actual == code and "raise ValueError" in actual
        complete_stage(workspace, feature, run_id, batch_id, "review", metadata={**metadata,
            "reviewScope": "Controlled deterministic sample source review, not LLM review quality",
            "reviewedSourceSha256": hashlib.sha256(actual.encode()).hexdigest()})
        start_stage(workspace, feature, run_id, batch_id, "test")
        test_name = f"test_creator_{index}"
        test_file = test_name + ".py"
        expected_positive, expected_negative = ((3, 0) if index == 1 else (4, -2))
        module = "cap" if index == 1 else "next"
        body = (f"from {module} import {function}\nclass Delivery(unittest.TestCase):\n"
            f"    def test_valid(self):\n        self.assertEqual({function}(2), {expected_positive})\n"
            f"        self.assertEqual({function}(-1), {expected_negative})\n"
            '    def test_invalid(self):\n        for value in (True, "4", None):\n'
            f"            with self.assertRaises(ValueError): {function}(value)\n")
        (worktree / test_file).write_text("import unittest\n" + body, encoding="utf-8")
        def record_execution(execution: dict) -> dict:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".log", delete=False) as log:
                log.write(execution["stdout"])
                log_path = Path(log.name)
            try:
                return execute_utest_command(workspace=str(workspace), feature=feature,
                    argv=execution["argv"], kind="test", task_id=task_id, test_files=[test_file],
                    code_workspace=str(worktree), run_id=run_id, batch_id=batch_id,
                    record_only=True, recorded_exit_code=execution["exitCode"],
                    recorded_output_file=str(log_path))
            finally:
                log_path.unlink(missing_ok=True)
        if index == 1:
            (worktree / test_file).write_text("import unittest\n" + body.replace(
                f"self.assertEqual({function}(2), {expected_positive})",
                f"self.assertEqual({function}(2), 999)"), encoding="utf-8")
            failed_execution = bash_test(worktree, test_name, expected=1)
            failed_record = record_execution(failed_execution)
            assert failed_record["ok"] is False and failed_record["result"] == "FAIL"
            rejected_gate = gate_batch(workspace, feature, run_id, batch_id)
            assert rejected_gate["success"] is False
            try:
                build_candidate(workspace, feature, run_id, wave=1, batch_ids=[batch_id])
            except ValueError as error:
                assert "not_ready_to_candidate" in str(error)
                rejection = str(error)
            else:
                raise ValueError("actual_failed_test_was_promoted_to_candidate")
            negative_failed_test = {"execution": failed_execution, "originalRecord": failed_record,
                "gate": rejected_gate, "candidateRejection": rejection}
            (worktree / test_file).write_text("import unittest\n" + body, encoding="utf-8")
        execution = bash_test(worktree, test_name)
        test = checked(record_execution(execution))
        lease = acquire_lease(workspace, feature, run_id, batch_id, ttl_seconds=600)
        resealed = checked(seal_parallel_batch(workspace, feature, run_id, batch_id, worktree,
            lease["ownerToken"]))
        release_lease(workspace, feature, run_id, batch_id, lease["ownerToken"], final_status="sealed")
        complete_stage(workspace, feature, run_id, batch_id, "test", metadata={
            "batchCommit": resealed["commitSha"], "testEvidenceIds": [test["evidenceId"]],
            "actualBashExecution": execution})
        checked(gate_batch(workspace, feature, run_id, batch_id))
        deliveries.append({"batchId": batch_id, "implementation": implementation,
            "test": test, "execution": execution, "commit": resealed["commitSha"]})
        observe(f"{batch_id}-review-and-actual-test-gated")
        receipt = {"phase": "batch-gated", "runId": run_id, "batchId": batch_id,
            "delivery": deliveries[-1], "negativeFailedTest": negative_failed_test,
            "productionCompile": compile_receipt,
            "observerSnapshots": snapshots.copy()}
        write_json(batch_receipt_path, receipt)
        if phase == "run-batch":
            return receipt
    if phase == "finish-run":
        snapshots = runtime["observerSnapshots"].copy()
        for batch_id in ("B001", "B002"):
            receipt = json.loads((feature_dir / "creator-code-receipts" / (batch_id + ".json")).read_text(encoding="utf-8"))
            if receipt["runId"] != run_id:
                raise ValueError("sample_batch_receipt_run_identity_changed")
            deliveries.append(receipt["delivery"])
            snapshots.extend(receipt["observerSnapshots"])
            negative_failed_test = receipt["negativeFailedTest"] or negative_failed_test
    candidate = checked(build_candidate(workspace, feature, run_id, wave=1,
        batch_ids=["B001", "B002"]))
    # This is the original current protocol: Batch UTest is authoritative;
    # retired duplicate candidate verification is not re-created here.
    promoted = checked(promote_candidate(workspace, feature, run_id, wave=1,
        repository_ref=candidate["repositoryRef"], allow_unverified=True))
    merged_manifest = load_manifest(workspace, feature, run_id)
    integration = merged_manifest["repositories"][candidate["repositoryRef"]].get("integration")
    integration_repo = Path(integration["worktreePath"]) if integration else repo
    integration_repo.resolve(strict=True).relative_to(workspace)
    if git(integration_repo, "rev-parse", "HEAD") != candidate["candidateSha"]:
        raise ValueError("actual_integration_head_must_match_promoted_candidate")
    joint = bash_test(integration_repo, "discover")
    e2e = checked(begin_e2e(workspace, feature, run_id))
    e2e_test = bash_test(Path(e2e["worktrees"][candidate["repositoryRef"]]), "discover")
    finished = checked(finish_e2e(workspace, feature, run_id, passed=True, metadata={
        "actualBashExecution": e2e_test, "environment": {"version": sys.version,
            "seedDataDigest": hashlib.sha256(b"controlled-boundary-inputs-v1").hexdigest(),
            "dependencies": {"python": sys.version.split()[0], "unittest": "stdlib"}}}))
    aggregate = aggregate_evidence(workspace, feature, run_id)
    if not aggregate["passed"]:
        raise RuntimeError(json.dumps(aggregate))
    observe("merged-and-real-e2e-accepted")
    result = {**prepared, "phase": "executed", "executed": True, "passed": True,
        "runId": run_id, "schedule": schedule_result, "negativeMissingStages": missing_test_gate,
        "negativeFailedTest": negative_failed_test,
        "deliveries": deliveries, "candidate": candidate, "promoted": promoted,
        "jointTest": joint, "e2e": finished, "aggregate": aggregate,
        "integrationWorkspace": str(integration_repo),
        "observerSnapshots": snapshots, "manifest": load_manifest(workspace, feature, run_id),
        "limits": "Real original scheduler/tasks/tests/merge/E2E, deterministic sample source/review; no LLM semantic quality claim"}
    write_json(feature_dir / "creator-code-sample.json", result)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "run", "begin-run", "run-batch", "finish-run"))
    parser.add_argument("--batch-id", choices=("B001", "B002"))
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feature", default="alpha")
    parser.add_argument("--knowledge-text-file", type=Path, required=True)
    parser.add_argument("--expect-observer", choices=("true", "false"), default="true")
    parser.add_argument("--production-compile", choices=("maven-java",))
    args = parser.parse_args()
    plugin = args.plugin_root.resolve(strict=True)
    workspace = args.workspace.resolve(strict=True)
    if not (plugin / "hooks/task_runner.py").is_file() or not args.feature.replace("-", "").isalnum():
        raise ValueError("invalid_explicit_sample_scope")
    knowledge = args.knowledge_text_file.read_text(encoding="utf-8")
    if not knowledge.strip():
        raise ValueError("actual_nonempty_knowledge_context_required")
    sys.path.insert(0, str(plugin))
    if args.command == "run-batch" and args.batch_id is None:
        raise ValueError("run_batch_requires_explicit_batch_id")
    result = prepare(workspace, args.feature, knowledge, args.production_compile) if args.command == "prepare" else run(
        workspace, args.feature, plugin, knowledge, args.expect_observer == "true", args.command,
        args.batch_id, args.production_compile)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
