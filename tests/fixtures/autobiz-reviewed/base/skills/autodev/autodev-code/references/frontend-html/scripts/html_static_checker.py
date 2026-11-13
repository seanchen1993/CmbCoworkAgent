#!/usr/bin/env python3
"""Static HTML-result review checks for generated frontend code."""

from __future__ import annotations

import argparse
from html.parser import HTMLParser
import json
import re
from pathlib import Path
from typing import Any


SOURCE_SUFFIXES = {".tsx", ".jsx", ".ts", ".js", ".vue", ".css", ".less", ".scss"}
CODE_SUFFIXES = {".tsx", ".jsx", ".ts", ".js", ".vue"}
SKIP_DIRS = {
    ".git",
    ".next",
    ".nuxt",
    ".output",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "public",
}


class ReviewInputError(ValueError):
    """Raised when review inputs cannot produce reliable evidence."""


RELATIVE_IMPORT_RE = re.compile(
    r"^\s*import\s+(?:[^'\"\n]+?\s+from\s+)?['\"](?P<path>\.[^'\"]+)['\"]",
    re.MULTILINE,
)
SIDE_EFFECT_IMPORT_RE = re.compile(r"^\s*import\s+['\"](?P<path>\.[^'\"]+)['\"]", re.MULTILINE)
REQUIRE_RE = re.compile(r"require\(\s*['\"](?P<path>\.[^'\"]+)['\"]\s*\)")

ACTION_WORDS = {
    "查询",
    "搜索",
    "重置",
    "新增",
    "添加",
    "编辑",
    "删除",
    "保存",
    "提交",
    "取消",
    "确定",
    "导入",
    "导出",
    "上传",
    "下载",
    "预览",
    "展开",
    "收起",
}
STRUCTURE_CHECKS = [
    ("table", re.compile(r"<table\b|表格|列表|thead|tbody", re.IGNORECASE), re.compile(r"\bTable\b|<table\b", re.IGNORECASE), "表格结构可能未还原"),
    ("tabs", re.compile(r"\btab(?:s|list|panel)?\b|role=['\"]tab|标签页|选项卡", re.IGNORECASE), re.compile(r"\bTabs\b|role=['\"]tab|\btab(?:s|list|panel)?\b", re.IGNORECASE), "Tab 结构可能未还原"),
    ("chart", re.compile(r"\b(chart|echarts|canvas|graph)\b|图表|趋势|折线|柱状|饼图|漏斗", re.IGNORECASE), re.compile(r"\b(Chart|ECharts|echarts|canvas|svg)\b|图表|趋势", re.IGNORECASE), "图表区域可能未还原"),
    ("upload", re.compile(r"\bupload\b|上传|type=['\"]file", re.IGNORECASE), re.compile(r"\bUpload\b|上传|type=['\"]file", re.IGNORECASE), "上传入口可能未还原"),
    ("pagination", re.compile(r"分页|条/页|跳至|page", re.IGNORECASE), re.compile(r"\bPagination\b|分页|page", re.IGNORECASE), "分页结构可能未还原"),
]


class SourceHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.stack: list[str] = []
        self.texts: list[str] = []
        self.headings: list[str] = []
        self.actions: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        self.stack.append(tag)
        attr_map = {key.lower(): value or "" for key, value in attrs}
        for key in ("value", "placeholder", "aria-label", "title"):
            value = normalize_text(attr_map.get(key, ""))
            if value and tag in {"button", "input", "select", "textarea", "a"}:
                self.actions.append(value)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        while self.stack:
            current = self.stack.pop()
            if current == tag:
                break

    def handle_data(self, data: str) -> None:
        text = normalize_text(data)
        if not text:
            return
        self.texts.append(text)
        current = self.stack[-1] if self.stack else ""
        if current in {"h1", "h2", "h3", "h4"}:
            self.headings.append(text)
        if current in {"button", "a"} or text in ACTION_WORDS:
            self.actions.append(text)


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8").lstrip("\ufeff")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8-sig", errors="replace").lstrip("\ufeff")


def should_skip(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def iter_files(target: Path, suffixes: set[str] = SOURCE_SUFFIXES) -> list[Path]:
    if target.is_file():
        return [target] if target.suffix in suffixes else []
    files: list[Path] = []
    for path in target.rglob("*"):
        if should_skip(path):
            continue
        if path.is_file() and path.suffix in suffixes:
            files.append(path)
    return files


def validated_target_files(target: Path) -> list[Path]:
    if not target.exists():
        raise ReviewInputError(f"review target does not exist: {target}")
    if target.is_file() and target.suffix not in SOURCE_SUFFIXES:
        raise ReviewInputError(f"review target suffix is not supported: {target.suffix or '<none>'}")
    files = iter_files(target)
    if not files:
        raise ReviewInputError(f"review target has no scannable source files: {target}")
    return files


def existing_input_path(value: str | Path | None, label: str) -> Path | None:
    if not value:
        return None
    path = Path(value).resolve()
    if not path.exists():
        raise ReviewInputError(f"{label} does not exist: {path}")
    if not path.is_file():
        raise ReviewInputError(f"{label} is not a file: {path}")
    return path


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


def resolve_import(base: Path, import_path: str) -> bool:
    candidate = (base.parent / import_path).resolve()
    if candidate.exists():
        return True
    suffixes = ["", ".ts", ".tsx", ".js", ".jsx", ".vue", ".css", ".less", ".scss", ".json"]
    for suffix in suffixes:
        if suffix and candidate.with_suffix(suffix).exists():
            return True
    for suffix in suffixes[1:]:
        if (candidate / f"index{suffix}").exists():
            return True
    return False


def line_number(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


def basic_code_findings(files: list[Path]) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    for path in files:
        text = read_text(path)
        if path.suffix in CODE_SUFFIXES:
            for regex, message in [
                (re.compile(r"<!--"), "JSX / TSX 中疑似残留 HTML 注释"),
                (re.compile(r"<[A-Za-z][^>\n]*\sclass="), "JSX 中疑似使用了 class，应改为 className"),
                (re.compile(r"<label[^>\n]*\sfor="), "JSX 中疑似使用了 for，应改为 htmlFor"),
                (re.compile(r"\son[a-z]+\s*="), "JSX 中疑似使用了小写 DOM 事件名"),
            ]:
                for match in regex.finditer(text):
                    findings.append(make_finding(
                        "must-fix",
                        "syntax",
                        str(path),
                        line_number(text, match.start()),
                        message,
                        match.group(0)[:120],
                    ))
            for regex, message in [
                (re.compile(r"\bTODO\b|待实现|占位|placeholder", re.IGNORECASE), "代码中仍有待办或占位内容"),
                (re.compile(r"lorem ipsum|示例文案|示例数据", re.IGNORECASE), "代码中仍有模板示例内容"),
            ]:
                for match in regex.finditer(text):
                    findings.append(make_finding(
                        "suggestion",
                        "maintainability",
                        str(path),
                        line_number(text, match.start()),
                        message,
                        match.group(0)[:120],
                    ))
            imports = []
            imports.extend(match.group("path") for match in RELATIVE_IMPORT_RE.finditer(text))
            imports.extend(match.group("path") for match in SIDE_EFFECT_IMPORT_RE.finditer(text))
            imports.extend(match.group("path") for match in REQUIRE_RE.finditer(text))
            for import_path in sorted(set(imports)):
                if not resolve_import(path, import_path):
                    pos = text.find(import_path)
                    findings.append(make_finding(
                        "must-fix",
                        "syntax",
                        str(path),
                        line_number(text, pos) if pos >= 0 else None,
                        "相对 import / require 路径不可解析",
                        import_path,
                    ))
    return findings


def parse_source_html(path: Path | None) -> dict[str, Any]:
    if not path:
        return {"text": "", "headings": [], "actions": []}
    parser = SourceHtmlParser()
    text = read_text(path)
    parser.feed(text)
    actions = unique_short(parser.actions)
    headings = unique_short(parser.headings)
    return {"text": text, "headings": headings, "actions": actions}


def parse_analysis(path: Path | None) -> dict[str, Any]:
    if not path:
        return {"actions": [], "headings": [], "text": ""}
    try:
        data = json.loads(read_text(path))
    except OSError as exc:
        raise ReviewInputError(f"analysis cannot be read: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ReviewInputError(f"analysis JSON is invalid: {path}: {exc}") from exc
    actions: list[str] = []
    headings: list[str] = []
    for value in data.get("sourceActionTexts", []) or []:
        actions.append(str(value))
    for item in data.get("texts", []) or []:
        text = str(item.get("text", ""))
        kind = str(item.get("kind", ""))
        if kind == "action":
            actions.append(text)
        if kind in {"heading", "section-title", "title"}:
            headings.append(text)
    for section in data.get("sections", []) or []:
        title = section.get("title") or section.get("ownerPath") or ""
        if title:
            headings.append(str(title))
    return {
        "actions": unique_short(actions),
        "headings": unique_short(headings),
        "text": json.dumps(data, ensure_ascii=False),
    }


def unique_short(values: list[str], limit: int = 80) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        cleaned = normalize_text(value)
        if not cleaned or len(cleaned) > 80 or cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
        if len(result) >= limit:
            break
    return result


def combined_target_text(files: list[Path]) -> str:
    chunks: list[str] = []
    for path in files:
        chunks.append(read_text(path))
    return "\n".join(chunks)


def missing_clue_findings(
    target: Path,
    target_text: str,
    source_html: dict[str, Any],
    analysis: dict[str, Any],
    plan_text: str,
) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    normalized_target = normalize_text(target_text)
    clues: list[tuple[str, str, str]] = []
    for value in source_html.get("headings", [])[:20]:
        clues.append(("fidelity", value, "source-html heading"))
    for value in source_html.get("actions", [])[:30]:
        clues.append(("fidelity", value, "source-html action"))
    for value in analysis.get("headings", [])[:20]:
        clues.append(("fidelity", value, "analysis heading"))
    for value in analysis.get("actions", [])[:30]:
        clues.append(("fidelity", value, "analysis action"))
    for word in ACTION_WORDS:
        if word in plan_text:
            clues.append(("fidelity", word, "PLAN action keyword"))

    seen: set[str] = set()
    for category, clue, evidence in clues:
        if clue in seen:
            continue
        seen.add(clue)
        if clue and clue not in normalized_target:
            findings.append(make_finding(
                "suggestion",
                category,
                str(target),
                None,
                f"源材料中的关键文案可能未出现在目标代码中：{clue}",
                evidence,
            ))
        if len(findings) >= 80:
            break

    source_blob = "\n".join([
        str(source_html.get("text", "")),
        str(analysis.get("text", "")),
        plan_text,
    ])
    for kind, source_re, target_re, message in STRUCTURE_CHECKS:
        if source_re.search(source_blob) and not target_re.search(target_text):
            findings.append(make_finding(
                "suggestion",
                "fidelity",
                str(target),
                None,
                message,
                kind,
            ))
    return findings


def summarize(findings: list[dict[str, Any]], execution_errors: int = 0) -> dict[str, int]:
    return {
        "mustFix": sum(1 for item in findings if item.get("severity") == "must-fix"),
        "suggestion": sum(1 for item in findings if item.get("severity") == "suggestion"),
        "keep": sum(1 for item in findings if item.get("severity") == "keep"),
        "executionErrors": execution_errors,
    }


def run_checks(
    target: str | Path,
    source_html: str | Path | None = None,
    analysis: str | Path | None = None,
    plan: str | Path | None = None,
) -> dict[str, Any]:
    target_path = Path(target).resolve()
    files = validated_target_files(target_path)
    findings = basic_code_findings(files)
    target_text = combined_target_text(files)
    source_path = existing_input_path(source_html, "--source-html")
    analysis_path = existing_input_path(analysis, "--analysis")
    plan_path = existing_input_path(plan, "--plan")
    source_info = parse_source_html(source_path)
    analysis_info = parse_analysis(analysis_path)
    plan_text = read_text(plan_path) if plan_path else ""
    findings.extend(missing_clue_findings(target_path, target_text, source_info, analysis_info, plan_text))
    if not findings:
        findings.append(make_finding(
            "keep",
            "syntax",
            str(target_path),
            None,
            "静态 HTML 回检未发现确定性问题",
            "html_static_checker",
        ))
    return {"target": str(target_path), "summary": summarize(findings), "findings": findings}


def to_markdown(result: dict[str, Any]) -> str:
    lines = [
        "【HTML 静态回检结果】",
        f"范围：{result['target']}",
        f"结论：{'通过' if result['summary']['mustFix'] == 0 and result['summary']['suggestion'] == 0 else '有问题需复核'}",
        "必须修复：",
    ]
    must = [item for item in result["findings"] if item["severity"] == "must-fix"]
    sugg = [item for item in result["findings"] if item["severity"] == "suggestion"]
    keep = [item for item in result["findings"] if item["severity"] == "keep"]
    lines.extend(format_items(must))
    lines.append("建议优化：")
    lines.extend(format_items(sugg))
    lines.append("可保持现状：")
    lines.extend(format_items(keep))
    return "\n".join(lines) + "\n"


def format_items(items: list[dict[str, Any]]) -> list[str]:
    if not items:
        return ["- 无"]
    result = []
    for item in items:
        line = item.get("line")
        loc = f"{item['file']}:{line}" if line else item["file"]
        result.append(f"- [{item['category']}] {item['message']}（{loc}；证据：{item['evidence']}）")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="Run static HTML-result review checks.")
    parser.add_argument("target")
    parser.add_argument("--source-html")
    parser.add_argument("--analysis")
    parser.add_argument("--plan")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    args = parser.parse_args()

    try:
        result = run_checks(args.target, args.source_html, args.analysis, args.plan)
    except ReviewInputError as exc:
        target = str(Path(args.target).resolve())
        finding = make_finding(
            "suggestion",
            "syntax",
            target,
            None,
            "HTML static review input error",
            str(exc),
        )
        result = {
            "target": target,
            "summary": summarize([finding], execution_errors=1),
            "findings": [finding],
        }
        exit_code = 2
    else:
        summary = result["summary"]
        exit_code = 1 if summary["mustFix"] or summary["suggestion"] else 0
    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(to_markdown(result), end="")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
