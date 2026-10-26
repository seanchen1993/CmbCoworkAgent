"""Read-only rules extracted from hooks/plan_granularity.py. See provenance.json."""
from __future__ import annotations
import re
from typing import Any

SCN_SUBSTRING = re.compile(r"SCN-\d{3}")


def _has_ambiguous_scenario_reference(spec_refs: list[str]) -> bool:
    """Ranges and bare IDs make the downstream coverage set unreliable."""
    for raw_ref in spec_refs:
        if not isinstance(raw_ref, str):
            continue
        stripped = raw_ref.strip()
        path_part, separator, anchor = stripped.partition("#")
        if not separator:
            continue
        scenario_ids = SCN_SUBSTRING.findall(anchor)
        if not scenario_ids:
            continue
        if not path_part.strip() or len(scenario_ids) != 1 or anchor.strip() != scenario_ids[0]:
            return True
    return False


def validate_plan_task_grouping_item(task: dict[str, Any], *, task_id: str) -> list[dict[str, Any]]:
    """Reject only references that would falsely mark a scenario as covered."""
    raw_refs = task.get("specRefs")
    spec_refs = raw_refs if isinstance(raw_refs, list) else []
    if not _has_ambiguous_scenario_reference(spec_refs):
        return []
    return [{
        "reason": "invalid_plan_task_scenario_reference",
        "detail": f"task={task_id} scenario refs must be individually expanded and fully qualified",
        "taskId": task_id,
        "field": "specRefs",
        "repairTarget": "task_group",
        "violations": [{
            "code": "scenario_reference_not_fully_qualified",
            "expected": "one_fully_qualified_scenario_ref_per_item",
        }],
    }]


def validate_plan_task_granularity_item(task: dict[str, Any], *, task_id: str) -> list[dict[str, Any]]:
    """Compatibility entry point for the stage gate; Plan v2 has no size gate."""
    return validate_plan_task_grouping_item(task, task_id=task_id)
