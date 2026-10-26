"""Read-only rules extracted from hooks/spec_contract.py. See provenance.json."""
from __future__ import annotations
import re
from typing import Match, Optional, Pattern

def _definition(kind: str, prefix: str, level: int) -> Pattern[str]:
    return re.compile(
        rf"^{'#' * level}\s+{kind}\s+"
        rf"(?=\[?({prefix}-\d{{3}})\]?:\s+.+$)"
        rf"(?:\[{prefix}-\d{{3}}\]|{prefix}-\d{{3}}):\s+.+$",
        re.MULTILINE,
    )


SPEC_REQUIREMENT_DEF_RE = _definition("Requirement", "REQ", 3)


SPEC_SCENARIO_DEF_RE = _definition("Scenario", "SCN", 4)


def spec_heading(text: str, anchor: str) -> Optional[Match[str]]:
    pattern = SPEC_REQUIREMENT_DEF_RE if anchor.startswith("REQ-") else SPEC_SCENARIO_DEF_RE
    return next((match for match in pattern.finditer(text) if match.group(1) == anchor), None)
