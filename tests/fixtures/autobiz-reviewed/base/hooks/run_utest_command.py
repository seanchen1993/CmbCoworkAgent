#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run or record one UTest command inside its assigned repository."""

from __future__ import print_function

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.evidence_store import EvidenceStoreError, append_evidence  # noqa: E402
from hooks.json_writer_common import resolve_feature, resolve_workspace, shell_join  # noqa: E402
from hooks.parallel_runtime import load_manifest  # noqa: E402
from hooks.unit_test_result_writer import ensure_plan_result, record_execution  # noqa: E402
from hooks.utest_plan_contract import (  # noqa: E402
    UTestPlanContractError,
    command_executes_tests,
    resolve_plan_target,
)
from hooks.utest_workspace_binding import (  # noqa: E402
    UTestWorkspaceBindingError,
    path_within,
    resolve_task_workspace,
    select_task_execution_target,
)


UT_ID_RE = re.compile(r"^UT-\d{3,}$")
TASK_ID_RE = re.compile(r"^T\d{3}$")
MODES = ("setup", "test")


class UTestCommandError(Exception):
    """Raised when a command cannot be safely prepared or recorded."""


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise UTestCommandError(
            "命令参数无效：{}。修复：运行 `${{pluginPath}}/hooks/run_utest_command.py --help`，"
            "不要传 repo/cwd/framework，并在 `--` 后传入 argv。".format(message)
        )


def _validate_argv(argv):
    if not isinstance(argv, list) or not argv:
        raise UTestCommandError(
            "argv 不能为空。修复：在 `--` 后传入可执行文件和参数，或使用 --argv-json。"
        )
    if not all(isinstance(value, str) and value for value in argv):
        raise UTestCommandError(
            "argv 必须是非空字符串数组。修复：不要传 shell 命令字符串或空参数。"
        )
    return list(argv)


def _validate_test_files(code_workspace, test_files):
    if not isinstance(test_files, list) or not test_files:
        raise UTestCommandError(
            "test 模式需要 --test-file。修复：先生成测试文件，再为每个文件传一个仓库根相对路径。"
        )
    root = Path(code_workspace).expanduser().resolve()
    result = []
    for raw_path in test_files:
        if not isinstance(raw_path, str) or not raw_path.strip():
            raise UTestCommandError(
                "--test-file 包含空值。修复：传入仓库根相对的现有测试文件。"
            )
        requested = Path(raw_path)
        if requested.is_absolute() or ".." in requested.parts:
            raise UTestCommandError(
                "--test-file 必须是仓库根相对路径：{}。修复：移除绝对路径或 ..。".format(
                    raw_path
                )
            )
        resolved = (root / requested).resolve()
        if not path_within(resolved, root) or not resolved.is_file():
            raise UTestCommandError(
                "--test-file 不存在或越出分配仓库：{}。修复：先落地测试文件再执行。".format(
                    raw_path
                )
            )
        relative = resolved.relative_to(root).as_posix()
        if relative not in result:
            result.append(relative)
    return result


def _terminate_process_tree(process):
    """Terminate the runner and every child it started after a timeout.

    Maven, Gradle and Node routinely fork a JVM/daemon.  Killing only the
    shell-facing parent makes a timeout look successful while the compiler
    continues consuming the Batch slot in the background.
    """
    if process.poll() is not None:
        return
    if os.name == "nt":
        # ``/T`` includes descendants; fall back to ``kill`` when taskkill is
        # unavailable (for example on a constrained test host).
        try:
            subprocess.run(
                ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            process.kill()
        return
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        process.kill()


def _read_capture(handle):
    size = os.fstat(handle.fileno()).st_size
    if hasattr(os, "pread"):
        # A surviving child may still share the writer's file offset. Read a
        # fixed snapshot without seeking that offset backwards.
        chunks = []
        offset = 0
        while offset < size:
            chunk = os.pread(handle.fileno(), min(size - offset, 1024 * 1024), offset)
            if not chunk:
                break
            chunks.append(chunk)
            offset += len(chunk)
        return b"".join(chunks).decode("utf-8", errors="replace")
    handle.seek(0)
    return handle.read(size).decode("utf-8", errors="replace")


def _run(argv, cwd, timeout):
    try:
        # Maven/Gradle may leave a child holding stdout or stderr after the
        # runner itself exits. Waiting for PIPE EOF would then hide the real
        # exit code (and the second communicate after timeout could hang).
        # Regular files let us wait for the runner process, not its pipe owners.
        with tempfile.TemporaryFile() as stdout_file, tempfile.TemporaryFile() as stderr_file:
            process_kwargs = {
                "cwd": str(cwd),
                "shell": False,
                "stdout": stdout_file,
                "stderr": stderr_file,
                "env": {**os.environ, "PYTHONUTF8": "1"},
            }
            if os.name == "nt":
                process_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
            else:
                process_kwargs["start_new_session"] = True
            process = subprocess.Popen(argv, **process_kwargs)
            timed_out = False
            try:
                process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                timed_out = True
                _terminate_process_tree(process)
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            stdout = _read_capture(stdout_file)
            stderr = _read_capture(stderr_file)
            if timed_out:
                timeout_message = "命令超过 {} 秒，已终止整个进程组。修复：缩小测试范围或检查阻塞资源。".format(timeout)
                stderr = "{}\n{}".format(stderr.rstrip(), timeout_message).lstrip()
                return 124, stdout, stderr, True, "command_timeout"
            return process.returncode, stdout, stderr, False, "completed"
    except FileNotFoundError as exc:
        return (
            127,
            "",
            "{}。修复：安装可执行文件，或从真实 manifest 选择项目 runner。".format(exc),
            True,
            "command_unavailable",
        )
    except OSError as exc:
        return (
            126,
            "",
            "{}。修复：确认可执行文件权限和当前平台支持。".format(exc),
            True,
            "command_error",
        )


def _parse_utc_epoch(value):
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _remaining_stage_seconds(workspace, feature, run_id, batch_id, stage_timeout):
    """Return the remaining durable UTest budget, when this is a Batch run."""
    if not run_id or not batch_id or stage_timeout is None:
        return None
    try:
        manifest = load_manifest(Path(workspace), feature, run_id)
        batch = manifest.get("batches", {}).get(batch_id, {})
        states = batch.get("stageStates", {}) if isinstance(batch, dict) else {}
        state = states.get("test", {}) if isinstance(states, dict) else {}
        started = _parse_utc_epoch(state.get("startedAt") if isinstance(state, dict) else None)
    except (OSError, ValueError, TypeError):
        return None
    if started is None:
        return None
    return int(stage_timeout - (time.time() - started))


def _failure_classification(exit_code, blocked, outcome, stdout, stderr):
    if outcome in {"command_timeout", "stage_deadline_exceeded"}:
        return "timeout"
    if blocked:
        return "environment"
    if exit_code == 0:
        return "passed"
    output = "\n".join((stdout or "", stderr or ""))
    compiler_markers = (
        "COMPILATION ERROR",
        "maven-compiler-plugin",
        "javac",
        "error TS",
        "TypeScript error",
        "Compilation failed",
    )
    return "source_compile" if any(marker in output for marker in compiler_markers) else "test_failure"


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _append_log(path, mode, target_id, cwd, command, exit_code, stdout, stderr):
    path.parent.mkdir(parents=True, exist_ok=True)
    parts = [
        "=== UTEST COMMAND {} ===".format(_timestamp()),
        "mode: {}".format(mode),
        "target: {}".format(target_id or "setup"),
        "cwd: {}".format(cwd),
        "command: {}".format(command),
        "exit_code: {}".format(exit_code),
        "--- stdout ---",
        stdout.rstrip(),
        "--- stderr ---",
        stderr.rstrip(),
        "=== END UTEST COMMAND ===",
        "",
    ]
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(parts) + "\n")


def _result_for(exit_code, blocked):
    if blocked:
        return "BLOCKED", "blocked"
    if exit_code == 0:
        return "PASS", "pass"
    return "FAIL", "fail"


def execute_utest_command(
    *,
    workspace,
    feature,
    argv=None,
    kind=None,
    mode=None,
    target_id=None,
    task_id=None,
    command_id=None,
    task_digest=None,
    test_files=None,
    environment_target_id=None,
    code_workspace=None,
    timeout=600,
    run_id=None,
    batch_id=None,
    stage_timeout=None,
    record_only=False,
    recorded_exit_code=None,
    recorded_output_file=None,
):
    selected_kind = kind or mode
    if selected_kind not in MODES:
        raise UTestCommandError(
            "kind 无效：{}。修复：使用 setup 或 test。".format(selected_kind)
        )
    if selected_kind == "test" and not record_only:
        raise UTestCommandError(
            "行为测试必须由 Bash 直接执行；使用 --record-only 登记 Bash 的真实退出码与输出，禁止由 Python runner 启动测试进程。"
        )
    if not isinstance(timeout, int) or timeout <= 0:
        raise UTestCommandError(
            "timeout 必须是正整数。修复：传入大于 0 的秒数。"
        )
    if stage_timeout is not None and (not isinstance(stage_timeout, int) or stage_timeout <= 0):
        raise UTestCommandError(
            "stage-timeout 必须是正整数。修复：传入整个 UTest 阶段允许的秒数。"
        )
    artifact_workspace = resolve_workspace(workspace)
    resolved_feature = resolve_feature(feature)
    feature_dir = artifact_workspace / ".autobizdevops" / "features" / resolved_feature
    if not isinstance(task_id, str) or not task_id.strip():
        raise UTestCommandError(
            "{} 模式需要 --task-id。修复：传入 assignment 中的 TASK ID。".format(selected_kind)
        )
    if not TASK_ID_RE.fullmatch(task_id):
        raise UTestCommandError(
            "--task-id 无效：{}。修复：传入 plan 中 TASK 的 id 原值，形如 T001；"
            "批次名、阶段名或其他自拟标签不是 TASK ID。".format(task_id)
        )
    try:
        _, authority = resolve_plan_target(feature_dir, task_id, command_id)
        workspace_context = resolve_task_workspace(
            artifact_workspace,
            resolved_feature,
            task_id,
            environment_target_id,
            code_workspace=code_workspace,
        )
    except (UTestPlanContractError, UTestWorkspaceBindingError) as exc:
        raise UTestCommandError(str(exc))
    if authority["taskDigest"] != workspace_context["taskDigest"]:
        raise UTestCommandError(
            "workspace context 与当前 plan 的 taskDigest 不一致。修复：停止复用旧绑定并重新路由。"
        )
    if task_digest is not None and task_digest != authority["taskDigest"]:
        raise UTestCommandError(
            "调用方 taskDigest 与当前 plan 不一致。修复：停止复用旧 assignment 并重新路由。"
        )
    command_argv = _validate_argv(argv)
    if selected_kind == "test":
        if target_id is not None and (
            not isinstance(target_id, str) or not UT_ID_RE.fullmatch(target_id)
        ):
            raise UTestCommandError(
                "--target-id 无效。修复：省略该参数自动分配，或使用 UT-001 形式的稳定 ID。"
            )
        try:
            test_files = _validate_test_files(
                workspace_context["binding"]["root"], test_files
            )
            execution_target = select_task_execution_target(workspace_context, test_files)
        except UTestWorkspaceBindingError as exc:
            raise UTestCommandError(str(exc))
        if target_id is not None and target_id != authority["targetId"]:
            raise UTestCommandError(
                "--target-id 与当前 TASK 不一致：{} != {}。"
                "修复：省略该参数或使用 router 展开的稳定 targetId。".format(
                    target_id, authority["targetId"]
                )
            )
        command_argv = _validate_argv(argv)
        if not command_executes_tests({"argv": command_argv}):
            raise UTestCommandError(
                "test 模式 argv 不会执行测试用例。修复：先生成测试，再传入真实的精确测试命令；"
                "Plan V2 不提供测试 argv。"
            )
        authority = dict(authority)
        authority["argv"] = list(command_argv)
        authority["cwd"] = execution_target["planLocation"]["cwd"]
        authority["repo"] = execution_target["planLocation"]["repo"]
        authority["executionCwd"] = execution_target["executionCwd"]
        authority["environmentTargetId"] = execution_target["environmentTargetId"]
        authority["testFiles"] = list(test_files)
        target_id = authority["targetId"]
        command_id = authority["commandId"]
        spec_refs = list(authority["specRefs"])
        try:
            ensure_plan_result(artifact_workspace, resolved_feature, create=True)
        except (UTestPlanContractError, ValueError, OSError) as exc:
            raise UTestCommandError(
                "UNIT_TEST_RESULT 目标初始化/重跑绑定失败：{}。"
                "修复：保持当前 plan，不要复用 digest 不一致的 target。".format(exc)
            )
    else:
        try:
            execution_target = select_task_execution_target(workspace_context)
        except UTestWorkspaceBindingError as exc:
            raise UTestCommandError(str(exc))

    code_workspace = Path(execution_target["repositoryRoot"])
    command_cwd = Path(execution_target["executionRoot"])

    command = shell_join(command_argv)
    log_path = feature_dir / "test-output.log"
    if record_only:
        if selected_kind != "test":
            raise UTestCommandError("--record-only 仅用于已由 Bash 执行的 test 命令。")
        if not isinstance(recorded_exit_code, int) or recorded_exit_code < 0:
            raise UTestCommandError("--record-only 需要 Bash 返回的非负 --exit-code。")
        if not isinstance(recorded_output_file, str) or not recorded_output_file.strip():
            raise UTestCommandError("--record-only 需要包含 Bash 原始输出的 --output-file。")
        output_path = Path(recorded_output_file).expanduser().resolve()
        temp_root = Path(tempfile.gettempdir()).resolve()
        if not path_within(output_path, temp_root) or not output_path.is_file():
            raise UTestCommandError(
                "--output-file 必须是系统临时目录内的现有输出文件，避免把仓库文件当成命令日志。"
            )
        try:
            stdout = output_path.read_text(encoding="utf-8", errors="replace")
        except OSError as exc:
            raise UTestCommandError("无法读取 Bash 输出文件 {}：{}".format(output_path, exc))
        exit_code = recorded_exit_code
        stderr = ""
        blocked = False
        outcome = "recorded_bash_execution"
    else:
        remaining_stage_seconds = _remaining_stage_seconds(
            artifact_workspace,
            resolved_feature,
            run_id,
            batch_id,
            stage_timeout,
        )
        if remaining_stage_seconds is not None and remaining_stage_seconds <= 0:
            exit_code = 124
            stdout = ""
            stderr = "UTest 阶段总时限 {} 秒已到，未启动新的测试命令。".format(stage_timeout)
            blocked = True
            outcome = "stage_deadline_exceeded"
        else:
            effective_timeout = timeout
            if remaining_stage_seconds is not None:
                effective_timeout = min(timeout, max(1, remaining_stage_seconds))
            exit_code, stdout, stderr, blocked, outcome = _run(
                command_argv, command_cwd, effective_timeout
            )
    _append_log(
        log_path,
        selected_kind,
        target_id,
        command_cwd,
        command,
        exit_code,
        stdout,
        stderr,
    )
    unit_result, evidence_result = _result_for(exit_code, blocked)
    response = {
        "ok": exit_code == 0,
        "kind": selected_kind,
        "result": unit_result,
        "exitCode": exit_code,
        "executionOutcome": outcome,
        "failureClassification": _failure_classification(
            exit_code, blocked, outcome, stdout, stderr
        ),
        "command": command,
        "cwd": str(command_cwd),
        "logPath": str(log_path),
        "evidenceId": None,
        "targetId": target_id,
        "taskId": task_id,
        "commandId": command_id,
        "taskDigest": authority["taskDigest"],
        "covers": list(authority["covers"]) if selected_kind == "test" else [],
        "workspaceRef": workspace_context["workspaceRef"],
        "repositoryRoot": str(code_workspace),
        "executionCwd": execution_target["executionCwd"],
        "environmentTargetId": execution_target["environmentTargetId"],
        "locationWarnings": list(workspace_context.get("locationWarnings", [])),
    }
    if selected_kind == "setup":
        return response

    output_tail = "\n".join(
        part for part in (stdout.rstrip(), stderr.rstrip()) if part
    ) or "(command produced no output)"
    record = {
        "featureId": resolved_feature,
        # UTest is a Batch substage of the unified Code workflow, not a
        # separate Board checkpoint or node.
        "checkpoint": "code_in_progress",
        "nodeId": "dev.code",
        "batchStage": "test",
        "skill": "autodev-utest",
        "taskId": task_id,
        "taskDigest": authority["taskDigest"],
        "action": "validation",
        "specRefs": list(spec_refs),
        "covers": list(authority["covers"]),
        "designRefs": [],
        "changedFiles": list(authority["testFiles"]),
        "validation": {
            "command": command,
            "commandId": authority["commandId"],
            "argv": list(authority["argv"]),
            "cwd": authority["cwd"],
            "executionCwd": authority["executionCwd"],
            "environmentTargetId": authority["environmentTargetId"],
            "repo": authority["repo"],
            "required": authority["required"],
            "covers": list(authority["covers"]),
            "exitCode": exit_code,
            "result": evidence_result,
            "testFiles": list(authority["testFiles"]),
        },
    }
    try:
        evidence = append_evidence(feature_dir, record, output_tail=output_tail)
    except EvidenceStoreError as exc:
        raise UTestCommandError(
            "Evidence 写入失败：{}。修复：修复 evidence 索引/冻结状态后重跑同一命令。".format(
                exc
            )
        )
    evidence_id = str(evidence["evidenceId"])
    try:
        writer_result = record_execution(
            artifact_workspace,
            resolved_feature,
            target_id=target_id,
            task_id=task_id,
            command_id=authority["commandId"],
            task_digest=authority["taskDigest"],
            spec_refs=list(spec_refs),
            covers=list(authority["covers"]),
            evidence_id=evidence_id,
            result=unit_result,
            command=command,
        )
    except Exception as exc:
        raise UTestCommandError(
            "UNIT_TEST_RESULT 写入失败，Evidence {} 已保留：{}。"
            "修复：不要重跑测试；修复结果文件的权限或结构后，使用 "
            "unit_test_result_writer.py record-execution 携带该 evidence ID 补记同一次执行。".format(
                evidence_id, exc
            )
        )
    response["evidenceId"] = evidence_id
    response["evidenceLogPath"] = str(feature_dir / "evidence" / (evidence_id + ".log"))
    if writer_result.data and isinstance(writer_result.data.get("target"), dict):
        response["targetId"] = writer_result.data["target"].get("targetId")
    response["resultPath"] = str(writer_result.path)
    response["resultChanged"] = writer_result.changed
    return response


def _parse_argv_json(raw):
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise UTestCommandError(
            "--argv-json 不是合法 JSON：{}。修复：传入 JSON 字符串数组。".format(exc)
        )
    return _validate_argv(value)


def main(argv=None):
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    if raw_argv and raw_argv[0] in MODES and "--kind" not in raw_argv and "--mode" not in raw_argv:
        raw_argv = ["--kind", raw_argv[0]] + raw_argv[1:]
    parser = RepairArgumentParser(description="在分配仓库内执行或登记 UTest 命令")
    parser.add_argument("--kind", "--mode", dest="kind", choices=MODES)
    parser.add_argument("--workspace")
    parser.add_argument("--feature")
    parser.add_argument("--target-id", "--ut-id", dest="target_id")
    parser.add_argument("--task-id")
    parser.add_argument("--command-id")
    parser.add_argument("--task-digest")
    parser.add_argument("--test-file", action="append")
    parser.add_argument("--environment-target-id")
    parser.add_argument(
        "--batch-worktree",
        dest="code_workspace",
        help="仅 Workflow 内使用：当前 Batch 的原生 Git Worktree，必须与 Plan 绑定仓库共享 Git common-dir。",
    )
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--run-id")
    parser.add_argument("--batch-id")
    parser.add_argument("--stage-timeout", type=int)
    parser.add_argument(
        "--record-only",
        action="store_true",
        help="不执行命令；登记 Bash 已执行的 test 命令、退出码与输出。",
    )
    parser.add_argument("--exit-code", type=int, help="--record-only 时 Bash 命令的退出码。")
    parser.add_argument("--output-file", help="--record-only 时包含 Bash 合并输出的临时文件。")
    parser.add_argument("--argv-json", "--command-json", dest="argv_json")
    parser.add_argument("command_argv", nargs=argparse.REMAINDER)
    try:
        args = parser.parse_args(raw_argv)
        missing = [
            name
            for name, value in (
                ("--kind", args.kind),
                ("--workspace", args.workspace),
                ("--feature", args.feature),
                ("--task-id", args.task_id),
            )
            if not value
        ]
        if missing:
            raise UTestCommandError(
                "缺少 {}。修复：从 UTest assignment 传入这些参数。".format(
                    ", ".join(missing)
                )
            )
        trailing_argv = list(args.command_argv)
        if trailing_argv and trailing_argv[0] == "--":
            trailing_argv = trailing_argv[1:]
        if args.argv_json and trailing_argv:
            raise UTestCommandError(
                "不能同时传 --argv-json 与尾随 argv。修复：只保留一种 argv 输入。"
            )
        if args.argv_json:
            command_argv = _parse_argv_json(args.argv_json)
        else:
            command_argv = _validate_argv(trailing_argv)
        result = execute_utest_command(
            workspace=args.workspace,
            feature=args.feature,
            argv=command_argv,
            kind=args.kind,
            target_id=args.target_id,
            task_id=args.task_id,
            command_id=args.command_id,
            task_digest=args.task_digest,
            test_files=args.test_file,
            environment_target_id=args.environment_target_id,
            code_workspace=args.code_workspace,
            timeout=args.timeout,
            run_id=args.run_id,
            batch_id=args.batch_id,
            stage_timeout=args.stage_timeout,
            record_only=args.record_only,
            recorded_exit_code=args.exit_code,
            recorded_output_file=args.output_file,
        )
    except UTestCommandError as exc:
        print("run_utest_command_failed: {}".format(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        print(
            "run_utest_command_failed: {}。修复：检查 workspace、feature 与结果产物后重跑。".format(
                exc
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))
    if args.record_only:
        # A failed test is still a successfully recorded execution.  The
        # structured JSON carries the test exitCode; this process status only
        # reports whether evidence/result recording itself succeeded.
        return 0
    return int(result["exitCode"])


if __name__ == "__main__":
    raise SystemExit(main())
