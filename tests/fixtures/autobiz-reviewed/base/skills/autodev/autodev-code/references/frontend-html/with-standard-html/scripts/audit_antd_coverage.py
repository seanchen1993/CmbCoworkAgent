#!/usr/bin/env python3
"""Audit React source for native UI controls that may need Ant Design conversion."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


SOURCE_SUFFIXES = {".tsx", ".jsx"}
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

TAG_RULES = {
    "button": "action control; consider Button",
    "input": "form control; consider Input, InputNumber, Checkbox, Radio, Switch, DatePicker, Upload, or related Form.Item control",
    "textarea": "text entry; consider Input.TextArea",
    "select": "choice control; consider Select, Cascader, or TreeSelect",
    "option": "select option; consider Select options data",
    "form": "form container; consider Form and Form.Item",
    "table": "record/data surface; consider Table unless it is a simple comparison/content table",
    "thead": "table structure; consider Table columns",
    "tbody": "table structure; consider Table dataSource",
    "tr": "table row; consider Table dataSource",
    "td": "table cell; consider Table columns/render",
    "dialog": "overlay; consider Modal or Drawer",
    "details": "expandable content; consider Collapse",
    "summary": "expandable header; consider Collapse",
    "progress": "progress indicator; consider Progress",
    "meter": "measurement indicator; consider Progress or Statistic",
}

ROLE_RULES = {
    "tablist": "tabs pattern; consider Tabs",
    "tab": "tab trigger; consider Tabs items",
    "tabpanel": "tab panel; consider Tabs items",
    "alert": "feedback pattern; consider Alert",
    "dialog": "overlay pattern; consider Modal or Drawer",
    "menu": "navigation/action menu; consider Menu or Dropdown",
}

CLASS_HINTS = {
    "modal": "modal-like class; consider Modal or Drawer",
    "drawer": "drawer-like class; consider Drawer",
    "pagination": "pagination-like class; consider Pagination",
    "upload": "upload-like class; consider Upload",
    "filter": "filter-like class; consider Form, Select, Input.Search, or Table filters",
    "validation": "validation-like class; consider Form.Item rules/help/status",
    "error": "error/validation-like class; consider Form.Item status or Alert",
}

TAG_RE = re.compile(r"<\s*({tags})(?=[\s>/])".format(tags="|".join(TAG_RULES)))
ROLE_RE = re.compile(r"\brole\s*=\s*['\"]({roles})['\"]".format(roles="|".join(ROLE_RULES)))
CLASS_RE = re.compile(r"\b(?:className|class)\s*=\s*(?:['\"]([^'\"]+)['\"]|\{{\s*['\"]([^'\"]+)['\"]\s*\}})")
IGNORE_RE = re.compile(r"antd-audit-ignore", re.IGNORECASE)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="utf-8-sig", errors="replace")


def should_skip(path: Path) -> bool:
    return any(part in SKIP_DIRS for part in path.parts)


def relative_to_or_self(path: Path, root: Path) -> Path:
    try:
        return path.relative_to(root)
    except ValueError:
        return path


def iter_source_files(root: Path):
    if root.is_file():
        if root.suffix in SOURCE_SUFFIXES:
            yield root
        return

    for path in root.rglob("*"):
        if should_skip(path):
            continue
        if path.is_file() and path.suffix in SOURCE_SUFFIXES:
            yield path


def has_ignore(lines: list[str], index: int) -> bool:
    window = lines[max(0, index - 2) : min(len(lines), index + 2)]
    return any(IGNORE_RE.search(line) for line in window)


def audit_file(path: Path, root: Path):
    text = read_text(path)
    lines = text.splitlines()
    findings = []

    for index, line in enumerate(lines):
        if has_ignore(lines, index):
            continue

        for match in TAG_RE.finditer(line):
            tag = match.group(1)
            findings.append((path, index + 1, f"<{tag}>", TAG_RULES[tag], line.strip()))

        for match in ROLE_RE.finditer(line):
            role = match.group(1)
            findings.append((path, index + 1, f'role="{role}"', ROLE_RULES[role], line.strip()))

        for match in CLASS_RE.finditer(line):
            classes = " ".join(group for group in match.groups() if group)
            lowered = classes.lower()
            for hint, reason in CLASS_HINTS.items():
                if hint in lowered:
                    findings.append((path, index + 1, f'class hint "{hint}"', reason, line.strip()))

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit JSX/TSX source for possible missed Ant Design conversions.")
    parser.add_argument("target", nargs="?", default=".", help="React project, source directory, or JSX/TSX file to audit.")
    parser.add_argument("--format", choices=["text", "markdown"], default="text")
    args = parser.parse_args()

    root = Path(args.target).resolve()
    files = list(iter_source_files(root))
    findings = []
    for file_path in files:
        findings.extend(audit_file(file_path, root))

    if args.format == "markdown":
        if not findings:
            print("Ant Design coverage audit: no native product UI candidates found in JSX/TSX source.")
            return 0
        print("| File | Line | Candidate | Recommendation | Source |")
        print("| --- | ---: | --- | --- | --- |")
        for path, line_no, candidate, reason, source in findings:
            rel = relative_to_or_self(path, root) if root.is_dir() else path
            escaped = source.replace("|", "\\|")
            print(f"| `{rel}` | {line_no} | `{candidate}` | {reason} | `{escaped}` |")
        return 1

    if not findings:
        print("Ant Design coverage audit: no native product UI candidates found in JSX/TSX source.")
        return 0

    print("Ant Design coverage audit found possible missed conversions:")
    for path, line_no, candidate, reason, source in findings:
        rel = relative_to_or_self(path, root) if root.is_dir() else path
        print(f"{rel}:{line_no}: {candidate} - {reason}")
        print(f"  {source}")
    print("\nResolve each finding by converting it to Ant Design or adding an `antd-audit-ignore` comment with a reason.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
