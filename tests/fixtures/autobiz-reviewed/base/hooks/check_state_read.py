#!/usr/bin/env python3
"""Pre-tool guard that blocks direct reads of checkpoint state sources.

当前 checkpoint 只能通过 read_state_json.py 获取。本守卫拦截四类绕过读取：

- ``.autobizdevops/state.json``：主事实源，但 skill 要求必须走脚本读取，
  不得绕过脚本手工读取后自行解析。
- ``.autobizdevops/STATE.md``：state.json 的自动生成视图，不是事实源。
- ``hooks.ndjson``：append-only 的 hook 审计日志，写入失败会被静默吞掉，
  可能缺行或滞后，末行看似"最新状态"但不可作为事实源。
- Feature 目录内的 ``.plan.lock``：内部写锁，不是流程输入。

拦截后在 reason 中给出 read_state_json.py 的调用方式，把调用方引导回脚本。
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from urllib.parse import unquote, urlparse


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
BLOCK_EXIT_CODE = 2

# hooks.ndjson 按文件名匹配，覆盖 features/ 与 archive/ 下的所有副本。
HOOK_LOG_FILENAME = "hooks.ndjson"
# state.json / STATE.md 按路径后缀匹配，避免误伤项目里其它同名的通用文件。
# 与 state_checkpoint.py 的 STATE_JSON_PATH_SUFFIX / STATE_PATH_SUFFIX 对应，
# tests/test_check_state_read.py 有一致性断言防止两处漂移。
STATE_JSON_PATH_SUFFIX = (".autobizdevops", "state.json")
STATE_MD_PATH_SUFFIX = (".autobizdevops", "state.md")
PLAN_LOCK_FILENAME = ".plan.lock"

PATH_KEYS = {
    "filePath",
    "file_path",
    "path",
    "filename",
    "absolutePath",
    "relativePath",
}
# 只拦"读文件内容"的命令；grep/rg/find/ls 等按名字搜索的命令不拦，
# 否则维护本仓库时检索这些文件名的字面量会被误伤。
READER_COMMANDS = {
    "cat",
    "head",
    "tail",
    "less",
    "more",
    "bat",
    "nl",
    "od",
    "xxd",
    "strings",
    "jq",
}
COMMAND_SEPARATORS = re.compile(r"\|\||&&|[|;&\n]")

HOOK_LOG = "hook_log"
STATE_JSON = "state_json"
STATE_MD = "state_md"
PLAN_LOCK = "plan_lock"

TARGET_REASONS = {
    HOOK_LOG: (
        "hooks.ndjson 是 append-only 的 hook 审计日志，不是状态源，"
        "不得据其判断或推断当前 checkpoint。"
    ),
    STATE_JSON: (
        "state.json 是 checkpoint 唯一来源，但不得绕过脚本手工读取后自行解析，"
        "以免漏掉脚本的规范化与校验处理。"
    ),
    STATE_MD: (
        "STATE.md 是 state.json 的自动生成视图，"
        "不得据其判断当前 checkpoint。"
    ),
    PLAN_LOCK: (
        ".plan.lock 是 Feature 内部写锁，不是流程输入，"
        "不得读取或据其判断执行进度。"
    ),
}


def read_stdin_text() -> str:
    raw = sys.stdin.buffer.read()
    if not raw:
        return ""
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode(sys.stdin.encoding or "utf-8", errors="replace")


def path_from_uri(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme != "file":
        return value
    return unquote(parsed.path)


def normalize(value: str) -> str:
    return path_from_uri(str(value)).replace("\\", "/").strip().strip("'\"")


def basename(value: str) -> str:
    return value.rstrip("/").rsplit("/", 1)[-1].lower()


def has_path_suffix(value: str, suffix: tuple[str, ...]) -> bool:
    parts = [part.lower() for part in value.split("/") if part and part != "."]
    return tuple(parts[-len(suffix):]) == suffix


def blocked_read_target(value: str) -> str | None:
    """返回被拦截的状态源类型；不是状态源时返回 None。"""
    normalized = normalize(value)
    if not normalized:
        return None
    if basename(normalized) == HOOK_LOG_FILENAME:
        return HOOK_LOG
    if has_path_suffix(normalized, STATE_JSON_PATH_SUFFIX):
        return STATE_JSON
    if has_path_suffix(normalized, STATE_MD_PATH_SUFFIX):
        return STATE_MD
    parts = [part.lower() for part in normalized.split("/") if part and part != "."]
    if basename(normalized) == PLAN_LOCK_FILENAME and ".autobizdevops" in parts:
        return PLAN_LOCK
    return None


def extract_candidate_paths(tool_input: object) -> list[str]:
    if not isinstance(tool_input, dict):
        return []

    paths: list[str] = []
    for key in PATH_KEYS:
        raw = tool_input.get(key)
        if isinstance(raw, str) and raw.strip():
            paths.append(raw)
        elif isinstance(raw, list):
            paths.extend(item for item in raw if isinstance(item, str) and item.strip())
    return paths


def command_read_target(command: str) -> str | None:
    """命令由读取类命令发起、且目标是状态源时，返回被拦截的类型。"""
    for segment in COMMAND_SEPARATORS.split(command):
        tokens = segment.split()
        if not tokens:
            continue
        if basename(tokens[0]) not in READER_COMMANDS:
            continue
        for token in tokens[1:]:
            target = blocked_read_target(token)
            if target is not None:
                return target
    return None


def payload_read_target(payload: dict) -> str | None:
    tool_input = payload.get("tool_input") or payload.get("input") or {}
    for path in extract_candidate_paths(tool_input):
        target = blocked_read_target(path)
        if target is not None:
            return target

    if isinstance(tool_input, dict):
        for key in ("command", "cmd", "script"):
            command = tool_input.get(key)
            if isinstance(command, str) and command.strip():
                target = command_read_target(command)
                if target is not None:
                    return target
    return None


def block_reason(target: str) -> str:
    script = f"{PLUGIN_ROOT}/read_state_json.py"
    return "\n".join(
        [
            TARGET_REASONS[target],
            "当前 checkpoint 请改用脚本读取：",
            f'python "{script}" --feature "${{feature}}"',
            "未确定 Feature 时不带 --feature 读取全量记录：",
            f'python "{script}"',
        ]
    )


def block(reason: str) -> int:
    print(reason, file=sys.stderr)
    json.dump(
        {
            "decision": "block",
            "reason": reason,
            "systemMessage": reason,
        },
        sys.stdout,
        ensure_ascii=False,
    )
    return BLOCK_EXIT_CODE


def main() -> int:
    raw_input = read_stdin_text()
    if not raw_input.strip():
        return 0

    try:
        payload = json.loads(raw_input)
    except json.JSONDecodeError:
        # 守卫不能因为脏输入阻断正常工具调用
        return 0

    if not isinstance(payload, dict):
        return 0

    target = payload_read_target(payload)
    if target is not None:
        return block(block_reason(target))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
