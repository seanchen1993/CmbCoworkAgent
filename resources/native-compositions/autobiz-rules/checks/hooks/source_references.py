"""Read-only rules extracted from hooks/source_references.py. See provenance.json."""
from __future__ import annotations
import re
from dataclasses import dataclass

SOURCE_SECTION_TITLE = "外部资料与实现约束"


SOURCE_ID_RE = re.compile(r"\bSRC-\d{3}\b")


_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*$")


_SEPARATOR_CELL_RE = re.compile(r"^:?-{3,}:?$")


_EMPTY_VALUES = {"", "-", "—", "无", "none", "n/a", "na", "不适用"}


@dataclass(frozen=True)
class SourceReference:
    source_id: str
    kind: str
    name: str
    locator: str
    scope: str
    status: str

    @property
    def is_external_interface(self) -> bool:
        normalized = re.sub(r"[\s_-]+", "", self.kind).casefold()
        return (
            "外部接口" in normalized
            or "第三方接口" in normalized
            or "externalapi" in normalized
            or (("外部" in normalized or "第三方" in normalized) and "api" in normalized)
        )


def _normalize_header(value: str) -> str:
    return re.sub(r"[\s`*_]+", "", value).casefold()


def _table_cells(line: str) -> list[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return []
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def _section_body(text: str) -> str | None:
    lines = text.splitlines()
    start = None
    level = None
    for index, line in enumerate(lines):
        match = _HEADING_RE.match(line)
        if match and SOURCE_SECTION_TITLE in match.group(2):
            start = index + 1
            level = len(match.group(1))
            break
    if start is None or level is None:
        return None

    end = len(lines)
    for index in range(start, len(lines)):
        match = _HEADING_RE.match(lines[index])
        if match and len(match.group(1)) <= level:
            end = index
            break
    return "\n".join(lines[start:end]).strip()


def has_source_section(text: str) -> bool:
    return _section_body(text) is not None


def extract_source_references(text: str) -> list[SourceReference]:
    """Return valid ``SRC-NNN`` rows from the PRD source table.

    Unknown columns are ignored.  The parser intentionally accepts a few
    header aliases so wording can evolve without weakening stable-ID checks.
    Invalid rows are reported by :func:`validate_source_reference_section`.
    """

    body = _section_body(text)
    if body is None:
        return []

    lines = body.splitlines()
    header_index = None
    headers: list[str] = []
    for index, line in enumerate(lines):
        cells = _table_cells(line)
        normalized = {_normalize_header(cell) for cell in cells}
        if cells and {"id", "类型"}.issubset(normalized):
            header_index = index
            headers = [_normalize_header(cell) for cell in cells]
            break
    if header_index is None:
        return []

    aliases = {
        "source_id": {"id", "资料id", "sourceid"},
        "kind": {"类型", "资料类型", "type"},
        "name": {"名称", "资料名称", "name"},
        "locator": {"地址/路径", "地址路径", "地址", "路径", "url/path", "locator"},
        "scope": {"约束范围", "关联需求", "适用范围", "scope"},
        "status": {"状态", "status"},
    }
    positions: dict[str, int] = {}
    for field, names in aliases.items():
        for index, header in enumerate(headers):
            if header in names:
                positions[field] = index
                break

    references: list[SourceReference] = []
    for line in lines[header_index + 1 :]:
        cells = _table_cells(line)
        if not cells:
            continue
        if all(_SEPARATOR_CELL_RE.match(cell.replace(" ", "")) for cell in cells):
            continue

        def value(field: str) -> str:
            index = positions.get(field)
            return cells[index].strip() if index is not None and index < len(cells) else ""

        source_match = SOURCE_ID_RE.fullmatch(value("source_id"))
        if source_match is None:
            continue
        references.append(
            SourceReference(
                source_id=source_match.group(0),
                kind=value("kind"),
                name=value("name"),
                locator=value("locator"),
                scope=value("scope"),
                status=value("status"),
            )
        )
    return references


def split_source_reference_section(text: str) -> tuple[list[str], list[str]]:
    """Return ``(errors, warnings)`` for the PRD-owned source index.

    Only the checks that keep downstream ``SRC-NNN`` references resolvable
    block.  Field completeness on non-interface rows is advisory: the skill
    text only demands full fields for 外部接口 / 第三方接口 rows.
    """

    body = _section_body(text)
    if body is None:
        return (
            [
                f"PRD.md 缺少必要段落: {SOURCE_SECTION_TITLE}；"
                "修复：新增该章节，没有外部资料时正文写「无」"
            ],
            [],
        )

    lowered = body.strip().casefold()
    if lowered in _EMPTY_VALUES:
        return [], []

    references = extract_source_references(text)
    errors: list[str] = []
    warnings: list[str] = []
    if not references:
        return (
            [
                f"{SOURCE_SECTION_TITLE} 必须写“无”，或使用包含 ID、类型、名称、地址/路径、"
                "约束范围、状态的表格；修复：补齐表头后每行以 SRC-NNN 开头"
            ],
            [],
        )

    ids = [reference.source_id for reference in references]
    duplicates = sorted({source_id for source_id in ids if ids.count(source_id) > 1})
    if duplicates:
        errors.append(
            f"外部资料 ID 重复: {', '.join(duplicates)}；"
            "修复：SRC-NNN 是跨阶段稳定引用，重复项改用未使用的编号"
        )

    for reference in references:
        missing = []
        if reference.kind.casefold() in _EMPTY_VALUES:
            missing.append("类型")
        if reference.name.casefold() in _EMPTY_VALUES:
            missing.append("名称")
        if reference.locator.casefold() in _EMPTY_VALUES:
            missing.append("地址/路径")
        if reference.scope.casefold() in _EMPTY_VALUES:
            missing.append("约束范围")
        if reference.status.casefold() in _EMPTY_VALUES:
            missing.append("状态")

        if reference.is_external_interface:
            if missing:
                errors.append(
                    f"{reference.source_id} 是外部接口，缺少字段: {', '.join(missing)}；"
                    "修复：补齐后续阶段据以调用的地址/路径、约束范围与状态"
                )
        elif missing:
            warnings.append(f"{reference.source_id} 缺少字段: {', '.join(missing)}")
    return errors, warnings
