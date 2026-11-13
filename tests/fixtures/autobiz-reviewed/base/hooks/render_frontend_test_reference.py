#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render bounded Vue3/React test guidance by framework and domain."""

from __future__ import print_function

import argparse
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PATH = (
    ROOT
    / "skills"
    / "autodev"
    / "autodev-utest"
    / "reference"
    / "frontend-test-patterns.md"
)
FRAMEWORKS = ("vue", "react")
DOMAINS = ("fundamentals", "component", "logic", "state", "integration")
ALL_VALUES = "*"
MAX_RENDERED_LINES = 400
SECTION_MARKER = re.compile(
    r"^<!--\s*section:\s*(?P<name>[^|]*?)\s*\|\s*framework:\s*(?P<frameworks>[^|]*?)\s*\|\s*domain:\s*(?P<domains>.*?)\s*-->\s*$"
)


class FrontendTestReferenceError(Exception):
    """Reference selection or structure error."""


class RepairArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise FrontendTestReferenceError(
            "命令参数无效：{}。修复：运行 `{} --help`，从 {} 与 {} 中选择。".format(
                message, self.prog, ", ".join(FRAMEWORKS), ", ".join(DOMAINS)
            )
        )


def _parse_marker_values(raw, legal, label, name, lineno):
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    if not values:
        raise FrontendTestReferenceError(
            "第 {} 行小节「{}」的 {} 为空。修复：写 `{}: *` 或选择 {}。".format(
                lineno, name, label, label, ", ".join(legal)
            )
        )
    if ALL_VALUES in values and values != (ALL_VALUES,):
        raise FrontendTestReferenceError(
            "第 {} 行小节「{}」把 `*` 与其他 {} 混用。修复：共享小节只写 `{}: *`。".format(
                lineno, name, label, label
            )
        )
    unknown = [value for value in values if value not in legal and value != ALL_VALUES]
    if unknown:
        raise FrontendTestReferenceError(
            "第 {} 行小节「{}」引用未知 {} {}。修复：只能使用 {} 或 `*`。".format(
                lineno, name, label, ", ".join(unknown), ", ".join(legal)
            )
        )
    return values


def parse_sections(text):
    sections = []
    current = None
    for lineno, line in enumerate(text.splitlines(), start=1):
        matched = SECTION_MARKER.match(line)
        if matched:
            name = matched.group("name").strip()
            if not name:
                raise FrontendTestReferenceError(
                    "第 {} 行 section 名称为空。修复：填写稳定小节名称。".format(lineno)
                )
            current = {
                "name": name,
                "frameworks": _parse_marker_values(
                    matched.group("frameworks"), FRAMEWORKS, "framework", name, lineno
                ),
                "domains": _parse_marker_values(
                    matched.group("domains"), DOMAINS, "domain", name, lineno
                ),
                "lines": [],
                "lineno": lineno,
            }
            sections.append(current)
            continue
        if current is not None:
            current["lines"].append(line)
    if not sections:
        raise FrontendTestReferenceError(
            "frontend-test-patterns.md 没有 section 标记。修复：添加 framework/domain 双维 section 标记。"
        )
    return sections


def _parse_framework(raw):
    framework = str(raw or "").strip().lower()
    if framework not in FRAMEWORKS:
        raise FrontendTestReferenceError(
            "未知 framework {}。修复：--framework 只接受 {}。".format(
                framework or "<empty>", ", ".join(FRAMEWORKS)
            )
        )
    return framework


def _parse_domains(raw):
    values = tuple(item.strip().lower() for item in str(raw or "").split(",") if item.strip())
    if not values:
        raise FrontendTestReferenceError(
            "--domain 不能为空。修复：从 {} 中选择。".format(", ".join(DOMAINS))
        )
    unknown = [value for value in values if value not in DOMAINS]
    if unknown:
        raise FrontendTestReferenceError(
            "未知 domain {}。修复：--domain 只接受 {}，多值用逗号分隔。".format(
                ", ".join(unknown), ", ".join(DOMAINS)
            )
        )
    return tuple(dict.fromkeys(values))


def sections_for_selection(sections, framework, domains):
    selected = []
    for section in sections:
        framework_match = (
            ALL_VALUES in section["frameworks"] or framework in section["frameworks"]
        )
        domain_match = (
            ALL_VALUES in section["domains"]
            or any(domain in section["domains"] for domain in domains)
        )
        if framework_match and domain_match:
            selected.append(section)
    return selected


def render(framework, domain, source=None):
    selected_framework = _parse_framework(framework)
    selected_domains = _parse_domains(domain)
    path = source or REFERENCE_PATH
    if not path.is_file():
        raise FrontendTestReferenceError(
            "找不到参考正文 {}。修复：确认插件安装完整，或用 --source 指定实际路径。".format(path)
        )
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise FrontendTestReferenceError(
            "无法读取参考正文 {}：{}。修复：确认文件可读且使用 UTF-8。".format(path, exc)
        )
    sections = parse_sections(text)
    selected = sections_for_selection(sections, selected_framework, selected_domains)
    matched_domains = set()
    for section in selected:
        for value in section["domains"]:
            if value != ALL_VALUES:
                matched_domains.add(value)
    missing = [value for value in selected_domains if value not in matched_domains]
    if missing:
        raise FrontendTestReferenceError(
            "{} 的 domain {} 没有专属小节。修复：在 {} 补充匹配标记。".format(
                selected_framework, ", ".join(missing), path.name
            )
        )
    body = "\n\n".join(
        "\n".join(section["lines"]).strip("\n") for section in selected
    )
    output = "# {} 前端单测参考 · {}\n\n{}\n".format(
        selected_framework, ",".join(selected_domains), body
    )
    line_count = len(output.splitlines())
    if line_count > MAX_RENDERED_LINES:
        raise FrontendTestReferenceError(
            "渲染结果 {} 行，超过 {} 行上限。修复：缩小 --domain 或拆分过长参考小节。".format(
                line_count, MAX_RENDERED_LINES
            )
        )
    return output


def main(argv=None):
    parser = RepairArgumentParser(description="按框架和域渲染前端单测参考")
    parser.add_argument("--framework")
    parser.add_argument("--domain")
    parser.add_argument("--source", type=Path, help="覆盖正文路径（测试用）")
    try:
        args = parser.parse_args(argv)
        if args.framework is None or args.domain is None:
            raise FrontendTestReferenceError(
                "缺少 --framework 或 --domain。修复：同时传入框架与一个或多个测试域。"
            )
        sys.stdout.write(render(args.framework, args.domain, source=args.source))
    except FrontendTestReferenceError as exc:
        print("render_frontend_test_reference_failed: {}".format(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
