#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""按测试域渲染 Spring Boot 2/3 单测参考。"""

from __future__ import annotations

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
    / "spring-test-patterns.md"
)

DOMAINS = ("fundamentals", "mvc", "security", "websocket", "persistence")
ALL_DOMAINS = "*"

SECTION_MARKER = re.compile(
    r"^<!--\s*section:\s*(?P<name>[^|]*?)\s*\|\s*domain:\s*(?P<domains>.*?)\s*-->\s*$"
)


class SpringTestReferenceError(Exception):
    """参考资料输入或结构错误。"""


def _legal_domains_text():
    return ", ".join(DOMAINS)


class RepairArgumentParser(argparse.ArgumentParser):
    """把参数错误转换为带修复方式的脚本错误。"""

    def error(self, message):
        raise SpringTestReferenceError(
            "命令参数无效：{}。修复：运行 `{} --help`，并从 {} 中填写 --domain。".format(
                message, self.prog, _legal_domains_text()
            )
        )


def _parse_section_domains(raw, name, lineno):
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    if not values:
        raise SpringTestReferenceError(
            "第 {} 行小节「{}」的 domain 为空。修复：写 `domain: *`，或从 {} 中选择。".format(
                lineno, name, _legal_domains_text()
            )
        )
    if ALL_DOMAINS in values and values != (ALL_DOMAINS,):
        raise SpringTestReferenceError(
            "第 {} 行小节「{}」把 `*` 与其他域混用。修复：通用小节只写 `domain: *`。".format(
                lineno, name
            )
        )
    unknown = [value for value in values if value not in DOMAINS and value != ALL_DOMAINS]
    if unknown:
        raise SpringTestReferenceError(
            "第 {} 行小节「{}」引用了未知域 {}。修复：只能使用 {} 或 `*`。".format(
                lineno, name, ", ".join(unknown), _legal_domains_text()
            )
        )
    return values


def parse_sections(text):
    """把正文切成有序小节；首个标记前的编辑说明不参与渲染。"""
    sections = []
    current = None

    for lineno, line in enumerate(text.splitlines(), start=1):
        matched = SECTION_MARKER.match(line)
        if matched:
            name = matched.group("name").strip()
            if not name:
                raise SpringTestReferenceError(
                    "第 {} 行 section 名称为空。修复：为小节填写可识别的名称。".format(lineno)
                )
            current = {
                "name": name,
                "domains": _parse_section_domains(
                    matched.group("domains"), name, lineno
                ),
                "lines": [],
                "lineno": lineno,
            }
            sections.append(current)
            continue
        if current is not None:
            current["lines"].append(line)

    if not sections:
        raise SpringTestReferenceError(
            "spring-test-patterns.md 中没有 section 标记。"
            "修复：至少添加一个 `<!-- section: 名称 | domain: <值> -->` 小节。"
        )
    return sections


def _parse_requested_domains(raw):
    values = tuple(item.strip() for item in raw.split(",") if item.strip())
    if not values:
        raise SpringTestReferenceError(
            "--domain 不能为空。修复：从 {} 中选择一个或多个域。".format(
                _legal_domains_text()
            )
        )
    unknown = [value for value in values if value not in DOMAINS]
    if unknown:
        raise SpringTestReferenceError(
            "未知域 {}。修复：--domain 只接受 {}，多值用逗号分隔。".format(
                ", ".join(unknown), _legal_domains_text()
            )
        )
    return tuple(dict.fromkeys(values))


def sections_for_domains(sections, domains):
    selected = []
    for section in sections:
        section_domains = section["domains"]
        if ALL_DOMAINS in section_domains or any(
            domain in section_domains for domain in domains
        ):
            selected.append(section)
    return selected


def render(domain, source=None):
    domains = _parse_requested_domains(domain)
    path = source or REFERENCE_PATH
    if not path.is_file():
        raise SpringTestReferenceError(
            "找不到参考正文 {}。修复：确认插件安装完整，或用 --source 指定实际路径。".format(
                path
            )
        )

    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise SpringTestReferenceError(
            "无法读取参考正文 {}：{}。修复：确认文件可读且使用 UTF-8 编码。".format(
                path, exc
            )
        )

    sections = parse_sections(text)
    selected = sections_for_domains(sections, domains)
    matched_domains = {
        value
        for section in selected
        for value in section["domains"]
        if value != ALL_DOMAINS
    }
    missing = [value for value in domains if value not in matched_domains]
    if missing:
        raise SpringTestReferenceError(
            "域 {} 没有匹配到专属小节。修复：在 {} 中补充对应 domain 标记。".format(
                ", ".join(missing), path.name
            )
        )

    body = "\n\n".join(
        "\n".join(section["lines"]).strip("\n") for section in selected
    )
    return "# Spring 单测参考 · {}\n\n{}\n".format(",".join(domains), body)


def main(argv=None):
    parser = RepairArgumentParser(description="按域渲染 Spring Boot 2/3 单测参考")
    parser.add_argument("--domain", help="测试域，支持逗号分隔多值")
    parser.add_argument("--source", type=Path, help="覆盖正文路径（测试用）")

    try:
        args = parser.parse_args(argv)
        if args.domain is None:
            raise SpringTestReferenceError(
                "缺少 --domain。修复：从 {} 中选择一个或多个域。".format(
                    _legal_domains_text()
                )
            )
        sys.stdout.write(render(args.domain, source=args.source))
    except SpringTestReferenceError as exc:
        print("render_spring_test_reference_failed: {}".format(exc), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
