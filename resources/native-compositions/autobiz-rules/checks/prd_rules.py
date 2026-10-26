"""Read-only rules extracted from skills/autobiz/hooks/prd_rules.py. See provenance.json."""
from __future__ import annotations
import re
from dataclasses import dataclass
from typing import List, Sequence, Union

REQUIRED_PRD_SECTIONS = ("外部资料与实现约束",)


FORMAL_SECTION_MAX_LEVEL = 3


PENDING_MARKER = "【待确认】"


_HEADING_RE = re.compile(r"^ {0,3}(#{1,6})\s+(.*?)\s*$")


_FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


@dataclass(frozen=True)
class Heading:
    level: int
    text: str
    line_index: int


def iter_headings(source: Union[str, Sequence[str]]) -> List[Heading]:
    """提取 Markdown 标题，忽略围栏代码块内的标题示例。"""
    lines = source.split("\n") if isinstance(source, str) else list(source)
    headings: List[Heading] = []
    fence = None
    for index, line in enumerate(lines):
        fence_match = _FENCE_RE.match(line)
        if fence_match:
            marker = fence_match.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence):
                fence = None
            continue
        if fence is not None:
            continue
        heading_match = _HEADING_RE.match(line)
        if heading_match:
            headings.append(
                Heading(len(heading_match.group(1)), heading_match.group(2), index)
            )
    return headings


def pending_marker_lines(content: str) -> List[int]:
    """返回残留 `【待确认】` 的 1-based 行号，供报错直接定位。"""
    return [
        index + 1
        for index, line in enumerate(content.split("\n"))
        if PENDING_MARKER in line
    ]
