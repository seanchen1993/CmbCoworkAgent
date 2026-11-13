#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Shared helpers for JSON artifact writer scripts."""

from __future__ import annotations

import contextlib
import io
import json
import os
import re
import shlex
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass


ROOT = Path(__file__).resolve().parents[1]
HOOKS_DIR = ROOT / "hooks"
AUTODEV_HOOKS_DIR = ROOT / "skills" / "autodev" / "hooks"
for candidate in (ROOT, HOOKS_DIR, AUTODEV_HOOKS_DIR):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from hooks.paths import get_plugin_output_workspace  # noqa: E402


POSTCHECK_FAIL_RE = re.compile(
    r"^POST_SKILL_FAIL\s+skill=(?P<skill>\S+)\s+reason=(?P<reason>\S+)"
    r"(?P<detail>.*?)(?:\s+payload=(?P<payload>\{.*\}))?$"
)

# 结构化字段随 FAIL 行尾的 payload 一起到达，一条错误一行；同 reason 重复出现时
# 每条错误各自带 target/action，不做跨行配对。旧行没有 payload，按原样降级。
POSTCHECK_PAYLOAD_FIELDS = ("artifact", "target", "problem", "action", "route")


class WriterError(RuntimeError):
    """Raised for expected writer failures that should be rendered as JSON."""


class WriterEncodingError(WriterError):
    """Raised when JSON input cannot safely round-trip through UTF-8."""


@dataclass(frozen=True)
class WriterResult:
    ok: bool
    path: Path | None = None
    changed: bool = False
    errors: list[dict[str, Any]] | None = None
    data: dict[str, Any] | None = None


def _error(reason: str, detail: str = "") -> dict[str, str]:
    result = {"reason": reason}
    if detail:
        result["detail"] = detail
    return result


def render_result(result: WriterResult) -> int:
    payload: dict[str, Any] = {
        "ok": result.ok,
        "changed": result.changed,
        "errors": result.errors or [],
    }
    if result.path is not None:
        payload["path"] = str(result.path)
    if result.data is not None:
        payload.update(result.data)
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=False))
    return 0 if result.ok else 1


def fail(reason: str, detail: str = "", *, path: Path | None = None) -> WriterResult:
    return WriterResult(ok=False, path=path, errors=[_error(reason, detail)])


def with_result_data(result: WriterResult, **data: Any) -> WriterResult:
    merged = dict(result.data or {})
    merged.update(data)
    return WriterResult(ok=result.ok, path=result.path, changed=result.changed, errors=result.errors, data=merged)


def shell_join(argv: list[str]) -> str:
    return " ".join(shlex.quote(item) for item in argv)


def fail_if_artifact_exists(path: Path, *, force: bool) -> WriterResult | None:
    if force:
        return None
    if path.is_file() and path.stat().st_size > 0:
        return fail("artifact_already_exists", "如需覆盖现有产物，请显式传 --force", path=path)
    return None


def resolve_workspace(explicit: str | Path | None = None) -> Path:
    if explicit is not None:
        workspace = Path(explicit).expanduser().resolve(strict=False)
        state = workspace / ".autobizdevops" / "state.json"
        if not state.is_file():
            raise WriterError(f"state.json 未找到: {state}")
        return workspace
    try:
        return get_plugin_output_workspace()
    except ValueError as exc:
        raise WriterError(str(exc)) from exc


def resolve_feature(explicit: str | None = None, *, env: dict[str, str] | None = None) -> str:
    values = os.environ if env is None else env
    provided = (explicit or "").strip()
    env_feature = str(values.get("FEATURE_ID", "") or "").strip()
    if provided and env_feature and provided != env_feature:
        raise WriterError(f"--feature 与 FEATURE_ID 不一致: --feature={provided} FEATURE_ID={env_feature}")
    feature = provided or env_feature
    if not feature:
        raise WriterError("feature 不能为空；请传 --feature 或设置 FEATURE_ID")
    if Path(feature).is_absolute() or ".." in Path(feature).parts or "/" in feature or "\\" in feature:
        raise WriterError(f"feature 不能包含路径分隔符: {feature}")
    return feature


def feature_dir(workspace: Path, feature: str) -> Path:
    return workspace / ".autobizdevops" / "features" / feature


def artifact_path(workspace: Path, feature: str, name: str) -> Path:
    return feature_dir(workspace, feature) / name


def load_json(path: Path, *, default: Any | None = None) -> Any:
    if not path.is_file() or path.stat().st_size <= 0:
        if default is not None:
            return default
        raise WriterError(f"JSON 产物不存在: {path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as exc:
        raise _encoding_error(
            f"JSON 文件 {path}",
            f"第 {exc.start} 个字节不是有效 UTF-8",
        ) from exc
    except json.JSONDecodeError as exc:
        raise WriterError(f"JSON 产物格式错误: {path}:{exc}") from exc
    _reject_unicode_surrogates(data, source=f"JSON 文件 {path}")
    return data


def require_finalized_plan(workspace: Path, feature: str) -> WriterResult | None:
    path = artifact_path(workspace, feature, "plan.json")
    data = load_json(path)
    if not isinstance(data, dict) or data.get("taskSetStatus") != "finalized":
        return fail("plan_task_set_not_finalized", path=path)
    return None


def atomic_write_json(path: Path, data: Any) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2, sort_keys=False) + "\n"
    _ensure_utf8_encodable(content, source=f"写入 {path}")
    old = path.read_text(encoding="utf-8") if path.is_file() else None
    if old == content:
        return False
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=".autobiz-", suffix=".tmp", delete=False
    ) as handle:
        tmp_path = Path(handle.name)
        handle.write(content)
    tmp_path.replace(path)
    return True


def write_text(path: Path, content: str) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not content.endswith("\n"):
        content += "\n"
    _ensure_utf8_encodable(content, source=f"写入 {path}")
    old = path.read_text(encoding="utf-8") if path.is_file() else None
    if old == content:
        return False
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=".autobiz-", suffix=".tmp", delete=False
    ) as handle:
        tmp_path = Path(handle.name)
        handle.write(content)
    tmp_path.replace(path)
    return True


def next_numbered_id(existing: list[str] | set[str], prefix: str, width: int = 3) -> str:
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d{{{width}}})$")
    highest = 0
    for value in existing:
        match = pattern.fullmatch(str(value))
        if match:
            highest = max(highest, int(match.group(1)))
    return f"{prefix}-{highest + 1:0{width}d}"


def string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise WriterError("字段必须是字符串数组")
    result: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise WriterError("字段必须是非空字符串数组")
        result.append(item.strip())
    return result


def parse_json_value(raw: str) -> Any:
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WriterError(f"参数不是合法 JSON: {raw}") from exc
    _reject_unicode_surrogates(data, source="命令行 JSON 参数")
    return data


def read_object_file(path: str | Path) -> dict[str, Any]:
    data = load_json(Path(path).expanduser().resolve(strict=False))
    if not isinstance(data, dict):
        raise WriterError(f"JSON 文件顶层必须是 object: {path}")
    return data


def read_object_stdin() -> dict[str, Any]:
    raw_bytes = sys.stdin.buffer.read()
    if not raw_bytes.strip():
        raise WriterError("stdin 为空；请通过 stdin 传入单个 JSON object")
    try:
        raw = raw_bytes.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise _encoding_error(
            "stdin",
            f"第 {exc.start} 个字节不是有效 UTF-8",
        ) from exc
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WriterError(f"stdin 不是合法 JSON: {exc}") from exc
    _reject_unicode_surrogates(data, source="stdin JSON")
    if not isinstance(data, dict):
        raise WriterError("stdin JSON 顶层必须是 object")
    return data


def _encoding_error(source: str, cause: str) -> WriterEncodingError:
    return WriterEncodingError(
        f"{source} 编码错误：{cause}。原因：非 UTF-8 输入会把中文路径解码成 "
        "Unicode surrogate；损坏的 JSON Unicode 转义也会产生同样的问题，之后无法安全写入 "
        "UTF-8 计划文件。修复：将 JSON 以 UTF-8 字节重新传入；不要使用 python -c、echo "
        "或系统默认编码拼接含中文 JSON。"
        "请改用 UTF-8 JSON 文件配合 --body-file，或让宿主直接以 UTF-8 bytes 传给 "
        "--body-stdin。"
    )


def _first_surrogate_path(value: Any, path: str = "$") -> str | None:
    if isinstance(value, str):
        for index, character in enumerate(value):
            if 0xD800 <= ord(character) <= 0xDFFF:
                return f"{path}[{index}]"
        return None
    if isinstance(value, list):
        for index, item in enumerate(value):
            found = _first_surrogate_path(item, f"{path}[{index}]")
            if found is not None:
                return found
        return None
    if isinstance(value, dict):
        for key, item in value.items():
            key_path = _first_surrogate_path(key, f"{path}.<key>")
            if key_path is not None:
                return key_path
            found = _first_surrogate_path(item, f"{path}.{key}")
            if found is not None:
                return found
    return None


def _reject_unicode_surrogates(value: Any, *, source: str) -> None:
    path = _first_surrogate_path(value)
    if path is not None:
        raise _encoding_error(source, f"JSON 在 {path} 包含 Unicode surrogate")


def _ensure_utf8_encodable(content: str, *, source: str) -> None:
    try:
        content.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise _encoding_error(source, "内容包含无法编码为 UTF-8 的 Unicode surrogate") from exc


def parse_postcheck_output(output: str, *, fallback_message: str = "") -> list[dict[str, Any]]:
    errors: list[dict[str, Any]] = []
    for raw_line in output.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = POSTCHECK_FAIL_RE.match(line)
        if match:
            detail = match.group("detail").strip()
            error = {
                "skill": match.group("skill"),
                "reason": match.group("reason"),
                "detail": detail,
            }
            raw_payload = match.group("payload")
            if raw_payload:
                try:
                    payload = json.loads(raw_payload)
                except json.JSONDecodeError:
                    payload = None
                if isinstance(payload, dict):
                    for field in POSTCHECK_PAYLOAD_FIELDS:
                        value = payload.get(field)
                        if isinstance(value, str) and value:
                            error[field] = value
                    diagnostics = payload.get("diagnostics")
                    if isinstance(diagnostics, dict):
                        error["diagnostics"] = diagnostics
            errors.append(error)
        elif line.startswith("POST_SKILL_FAIL"):
            errors.append(_error("postcheck_failure", line))
    if not errors and fallback_message:
        errors.append(_error("postcheck_failure", fallback_message))
    return errors


def capture_stdout(func: Callable[[], tuple[int, str]]) -> tuple[int, str, str]:
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        code, message = func()
    return code, message, output.getvalue()
