#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""The one Plan-v2 guard that protects scenario coverage accounting."""

from __future__ import annotations

import re
from typing import Any


SCN_SUBSTRING = re.compile(r"SCN-\d{3}")

# Legacy writer subcommands still import these names to describe their own
# retired input formats.  Plan v2 never consumes them and therefore has no
# corresponding cardinality gate.
PLAN_TASK_MAX_SCENARIOS = 1_000_000
PLAN_TASK_MAX_APIS = 1_000_000
PLAN_TASK_MAX_UI_PAGES = 1_000_000
PLAN_TASK_MAX_UI_INTERACTIONS = 1_000_000
PLAN_TASK_MATRIX_MAX_SCENARIOS = 1_000_000
PLAN_TASK_HARD_MAX_APIS = 1_000_000
PLAN_TASK_HARD_MAX_UI_PAGES = 1_000_000
PLAN_TASK_HARD_MAX_UI_INTERACTIONS = 1_000_000
PLAN_TASK_SPLIT_RATIONALE_MIN_LENGTH = 0
PLAN_TASK_SPLIT_RATIONALE_MIN_IDS_BY_PREFIX: dict[str, int] = {}


def scenario_refs_from_spec_refs(spec_refs: list[str]) -> set[str]:
    """Return normalized scenario references from a task's spec references."""
    refs: set[str] = set()
    for raw_ref in spec_refs:
        if not isinstance(raw_ref, str):
            continue
        stripped = raw_ref.strip()
        if not stripped:
            continue
        path_part, separator, anchor = stripped.partition("#")
        if not separator:
            continue
        scenario_ids = SCN_SUBSTRING.findall(anchor)
        normalized_path = path_part.strip().replace("\\", "/")
        for scenario_id in scenario_ids:
            refs.add(f"{normalized_path}#{scenario_id}" if normalized_path else scenario_id)
    return refs


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
