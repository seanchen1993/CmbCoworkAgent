"""Read-only rules extracted from hooks/plan_scope.py. See provenance.json."""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any, NamedTuple
from hooks.implementation_scope import scope_path
from hooks.spec_contract import SPEC_SCENARIO_DEF_RE
from hooks.design_contract_lock import load_confirmed_design_contract
from hooks.source_context import load_source_context, source_index

SCOPE_KINDS = {
    "scenario": ("includedScenarioRefs", "deferredScenarioRefs", "Scenario 引用"),
    "design": ("includedDesignIds", "deferredDesignIds", "Design ID"),
    "source": ("includedSourceRefs", "deferredSourceRefs", "来源要求 ID"),
}


class ScopeSelection(NamedTuple):
    """What the current round must cover, what it defers, what it never named."""

    included: set[str]
    deferred: set[str]
    unpartitioned: set[str]


def _scope_error(reason: str, detail: str, field: str, suggestion: str) -> dict[str, Any]:
    return {
        "reason": reason,
        "detail": detail,
        "field": field,
        "repairTarget": "implementation_scope",
        "repairSuggestion": suggestion,
    }


def _ref_set(value: Any, field: str) -> tuple[set[str], list[dict[str, Any]]]:
    if value is None:
        return set(), []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return set(), [_scope_error(
            "implementation_scope_partition_must_be_string_array",
            f"field={field}",
            field,
            f"把 IMPLEMENTATION_SCOPE.json 的 {field} 写成字符串数组，每项一个 ID/引用",
        )]
    return {item.strip() for item in value if item.strip()}, []


class PlanScope:
    """The included/deferred partition a Feature declared, if it declared one."""

    def __init__(self, partitions: dict[str, tuple[set[str], set[str]]]):
        self._partitions = partitions

    def declares(self, kind: str) -> bool:
        return kind in self._partitions

    @property
    def declared_kinds(self) -> list[str]:
        return sorted(self._partitions)

    def select(self, kind: str, universe: set[str]) -> tuple[ScopeSelection, list[dict[str, Any]]]:
        """Split ``universe`` into what this round covers, defers and never named."""

        universe = set(universe)
        if kind not in self._partitions:
            return ScopeSelection(universe, set(), set()), []
        included, deferred = self._partitions[kind]
        included_field, deferred_field, label = SCOPE_KINDS[kind]
        errors: list[dict[str, Any]] = []
        unknown = sorted((included | deferred) - universe)
        if unknown:
            errors.append(_scope_error(
                "implementation_scope_unknown_ref",
                f"kind={kind};ids={','.join(unknown)}",
                included_field,
                (
                    f"IMPLEMENTATION_SCOPE.json 声明了不存在的 {label}：{', '.join(unknown)}。"
                    f"从 {included_field} / {deferred_field} 中删除这些条目，或到上游产物补回对应定义"
                ),
            ))
        return (
            ScopeSelection(
                included & universe,
                deferred & universe,
                universe - included - deferred,
            ),
            errors,
        )


def load_plan_scope(feature_dir: Path) -> tuple[PlanScope, list[dict[str, Any]]]:
    """Read the optional partition. Shape problems block; a missing file does not."""

    path = scope_path(feature_dir)
    if not path.is_file():
        return PlanScope({}), []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # load_scope() already reports unreadable scope files; do not double-report.
        return PlanScope({}), []
    if not isinstance(payload, dict):
        return PlanScope({}), []
    return partition_from_payload(payload)


def partition_from_payload(payload: dict[str, Any]) -> tuple[PlanScope, list[dict[str, Any]]]:
    partitions: dict[str, tuple[set[str], set[str]]] = {}
    errors: list[dict[str, Any]] = []
    for kind in sorted(SCOPE_KINDS):
        included_field, deferred_field, label = SCOPE_KINDS[kind]
        raw_included = payload.get(included_field)
        raw_deferred = payload.get(deferred_field)
        if raw_included is None and raw_deferred is None:
            continue
        included, included_errors = _ref_set(raw_included, included_field)
        deferred, deferred_errors = _ref_set(raw_deferred, deferred_field)
        errors.extend(included_errors)
        errors.extend(deferred_errors)
        if included_errors or deferred_errors:
            continue
        overlap = sorted(included & deferred)
        if overlap:
            errors.append(_scope_error(
                "implementation_scope_partition_overlap",
                f"kind={kind};ids={','.join(overlap)}",
                included_field,
                (
                    f"这些 {label} 同时出现在 {included_field} 和 {deferred_field}："
                    f"{', '.join(overlap)}。每条只能归属一侧，从其中一个数组里删除"
                ),
            ))
            continue
        partitions[kind] = (included, deferred)
    return PlanScope(partitions), errors


def scope_report(selections: dict[str, ScopeSelection]) -> dict[str, Any]:
    """Report what the round defers, so deferred work stays visible without tasks."""

    report: dict[str, Any] = {}
    for kind, selection in sorted(selections.items()):
        if not selection.deferred and not selection.unpartitioned:
            continue
        report[kind] = {
            "includedCount": len(selection.included),
            "deferred": sorted(selection.deferred),
            "unpartitioned": sorted(selection.unpartitioned),
        }
    return report


def resolve_plan_scope(feature_dir: Path) -> tuple[dict[str, ScopeSelection], list[dict[str, Any]]]:
    """Use the same coverage universe in publishing and stage validation."""
    scope, errors = load_plan_scope(feature_dir)
    scenarios: set[str] = set()
    for spec in sorted((feature_dir / "specs").glob("**/*.md")):
        scenarios.update(
            f"{spec.relative_to(feature_dir).as_posix()}#{anchor}"
            for anchor in SPEC_SCENARIO_DEF_RE.findall(spec.read_text(encoding="utf-8"))
        )
    # Plan must use the Design snapshot already accepted by dev.design.  Reading
    # design.md here would let an unvalidated edit silently narrow Plan
    # coverage after the lock was produced.
    design_contract, design_errors = load_confirmed_design_contract(feature_dir, feature_dir.name)
    errors.extend(design_errors)
    design_ids = {
        value
        for kind in ("API", "DATA", "D")
        for value in design_contract.get("ids", {}).get(kind, set())
        if isinstance(value, str)
    }
    context, source_errors = load_source_context(feature_dir)
    errors.extend({"reason": "invalid_source_context", "detail": error} for error in source_errors)
    source_ids = set(source_index(context))
    selections: dict[str, ScopeSelection] = {}
    for kind, universe in (
        ("scenario", scenarios),
        ("design", design_ids),
        ("source", source_ids),
    ):
        selections[kind], issues = scope.select(kind, universe)
        errors.extend(issues)
    return selections, errors
