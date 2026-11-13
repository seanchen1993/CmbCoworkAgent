#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Deterministic Playwright false-green scan and attributed resolutions."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from hooks.e2e_trust_common import (  # noqa: E402
    QUALITY_SCAN_NAME,
    atomic_write_json,
    load_json_object,
    normalize_relative_path,
    scan_path,
    sha256_path,
)
from hooks.json_writer_common import resolve_feature, resolve_workspace  # noqa: E402


SOURCE_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs")
CONFIG_NAMES = (
    "playwright.config.ts",
    "playwright.config.js",
    "playwright.config.mts",
    "playwright.config.mjs",
    "playwright.config.cts",
    "playwright.config.cjs",
)
IMPORT_RE = re.compile(
    r"(?:\b(?:import|export)\b[^'\"]*?\bfrom\s*|\bimport\s*|\brequire\s*\()"
    r"['\"]([^'\"]+)['\"]"
)
DYNAMIC_IMPORT_RE = re.compile(r"\bimport\s*\(([^)]*)\)")
TEST_START_RE = re.compile(r"\b(?:test|it)\s*\(")
EXPECT_RE = re.compile(r"\bexpect(?:\.[A-Za-z]+)?\s*\(")
LOCATOR_TRUTHY_RE = re.compile(
    r"expect\s*\([^\n]*(?:locator|getByRole|getByLabel|getByPlaceholder|getByTestId)"
    r"[^\n]*\)\s*\.(?:not\.)?(?:toBeTruthy|toBeDefined|toBeNull)\s*\("
)
PLAYWRIGHT_ASSERTION_RE = re.compile(
    r"\bexpect(?:\.[A-Za-z]+)?\s*\([^\n]+\)\s*\."
    r"(?:not\.)?(?:toHave[A-Za-z]+|toBe(?:Visible|Hidden|Enabled|Disabled|Checked|Editable|Focused|Empty|InViewport))\s*\("
)
ACTION_RE = re.compile(
    r"\.(?:click|dblclick|fill|press|check|uncheck|selectOption|hover|focus|blur|"
    r"dragTo|setInputFiles|goto|reload|waitForURL|waitForLoadState)\s*\("
)
STATE_READ_RE = re.compile(
    r"\.(?:isVisible|isHidden|isEnabled|isDisabled|isChecked|isEditable)\s*\("
)
ONLY_RE = re.compile(r"\b(?:test|it|describe)\.only\s*\(")
TEST_FAIL_RE = re.compile(r"\btest\.fail\s*\(")
EMPTY_CATCH_RE = re.compile(r"\bcatch\s*(?:\([^)]*\))?\s*\{\s*(?:return\s*;?)?\s*\}", re.DOTALL)
PROMISE_SWALLOW_RE = re.compile(r"\.catch\s*\(\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{\s*\}\s*\)")


class QualityCheckError(ValueError):
    pass


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise QualityCheckError(
            "命令参数无效：{}。修复：运行 `{} --help` 并补齐参数。".format(
                message, self.prog
            )
        )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _line_at(text: str, line: int) -> str:
    lines = text.splitlines()
    return lines[line - 1].strip() if 0 < line <= len(lines) else ""


def _finding_id(rule: str, path: str, snippet: str) -> str:
    normalized = " ".join(snippet.split())
    digest = hashlib.sha256((path + "\0" + normalized).encode("utf-8")).hexdigest()[:12]
    return "{}-{}".format(rule.replace(":", "-"), digest)


def _finding(rule: str, tier: str, path: str, line: int, snippet: str) -> Dict[str, Any]:
    return {
        "findingId": _finding_id(rule, path, snippet),
        "tier": tier,
        "rule": rule,
        "path": path,
        "line": line,
        "snippet": snippet[:500],
        "status": "candidate",
        "reviewer": None,
        "rationale": None,
        "reviewedAt": None,
    }


def _mask_comments(text: str) -> str:
    output: List[str] = []
    quote = ""
    escaped = False
    line_comment = False
    block_comment = False
    index = 0
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
                output.append(char)
            else:
                output.append(" ")
            index += 1
            continue
        if block_comment:
            if char == "*" and next_char == "/":
                output.extend((" ", " "))
                block_comment = False
                index += 2
                continue
            output.append("\n" if char == "\n" else " ")
            index += 1
            continue
        if quote:
            output.append(char)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
            output.append(char)
            index += 1
            continue
        if char == "/" and next_char == "/":
            output.extend((" ", " "))
            line_comment = True
            index += 2
            continue
        if char == "/" and next_char == "*":
            output.extend((" ", " "))
            block_comment = True
            index += 2
            continue
        output.append(char)
        index += 1
    return "".join(output)


def _has_await_before(line: str, match_start: int) -> bool:
    prefix = line[:match_start]
    return bool(re.search(r"\bawait\s*$", prefix))


def _statement_prefix(line: str, match_start: int) -> str:
    prefix = line[:match_start]
    boundary = max(prefix.rfind(";"), prefix.rfind("{"), prefix.rfind("}"))
    return prefix[boundary + 1 :]


def _delimiter_end(
    text: str, opening: int, open_character: str, close_character: str
) -> Optional[int]:
    depth = 0
    quote = ""
    escaped = False
    line_comment = False
    block_comment = False
    index = opening
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
            index += 1
            continue
        if block_comment:
            if char == "*" and next_char == "/":
                block_comment = False
                index += 2
                continue
            index += 1
            continue
        if quote:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = ""
            index += 1
            continue
        if char in ("'", '"', "`"):
            quote = char
        elif char == "/" and next_char == "/":
            line_comment = True
            index += 2
            continue
        elif char == "/" and next_char == "*":
            block_comment = True
            index += 2
            continue
        elif char == open_character:
            depth += 1
        elif char == close_character:
            depth -= 1
            if depth == 0:
                return index
        index += 1
    return None


def _brace_end(text: str, opening: int) -> Optional[int]:
    return _delimiter_end(text, opening, "{", "}")


def _paren_end(text: str, opening: int) -> Optional[int]:
    return _delimiter_end(text, opening, "(", ")")


def _test_blocks(text: str) -> List[Tuple[int, int]]:
    result: List[Tuple[int, int]] = []
    for match in TEST_START_RE.finditer(text):
        prefix = text[max(0, match.start() - 14) : match.start()]
        if re.search(r"(?:describe|beforeEach|afterEach)\s*\.\s*$", prefix):
            continue
        arrow = text.find("=>", match.end())
        function = text.find("function", match.end())
        if arrow < 0 and function < 0:
            continue
        body_marker = arrow + 2 if arrow >= 0 and (function < 0 or arrow < function) else function + len("function")
        opening = text.find("{", body_marker)
        if arrow >= 0 and (function < 0 or arrow < function):
            expression_start = body_marker
            while expression_start < len(text) and text[expression_start].isspace():
                expression_start += 1
            if expression_start >= len(text) or text[expression_start] != "{":
                line_end = text.find("\n", expression_start)
                statement_end = text.find(";", expression_start)
                candidates = [value for value in (line_end, statement_end) if value >= 0]
                end = min(candidates) + 1 if candidates else len(text)
                result.append((match.start(), end))
                continue
        if opening < 0:
            continue
        closing = _brace_end(text, opening)
        if closing is not None:
            result.append((match.start(), closing + 1))
    return result


def scan_source(path: str, text: str) -> List[Dict[str, Any]]:
    findings: List[Dict[str, Any]] = []
    seen: Set[str] = set()

    def add(rule: str, tier: str, line: int, snippet: str) -> None:
        finding = _finding(rule, tier, path, line, snippet)
        if finding["findingId"] not in seen:
            seen.add(str(finding["findingId"]))
            findings.append(finding)

    scan_text = _mask_comments(text)
    raw_lines = text.splitlines()
    for line_no, line in enumerate(scan_text.splitlines(), 1):
        raw_line = raw_lines[line_no - 1] if line_no <= len(raw_lines) else ""
        if LOCATOR_TRUTHY_RE.search(line):
            add("locator-truthy", "blocker", line_no, raw_line.strip())
        for assertion in PLAYWRIGHT_ASSERTION_RE.finditer(line):
            if not _has_await_before(line, assertion.start()):
                add("no-await", "blocker", line_no, raw_line.strip())
        for action in ACTION_RE.finditer(line):
            if not re.search(r"\bawait\b", _statement_prefix(line, action.start())):
                add("no-await", "blocker", line_no, raw_line.strip())
        for state_read in STATE_READ_RE.finditer(line):
            prefix = _statement_prefix(line, state_read.start())
            if not re.search(r"(?:\breturn\s+|\bif\s*\(|\bwhile\s*\(|=|\bexpect\s*\()", prefix):
                add("discarded-state-read", "blocker", line_no, raw_line.strip())
        if ONLY_RE.search(line):
            add("only-leak", "blocker", line_no, raw_line.strip())
        if TEST_FAIL_RE.search(line):
            add("expected-failure", "blocker", line_no, raw_line.strip())

    for match in EMPTY_CATCH_RE.finditer(scan_text):
        line = _line_number(scan_text, match.start())
        add("swallowed-exception", "blocker", line, _line_at(text, line))
    for match in PROMISE_SWALLOW_RE.finditer(scan_text):
        line = _line_number(scan_text, match.start())
        add("swallowed-exception", "blocker", line, _line_at(text, line))

    conditional_ranges: List[Tuple[int, int]] = []
    for match in re.finditer(r"\bif\s*\(", scan_text):
        condition_open = scan_text.find("(", match.start(), match.end())
        condition_close = _paren_end(scan_text, condition_open) if condition_open >= 0 else None
        opening = -1
        if condition_close is not None:
            remainder = scan_text[condition_close + 1 :]
            whitespace = len(remainder) - len(remainder.lstrip())
            candidate = condition_close + 1 + whitespace
            if candidate < len(scan_text) and scan_text[candidate] == "{":
                opening = candidate
        closing = _brace_end(scan_text, opening) if opening >= 0 else None
        if closing is not None:
            conditional_ranges.append((opening, closing))
    for match in EXPECT_RE.finditer(scan_text):
        if any(start < match.start() < end for start, end in conditional_ranges):
            line = _line_number(scan_text, match.start())
            add("conditional-assertion", "blocker", line, _line_at(text, line))

    for start, end in _test_blocks(scan_text):
        body = scan_text[start:end]
        if not EXPECT_RE.search(body):
            line = _line_number(text, start)
            add("zero-assertion", "blocker", line, _line_at(text, line))
    return findings


def _candidate_files(path: Path) -> Iterable[Path]:
    if path.is_file():
        yield path
        return
    for candidate in sorted(path.rglob("*")) if path.is_dir() else []:
        if candidate.is_file():
            parts = set(candidate.parts)
            if not parts.intersection({"node_modules", ".git", "dist", "build"}):
                yield candidate


def _load_tsconfig(code_root: Path) -> Tuple[Path, Dict[str, Any], Optional[str]]:
    path = code_root / "tsconfig.json"
    if not path.is_file():
        return code_root, {}, None
    try:
        raw = _mask_comments(path.read_text(encoding="utf-8"))
        raw = re.sub(r",\s*([}\]])", r"\1", raw)
        data = json.loads(raw)
    except (OSError, ValueError):
        return code_root, {}, "tsconfig_unparseable"
    compiler = data.get("compilerOptions") if isinstance(data, dict) else None
    if not isinstance(compiler, dict):
        return code_root, {}, None
    base = compiler.get("baseUrl", ".")
    base_root = (code_root / str(base)).resolve()
    paths = compiler.get("paths")
    return base_root, paths if isinstance(paths, dict) else {}, None


def _resolve_file(base: Path) -> Optional[Path]:
    candidates = [base]
    if not base.suffix:
        candidates.extend(Path(str(base) + suffix) for suffix in SOURCE_SUFFIXES)
        candidates.extend(base / ("index" + suffix) for suffix in SOURCE_SUFFIXES)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _resolve_import(
    source: Path,
    specifier: str,
    code_root: Path,
    base_root: Path,
    paths: Dict[str, Any],
) -> Tuple[Optional[Path], Optional[str], Optional[Path]]:
    if specifier.startswith("."):
        candidate = (source.parent / specifier).resolve()
        resolved = _resolve_file(candidate)
        return resolved, None if resolved else "relative_unresolved", candidate
    for pattern, targets in paths.items():
        if not isinstance(pattern, str) or not isinstance(targets, list):
            continue
        if "*" in pattern:
            before, after = pattern.split("*", 1)
            if not specifier.startswith(before) or not specifier.endswith(after):
                continue
            wildcard = specifier[len(before) : len(specifier) - len(after) if after else None]
        elif specifier == pattern:
            wildcard = ""
        else:
            continue
        for target in targets:
            if not isinstance(target, str):
                continue
            candidate = (base_root / target.replace("*", wildcard)).resolve()
            resolved = _resolve_file(candidate)
            if resolved is not None:
                return resolved, None, None
        return None, "alias_unresolved", candidate if "candidate" in locals() else base_root
    if specifier.startswith("@/"):
        candidate = (base_root / specifier[2:]).resolve()
        resolved = _resolve_file(candidate)
        return resolved, None if resolved else "alias_unresolved", candidate
    # Bare package imports are external dependencies, not local blind spots.
    return None, None, None


def _covered_by_input_dir(path: Path, input_dirs: Sequence[Path]) -> bool:
    for directory in input_dirs:
        try:
            path.resolve().relative_to(directory.resolve())
            return True
        except ValueError:
            continue
    return False


def _covered_by_explicit_input(path: Path, explicit_inputs: Sequence[Path]) -> bool:
    candidate = str(path.resolve())
    for explicit in explicit_inputs:
        resolved = str(explicit.resolve())
        if resolved == candidate or resolved.startswith(candidate + "."):
            return True
    return False


def _role(path: Path, specs: Set[Path], config: Optional[Path]) -> str:
    if path in specs:
        return "spec"
    if config is not None and path == config:
        return "config"
    lowered = path.name.lower()
    if "fixture" in lowered or "auth" in lowered or "setup" in lowered:
        return "fixture"
    if "page" in lowered:
        return "page_object"
    return "helper"


def _discover_inputs(
    code_root: Path,
    spec_paths: Sequence[Path],
    explicit_inputs: Sequence[Path],
    input_dirs: Sequence[Path],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    base_root, aliases, tsconfig_error = _load_tsconfig(code_root)
    config = next((code_root / name for name in CONFIG_NAMES if (code_root / name).is_file()), None)
    specs = set(path.resolve() for path in spec_paths)
    explicit_resolved = [path.resolve() for path in explicit_inputs]
    config_resolved = config.resolve() if config is not None else None
    queue = list(specs)
    if config_resolved is not None:
        queue.append(config_resolved)
    discovered: Set[Path] = set(queue)
    unresolved: List[Dict[str, Any]] = []
    if tsconfig_error:
        unresolved.append(
            {
                "from": "tsconfig.json",
                "specifier": "compilerOptions.paths",
                "reason": tsconfig_error,
            }
        )
    while queue:
        source = queue.pop(0)
        try:
            text = source.read_text(encoding="utf-8")
        except OSError:
            continue
        import_specifiers = list(IMPORT_RE.findall(text))
        for dynamic in DYNAMIC_IMPORT_RE.finditer(text):
            argument = dynamic.group(1).strip()
            literal = re.fullmatch(r"['\"]([^'\"]+)['\"]", argument)
            if literal:
                import_specifiers.append(literal.group(1))
            elif not _covered_by_input_dir(source, input_dirs) and not explicit_resolved:
                unresolved.append(
                    {
                        "from": source.relative_to(code_root).as_posix(),
                        "specifier": argument[:200],
                        "reason": "dynamic_import_non_literal",
                    }
                )
        for specifier in dict.fromkeys(import_specifiers):
            resolved, reason, blind_path = _resolve_import(
                source, specifier, code_root, base_root, aliases
            )
            if resolved is not None:
                try:
                    resolved.relative_to(code_root)
                except ValueError:
                    if not _covered_by_input_dir(resolved, input_dirs):
                        unresolved.append(
                            {
                                "from": source.relative_to(code_root).as_posix(),
                                "specifier": specifier,
                                "reason": "import_outside_workspace",
                            }
                        )
                    continue
                if resolved not in discovered:
                    discovered.add(resolved)
                    queue.append(resolved)
            elif reason and not (
                blind_path is not None
                and (
                    _covered_by_input_dir(blind_path, input_dirs)
                    or _covered_by_explicit_input(blind_path, explicit_resolved)
                )
            ):
                unresolved.append(
                    {
                        "from": source.relative_to(code_root).as_posix(),
                        "specifier": specifier,
                        "reason": reason,
                    }
                )
    discovered.update(path.resolve() for path in explicit_inputs)
    for directory in input_dirs:
        discovered.update(path.resolve() for path in _candidate_files(directory))

    entries: List[Dict[str, Any]] = []
    explicit_set = set(explicit_resolved)
    input_dir_files: Set[Path] = set()
    for directory in input_dirs:
        input_dir_files.update(path.resolve() for path in _candidate_files(directory))
    for path in sorted(discovered):
        relative = path.relative_to(code_root).as_posix()
        if path in explicit_set:
            role = "reviewed_source"
        elif path in input_dir_files and path not in specs:
            role = "conservative_input"
        else:
            role = _role(path, specs, config.resolve() if config else None)
        entries.append({"path": relative, "role": role, "sha256": sha256_path(path)})
    unique_unresolved = []
    seen_unresolved = set()
    for entry in unresolved:
        key = (entry["from"], entry["specifier"], entry["reason"])
        if key not in seen_unresolved:
            seen_unresolved.add(key)
            unique_unresolved.append(entry)
    return entries, unique_unresolved


def _gate_fields(payload: Dict[str, Any]) -> None:
    findings = payload.get("findings") if isinstance(payload.get("findings"), list) else []
    counts = {"blocker": 0, "major": 0, "minor": 0}
    unresolved_blockers = 0
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        tier = finding.get("tier")
        if tier in counts:
            counts[str(tier)] += 1
        if tier == "blocker" and finding.get("status") in {"candidate", "confirmed"}:
            unresolved_blockers += 1
    payload["counts"] = counts
    payload["unresolvedBlockers"] = unresolved_blockers
    unresolved_imports = payload.get("unresolvedImports")
    payload["passed"] = unresolved_blockers == 0 and isinstance(unresolved_imports, list) and not unresolved_imports


def scan(
    workspace: Path,
    feature: str,
    code_workspace: Path,
    spec_paths: Sequence[str],
    inputs: Sequence[str],
    input_dirs: Sequence[str],
) -> Dict[str, Any]:
    code_root = code_workspace.expanduser().resolve()
    if not code_root.is_dir():
        raise QualityCheckError(
            "code-workspace 不存在或不是目录：{}。修复：传入被测仓库根目录。".format(code_root)
        )
    resolved_specs: List[Path] = []
    for raw in spec_paths:
        _, path = normalize_relative_path(code_root, raw, "spec path")
        if not path.is_file():
            raise QualityCheckError(
                "spec 不存在：{}。修复：传入实际 Playwright spec 路径。".format(path)
            )
        resolved_specs.append(path)
    if not resolved_specs:
        raise QualityCheckError(
            "至少需要一个 --spec-path。修复：传入本次 verdict 要执行的 Playwright spec。"
        )
    explicit: List[Path] = []
    for raw in inputs:
        _, path = normalize_relative_path(code_root, raw, "input")
        if not path.is_file():
            raise QualityCheckError(
                "input 不存在：{}。修复：传入语义审查实际读取的文件。".format(path)
            )
        explicit.append(path)
    directories: List[Path] = []
    for raw in input_dirs:
        _, path = normalize_relative_path(code_root, raw, "input dir")
        if not path.is_dir():
            raise QualityCheckError(
                "input-dir 不存在：{}。修复：传入用于保守哈希的目录。".format(path)
            )
        directories.append(path)

    feature_dir = _feature_dir(workspace, feature)
    path = scan_path(feature_dir)
    previous: Dict[str, Any] = {}
    if path.is_file():
        try:
            previous = load_json_object(path, QUALITY_SCAN_NAME)
        except ValueError:
            previous = {}
    previous_inputs = {
        entry.get("path"): entry.get("sha256")
        for entry in previous.get("scannedInputs", [])
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    previous_findings = {
        entry.get("findingId"): entry
        for entry in previous.get("findings", [])
        if isinstance(entry, dict) and isinstance(entry.get("findingId"), str)
    }
    scanned_inputs, unresolved = _discover_inputs(
        code_root, resolved_specs, explicit, directories
    )
    scanned_paths = {
        entry.get("path")
        for entry in scanned_inputs
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }
    for old in previous_findings.values():
        if not isinstance(old, dict) or not str(old.get("rule", "")).startswith("semantic:"):
            continue
        relative = old.get("path")
        if not isinstance(relative, str) or relative in scanned_paths:
            continue
        try:
            normalized, source = normalize_relative_path(code_root, relative, "semantic input")
        except ValueError:
            unresolved.append(
                {"from": relative, "specifier": relative, "reason": "semantic_input_outside_workspace"}
            )
            continue
        if not source.is_file():
            unresolved.append(
                {"from": normalized, "specifier": normalized, "reason": "semantic_input_missing"}
            )
            continue
        scanned_inputs.append(
            {"path": normalized, "role": "reviewed_source", "sha256": sha256_path(source)}
        )
        scanned_paths.add(normalized)
    scanned_inputs.sort(key=lambda entry: str(entry.get("path", "")))
    current_hashes = {entry["path"]: entry["sha256"] for entry in scanned_inputs}
    findings: List[Dict[str, Any]] = []
    for spec in resolved_specs:
        relative = spec.relative_to(code_root).as_posix()
        text = spec.read_text(encoding="utf-8", errors="replace")
        for finding in scan_source(relative, text):
            old = previous_findings.get(finding["findingId"])
            if (
                isinstance(old, dict)
                and old.get("status") in {"confirmed", "dismissed"}
                and previous_inputs.get(relative) == current_hashes.get(relative)
            ):
                for field in ("status", "reviewer", "rationale", "reviewedAt"):
                    finding[field] = old.get(field)
            findings.append(finding)
    # Preserve manually-added semantic findings while their source input is unchanged.
    for old in previous_findings.values():
        if not isinstance(old, dict) or not str(old.get("rule", "")).startswith("semantic:"):
            continue
        relative = old.get("path")
        copied = dict(old)
        if previous_inputs.get(relative) != current_hashes.get(relative):
            copied.update(
                {"status": "candidate", "reviewer": None, "rationale": None, "reviewedAt": None}
            )
        findings.append(copied)
    payload: Dict[str, Any] = {
        "version": 1,
        "codeWorkspace": str(code_root),
        "scannedAt": utc_now(),
        "scannedInputs": scanned_inputs,
        "unresolvedImports": unresolved,
        "findings": findings,
    }
    _gate_fields(payload)
    atomic_write_json(path, payload)
    return payload


def resolve(
    workspace: Path,
    feature: str,
    finding_id: Optional[str],
    status: str,
    reviewer: str,
    rationale: str,
    inputs: Sequence[str],
    rule: Optional[str],
    tier: str,
    source_path: Optional[str],
    line: Optional[int],
    snippet: Optional[str],
) -> Dict[str, Any]:
    feature_dir = _feature_dir(workspace, feature)
    path = scan_path(feature_dir)
    payload = load_json_object(path, QUALITY_SCAN_NAME)
    code_root_raw = payload.get("codeWorkspace")
    if not isinstance(code_root_raw, str):
        raise QualityCheckError(
            "扫描产物缺少 codeWorkspace。修复：重新运行 scan。"
        )
    code_root = Path(code_root_raw).resolve()
    findings = payload.get("findings")
    if not isinstance(findings, list):
        raise QualityCheckError("findings 结构损坏。修复：重新运行 scan。")
    target: Optional[Dict[str, Any]] = None
    semantic_input: Optional[Tuple[str, Path]] = None
    if finding_id:
        target = next(
            (entry for entry in findings if isinstance(entry, dict) and entry.get("findingId") == finding_id),
            None,
        )
        if target is None:
            raise QualityCheckError(
                "finding 不存在：{}。修复：读取最新扫描产物并使用其中的 findingId。".format(
                    finding_id
                )
            )
    elif rule:
        if not rule.startswith("semantic:"):
            raise QualityCheckError(
                "人工发现 rule 必须以 semantic: 开头。修复：使用 semantic:<name>。"
            )
        if not source_path or not snippet:
            raise QualityCheckError(
                "人工发现需要 --path 与 --snippet。修复：记录问题位置和摘要。"
            )
        relative, source = normalize_relative_path(code_root, source_path, "semantic path")
        if not source.is_file():
            raise QualityCheckError(
                "语义审查文件不存在。修复：传入实际读取的源文件。"
            )
        proposed = _finding(rule, tier, relative, line or 1, snippet)
        target = next(
            (
                entry
                for entry in findings
                if isinstance(entry, dict)
                and entry.get("findingId") == proposed.get("findingId")
            ),
            None,
        )
        if target is None:
            target = proposed
            findings.append(target)
        status = "confirmed"
        semantic_input = (relative, source)
    else:
        raise QualityCheckError(
            "需要 --finding-id 或 --rule。修复：裁定扫描发现，或新增 semantic:<name> 发现。"
        )
    if not reviewer.strip() or not rationale.strip():
        raise QualityCheckError(
            "裁定需要 reviewer 与 rationale。修复：记录署名和非空理由。"
        )
    target.update(
        {
            "status": status,
            "reviewer": reviewer.strip(),
            "rationale": rationale.strip(),
            "reviewedAt": utc_now(),
        }
    )
    scanned_inputs = payload.get("scannedInputs")
    if not isinstance(scanned_inputs, list):
        raise QualityCheckError("scannedInputs 结构损坏。修复：重新运行 scan。")
    by_path = {
        entry.get("path"): entry
        for entry in scanned_inputs
        if isinstance(entry, dict) and isinstance(entry.get("path"), str)
    }

    def add_reviewed_input(relative: str, input_path: Path) -> None:
        existing = by_path.get(relative)
        current_hash = sha256_path(input_path)
        if isinstance(existing, dict):
            if existing.get("sha256") != current_hash:
                raise QualityCheckError(
                    "扫描输入已变化：{}。修复：重新运行 scan，不能用 resolve 刷新旧哈希。".format(
                        relative
                    )
                )
            return
        by_path[relative] = {
            "path": relative,
            "role": "reviewed_source",
            "sha256": current_hash,
        }
    if semantic_input is not None:
        relative, input_path = semantic_input
        add_reviewed_input(relative, input_path)
    for raw in inputs:
        relative, input_path = normalize_relative_path(code_root, raw, "review input")
        if not input_path.is_file():
            raise QualityCheckError(
                "审查输入不存在：{}。修复：传入实际读取的文件。".format(input_path)
            )
        add_reviewed_input(relative, input_path)
    payload["scannedInputs"] = [by_path[key] for key in sorted(by_path)]
    _gate_fields(payload)
    atomic_write_json(path, payload)
    return payload


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = RepairArgumentParser(description="扫描并裁定 Playwright E2E 假绿模式")
    sub = parser.add_subparsers(dest="command", required=True)
    scan_parser = sub.add_parser("scan")
    scan_parser.add_argument("--workspace", required=True)
    scan_parser.add_argument("--feature", required=True)
    scan_parser.add_argument("--code-workspace", required=True)
    scan_parser.add_argument("--spec-path", action="append", required=True)
    scan_parser.add_argument("--input", action="append", default=[])
    scan_parser.add_argument("--input-dir", action="append", default=[])

    resolve_parser = sub.add_parser("resolve")
    resolve_parser.add_argument("--workspace", required=True)
    resolve_parser.add_argument("--feature", required=True)
    resolve_parser.add_argument("--finding-id")
    resolve_parser.add_argument("--status", choices=["confirmed", "dismissed"], default="confirmed")
    resolve_parser.add_argument("--reviewer", required=True)
    resolve_parser.add_argument("--rationale", required=True)
    resolve_parser.add_argument("--input", action="append", default=[])
    resolve_parser.add_argument("--rule")
    resolve_parser.add_argument("--tier", choices=["blocker", "major", "minor"], default="blocker")
    resolve_parser.add_argument("--path")
    resolve_parser.add_argument("--line", type=int)
    resolve_parser.add_argument("--snippet")

    try:
        args = parser.parse_args(argv)
        workspace = resolve_workspace(args.workspace)
        feature = resolve_feature(args.feature)
        if args.command == "scan":
            payload = scan(
                workspace,
                feature,
                Path(args.code_workspace),
                args.spec_path,
                args.input,
                args.input_dir,
            )
        else:
            payload = resolve(
                workspace,
                feature,
                args.finding_id,
                args.status,
                args.reviewer,
                args.rationale,
                args.input,
                args.rule,
                args.tier,
                args.path,
                args.line,
                args.snippet,
            )
    except (QualityCheckError, ValueError) as exc:
        print("e2e_quality_check_failed: {}".format(exc), file=sys.stderr)
        return 2
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))
    return 0 if payload.get("passed") is True else 1


if __name__ == "__main__":
    raise SystemExit(main())
