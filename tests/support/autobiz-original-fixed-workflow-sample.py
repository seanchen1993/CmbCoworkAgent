"""Controlled authorship only; the original fixed Workflow owns every lifecycle transition."""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("original_app_sample", Path(__file__).with_name("autobiz-full-app-sample.py"))
sample = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sample)


def implement(workspace, feature, run_id, batch_id, dispatch_auth=None):
    from hooks.parallel_batch_scheduler import mark_batch
    from hooks.parallel_runtime import acquire_lease, check_lease, release_lease
    from hooks.task_runner import start_task, finish_implementation, prepare_compile, record_compile, TaskRunnerError
    from hooks.worktree_manager import seal_parallel_batch
    worktree, branch, task_id, index = sample.batch_context(workspace, feature, run_id, batch_id)
    module, function, operation = ("cap", "successor", "value + 1") if index == 1 else ("next", "double", "value * 2")
    java = worktree / "src/main/java" / ("Delivery" + module.title() + ".java")
    from hooks import frontend_route_write_guard
    def code_write_guard(path):
        return subprocess.run([sys.executable, "-B", "-X", "utf8", frontend_route_write_guard.__file__],
            input=json.dumps({"tool_name": "write_file", "tool_input": {"file_path": str(path), "content": "controlled production source"}}),
            capture_output=True, text=True, encoding="utf-8", cwd=Path(frontend_route_write_guard.__file__).parents[1], timeout=30)
    denied = code_write_guard(java)
    if denied.returncode != 2:
        raise ValueError("production_write_without_active_task_was_not_rejected:" + denied.stdout + denied.stderr)
    token = acquire_lease(workspace, feature, run_id, batch_id, ttl_seconds=600,
        dispatch_auth=dispatch_auth)["ownerToken"]
    sample.checked(mark_batch(workspace, feature, run_id, batch_id, "running", worktreePath=str(worktree), branchName=branch))
    started = start_task(workspace, feature, task_id, worktree, parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    allowed = code_write_guard(java)
    if allowed.returncode:
        raise ValueError("native_active_task_write_guard_rejected:" + allowed.stdout + allowed.stderr)
    classname = "Delivery" + module.title()
    if java.exists() or (worktree / (module + ".py")).exists():
        raise ValueError("original_sample_must_not_replay_an_existing_implementation")
    java.parent.mkdir(parents=True, exist_ok=True)
    java.write_text(f"public class {classname} {{\n  public static void main(String[] args) {{\n"
        f"    long value = Long.parseLong(args[0]);\n    System.out.println({operation});\n  }}\n}}\n", encoding="utf-8")
    (worktree / (module + ".py")).write_text("from pathlib import Path\nimport subprocess\n"
        f"def {function}(value):\n"
        '    if isinstance(value, bool) or not isinstance(value, int):\n        raise ValueError("integer required")\n'
        f'    source = Path(__file__).parent / "src/main/java/{classname}.java"\n'
        '    return int(subprocess.run(["java", str(source), str(value)], check=True,\n'
        '        capture_output=True, text=True, timeout=30).stdout.strip())\n', encoding="utf-8")
    try:
        finish_implementation(workspace, feature, task_id, worktree, started["runId"],
            no_code_change_why=None, supporting_files=[], parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    except TaskRunnerError as error:
        if "production_compile_result_missing" not in str(error):
            raise
    else:
        raise ValueError("missing_production_compile_was_not_rejected")
    argv = ["mvn", "-o", "-q", "-DskipTests", "compile"]
    prepared = prepare_compile(workspace, feature, task_id, worktree, started["runId"], argv=argv,
        execution_cwd=worktree, parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    bash = os.environ.get("GIT_BASH_PATH", r"C:\Program Files\Git\bin\bash.exe")
    actual = subprocess.run([bash, "-c", " ".join(shlex.quote(arg) for arg in argv)], cwd=worktree,
        capture_output=True, text=True, encoding="utf-8", timeout=90)
    log = workspace / ".autobizdevops/features" / feature / (batch_id + "-production-compile.log")
    log.write_text(actual.stdout + actual.stderr, encoding="utf-8")
    compilation = record_compile(workspace, feature, task_id, worktree, started["runId"],
        attempt_id=prepared["attemptId"], exit_code=actual.returncode, log_exit_code=0,
        output_file=log, parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    if not compilation.get("passed"):
        raise ValueError("real_maven_compile_failed:" + log.read_text("utf-8"))
    ok, implementation = finish_implementation(workspace, feature, task_id, worktree, started["runId"],
        no_code_change_why=None, supporting_files=[], parallel_run_id=run_id, lease_token=token, workspace_ref="default")
    if not ok or not check_lease(workspace, feature, run_id, batch_id, token):
        raise ValueError(json.dumps(implementation, ensure_ascii=False))
    sealed = sample.checked(seal_parallel_batch(workspace, feature, run_id, batch_id, worktree, token, purpose="review"))
    release_lease(workspace, feature, run_id, batch_id, token, final_status="sealed")
    return {"batchId": batch_id, "status": "success", "tasksCompleted": 1, "tasksTotal": 1,
        "worktreePath": str(worktree), "branchName": branch, "commitSha": sealed["commitSha"],
        "actualProductionCompile": compilation, "negativeMissingCompile": True,
        "negativeUnauthorizedWrite": True,
        "implementationEvidenceId": implementation.get("implementationEvidenceId")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("implement", "utest", "e2e"))
    parser.add_argument("--plugin-root", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--feature", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--batch-id", choices=("B001", "B002"))
    parser.add_argument("--worktree", type=Path)
    parser.add_argument("--dispatch-generation", type=int)
    parser.add_argument("--dispatch-token")
    args = parser.parse_args()
    sys.path.insert(0, str(args.plugin_root.resolve(strict=True)))
    workspace = args.workspace.resolve(strict=True)
    if args.action == "e2e":
        result = sample.e2e(workspace, args.feature, args.run_id, args.worktree.resolve(strict=True))
    else:
        if not args.batch_id:
            raise ValueError("explicit_original_batch_required")
        dispatch_auth = {"generation": args.dispatch_generation, "token": args.dispatch_token}
        if args.dispatch_generation is None or not args.dispatch_token:
            raise ValueError("original_dispatch_authority_required")
        result = (implement if args.action == "implement" else sample.utest)(workspace, args.feature, args.run_id, args.batch_id, dispatch_auth)
    print("APP_SAMPLE_RESULT=" + json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
