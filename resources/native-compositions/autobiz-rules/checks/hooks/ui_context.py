"""Read-only rules extracted from hooks/ui_context.py. See provenance.json."""
from __future__ import annotations
import json
import re
from pathlib import Path
from typing import Any

UI_CONTEXT_VERSION = 1


UI_CONTEXT_NAME = "UI_CONTEXT.json"


DECISION_STATUSES = {"defaulted", "confirmed", "locked"}


DECISION_SOURCES = {"user_confirmed", "prd_inferred", "default_false", "legacy_import"}


VISUAL_SOURCE_TYPES = {"high_fidelity_html", "standard_html", "design_link", "prototype_link", "image", "other"}


FRONTEND_ROUTES = {"none", "spec-driven-ui", "absolute-html", "standard-html", "missing-html"}


VISUAL_SOURCE_ROUTES = FRONTEND_ROUTES - {"none"}


PAGE_ID_RE = re.compile(r"^PAGE-\d{3}$")


INTERACTION_ID_RE = re.compile(r"^UIX-\d{3}$")


VISUAL_SOURCE_ID_RE = re.compile(r"^VIS-\d{3}$")


CAPABILITY_ID_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


REQ_ID_RE = re.compile(r"\bREQ-\d{3}\b")


SCN_ID_RE = re.compile(r"\bSCN-\d{3}\b")


SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


class UIContextError(ValueError):
    """Raised when UI_CONTEXT.json cannot be loaded."""


def ui_context_path(feature_dir: Path) -> Path:
    return feature_dir / UI_CONTEXT_NAME


def load_ui_context(feature_dir: Path) -> dict[str, Any] | None:
    path = ui_context_path(feature_dir)
    if not path.is_file() or path.stat().st_size <= 0:
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise UIContextError(f"invalid_ui_context_json:{path}:{exc}") from exc
    if not isinstance(data, dict):
        raise UIContextError(f"invalid_ui_context_root:{path}")
    return data


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    result: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        stripped = item.strip()
        if stripped:
            result.append(stripped)
    return result


def _object_list(value: Any) -> list[dict[str, Any]] | None:
    if not isinstance(value, list):
        return None
    if not all(isinstance(item, dict) for item in value):
        return None
    return value


def _validate_string_field(errors: list[str], item: dict[str, Any], field: str, context: str, *, required: bool = True) -> None:
    value = item.get(field)
    if value is None and not required:
        return
    if not isinstance(value, str) or not value.strip():
        errors.append(f"{context}.{field}_missing")


def _validate_string_array(
    errors: list[str],
    item: dict[str, Any],
    field: str,
    context: str,
    *,
    required: bool = False,
    item_re: re.Pattern[str] | None = None,
) -> list[str]:
    values = _string_list(item.get(field))
    if values is None:
        errors.append(f"{context}.{field}_must_be_string_array")
        return []
    if required and not values:
        errors.append(f"{context}.{field}_missing")
    if item_re is not None:
        for value in values:
            if not item_re.fullmatch(value):
                errors.append(f"{context}.{field}_invalid:{value}")
    return values


def validate_ui_context_data(
    data: Any,
    *,
    feature_id: str | None = None,
    require_confirmed: bool = False,
    require_locked: bool = False,
    defined_requirements: set[str] | None = None,
    defined_scenarios: set[str] | None = None,
) -> list[str]:
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["ui_context_root_must_be_object"]

    if data.get("version") != UI_CONTEXT_VERSION:
        errors.append("ui_context_invalid_version")
    raw_feature_id = data.get("featureId")
    if not isinstance(raw_feature_id, str) or not raw_feature_id.strip():
        errors.append("ui_context_missing_feature_id")
    elif feature_id and raw_feature_id != feature_id:
        errors.append(f"ui_context_feature_id_mismatch:{raw_feature_id}")

    ui_required = data.get("uiRequired")
    if not isinstance(ui_required, bool):
        errors.append("ui_context_uiRequired_must_be_bool")

    status = data.get("decisionStatus")
    if not isinstance(status, str) or status not in DECISION_STATUSES:
        errors.append("ui_context_invalid_decision_status")
    elif require_confirmed and status not in {"confirmed", "locked"}:
        errors.append("ui_context_not_confirmed")
    elif require_locked and status != "locked":
        errors.append("ui_context_not_locked")

    source = data.get("decisionSource")
    if source is not None and (not isinstance(source, str) or source not in DECISION_SOURCES):
        errors.append("ui_context_invalid_decision_source")

    for field in ("confirmedAtCheckpoint", "lockedAtCheckpoint"):
        value = data.get(field)
        if value is not None and (not isinstance(value, str) or not value.strip()):
            errors.append(f"ui_context_{field}_invalid")

    pages = _object_list(data.get("pages"))
    interactions = _object_list(data.get("interactions"))
    visual_sources = _object_list(data.get("visualSources"))
    capabilities = _object_list(data.get("capabilities"))
    for field, values in (
        ("pages", pages),
        ("interactions", interactions),
        ("visualSources", visual_sources),
        ("capabilities", capabilities),
    ):
        if values is None:
            errors.append(f"ui_context_{field}_must_be_array")

    pages = pages or []
    interactions = interactions or []
    visual_sources = visual_sources or []
    capabilities = capabilities or []

    if ui_required is True and not (pages or interactions or capabilities):
        errors.append("ui_context_required_without_ui_scope")
    if ui_required is True and (require_locked or status == "locked"):
        active_ui_capabilities = [
            capability for capability in capabilities if capability.get("uiRequired") is not False
        ]
        if not active_ui_capabilities:
            errors.append("ui_context_locked_without_ui_capability")
    if ui_required is False:
        reason = data.get("notApplicableReason")
        if not isinstance(reason, str) or not reason.strip():
            errors.append("ui_context_not_applicable_reason_missing")
        if any(cap.get("uiRequired") is True for cap in capabilities):
            errors.append("ui_context_false_has_ui_capability")

    page_ids: set[str] = set()
    for index, page in enumerate(pages):
        context = f"pages[{index}]"
        page_id = page.get("pageId")
        if not isinstance(page_id, str) or not PAGE_ID_RE.fullmatch(page_id):
            errors.append(f"{context}.pageId_invalid")
            continue
        if page_id in page_ids:
            errors.append(f"{context}.pageId_duplicate:{page_id}")
        page_ids.add(page_id)
        _validate_string_field(errors, page, "name", context)
        _validate_string_field(errors, page, "goal", context)
        _validate_string_field(errors, page, "routeHint", context, required=False)
        states = page.get("states")
        if states is not None and _string_list(states) is None:
            errors.append(f"{context}.states_must_be_string_array")

    interaction_ids: set[str] = set()
    for index, interaction in enumerate(interactions):
        context = f"interactions[{index}]"
        interaction_id = interaction.get("interactionId")
        if not isinstance(interaction_id, str) or not INTERACTION_ID_RE.fullmatch(interaction_id):
            errors.append(f"{context}.interactionId_invalid")
            continue
        if interaction_id in interaction_ids:
            errors.append(f"{context}.interactionId_duplicate:{interaction_id}")
        interaction_ids.add(interaction_id)
        page_id = interaction.get("pageId")
        if not isinstance(page_id, str) or page_id not in page_ids:
            errors.append(f"{context}.pageId_unknown:{page_id}")
        _validate_string_field(errors, interaction, "summary", context)
        if interaction.get("stateRefs") is not None and _string_list(interaction.get("stateRefs")) is None:
            errors.append(f"{context}.stateRefs_must_be_string_array")
        _validate_spec_refs(errors, interaction, context, defined_requirements, defined_scenarios, required=False)

    visual_source_ids: set[str] = set()
    for index, visual_source in enumerate(visual_sources):
        context = f"visualSources[{index}]"
        source_id = visual_source.get("sourceId")
        if not isinstance(source_id, str) or not VISUAL_SOURCE_ID_RE.fullmatch(source_id):
            errors.append(f"{context}.sourceId_invalid")
            continue
        if source_id in visual_source_ids:
            errors.append(f"{context}.sourceId_duplicate:{source_id}")
        visual_source_ids.add(source_id)
        source_type = visual_source.get("type")
        if not isinstance(source_type, str) or source_type not in VISUAL_SOURCE_TYPES:
            errors.append(f"{context}.type_invalid")
        _validate_string_field(errors, visual_source, "path", context)
        route = visual_source.get("route")
        if route is not None and (not isinstance(route, str) or route not in VISUAL_SOURCE_ROUTES):
            errors.append(f"{context}.route_invalid")
        required = visual_source.get("required")
        if required is not None and not isinstance(required, bool):
            errors.append(f"{context}.required_must_be_bool")
        for field in ("contentSha256", "bundleSha256"):
            digest = visual_source.get(field)
            if digest is not None and (not isinstance(digest, str) or not SHA256_RE.fullmatch(digest)):
                errors.append(f"{context}.{field}_invalid")

    capability_ids: set[str] = set()
    referenced_visual_source_ids: set[str] = set()
    for index, capability in enumerate(capabilities):
        context = f"capabilities[{index}]"
        capability_id = capability.get("capabilityId")
        if not isinstance(capability_id, str) or not CAPABILITY_ID_RE.fullmatch(capability_id):
            errors.append(f"{context}.capabilityId_invalid")
        elif capability_id in capability_ids:
            errors.append(f"{context}.capabilityId_duplicate:{capability_id}")
        else:
            capability_ids.add(capability_id)
        if capability.get("uiRequired") is not None and not isinstance(capability.get("uiRequired"), bool):
            errors.append(f"{context}.uiRequired_must_be_bool")
        for page_id in _validate_string_array(errors, capability, "pageRefs", context, required=False, item_re=PAGE_ID_RE):
            if page_id not in page_ids:
                errors.append(f"{context}.pageRef_unknown:{page_id}")
        for interaction_id in _validate_string_array(errors, capability, "interactionRefs", context, required=False, item_re=INTERACTION_ID_RE):
            if interaction_id not in interaction_ids:
                errors.append(f"{context}.interactionRef_unknown:{interaction_id}")
        visual_source_refs = (
            _validate_string_array(
                errors,
                capability,
                "visualSourceRefs",
                context,
                required=False,
                item_re=VISUAL_SOURCE_ID_RE,
            )
            if "visualSourceRefs" in capability
            else []
        )
        for source_id in visual_source_refs:
            if source_id not in visual_source_ids:
                errors.append(f"{context}.visualSourceRef_unknown:{source_id}")
            else:
                referenced_visual_source_ids.add(source_id)
        _validate_spec_refs(
            errors,
            capability,
            context,
            defined_requirements,
            defined_scenarios,
            required=require_locked or status == "locked",
        )

    if require_locked or status == "locked":
        for visual_source in visual_sources:
            source_id = visual_source.get("sourceId")
            if (
                isinstance(source_id, str)
                and visual_source.get("required") is True
                and isinstance(visual_source.get("contentSha256"), str)
                and source_id not in referenced_visual_source_ids
            ):
                errors.append(f"visualSources.required_archived_source_unbound:{source_id}")

    return errors


def _validate_spec_refs(
    errors: list[str],
    item: dict[str, Any],
    context: str,
    defined_requirements: set[str] | None,
    defined_scenarios: set[str] | None,
    *,
    required: bool,
) -> list[str]:
    if item.get("specRefs") is None and not required:
        return []
    spec_refs = _validate_string_array(errors, item, "specRefs", context, required=required)
    req_refs = set(REQ_ID_RE.findall(" ".join(spec_refs)))
    scn_refs = set(SCN_ID_RE.findall(" ".join(spec_refs)))
    if spec_refs and not req_refs:
        errors.append(f"{context}.specRefs_missing_requirement_id")
    if spec_refs and not scn_refs:
        errors.append(f"{context}.specRefs_missing_scenario_id")
    if defined_requirements is not None:
        for req_id in sorted(req_refs):
            if req_id not in defined_requirements:
                errors.append(f"{context}.specRefs_unknown_requirement:{req_id}")
    if defined_scenarios is not None:
        for scn_id in sorted(scn_refs):
            if scn_id not in defined_scenarios:
                errors.append(f"{context}.specRefs_unknown_scenario:{scn_id}")
    return spec_refs


def ui_context_indexes(data: dict[str, Any] | None) -> dict[str, set[str]]:
    if not isinstance(data, dict):
        return {"page": set(), "interaction": set(), "visualSource": set(), "capability": set()}
    return {
        "page": {
            item["pageId"]
            for item in data.get("pages", [])
            if isinstance(item, dict) and isinstance(item.get("pageId"), str)
        },
        "interaction": {
            item["interactionId"]
            for item in data.get("interactions", [])
            if isinstance(item, dict) and isinstance(item.get("interactionId"), str)
        },
        "visualSource": {
            item["sourceId"]
            for item in data.get("visualSources", [])
            if isinstance(item, dict) and isinstance(item.get("sourceId"), str)
        },
        "capability": {
            item["capabilityId"]
            for item in data.get("capabilities", [])
            if isinstance(item, dict) and isinstance(item.get("capabilityId"), str)
        },
    }
