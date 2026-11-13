#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""PreToolUse(task) hook: augment Explore-autodev task prompts."""

from __future__ import print_function

import json
import sys


PREFIX = "[task-prompt-augment]"
TARGET_SUBAGENT_TYPE = "Explore-autodev"
APPEND_MARKER = "appendix"
APPEND_INSTRUCTION = """

<{marker}>

### 系统约束补充

探索代码前，先检查 `<AGENTS_INSTRUCTIONS>`：

1. 根据 `<SCOPE>` 确定本任务涉及的 deployUnit。
2. 检查对应 `<SYSTEM>`、`<UNIT>` 是否引用了相关架构、领域、API 或编码规范文件。
3. 有对应文件时，先通过工具实际读取，再探索代码。
4. 没有对应文件或路径不可访问时，明确记录后继续原任务，不得猜测文件内容。

输出增加 `## 架构约束`，只记录从实际读取文件中提取且与本任务相关的约束；现有能力、差异分析和 Capability 建议同时以需求、系统约束和源码为依据。
你必须完整输出上述系统约束补充，
</{marker}>""".format(marker=APPEND_MARKER)


def read_stdin_text():
    raw = sys.stdin.buffer.read()
    if not raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode(sys.stdin.encoding or "utf-8", errors="replace")


def as_dict(value):
    return value if isinstance(value, dict) else {}


def get_tool_input(payload):
    return as_dict(payload.get("tool_input") or payload.get("input"))


def is_target_subagent(tool_input):
    subagent_type = tool_input.get("subagent_type")
    if not isinstance(subagent_type, str):
        return False
    return subagent_type.strip().lower() == TARGET_SUBAGENT_TYPE.lower()


def has_existing_constraint_instruction(description):
    if APPEND_MARKER in description:
        return True

    has_agents_block = (
        "<AGENTS_INSTRUCTIONS>" in description
        and any(
            tag in description
            for tag in ("<SCOPE>", "<SYSTEM", "<UNIT")
        )
    )
    if has_agents_block:
        return True

    has_reference_section = "系统约束文档" in description and ".md" in description
    has_read_requirement = any(
        phrase in description
        for phrase in ("必须先读取", "先读取", "先读", "实际读取")
    )
    has_architecture_output = "架构约束" in description
    return (
        has_reference_section
        and has_read_requirement
        and has_architecture_output
    )


def build_updated_input(payload, stream):
    tool_input = get_tool_input(payload)
    if not is_target_subagent(tool_input):
        print(
            "{} skipped; subagent_type must be {}".format(
                PREFIX, TARGET_SUBAGENT_TYPE
            ),
            file=stream,
        )
        return None

    description = tool_input.get("description")
    if not isinstance(description, str) or not description.strip():
        print(
            "{} description missing; pass the Explore-autodev task prompt in "
            "tool_input.description".format(PREFIX),
            file=stream,
        )
        return None

    if has_existing_constraint_instruction(description):
        print(
            "{} skipped; system constraint instruction already present".format(PREFIX),
            file=stream,
        )
        return None

    updated_description = description + APPEND_INSTRUCTION
    print(
        "{} appended {} to Explore-autodev description".format(
            PREFIX, APPEND_MARKER
        ),
        file=stream,
    )
    return {"updatedInput": {"description": updated_description}}


def emit_updated_input(payload, output_stream, error_stream):
    result = build_updated_input(payload, error_stream)
    if result is None:
        return False
    json.dump(result, output_stream, ensure_ascii=False, separators=(",", ":"))
    output_stream.write("\n")
    return True


def main():
    raw_input = read_stdin_text()
    if not raw_input.strip():
        print(
            "{} empty stdin; verify CMBDevClaw passes the PreToolUse payload "
            "to command hooks".format(PREFIX),
            file=sys.stderr,
        )
        return 0

    try:
        payload = json.loads(raw_input)
    except (TypeError, ValueError) as error:
        print(
            "{} invalid JSON: {}; capture the raw PreToolUse payload and update "
            "the parser".format(PREFIX, error),
            file=sys.stderr,
        )
        return 0

    if not isinstance(payload, dict):
        print(
            "{} payload is not an object; capture the raw PreToolUse payload "
            "and update the parser".format(PREFIX),
            file=sys.stderr,
        )
        return 0

    emit_updated_input(payload, sys.stdout, sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
