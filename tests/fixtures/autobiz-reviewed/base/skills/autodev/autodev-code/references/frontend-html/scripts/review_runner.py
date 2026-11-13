#!/usr/bin/env python3
"""Unified review runner for generated frontend code."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
FRONTEND_HTML_ROOT = SCRIPT_DIR.parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

import html_static_checker  # noqa: E402


ANTD_IMPORT_RE = re.compile(
    r"^\s*import\s+(?:[^'\"]+?\s+from\s+)?['\"](?:antd|@ant-design/[^'\"]+)['\"]",
    re.MULTILINE,
)
ANTD_STATE_RE = re.compile(
    r"\b(?:['\"]?auditRequired['\"]?\s*[:=]\s*true|auditRequired=true|"
    r"['\"]?antdMode['\"]?\s*[:=]\s*['\"]?(?:required|selected)|antdMode=(?:required|selected))\b",
    re.IGNORECASE,
)


def make_finding(
    severity: str,
    category: str,
    file: str,
    line: int | None,
    message: str,
    evidence: str,
) -> dict[str, Any]:
    return {
        "severity": severity,
        "category": category,
        "file": file,
        "line": line,
        "message": message,
        "evidence": evidence,
    }


def summarize(findings: list[dict[str, Any]], execution_errors: int = 0) -> dict[str, int]:
    return {
        "mustFix": sum(1 for item in findings if item.get("severity") == "must-fix"),
        "suggestion": sum(1 for item in findings if item.get("severity") == "suggestion"),
        "keep": sum(1 for item in findings if item.get("severity") == "keep"),
        "executionErrors": execution_errors,
    }


def read_optional(path: str | None) -> str:
    if not path:
        return ""
    candidate = Path(path)
    if not candidate.exists():
        return ""
    try:
        return candidate.read_text(encoding="utf-8").lstrip("\ufeff")
    except UnicodeDecodeError:
        return candidate.read_text(encoding="utf-8-sig", errors="replace").lstrip("\ufeff")


def target_code_text(target: Path) -> str:
    if target.is_file():
        if target.suffix not in html_static_checker.CODE_SUFFIXES:
            return ""
        return read_optional(str(target))
    chunks: list[str] = []
    for path in html_static_checker.iter_files(target, html_static_checker.CODE_SUFFIXES):
        chunks.append(read_optional(str(path)))
    return "\n".join(chunks)


def should_run_antd_auto(target: Path, plan: str | None, analysis: str | None) -> bool:
    code_text = target_code_text(target)
    state_haystack = "\n".join([
        code_text,
        read_optional(plan),
        read_optional(analysis),
    ])
    return bool(ANTD_STATE_RE.search(state_haystack) or ANTD_IMPORT_RE.search(code_text))


def run_antd_audit(target: Path) -> tuple[list[dict[str, Any]], int]:
    script = FRONTEND_HTML_ROOT / "with-standard-html" / "scripts" / "audit_antd_coverage.py"
    if not script.exists():
        return [
            make_finding(
                "suggestion",
                "antd-audit",
                str(script),
                None,
                "AntD 覆盖审计脚本不存在，已跳过",
                "antd-audit-script-missing",
            )
        ], 1
    proc = subprocess.run(
        [sys.executable, str(script), str(target), "--format", "markdown"],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode == 0:
        return [
            make_finding(
                "keep",
                "antd-audit",
                str(target),
                None,
                "Ant Design 覆盖审计未发现候选项",
                "audit_antd_coverage.py",
            )
        ], 0
    if proc.returncode == 1:
        return parse_antd_markdown(proc.stdout, target), 0
    return [
        make_finding(
            "suggestion",
            "antd-audit",
            str(target),
            None,
            "Ant Design 覆盖审计执行失败",
            (proc.stderr or proc.stdout or f"exit {proc.returncode}").strip(),
        )
    ], 1


def parse_antd_markdown(markdown: str, target: Path) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for line in markdown.splitlines():
        if not line.startswith("| `"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 5 or cells[0] == "---":
            continue
        file_cell = cells[0].strip("`")
        try:
            line_no = int(cells[1])
        except ValueError:
            line_no = None
        candidate = cells[2].strip("`")
        recommendation = cells[3]
        findings.append(make_finding(
            "suggestion",
            "antd-audit",
            str(target / file_cell) if target.is_dir() else str(target),
            line_no,
            f"可能遗漏 Ant Design 转换候选：{candidate}",
            recommendation,
        ))
    if not findings and markdown.strip():
        findings.append(make_finding(
            "suggestion",
            "antd-audit",
            str(target),
            None,
            "Ant Design 覆盖审计发现候选项，请查看原始输出",
            markdown.strip()[:500],
        ))
    return findings


def run_all(args: argparse.Namespace) -> dict[str, Any]:
    target = Path(args.target).resolve()
    findings: list[dict[str, Any]] = []
    execution_errors = 0
    checks: list[str] = []

    try:
        html_result = html_static_checker.run_checks(
            target,
            source_html=args.source_html,
            analysis=args.analysis,
            plan=args.plan,
        )
        findings.extend(html_result["findings"])
        checks.append("html-static")
    except html_static_checker.ReviewInputError as exc:
        execution_errors += 1
        findings.append(make_finding(
            "suggestion",
            "syntax",
            str(target),
            None,
            "HTML static review input error",
            str(exc),
        ))
    except Exception as exc:  # pragma: no cover - defensive runner guard
        execution_errors += 1
        findings.append(make_finding(
            "suggestion",
            "syntax",
            str(target),
            None,
            "HTML 静态回检执行失败",
            repr(exc),
        ))

    run_antd = execution_errors == 0 and (
        args.antd_audit == "on" or (
            args.antd_audit == "auto" and should_run_antd_auto(target, args.plan, args.analysis)
        )
    )
    if run_antd:
        antd_findings, antd_errors = run_antd_audit(target)
        findings.extend(antd_findings)
        execution_errors += antd_errors
        checks.append("antd-audit")

    return {
        "target": str(target),
        "summary": summarize(findings, execution_errors),
        "findings": findings,
        "checks": checks,
    }


def grouped_findings(findings: list[dict[str, Any]], severity: str) -> list[dict[str, Any]]:
    return [item for item in findings if item.get("severity") == severity]


def format_items(items: list[dict[str, Any]]) -> list[str]:
    if not items:
        return ["- 无"]
    lines: list[str] = []
    for item in items:
        line = item.get("line")
        loc = f"{item['file']}:{line}" if line else item["file"]
        lines.append(f"- [{item['category']}] {item['message']}（{loc}；证据：{item['evidence']}）")
    return lines


def to_markdown(result: dict[str, Any]) -> str:
    summary = result["summary"]
    if summary["executionErrors"]:
        conclusion = "执行异常，需查看检查器错误"
    elif summary["mustFix"]:
        conclusion = "有问题需修复"
    elif summary["suggestion"]:
        conclusion = "通过但有建议优化"
    else:
        conclusion = "通过"
    check_lines = [f"- {name}" for name in result.get("checks", [])] or ["- 无"]
    lines = [
        "【统一回检结果】",
        f"范围：{result['target']}",
        f"结论：{conclusion}",
        "必须修复：",
        *format_items(grouped_findings(result["findings"], "must-fix")),
        "建议优化：",
        *format_items(grouped_findings(result["findings"], "suggestion")),
        "可保持现状：",
        *format_items(grouped_findings(result["findings"], "keep")),
        "执行的检查：",
        *check_lines,
        "是否已修改：否",
    ]
    return "\n".join(lines) + "\n"


def write_or_print(content: str, output: str | None) -> None:
    if not output:
        print(content, end="")
        return
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(content, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run unified frontend post-generation review.")
    parser.add_argument("--target", required=True, help="Generated page/component file or directory.")
    parser.add_argument("--source-html", help="Original source HTML used for fidelity clues.")
    parser.add_argument("--analysis", help=".frontend/html-analysis/*.json file.")
    parser.add_argument("--plan", help="PLAN.md file used as implementation context.")
    parser.add_argument("--antd-audit", choices=["auto", "on", "off"], default="auto")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    parser.add_argument("--output", help="Optional report output path.")
    args = parser.parse_args()

    result = run_all(args)
    if args.format == "json":
        content = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    else:
        content = to_markdown(result)
    write_or_print(content, args.output)

    summary = result["summary"]
    if summary["executionErrors"]:
        return 2
    if summary["mustFix"] or summary["suggestion"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
