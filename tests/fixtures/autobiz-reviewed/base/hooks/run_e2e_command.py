#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Run one Playwright Test verdict command and commit auditable E2E facts."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, DefaultDict, Dict, List, Optional, Sequence, Tuple


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.e2e_result_writer import record_execution  # noqa: E402
from hooks.e2e_trust_common import (  # noqa: E402
    DIAGNOSTICS_DIR,
    atomic_write_json,
    load_json_object,
    normalize_relative_path,
    scan_path,
    sha256_path,
    validate_execution_evidence_chain,
    validate_execution_log_chain,
    validate_scan_current,
)
from hooks.evidence_kernel import FileLock  # noqa: E402
from hooks.evidence_store import (  # noqa: E402
    EvidenceStoreError,
    append_evidence,
    read_records,
    stream_path,
)
from hooks.json_writer_common import resolve_feature, resolve_workspace, shell_join  # noqa: E402


CONFIG_NAMES = (
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mts",
    "playwright.config.mjs",
    "playwright.config.cts",
    "playwright.config.cjs",
)
NPX_NO_VALUE_FLAGS = {
    "--yes",
    "-y",
    "--no-install",
    "--ignore-existing",
    "--quiet",
}
NPX_VALUE_FLAGS = {
    "--package",
    "-p",
    "--call",
    "-c",
    "--shell",
    "--shell-auto-fallback",
    "--cache",
    "--userconfig",
}
PASS_WITH_NO_TESTS = {"--pass-with-no-tests", "--passwithnotests"}
RUN_ID_RE = re.compile(r"^run-\d+-[a-f0-9]{12}$")


class E2ECommandError(ValueError):
    pass


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise E2ECommandError(
            "命令参数无效：{}。修复：运行 `{} --help`，并在 `--` 后传 Playwright argv。".format(
                message, self.prog
            )
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def _validate_argv(argv: Sequence[str]) -> List[str]:
    if not isinstance(argv, (list, tuple)) or not argv:
        raise E2ECommandError(
            "argv 不能为空。修复：在 `--` 后传入直接的 `playwright test` 命令。"
        )
    if not all(isinstance(value, str) and value for value in argv):
        raise E2ECommandError(
            "argv 必须是非空字符串数组。修复：不要传 shell 命令字符串或空参数。"
        )
    return list(argv)


def _basename(value: str) -> str:
    return Path(value).name.lower()


def parse_playwright_command(argv: Sequence[str]) -> Dict[str, Any]:
    values = _validate_argv(argv)
    runner = _basename(values[0])
    if runner in {"npm", "npm.cmd"}:
        raise E2ECommandError(
            "package_script_verdict_not_supported：npm run 无法可靠注入 reporter。"
            "修复：先单独执行环境准备，再直接运行 `npx playwright test ...`。"
        )
    index = 1
    declared_packages: List[str] = []
    if runner in {"npx", "npx.cmd"}:
        while index < len(values) and values[index].startswith("-"):
            token = values[index]
            flag = token.split("=", 1)[0]
            if flag in NPX_NO_VALUE_FLAGS:
                index += 1
                continue
            if flag in NPX_VALUE_FLAGS:
                if "=" in token:
                    value = token.split("=", 1)[1]
                    if not value:
                        raise E2ECommandError(
                            "npx 标志 {} 缺少值。修复：补齐该标志参数。".format(flag)
                        )
                    index += 1
                else:
                    if index + 1 >= len(values):
                        raise E2ECommandError(
                            "npx 标志 {} 缺少值。修复：补齐该标志参数。".format(flag)
                        )
                    value = values[index + 1]
                    index += 2
                if flag in {"--package", "-p"}:
                    declared_packages.append(value)
                continue
            raise E2ECommandError(
                "unknown_package_runner_flag:{}。修复：移除未知前置标志，或为解析器补充明确规则。".format(
                    token
                )
            )
    elif runner in {"pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe"}:
        if index < len(values) and values[index] == "run":
            raise E2ECommandError(
                "package_script_verdict_not_supported：run 脚本无法可靠注入 reporter。"
                "修复：使用包运行器的 exec/dlx 加直接 `playwright test`。"
            )
        if index >= len(values) or values[index] not in {"exec", "dlx", "x"}:
            raise E2ECommandError(
                "package_runner_exec_required。修复：使用 pnpm/yarn/bun 的 exec、dlx 或 x 后再直接运行 `playwright test`。"
            )
        index += 1
        while index < len(values) and values[index].startswith("-"):
            raise E2ECommandError(
                "unknown_package_runner_flag:{}。修复：移除未知前置标志，或为解析器补充明确规则。".format(
                    values[index]
                )
            )
    elif runner in {"bunx", "bunx.exe"}:
        pass
    else:
        index = 0

    if index >= len(values):
        raise E2ECommandError(
            "缺少 Playwright bin。修复：传入 `playwright test`。"
        )
    binary = _basename(values[index])
    if binary in {"playwright-cli", "playwright-cli.cmd"} or any(
        package == "@playwright/cli" or package.startswith("@playwright/cli@")
        for package in declared_packages
    ):
        raise E2ECommandError(
            "e2e_verdict_requires_playwright_test：这是有头探索 CLI，不是测试裁定入口。"
            "修复：探索完成后持久化 spec，再运行 `npx --yes --package @playwright/test playwright test ...`。"
        )
    if binary not in {"playwright", "playwright.cmd"}:
        raise E2ECommandError(
            "not_playwright_test_entry:{}。修复：直接运行 `playwright test`，不要使用包脚本或其他命令。".format(
                values[index]
            )
        )
    test_index = index + 1
    if test_index >= len(values) or values[test_index] != "test":
        raise E2ECommandError(
            "playwright_test_subcommand_missing。修复：在 playwright 后使用 `test` 子命令。"
        )
    return {
        "argv": values,
        "binIndex": index,
        "testIndex": test_index,
        "declaredPackages": declared_packages,
        "versionArgv": values[:test_index] + ["--version"],
    }


def inject_json_reporter(parsed: Dict[str, Any]) -> Tuple[List[str], str]:
    argv = list(parsed["argv"])
    test_index = int(parsed["testIndex"])
    separator = next(
        (index for index in range(test_index + 1, len(argv)) if argv[index] == "--"),
        len(argv),
    )
    index = test_index + 1
    while index < separator:
        token = argv[index]
        if token.startswith("--reporter="):
            reporters = token.split("=", 1)[1]
            values = [item.strip() for item in reporters.split(",") if item.strip()]
            if "json" not in values:
                values.append("json")
            argv[index] = "--reporter=" + ",".join(values)
            return argv, argv[index]
        if token == "--reporter":
            if index + 1 >= separator:
                raise E2ECommandError(
                    "--reporter 缺少值。修复：传入 `--reporter=json`。"
                )
            values = [item.strip() for item in argv[index + 1].split(",") if item.strip()]
            if "json" not in values:
                values.append("json")
            argv[index + 1] = ",".join(values)
            return argv, "--reporter=" + argv[index + 1]
        index += 1
    argv.insert(separator, "--reporter=json")
    return argv, "--reporter=json"


def _resolve_command_cwd(code_workspace: Path, cwd: Optional[str]) -> Tuple[Path, Path]:
    root = code_workspace.expanduser().resolve()
    if not root.is_dir():
        raise E2ECommandError(
            "code-workspace 不存在：{}。修复：传入被测仓库根目录。".format(root)
        )
    requested = Path(cwd).expanduser() if cwd else root
    if not requested.is_absolute():
        requested = root / requested
    resolved = requested.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise E2ECommandError(
            "cwd 越出被测仓库：{}。修复：把 --cwd 限制在 {} 内。".format(resolved, root)
        )
    if not resolved.is_dir():
        raise E2ECommandError(
            "cwd 不存在：{}。修复：传入被测仓库内的现有目录。".format(resolved)
        )
    return root, resolved


def _run(argv: Sequence[str], cwd: Path, timeout: int, env: Optional[Dict[str, str]] = None) -> Tuple[int, str, str, bool]:
    try:
        child_env = dict(os.environ if env is None else env)
        child_env["PYTHONUTF8"] = "1"
        completed = subprocess.run(
            list(argv),
            cwd=str(cwd),
            shell=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            universal_newlines=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
            check=False,
            env=child_env,
        )
        return completed.returncode, completed.stdout or "", completed.stderr or "", False
    except FileNotFoundError as exc:
        return 127, "", "{}。修复：安装项目声明的 Playwright Test runner。".format(exc), True
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        if isinstance(stdout, bytes):
            stdout = stdout.decode("utf-8", errors="replace")
        if isinstance(stderr, bytes):
            stderr = stderr.decode("utf-8", errors="replace")
        return (
            124,
            stdout,
            (stderr.rstrip() + "\n命令超时。修复：检查阻塞资源、服务和测试范围。").lstrip(),
            True,
        )
    except OSError as exc:
        return 126, "", "{}。修复：检查可执行权限与平台支持。".format(exc), True


def _playwright_version(parsed: Dict[str, Any], cwd: Path, timeout: int) -> str:
    code, stdout, stderr, blocked = _run(parsed["versionArgv"], cwd, min(timeout, 60))
    output = (stdout + "\n" + stderr).strip()
    match = re.search(r"(?:Version\s+)?(\d+\.\d+(?:\.\d+)?)", output)
    if blocked or code != 0 or not match:
        raise E2ECommandError(
            "playwright_version_unavailable：{}。修复：确认同一直接命令前缀支持 `playwright --version`。".format(
                output[:300]
            )
        )
    return match.group(1)


def _test_args(parsed: Dict[str, Any]) -> List[str]:
    return list(parsed["argv"])[int(parsed["testIndex"]) + 1 :]


def _test_option_args(parsed: Dict[str, Any]) -> List[str]:
    args = _test_args(parsed)
    return args[: args.index("--")] if "--" in args else args


def _reject_empty_run_flags(parsed: Dict[str, Any]) -> None:
    for token in _test_option_args(parsed):
        normalized = token.split("=", 1)[0].lower()
        if normalized in PASS_WITH_NO_TESTS:
            raise E2ECommandError(
                "pass_with_no_tests_forbidden:{}。修复：移除空跑豁免并确保 caseId 绑定测试实际执行。".format(
                    token
                )
            )


def _config_info(
    code_root: Path, command_cwd: Path, parsed: Dict[str, Any]
) -> Tuple[Optional[str], Optional[str], str]:
    args = _test_option_args(parsed)
    raw_config: Optional[str] = None
    for index, token in enumerate(args):
        if token.startswith("--config="):
            raw_config = token.split("=", 1)[1]
            break
        if token.startswith("-c="):
            raw_config = token.split("=", 1)[1]
            break
        if token in {"--config", "-c"} and index + 1 < len(args):
            raw_config = args[index + 1]
            break
    candidate: Optional[Path] = None
    if raw_config:
        requested = Path(raw_config)
        candidate = requested.resolve() if requested.is_absolute() else (command_cwd / requested).resolve()
        if candidate.is_dir():
            candidate = next((candidate / name for name in CONFIG_NAMES if (candidate / name).is_file()), None)
        if candidate is None or not candidate.is_file():
            raise E2ECommandError(
                "Playwright config 不存在。修复：更正 --config 路径或移除该参数使用默认配置。"
            )
    else:
        candidate = next((command_cwd / name for name in CONFIG_NAMES if (command_cwd / name).is_file()), None)
        if candidate is None and command_cwd != code_root:
            candidate = next((code_root / name for name in CONFIG_NAMES if (code_root / name).is_file()), None)
    if candidate is None:
        return None, None, "playwright_defaults"
    relative, resolved = normalize_relative_path(code_root, str(candidate), "playwright config")
    return relative, sha256_path(resolved), "config_file"


def _walk_suites(suites: Any) -> List[Dict[str, Any]]:
    result: List[Dict[str, Any]] = []
    for suite in suites if isinstance(suites, list) else []:
        if not isinstance(suite, dict):
            continue
        for spec in suite.get("specs", []) if isinstance(suite.get("specs"), list) else []:
            if isinstance(spec, dict):
                result.append(spec)
        result.extend(_walk_suites(suite.get("suites")))
    return result


def _reported_spec_path(spec: Dict[str, Any], report: Dict[str, Any], code_root: Path) -> Optional[str]:
    code_root = code_root.resolve()
    raw: Optional[str] = None
    location = spec.get("location")
    if isinstance(location, dict) and isinstance(location.get("file"), str):
        raw = location["file"]
    elif isinstance(spec.get("file"), str):
        raw = spec["file"]
    if not raw:
        return None
    candidate = Path(raw)
    if not candidate.is_absolute():
        config = report.get("config") if isinstance(report.get("config"), dict) else {}
        root_dir = config.get("rootDir")
        base = Path(root_dir).resolve() if isinstance(root_dir, str) and root_dir else code_root
        candidate = (base / candidate).resolve()
    try:
        return candidate.resolve().relative_to(code_root).as_posix()
    except ValueError:
        return None


def _normalize_case_id(value: str) -> str:
    return value[1:] if value.startswith("@") else value


def _spec_matches_case(spec: Dict[str, Any], case_id: str) -> Optional[str]:
    wanted = _normalize_case_id(case_id).lower()
    tags = spec.get("tags") if isinstance(spec.get("tags"), list) else []
    if any(isinstance(tag, str) and _normalize_case_id(tag).lower() == wanted for tag in tags):
        return "tag_exact"
    title = spec.get("title")
    if isinstance(title, str) and "[{}]".format(case_id).lower() in title.lower():
        return "title_marker"
    return None


def _status_counts(tests: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"expected": 0, "unexpected": 0, "flaky": 0, "skipped": 0}
    for test in tests:
        status = test.get("status")
        if status in counts:
            counts[str(status)] += 1
        else:
            counts["unexpected"] += 1
    return counts


def _report_facts(
    report: Dict[str, Any],
    code_root: Path,
    declared_specs: Dict[str, str],
    case_id: str,
) -> Tuple[Dict[str, Any], List[str]]:
    errors: List[str] = []
    suites = report.get("suites")
    stats = report.get("stats")
    if not isinstance(suites, list) or not isinstance(stats, dict):
        return {}, ["invalid_playwright_json_report_shape"]
    all_specs = _walk_suites(suites)
    reported: List[str] = []
    matched_tests: List[Dict[str, Any]] = []
    matchers = set()
    for spec in all_specs:
        relative = _reported_spec_path(spec, report, code_root)
        if relative is None:
            errors.append("report_spec_path_unresolvable")
            continue
        reported.append(relative)
        matcher = _spec_matches_case(spec, case_id)
        if matcher:
            matchers.add(matcher)
            tests = spec.get("tests")
            if isinstance(tests, list):
                matched_tests.extend(test for test in tests if isinstance(test, dict))
    if not reported:
        errors.append("report_contains_no_specs")
    undeclared = sorted(set(reported) - set(declared_specs))
    if undeclared:
        errors.append("report_specs_not_declared:{}".format(",".join(undeclared)))
    if not matched_tests:
        errors.append("case_binding_matched_zero_tests")
    counts = _status_counts(matched_tests)
    for test in matched_tests:
        if test.get("status") not in {"expected", "unexpected", "flaky", "skipped"}:
            errors.append("invalid_playwright_test_status")
        if test.get("expectedStatus") not in {"passed", "failed", "skipped"}:
            errors.append("invalid_playwright_expected_status")
        if not isinstance(test.get("projectId"), str) or not test.get("projectId"):
            errors.append("invalid_playwright_project_identity")
        if not isinstance(test.get("projectName"), str) or not test.get("projectName"):
            errors.append("invalid_playwright_project_identity")
    expected_all = bool(matched_tests) and all(test.get("expectedStatus") == "passed" for test in matched_tests)
    last_all = True
    for test in matched_tests:
        results = test.get("results")
        if not isinstance(results, list) or not results or not isinstance(results[-1], dict):
            errors.append("invalid_playwright_test_results")
            last_all = False
        elif results[-1].get("status") not in {"passed", "failed", "timedOut", "interrupted", "skipped"}:
            errors.append("invalid_playwright_result_status")
            last_all = False
        elif results[-1].get("status") != "passed":
            last_all = False
    project_tests: DefaultDict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    for test in matched_tests:
        project_tests[(str(test.get("projectId", "")), str(test.get("projectName", "")))].append(test)
    projects = [
        {
            "projectId": project_id,
            "projectName": project_name,
            "byStatus": _status_counts(tests),
        }
        for (project_id, project_name), tests in sorted(project_tests.items())
    ]
    report_stats = {
        name: stats.get(name)
        for name in ("expected", "unexpected", "flaky", "skipped")
    }
    if any(type(value) is not int or value < 0 for value in report_stats.values()):
        errors.append("invalid_playwright_report_stats")
    facts = {
        "reportedSpecPaths": sorted(set(reported)),
        "caseBinding": {
            "matcher": "+".join(sorted(matchers)) if matchers else None,
            "matchedTests": len(matched_tests),
            "executed": counts["expected"] + counts["unexpected"] + counts["flaky"],
            "failed": counts["unexpected"],
            "byStatus": counts,
            "expectedStatusAllPassed": expected_all,
            "lastResultAllPassed": last_all,
        },
        "projects": projects,
        "reportStats": report_stats,
    }
    return facts, errors


def _collect_report_diagnostics(
    report: Dict[str, Any],
    case_id: str,
    code_root: Path,
    command_cwd: Path,
    diagnostics: Path,
    round_index: int,
    run_id: str,
    report_relative: Optional[str],
) -> Dict[str, Optional[str]]:
    paths: Dict[str, Optional[str]] = {
        "trace": None,
        "screenshot": None,
        "console": None,
        "network": None,
        "report": report_relative,
    }
    for spec in _walk_suites(report.get("suites")):
        if not _spec_matches_case(spec, case_id):
            continue
        tests = spec.get("tests") if isinstance(spec.get("tests"), list) else []
        for test in tests:
            if not isinstance(test, dict):
                continue
            results = test.get("results") if isinstance(test.get("results"), list) else []
            for result in results:
                if not isinstance(result, dict):
                    continue
                attachments = (
                    result.get("attachments")
                    if isinstance(result.get("attachments"), list)
                    else []
                )
                for attachment in attachments:
                    if not isinstance(attachment, dict) or not isinstance(attachment.get("path"), str):
                        continue
                    raw_path = Path(attachment["path"])
                    source = raw_path.resolve() if raw_path.is_absolute() else (command_cwd / raw_path).resolve()
                    try:
                        source.relative_to(code_root)
                    except ValueError:
                        continue
                    if not source.is_file():
                        continue
                    name = str(attachment.get("name", "")).lower()
                    content_type = str(attachment.get("contentType", "")).lower()
                    suffix = source.suffix.lower()
                    kind: Optional[str] = None
                    if "trace" in name or suffix == ".zip":
                        kind = "trace"
                    elif content_type.startswith("image/") or "screenshot" in name:
                        kind = "screenshot"
                    elif "network" in name or "har" in name or suffix == ".har":
                        kind = "network"
                    elif "console" in name:
                        kind = "console"
                    if kind is None or paths[kind] is not None:
                        continue
                    destination = diagnostics / "{}-{}{}".format(
                        kind, run_id, suffix if suffix else ".bin"
                    )
                    if source != destination.resolve():
                        shutil.copy2(str(source), str(destination))
                    paths[kind] = _diagnostic_relative(
                        round_index, destination.name
                    )
    return paths


def _derive_result(
    process_exit_code: int,
    process_blocked: bool,
    facts: Dict[str, Any],
    errors: Sequence[str],
) -> Tuple[str, int, List[str]]:
    reasons = list(errors)
    if process_blocked:
        reasons.append("playwright_process_blocked")
        return "BLOCKED", 1, reasons
    structural = [
        reason
        for reason in reasons
        if reason.startswith(("invalid_", "report_", "case_binding_"))
    ]
    if structural:
        return "BLOCKED", 1, reasons
    binding = facts.get("caseBinding") if isinstance(facts.get("caseBinding"), dict) else {}
    counts = binding.get("byStatus") if isinstance(binding.get("byStatus"), dict) else {}
    if counts.get("flaky", 0) > 0:
        reasons.append("matched_test_flaky")
        return "FLAKY", 1, reasons
    passed = (
        binding.get("matchedTests", 0) > 0
        and binding.get("expectedStatusAllPassed") is True
        and binding.get("lastResultAllPassed") is True
        and counts.get("unexpected") == 0
        and counts.get("flaky") == 0
        and counts.get("skipped") == 0
        and process_exit_code == 0
        and not reasons
    )
    if passed:
        return "PASS", 0, []
    if binding.get("expectedStatusAllPassed") is not True:
        reasons.append("expected_status_not_all_passed")
    if binding.get("lastResultAllPassed") is not True:
        reasons.append("last_result_not_all_passed")
    if counts.get("unexpected", 0) > 0:
        reasons.append("matched_test_unexpected")
    if counts.get("skipped", 0) > 0:
        reasons.append("matched_test_skipped")
    if process_exit_code != 0:
        reasons.append("playwright_process_nonzero")
    return "FAIL", 1, reasons


def _read_result_context(feature_dir: Path, case_id: str) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    result = load_json_object(feature_dir / "E2E_RESULT.json", "E2E_RESULT.json")
    current = result.get("currentRound")
    if not isinstance(current, dict) or not isinstance(current.get("index"), int):
        raise E2ECommandError(
            "currentRound 缺失。修复：先运行 e2e_result_writer.py begin-round。"
        )
    case = next(
        (
            item
            for item in result.get("cases", [])
            if isinstance(item, dict) and item.get("caseId") == case_id
        ),
        None,
    )
    if case is None:
        raise E2ECommandError(
            "caseId 未登记：{}。修复：先使用 e2e_result_writer.py add-case。".format(case_id)
        )
    quality = result.get("qualityGate")
    if not isinstance(quality, dict):
        raise E2ECommandError(
            "qualityGate 未同步。修复：完成 scan/resolve 后运行 sync-quality-gate。"
        )
    scan, scan_errors = validate_scan_current(feature_dir, quality)
    if scan_errors or scan is None:
        raise E2ECommandError(
            "quality_gate_invalid:{}。修复：重新扫描、裁定并 sync-quality-gate。".format(
                ",".join(scan_errors)
            )
        )
    return result, current, case


def _pending_path(feature_dir: Path, round_index: int, run_id: str) -> Path:
    return feature_dir / DIAGNOSTICS_DIR / "round-{}".format(round_index) / "{}.pending.json".format(run_id)


def _diagnostic_relative(round_index: int, name: str) -> str:
    return "{}/round-{}/{}".format(DIAGNOSTICS_DIR, round_index, name)


def _load_log_for_append(path: Path) -> Tuple[List[Dict[str, Any]], bool]:
    if not path.is_file() or path.stat().st_size == 0:
        return [], False
    content = path.read_bytes()
    if content.lstrip()[:1] not in {b"{", b"["}:
        raise E2ECommandError(
            "legacy_e2e_log_read_only。修复：保留旧日志归档，开启新轮并重新执行受影响用例。"
        )
    repaired = False
    if not content.endswith(b"\n"):
        cutoff = content.rfind(b"\n")
        content = content[: cutoff + 1] if cutoff >= 0 else b""
        path.write_bytes(content)
        repaired = True
    try:
        decoded_lines = content.decode("utf-8", errors="strict").splitlines(keepends=True)
    except UnicodeDecodeError as exc:
        raise E2ECommandError(
            "e2e_run_log_invalid_utf8:{}。修复：人工恢复损坏的 JSONL 字节。".format(exc)
        )
    nonempty_indexes = [
        index for index, raw in enumerate(decoded_lines) if raw.strip()
    ]
    if nonempty_indexes:
        tail_index = nonempty_indexes[-1]
        try:
            json.loads(decoded_lines[tail_index])
        except ValueError:
            content = "".join(decoded_lines[:tail_index]).encode("utf-8")
            path.write_bytes(content)
            decoded_lines = decoded_lines[:tail_index]
            repaired = True
    records: List[Dict[str, Any]] = []
    for line_no, raw in enumerate(decoded_lines, 1):
        if not raw.strip():
            continue
        try:
            value = json.loads(raw)
        except ValueError:
            raise E2ECommandError(
                "e2e_run_log_corrupt_non_tail:line={}。修复：人工恢复该非末尾 JSONL 记录。".format(
                    line_no
                )
            )
        if not isinstance(value, dict):
            raise E2ECommandError(
                "e2e_run_log_non_object:line={}。修复：人工恢复 JSON object 行。".format(line_no)
            )
        records.append(value)
    return records, repaired


def _append_log_record(path: Path, record: Dict[str, Any]) -> bool:
    records, repaired = _load_log_for_append(path)
    same = [item for item in records if item.get("kind") == "verdict_run" and item.get("runId") == record.get("runId")]
    if len(same) > 1:
        raise E2ECommandError(
            "duplicate_e2e_log_run_id:{}。修复：人工恢复重复日志行。".format(record.get("runId"))
        )
    if same:
        if same[0] != record:
            raise E2ECommandError(
                "e2e_log_run_id_payload_mismatch:{}。修复：保留 pending 中的执行器事实。".format(
                    record.get("runId")
                )
            )
        return repaired
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return repaired


def _existing_evidence_for_run(feature_dir: Path, run_id: str) -> List[Dict[str, Any]]:
    try:
        records = read_records(stream_path(feature_dir))
    except EvidenceStoreError as exc:
        raise E2ECommandError(
            "Evidence 流不可读：{}。修复：恢复 Evidence 索引与流一致性。".format(exc)
        )
    return [
        record
        for record in records
        if isinstance(record.get("e2eRun"), dict) and record["e2eRun"].get("runId") == run_id
    ]


def _commit_pending(workspace: Path, feature: str, pending_path: Path) -> Dict[str, Any]:
    feature_dir = _feature_dir(workspace, feature)
    pending = load_json_object(pending_path, "E2E pending")
    run_id = pending.get("runId")
    if not isinstance(run_id, str) or not RUN_ID_RE.fullmatch(run_id):
        raise E2ECommandError(
            "pending runId 无效。修复：使用执行器产生的 pending 文件。"
        )
    expected_execution = pending.get("execution")
    expected_evidence = pending.get("evidenceRecord")
    expected_log = pending.get("logRecord")
    if not all(isinstance(value, dict) for value in (expected_execution, expected_evidence, expected_log)):
        raise E2ECommandError(
            "pending payload 不完整。修复：保留诊断并重新执行受影响 case。"
        )
    pending_errors = validate_execution_evidence_chain(
        expected_execution,
        expected_evidence,
        pending.get("caseId"),
        expected_log.get("taskId"),
        expected_log.get("specRefs"),
    )
    pending_errors.extend(
        validate_execution_log_chain(
            expected_execution,
            None,
            expected_log,
            pending.get("caseId"),
            expected_log.get("taskId"),
            expected_log.get("specRefs"),
        )
    )
    if pending_errors:
        raise E2ECommandError(
            "e2e_pending_payload_mismatch:{}。修复：保留诊断并重新执行受影响 case。".format(
                ",".join(pending_errors)
            )
        )
    with FileLock(feature_dir / DIAGNOSTICS_DIR / "e2e-run.lock"):
        result_data = load_json_object(feature_dir / "E2E_RESULT.json", "E2E_RESULT.json")
        current_case = next(
            (
                item
                for item in result_data.get("cases", [])
                if isinstance(item, dict) and item.get("caseId") == pending.get("caseId")
            ),
            None,
        )
        if (
            current_case is None
            or current_case.get("taskId") != expected_log.get("taskId")
            or current_case.get("specRefs") != expected_log.get("specRefs")
        ):
            raise E2ECommandError(
                "e2e_pending_case_trace_mismatch。修复：恢复执行时的 case/task/spec 追溯后再 resume。"
            )
        matches = _existing_evidence_for_run(feature_dir, run_id)
        if len(matches) > 1:
            ids = ",".join(str(item.get("evidenceId")) for item in matches)
            raise E2ECommandError(
                "duplicate_e2e_evidence_run_id:{} ids={}。修复：人工恢复重复 Evidence。".format(
                    run_id, ids
                )
            )
        if matches:
            evidence = matches[0]
            expected_record = pending.get("evidenceRecord")
            expected_run = (
                expected_record.get("e2eRun")
                if isinstance(expected_record, dict)
                and isinstance(expected_record.get("e2eRun"), dict)
                else {}
            )
            actual_run = evidence.get("e2eRun") if isinstance(evidence.get("e2eRun"), dict) else {}
            if actual_run != expected_run:
                raise E2ECommandError(
                    "e2e_evidence_run_id_payload_mismatch:{}。修复：人工恢复与 pending 一致的 Evidence。".format(
                        run_id
                    )
                )
        else:
            try:
                evidence = append_evidence(
                    feature_dir,
                    dict(pending["evidenceRecord"]),
                    output_tail=str(pending.get("outputTail", "")),
                )
            except EvidenceStoreError as exc:
                raise E2ECommandError(
                    "Evidence 写入失败：{}。修复：恢复 Evidence 后运行 resume --run-id {}。".format(
                        exc, run_id
                    )
                )
        evidence_id = str(evidence.get("evidenceId"))
        log_record = dict(pending["logRecord"])
        log_record["evidenceId"] = evidence_id
        execution = dict(pending["execution"])
        execution["evidenceId"] = evidence_id
        evidence_chain_errors = validate_execution_evidence_chain(
            execution,
            evidence,
            pending.get("caseId"),
            log_record.get("taskId"),
            log_record.get("specRefs"),
        )
        if evidence_chain_errors:
            raise E2ECommandError(
                "e2e_pending_evidence_chain_mismatch:{}。修复：人工恢复与 pending 一致的 Evidence。".format(
                    ",".join(evidence_chain_errors)
                )
            )
        repaired = _append_log_record(feature_dir / "e2e-run.log", log_record)
        if repaired:
            pending.setdefault("repairs", []).append(
                {"kind": "truncated_partial_log_tail", "repairedAt": utc_now()}
            )
            atomic_write_json(pending_path, pending)
        record_execution(workspace, feature, str(pending["caseId"]), execution)
        try:
            pending_path.unlink()
        except FileNotFoundError:
            pass
    return {
        "ok": execution.get("result") == "PASS",
        "runId": run_id,
        "caseId": pending.get("caseId"),
        "result": execution.get("result"),
        "processExitCode": execution.get("processExitCode"),
        "gateExitCode": execution.get("gateExitCode"),
        "evidenceId": evidence_id,
        "resultPath": str(feature_dir / "E2E_RESULT.json"),
        "logPath": str(feature_dir / "e2e-run.log"),
    }


def execute_e2e_command(
    workspace: Path,
    feature: str,
    code_workspace: Path,
    argv: Sequence[str],
    case_id: str,
    task_id: str,
    spec_refs: Sequence[str],
    spec_paths: Sequence[str],
    cwd: Optional[str] = None,
    entry_url: Optional[str] = None,
    auth_status: str = "not_required",
    browser_annotation: Optional[str] = None,
    timeout: int = 900,
) -> Dict[str, Any]:
    if not isinstance(timeout, int) or timeout <= 0:
        raise E2ECommandError("timeout 必须为正整数。修复：传入正秒数。")
    if not task_id.strip() or not spec_refs:
        raise E2ECommandError(
            "task-id 与 spec-ref 必填。修复：传入 E2E case 的追溯引用。"
        )
    if auth_status not in {"bypassed", "pre_authenticated", "not_required", "failed", "not_verified"}:
        raise E2ECommandError(
            "auth-status 无效。修复：使用 bypassed/pre_authenticated/not_required/failed/not_verified。"
        )
    artifact_workspace = resolve_workspace(workspace)
    resolved_feature = resolve_feature(feature)
    feature_dir = _feature_dir(artifact_workspace, resolved_feature)
    _, current, case = _read_result_context(feature_dir, case_id)
    if case.get("taskId") != task_id or list(case.get("specRefs", [])) != list(spec_refs):
        raise E2ECommandError(
            "case/task/spec 追溯与 E2E_RESULT 不一致。修复：使用已登记 case 的精确 taskId/specRefs。"
        )
    code_root, command_cwd = _resolve_command_cwd(Path(code_workspace), cwd)
    scan = load_json_object(scan_path(feature_dir), "E2E_QUALITY_SCAN.json")
    if scan.get("codeWorkspace") != str(code_root):
        raise E2ECommandError(
            "扫描 workspace 与执行 workspace 不一致。修复：在当前被测仓库重新扫描。"
        )
    scanned = {
        item.get("path"): item.get("sha256")
        for item in scan.get("scannedInputs", [])
        if isinstance(item, dict)
    }
    declared_specs: Dict[str, str] = {}
    for raw in spec_paths:
        relative, path = normalize_relative_path(code_root, raw, "spec path")
        if not path.is_file():
            raise E2ECommandError(
                "spec 不存在：{}。修复：重新生成测试资产并扫描。".format(path)
            )
        digest = sha256_path(path)
        if scanned.get(relative) != digest:
            raise E2ECommandError(
                "spec 未被当前质量扫描覆盖：{}。修复：重新运行 scan/resolve/sync。".format(relative)
            )
        declared_specs[relative] = digest
    if not declared_specs:
        raise E2ECommandError(
            "至少需要一个 --spec-path。修复：声明本次 verdict 使用的持久化 spec。"
        )
    parsed = parse_playwright_command(argv)
    _reject_empty_run_flags(parsed)
    version = _playwright_version(parsed, command_cwd, timeout)
    config_path, config_hash, config_source = _config_info(code_root, command_cwd, parsed)
    if config_source == "config_file" and scanned.get(config_path) != config_hash:
        raise E2ECommandError(
            "Playwright config 未被当前质量扫描覆盖。修复：重新 scan/resolve/sync。"
        )
    run_id = "run-{}-{}".format(current["index"], uuid.uuid4().hex[:12])
    diagnostics = feature_dir / DIAGNOSTICS_DIR / "round-{}".format(current["index"])
    diagnostics.mkdir(parents=True, exist_ok=True)
    report_relative = _diagnostic_relative(current["index"], "report-{}.json".format(run_id))
    report_path = feature_dir / report_relative
    command_argv, reporter_argument = inject_json_reporter(parsed)
    child_env = dict(os.environ)
    child_env["PLAYWRIGHT_JSON_OUTPUT_FILE"] = str(report_path.resolve())
    child_env.pop("PLAYWRIGHT_JSON_OUTPUT_DIR", None)
    child_env.pop("PLAYWRIGHT_JSON_OUTPUT_NAME", None)
    started_at = utc_now()
    process_code, stdout, stderr, process_blocked = _run(
        command_argv, command_cwd, timeout, env=child_env
    )
    finished_at = utc_now()
    report: Dict[str, Any] = {}
    report_errors: List[str] = []
    report_hash: Optional[str] = None
    if not report_path.is_file():
        report_errors.append(
            "report_missing:{} reporter={}".format(report_path.resolve(), reporter_argument)
        )
    else:
        report_hash = sha256_path(report_path)
        try:
            report = load_json_object(report_path, "Playwright JSON report")
        except ValueError as exc:
            report_errors.append("invalid_playwright_json_report:{}".format(exc))
    facts: Dict[str, Any] = {}
    if report:
        facts, fact_errors = _report_facts(report, code_root, declared_specs, case_id)
        report_errors.extend(fact_errors)
    result, gate_exit_code, reasons = _derive_result(
        process_code, process_blocked, facts, report_errors
    )
    report_record = {"path": report_relative, "sha256": report_hash}
    browser = (
        {"text": browser_annotation, "source": "skill_declared"}
        if browser_annotation
        else None
    )
    diagnostic_paths = _collect_report_diagnostics(
        report,
        case_id,
        code_root,
        command_cwd,
        diagnostics,
        current["index"],
        run_id,
        report_relative if report_path.is_file() else None,
    )
    execution: Dict[str, Any] = {
        "runId": run_id,
        "roundIndex": current["index"],
        "executionPhase": "verdict",
        "executionAdapter": "playwright_test",
        "result": result,
        "codeWorkspace": str(code_root),
        "cwd": str(command_cwd),
        "specPaths": sorted(declared_specs),
        "specHashes": declared_specs,
        "configPath": config_path,
        "configSha256": config_hash,
        "configSource": config_source,
        "playwrightVersion": version,
        "playwrightVersionSource": "cli",
        "declaredPackages": parsed["declaredPackages"],
        "command": shell_join(command_argv),
        "processExitCode": process_code,
        "gateExitCode": gate_exit_code,
        "report": report_record,
        "caseBinding": facts.get("caseBinding", {}),
        "projects": facts.get("projects", []),
        "reportStats": facts.get("reportStats", {}),
        "browserAnnotation": browser,
        "entryUrl": entry_url,
        "authStatus": auth_status,
        "diagnosticPaths": diagnostic_paths,
        "reasons": reasons,
        "evidenceId": None,
        "startedAt": started_at,
        "finishedAt": finished_at,
    }
    e2e_run = {
        key: execution[key]
        for key in (
            "runId",
            "roundIndex",
            "result",
            "processExitCode",
            "specPaths",
            "specHashes",
            "configPath",
            "configSha256",
            "configSource",
            "report",
            "caseBinding",
            "projects",
            "executionAdapter",
            "playwrightVersion",
        )
    }
    e2e_run["caseId"] = case_id
    evidence_record = {
        "featureId": resolved_feature,
        # Final E2E is the V-E2E validation substage owned by Code.  Keep the
        # producer skill for trust validation, but never create a phantom
        # global e2e checkpoint.
        "checkpoint": "code_in_progress",
        "nodeId": "dev.code",
        "batchStage": "e2e_test",
        "skill": "autodev-e2e",
        "taskId": task_id,
        "action": "validation",
        "specRefs": list(spec_refs),
        "designRefs": [],
        "changedFiles": [],
        "validation": {
            "command": execution["command"],
            "exitCode": gate_exit_code,
            "result": "pass"
            if result == "PASS"
            else ("blocked" if result == "BLOCKED" else "fail"),
        },
        "e2eRun": e2e_run,
    }
    output_tail = "\n".join(
        value
        for value in (
            stdout.rstrip(),
            stderr.rstrip(),
            "gate_reasons: {}".format(",".join(reasons)) if reasons else "",
        )
        if value
    ) or "(command produced no output)"
    log_record = {
        "kind": "verdict_run",
        "runId": run_id,
        "caseId": case_id,
        "taskId": task_id,
        "specRefs": list(spec_refs),
        "specHash": declared_specs,
        "command": execution["command"],
        "processExitCode": process_code,
        "gateExitCode": gate_exit_code,
        "result": result,
        "evidenceId": None,
        "roundIndex": current["index"],
        "ts": finished_at,
    }
    pending_path = _pending_path(feature_dir, current["index"], run_id)
    pending = {
        "version": 1,
        "runId": run_id,
        "caseId": case_id,
        "preparedAt": finished_at,
        "evidenceRecord": evidence_record,
        "outputTail": output_tail,
        "logRecord": log_record,
        "execution": execution,
        "repairs": [],
    }
    atomic_write_json(pending_path, pending)
    return _commit_pending(artifact_workspace, resolved_feature, pending_path)


def resume_e2e_command(workspace: Path, feature: str, run_id: str) -> Dict[str, Any]:
    if not RUN_ID_RE.fullmatch(run_id):
        raise E2ECommandError(
            "run-id 无效。修复：使用 pending 文件名中的完整 runId。"
        )
    artifact_workspace = resolve_workspace(workspace)
    resolved_feature = resolve_feature(feature)
    feature_dir = _feature_dir(artifact_workspace, resolved_feature)
    matches = list((feature_dir / DIAGNOSTICS_DIR).glob("round-*/{}.pending.json".format(run_id)))
    if len(matches) != 1:
        raise E2ECommandError(
            "pending_not_unique:{} count={}。修复：确认诊断目录只保留一份该 runId pending。".format(
                run_id, len(matches)
            )
        )
    return _commit_pending(artifact_workspace, resolved_feature, matches[0])


def append_e2e_note(
    workspace: Path, feature: str, phase: str, message: str
) -> Dict[str, Any]:
    artifact_workspace = resolve_workspace(workspace)
    resolved_feature = resolve_feature(feature)
    if not phase.strip() or not message.strip():
        raise E2ECommandError(
            "note 的 phase/text 不能为空。修复：记录探索、服务或鉴权事实。"
        )
    feature_dir = _feature_dir(artifact_workspace, resolved_feature)
    record = {
        "kind": "note",
        "ts": utc_now(),
        "phase": phase.strip(),
        "text": message.strip(),
    }
    with FileLock(feature_dir / DIAGNOSTICS_DIR / "e2e-run.lock"):
        path = feature_dir / "e2e-run.log"
        _load_log_for_append(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    return {"ok": True, "gateExitCode": 0, "logPath": str(path), "note": record}


def _parse_argv_json(raw: str) -> List[str]:
    try:
        value = json.loads(raw)
    except ValueError as exc:
        raise E2ECommandError(
            "--argv-json 不是合法 JSON：{}。修复：传入字符串数组。".format(exc)
        )
    return _validate_argv(value)


def main(argv: Optional[Sequence[str]] = None) -> int:
    raw = list(sys.argv[1:] if argv is None else argv)
    parser = RepairArgumentParser(description="可信执行 Playwright Test verdict")
    sub = parser.add_subparsers(dest="command", required=True)
    run = sub.add_parser("run")
    run.add_argument("--workspace", required=True)
    run.add_argument("--feature", required=True)
    run.add_argument("--code-workspace", required=True)
    run.add_argument("--cwd")
    run.add_argument("--case-id", required=True)
    run.add_argument("--task-id", required=True)
    run.add_argument("--spec-ref", action="append", required=True)
    run.add_argument("--spec-path", action="append", required=True)
    run.add_argument("--entry-url")
    run.add_argument("--auth-status", default="not_required")
    run.add_argument("--browser-annotation")
    run.add_argument("--timeout", type=int, default=900)
    run.add_argument("--argv-json")
    run.add_argument("command_argv", nargs=argparse.REMAINDER)

    resume = sub.add_parser("resume")
    resume.add_argument("--workspace", required=True)
    resume.add_argument("--feature", required=True)
    resume.add_argument("--run-id", required=True)
    note = sub.add_parser("note")
    note.add_argument("--workspace", required=True)
    note.add_argument("--feature", required=True)
    note.add_argument("--phase", required=True)
    note.add_argument("--text", required=True)
    try:
        args = parser.parse_args(raw)
        if args.command == "resume":
            result = resume_e2e_command(Path(args.workspace), args.feature, args.run_id)
        elif args.command == "note":
            result = append_e2e_note(
                Path(args.workspace), args.feature, args.phase, args.text
            )
        else:
            trailing = list(args.command_argv)
            if trailing and trailing[0] == "--":
                trailing = trailing[1:]
            if args.argv_json and trailing:
                raise E2ECommandError(
                    "不能同时传 --argv-json 与尾随 argv。修复：只保留一种输入。"
                )
            command_argv = _parse_argv_json(args.argv_json) if args.argv_json else _validate_argv(trailing)
            result = execute_e2e_command(
                Path(args.workspace),
                args.feature,
                Path(args.code_workspace),
                command_argv,
                args.case_id,
                args.task_id,
                args.spec_ref,
                args.spec_path,
                cwd=args.cwd,
                entry_url=args.entry_url,
                auth_status=args.auth_status,
                browser_annotation=args.browser_annotation,
                timeout=args.timeout,
            )
    except (E2ECommandError, ValueError) as exc:
        print("run_e2e_command_failed: {}".format(exc), file=sys.stderr)
        return 2
    except Exception as exc:
        print(
            "run_e2e_command_failed: {}。修复：保留 pending 与诊断目录，修复产物后运行 resume。".format(
                exc
            ),
            file=sys.stderr,
        )
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=False))
    return int(result.get("gateExitCode", 1))


if __name__ == "__main__":
    raise SystemExit(main())
