"""Read-only rules extracted from hooks/code_task_context.py. See provenance.json."""
from __future__ import annotations
import re
from pathlib import Path
from typing import Any
from hooks.spec_contract import spec_heading
from hooks.source_context import load_source_context, source_index
class WriterError(ValueError): pass

ANCHOR_RE = re.compile(r"^(REQ|SCN|API|DATA|D)-\d{3}$")


def _split_ref(ref: str) -> tuple[str, str]:
    path_part, marker, anchor = ref.partition("#")
    if not marker or not anchor.strip():
        raise WriterError(f"引用缺少 anchor: {ref}")
    anchor = anchor.strip()
    if not ANCHOR_RE.fullmatch(anchor):
        raise WriterError(f"引用 anchor 格式非法: {ref}")
    return path_part.strip(), anchor


def _inside_base(candidate: Path, base: Path) -> bool:
    try:
        candidate.relative_to(base)
        return True
    except ValueError:
        return False


def _safe_ref_path(base: Path, raw_path: str, ref: str) -> Path:
    if not raw_path:
        raise WriterError(f"引用缺少相对路径: {ref}")
    path = Path(raw_path)
    if path.is_absolute():
        raise WriterError(f"引用必须是产物目录相对路径，不允许绝对路径: {ref}")
    candidate = (base / path).resolve(strict=False)
    resolved_base = base.resolve(strict=False)
    if not _inside_base(candidate, resolved_base):
        raise WriterError(f"引用路径越界: {ref}")
    return candidate


def _line_number(text: str, offset: int) -> int:
    return text.count("\n", 0, offset) + 1


def _find_unique_anchor_file(base: Path, anchor: str, *, design: bool) -> Path:
    if design:
        return base / "design.md"
    candidates = sorted((base / "specs").glob("**/*.md"))
    matches: list[Path] = []
    for candidate in candidates:
        try:
            text = candidate.read_text(encoding="utf-8")
        except OSError:
            continue
        if _extract_spec_snippet(text, anchor) is not None:
            matches.append(candidate)
    if len(matches) == 1:
        return matches[0]
    if not matches:
        raise WriterError(f"短引用未找到 anchor: #{anchor}")
    raise WriterError(f"短引用 anchor 不唯一: #{anchor}")


def _resolve_path(base: Path, ref: str, anchor: str, *, design: bool) -> Path:
    raw_path, _ = _split_ref(ref)
    if not raw_path:
        return _find_unique_anchor_file(base, anchor, design=design).resolve(strict=False)
    return _safe_ref_path(base, raw_path, ref)


def _extract_spec_snippet(text: str, anchor: str) -> tuple[str, int] | None:
    if not anchor.startswith(("REQ-", "SCN-")):
        return None
    match = spec_heading(text, anchor)
    if not match:
        return None
    # Stop at the next peer or enclosing section, including mixed ID styles.
    end_re = re.compile(r"^#{1,4}\s+\S", re.MULTILINE)
    end_match = end_re.search(text, match.end())
    end = end_match.start() if end_match else len(text)
    snippet = text[match.start() : end].strip()
    return snippet, _line_number(text, match.start())


def _extract_design_snippet(text: str, anchor: str) -> tuple[str, int] | None:
    lines = text.splitlines()
    row_re = re.compile(rf"^\|\s*{re.escape(anchor)}\s*\|")
    for index, line in enumerate(lines):
        if not row_re.match(line):
            continue
        heading = index
        while heading > 0 and not re.match(r"^#{2,}\s+", lines[heading]):
            heading -= 1
        start = min(max(heading, 0), max(index - 2, 0))
        end = min(len(lines), index + 1)
        return "\n".join(lines[start:end]).strip(), index + 1
    return None


def _relative_to_base(path: Path, base: Path) -> str:
    try:
        return path.resolve(strict=False).relative_to(base.resolve(strict=False)).as_posix()
    except ValueError:
        return str(path)


def _resolve_refs(base: Path, refs: list[str], *, design: bool) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    resolved: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    seen: set[str] = set()
    for ref in refs:
        if ref in seen:
            continue
        seen.add(ref)
        try:
            raw_path, anchor = _split_ref(ref)
            if design and not (anchor.startswith("API-") or anchor.startswith("DATA-") or anchor.startswith("D-")):
                raise WriterError(f"designRefs 只允许 API/DATA/D anchor: {ref}")
            if not design and not (anchor.startswith("REQ-") or anchor.startswith("SCN-")):
                raise WriterError(f"specRefs 只允许 REQ/SCN anchor: {ref}")
            path = _resolve_path(base, ref, anchor, design=design)
        except WriterError as exc:
            errors.append({"reason": "invalid_artifact_ref", "detail": f"{ref}: {exc}"})
            resolved.append({"ref": ref, "found": False, "error": "invalid_artifact_ref"})
            continue

        item: dict[str, Any] = {
            "ref": ref,
            "path": _relative_to_base(path, base),
            "absolutePath": str(path),
            "anchor": anchor,
            "found": False,
        }
        if not path.is_file():
            errors.append({"reason": "missing_ref_file", "detail": ref})
            item["error"] = "missing_ref_file"
            resolved.append(item)
            continue

        text = path.read_text(encoding="utf-8")
        extracted = _extract_design_snippet(text, anchor) if design else _extract_spec_snippet(text, anchor)
        if extracted is None:
            errors.append({"reason": "missing_ref_anchor", "detail": ref})
            item["error"] = "missing_ref_anchor"
            resolved.append(item)
            continue
        snippet, line = extracted
        item.update({"found": True, "line": line, "text": snippet, "sourcePathWasExplicit": bool(raw_path)})
        resolved.append(item)
    return resolved, errors


def resolve_task_refs(base: Path, task: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, str]]]:
    spec_refs = [ref for ref in task.get("specRefs", []) if isinstance(ref, str)]
    design_refs = [ref for ref in task.get("designRefs", []) if isinstance(ref, str)]
    for field in ("apiIds", "dataIds", "decisionIds"):
        design_refs.extend(f"design.md#{value}" for value in task.get(field, []) if isinstance(value, str))
    resolved_specs, spec_errors = _resolve_refs(base, spec_refs, design=False)
    resolved_design, design_errors = _resolve_refs(base, design_refs, design=True)
    return resolved_specs, resolved_design, spec_errors + design_errors
