"""Effective workflow compiler for base config plus profile overlays."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Iterable


BASE_WORKFLOW_PROFILE = "standard"
LEGACY_BASE_WORKFLOW_PROFILE = "base"
BASE_WORKFLOW_TEMPLATE = "standard"
LEGACY_CUSTOM_WORKFLOW_TEMPLATE = "custom"
LEGACY_CUSTOM_REQUIRED_NODES = ("dev.code", "ops.archive")
LEGACY_LEAN_WORKFLOW_TEMPLATE = "lean"
LEGACY_LEAN_NODES = ("dev.specs", "dev.code", "ops.archive")
ALLOWED_TEMPLATE_KINDS = frozenset({"profile", "nodeSubset", "custom"})
# 对外展示的模板类型名（内部 kind 保留编译语义，profile 对外呈现为 classical）。
TEMPLATE_TYPE_BY_KIND = {"profile": "classical"}
DEFAULT_ENABLED_DYNAMIC_PHASES = frozenset({"Biz", "Dev"})
ALLOWED_PHASES = frozenset({"Biz", "Dev", "Ops"})
ALLOWED_GUARDS = frozenset({"code_compile"})
ALLOWED_WORKFLOW_DECISIONS = frozenset({"enabled", "skipped"})
ALLOWED_DYNAMIC_STAGE_DEFAULTS = frozenset({"pending", "skip"})
ENABLED_WORKFLOW_DECISION = "enabled"
SKIPPED_WORKFLOW_DECISION = "skipped"
OVERLAY_RELATIVE_DIR = Path(".autobizdevops") / "workflow.d"
PLUGIN_OVERLAY_DIR_NAME = "workflow.d"
NEXT_ACTION_FIELDS = ("slashSkill", "userMessage", "dialogTips")
DERIVED_STATE_IDS = frozenset({"not_started", "in_progress", "done", "archived"})


class WorkflowCompileError(Exception):
    """Raised when workflow overlays cannot be compiled safely."""


def repo_root_for_config_path(config_path: Path) -> Path:
    return config_path.resolve().parent.parent


def default_config_path() -> Path:
    return Path(__file__).resolve().with_name("board_config.json")


def read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise WorkflowCompileError(f"invalid workflow JSON: {path}:{exc.lineno}:{exc.colno}") from exc
    if not isinstance(payload, dict):
        raise WorkflowCompileError(f"workflow JSON must be an object: {path}")
    return payload


def overlay_paths(repo_root: Path, workspace: Path | None) -> list[Path]:
    paths: list[Path] = []
    plugin_dir = repo_root / "board_core" / PLUGIN_OVERLAY_DIR_NAME
    if plugin_dir.is_dir():
        paths.extend(sorted(plugin_dir.glob("*.json")))
    if workspace is not None:
        workspace_dir = workspace.resolve() / OVERLAY_RELATIVE_DIR
        if workspace_dir.is_dir():
            paths.extend(sorted(workspace_dir.glob("*.json")))
    return paths


def _overlay_for_profile(payload: dict, path: Path, profile: str) -> dict | None:
    profiles = payload.get("profiles")
    if isinstance(profiles, dict):
        selected = profiles.get(profile)
        if selected is None:
            return None
        if not isinstance(selected, dict):
            raise WorkflowCompileError(f"workflow profile must be an object: {path}:{profile}")
        return selected

    declared_profile = payload.get("profile")
    if declared_profile is None:
        return payload if path.stem == profile else None
    if declared_profile == profile:
        return payload
    return None


def normalize_workflow_profile(profile: str | None) -> str:
    if profile is None:
        return BASE_WORKFLOW_PROFILE
    cleaned = str(profile).strip()
    if not cleaned or cleaned == LEGACY_BASE_WORKFLOW_PROFILE:
        return BASE_WORKFLOW_PROFILE
    return cleaned


def _configured_profile_overlay(base_config: dict, profile: str) -> dict | None:
    workflow = base_config.get("workflow")
    if not isinstance(workflow, dict):
        return None
    profiles = workflow.get("profiles")
    if not isinstance(profiles, dict):
        return None
    selected = profiles.get(profile)
    if selected is None:
        return None
    if not isinstance(selected, dict):
        raise WorkflowCompileError(f"workflow.profiles.{profile} must be an object")
    if profile == BASE_WORKFLOW_PROFILE and not selected.get("nodes"):
        return None
    return selected


def configured_profile_names(base_config: dict) -> tuple[str, ...]:
    workflow = base_config.get("workflow")
    if not isinstance(workflow, dict):
        return (BASE_WORKFLOW_PROFILE,)
    profiles = workflow.get("profiles")
    if not isinstance(profiles, dict):
        return (BASE_WORKFLOW_PROFILE,)
    names = [
        name
        for name in profiles
        if isinstance(name, str) and name.strip()
    ]
    if BASE_WORKFLOW_PROFILE not in names:
        names.insert(0, BASE_WORKFLOW_PROFILE)
    return tuple(dict.fromkeys(names))


def configured_profile_options(base_config: dict) -> list[dict[str, str]]:
    workflow = base_config.get("workflow")
    profiles = workflow.get("profiles", {}) if isinstance(workflow, dict) else {}
    profiles = profiles if isinstance(profiles, dict) else {}
    result: list[dict[str, str]] = []
    for profile in configured_profile_names(base_config):
        raw = profiles.get(profile, {})
        raw = raw if isinstance(raw, dict) else {}
        label = raw.get("label", profile)
        description = raw.get("description", "")
        result.append({
            "id": profile,
            "label": label if isinstance(label, str) and label.strip() else profile,
            "description": description if isinstance(description, str) else "",
        })
    return result


def normalize_workflow_template(template: str | None) -> str:
    if template is None:
        return BASE_WORKFLOW_TEMPLATE
    cleaned = str(template).strip()
    return cleaned or BASE_WORKFLOW_TEMPLATE


def _legacy_custom_template_spec(template: str) -> dict | None:
    if template != LEGACY_CUSTOM_WORKFLOW_TEMPLATE:
        return None
    return {
        "id": LEGACY_CUSTOM_WORKFLOW_TEMPLATE,
        "kind": "custom",
        "label": "自定义（旧版）",
        "description": "兼容旧 state.json 中已创建的 custom 流程；不再作为新建模板展示。",
        "nodes": [],
        "requiredNodes": list(LEGACY_CUSTOM_REQUIRED_NODES),
    }


def _legacy_lean_template_spec(template: str) -> dict | None:
    if template != LEGACY_LEAN_WORKFLOW_TEMPLATE:
        return None
    return {
        "id": LEGACY_LEAN_WORKFLOW_TEMPLATE,
        "kind": "nodeSubset",
        "label": "精简路线（暂时下架）",
        "description": "兼容已创建的 lean 流程；暂不作为新建模板展示。",
        "nodes": list(LEGACY_LEAN_NODES),
        "requiredNodes": [],
    }


def workflow_template_uses_nodes(base_config: dict, template: str | None) -> bool:
    """Whether this template stores a per-record workflowNodes list.

    The configured template registry intentionally does not expose the retired
    custom template, but existing state records with workflowTemplate=custom
    still need to retain their workflowNodes field.
    """
    template = normalize_workflow_template(template)
    if _legacy_custom_template_spec(template) is not None:
        return True
    return configured_workflow_templates(base_config).get(template, {}).get("kind") == "custom"


def configured_workflow_templates(base_config: dict) -> dict[str, dict]:
    """Validated workflow.templates registry; standard is always present."""
    workflow = base_config.get("workflow")
    raw = workflow.get("templates", {}) if isinstance(workflow, dict) else {}
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise WorkflowCompileError("workflow.templates must be an object")

    templates: dict[str, dict] = {}
    for template_id, spec in raw.items():
        if not isinstance(template_id, str) or not template_id.strip():
            raise WorkflowCompileError("workflow.templates keys must be non-empty strings")
        if not isinstance(spec, dict):
            raise WorkflowCompileError(f"workflow.templates.{template_id} must be an object")
        kind = spec.get("kind", "profile")
        if kind not in ALLOWED_TEMPLATE_KINDS:
            allowed = ", ".join(sorted(ALLOWED_TEMPLATE_KINDS))
            raise WorkflowCompileError(f"workflow.templates.{template_id}.kind must be one of: {allowed}")
        nodes = spec.get("nodes")
        if kind == "nodeSubset":
            if not isinstance(nodes, list) or not nodes or any(not isinstance(item, str) or not item for item in nodes):
                raise WorkflowCompileError(
                    f"workflow.templates.{template_id}.nodes must be a non-empty list of node ids"
                )
        elif nodes is not None:
            raise WorkflowCompileError(f"workflow.templates.{template_id}.nodes is only allowed for nodeSubset")
        required_nodes = spec.get("requiredNodes")
        if required_nodes is not None:
            if kind != "custom":
                raise WorkflowCompileError(
                    f"workflow.templates.{template_id}.requiredNodes is only allowed for custom"
                )
            if not isinstance(required_nodes, list) or any(
                not isinstance(item, str) or not item for item in required_nodes
            ):
                raise WorkflowCompileError(
                    f"workflow.templates.{template_id}.requiredNodes must be a list of node ids"
                )
        templates[template_id.strip()] = {
            "id": template_id.strip(),
            "kind": kind,
            "label": spec.get("label", template_id) if isinstance(spec.get("label", template_id), str) else template_id,
            "description": spec.get("description", "") if isinstance(spec.get("description", ""), str) else "",
            "nodes": list(nodes) if isinstance(nodes, list) else [],
            "requiredNodes": list(required_nodes) if isinstance(required_nodes, list) else [],
        }

    templates.setdefault(
        BASE_WORKFLOW_TEMPLATE,
        {
            "id": BASE_WORKFLOW_TEMPLATE,
            "kind": "profile",
            "label": "标准",
            "description": "完整主干流程。",
            "nodes": [],
            "requiredNodes": [],
        },
    )
    return templates


def configured_template_options(base_config: dict) -> list[dict[str, object]]:
    templates = configured_workflow_templates(base_config)
    workflow = base_config.get("workflow")
    base_nodes = workflow.get("nodes", []) if isinstance(workflow, dict) else []
    base_node_ids = [
        node["id"]
        for node in base_nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    ]

    def _display_nodes(template: dict) -> list[str]:
        if template["kind"] == "nodeSubset":
            return list(template["nodes"])
        if template["kind"] == "profile":
            return list(base_node_ids)
        return []  # custom: 由用户选择，UI 走 nodes/closure 端点

    ordered = [BASE_WORKFLOW_TEMPLATE] + [name for name in templates if name != BASE_WORKFLOW_TEMPLATE]
    options: list[dict[str, object]] = []
    for name in ordered:
        template = templates[name]
        option: dict[str, object] = {
            "id": template["id"],
            "templateType": TEMPLATE_TYPE_BY_KIND.get(template["kind"], template["kind"]),
            "label": template["label"],
            "description": template["description"],
            "nodes": _display_nodes(template),
        }
        # 固定链模板用 nodes 即可；只有 custom 需要锁定项。
        if template["kind"] == "custom":
            option["requiredNodes"] = list(template.get("requiredNodes", []))
        options.append(option)
    return options


def resolve_template_subset(
    base_config: dict,
    template: str | None,
    *,
    workflow_nodes: object = None,
) -> list[str] | None:
    """Resolve a template to its node subset, or None for full-workflow templates.

    nodeSubset templates take nodes from the registry; custom templates take
    them from the per-feature record (workflow_nodes).
    """
    template = normalize_workflow_template(template)
    registry = configured_workflow_templates(base_config)
    spec = registry.get(template)
    if spec is None:
        spec = _legacy_custom_template_spec(template)
    if spec is None:
        spec = _legacy_lean_template_spec(template)
    if spec is None:
        known = ", ".join(sorted(registry))
        raise WorkflowCompileError(f"unknown workflow template: {template}; known: {known}")

    if spec["kind"] == "profile":
        return None
    if spec["kind"] == "nodeSubset":
        return list(spec["nodes"])

    if workflow_nodes is None:
        workflow_nodes = []
    if not isinstance(workflow_nodes, list) or any(
        not isinstance(item, str) or not item.strip() for item in workflow_nodes
    ):
        raise WorkflowCompileError(f"workflow template {template} requires workflowNodes to be a list of node ids")
    merged_nodes = [item.strip() for item in workflow_nodes]
    for required_id in spec.get("requiredNodes", []):
        if required_id not in merged_nodes:
            merged_nodes.append(required_id)
    if not merged_nodes:
        raise WorkflowCompileError(f"workflow template {template} requires workflowNodes to be a non-empty list")
    return merged_nodes


def normalize_workflow_skipped_nodes(value: object | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise WorkflowCompileError("workflowSkippedNodes must be a list of non-empty node ids")
    return tuple(dict.fromkeys(item.strip() for item in value))


def configured_skip_policy(base_config: dict) -> dict:
    """Validated workflow.skipPolicy.

    Policy is enforced only by the skip operation (validate_skip_request), not
    by the compiler: tightening the policy later must not make existing state
    records unloadable.
    """
    workflow = base_config.get("workflow")
    raw = workflow.get("skipPolicy", {}) if isinstance(workflow, dict) else {}
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise WorkflowCompileError("workflow.skipPolicy must be an object")
    locked = raw.get("lockedNodes", [])
    if locked is None:
        locked = []
    if not isinstance(locked, list) or any(
        not isinstance(item, str) or not item.strip() for item in locked
    ):
        raise WorkflowCompileError("workflow.skipPolicy.lockedNodes must be a list of non-empty node ids")
    return {"lockedNodes": tuple(dict.fromkeys(item.strip() for item in locked))}


def _active_nodes(nodes: list[dict]) -> list[dict]:
    return [node for node in nodes if not node.get("skipped")]


def _mark_skipped_nodes(
    nodes: list[dict],
    skipped_ids: tuple[str, ...],
    *,
    context: str = "workflowSkippedNodes",
) -> list[dict]:
    """Mark skipped nodes in place and return the active sublist.

    Skipped nodes stay in the node array (the board renders them as 已跳过) but
    are excluded from every contract derivation by the callers.
    """
    if not skipped_ids:
        return nodes
    known = {str(node.get("id", "")) for node in nodes if isinstance(node, dict)}
    unknown = sorted(set(skipped_ids) - known)
    if unknown:
        raise WorkflowCompileError(f"{context} references unknown nodes: {', '.join(unknown)}")
    skipped_set = set(skipped_ids)
    active: list[dict] = []
    for node in nodes:
        if str(node.get("id", "")) in skipped_set:
            node["skipped"] = True
        else:
            active.append(node)
    if not active:
        raise WorkflowCompileError(f"{context} cannot skip every workflow node")
    return active


def normalize_workflow_skipped_nodes(value: object | None) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, (list, tuple)) or any(
        not isinstance(item, str) or not item.strip() for item in value
    ):
        raise WorkflowCompileError("workflowSkippedNodes must be a list of non-empty node ids")
    return tuple(dict.fromkeys(item.strip() for item in value))


def configured_skip_policy(base_config: dict) -> dict:
    """Validated workflow.skipPolicy.

    Policy is enforced only by the skip operation (validate_skip_request), not
    by the compiler: tightening the policy later must not make existing state
    records unloadable.
    """
    workflow = base_config.get("workflow")
    raw = workflow.get("skipPolicy", {}) if isinstance(workflow, dict) else {}
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise WorkflowCompileError("workflow.skipPolicy must be an object")
    locked = raw.get("lockedNodes", [])
    if locked is None:
        locked = []
    if not isinstance(locked, list) or any(
        not isinstance(item, str) or not item.strip() for item in locked
    ):
        raise WorkflowCompileError("workflow.skipPolicy.lockedNodes must be a list of non-empty node ids")
    return {"lockedNodes": tuple(dict.fromkeys(item.strip() for item in locked))}


def _active_nodes(nodes: list[dict]) -> list[dict]:
    return [node for node in nodes if not node.get("skipped")]


def _mark_skipped_nodes(
    nodes: list[dict],
    skipped_ids: tuple[str, ...],
    *,
    context: str = "workflowSkippedNodes",
) -> list[dict]:
    """Mark skipped nodes in place and return the active sublist.

    Skipped nodes stay in the node array (the board renders them as 已跳过) but
    are excluded from every contract derivation by the callers.
    """
    if not skipped_ids:
        return nodes
    known = {str(node.get("id", "")) for node in nodes if isinstance(node, dict)}
    unknown = sorted(set(skipped_ids) - known)
    if unknown:
        raise WorkflowCompileError(f"{context} references unknown nodes: {', '.join(unknown)}")
    skipped_set = set(skipped_ids)
    active: list[dict] = []
    for node in nodes:
        if str(node.get("id", "")) in skipped_set:
            node["skipped"] = True
        else:
            active.append(node)
    if not active:
        raise WorkflowCompileError(f"{context} cannot skip every workflow node")
    return active


def normalize_workflow_decisions(decisions: object | None) -> dict[str, str]:
    if decisions is None:
        return {}
    if not isinstance(decisions, dict):
        raise WorkflowCompileError("workflowDecisions must be an object")

    normalized: dict[str, str] = {}
    for stage_id, decision in decisions.items():
        if not isinstance(stage_id, str) or not stage_id.strip():
            raise WorkflowCompileError("workflowDecisions keys must be non-empty strings")
        if not isinstance(decision, str) or not decision.strip():
            raise WorkflowCompileError(f"workflowDecisions.{stage_id} must be a non-empty string")
        cleaned_decision = decision.strip()
        if cleaned_decision not in ALLOWED_WORKFLOW_DECISIONS:
            allowed = ", ".join(sorted(ALLOWED_WORKFLOW_DECISIONS))
            raise WorkflowCompileError(f"workflowDecisions.{stage_id} must be one of: {allowed}")
        normalized[stage_id.strip()] = cleaned_decision
    return normalized


def _dynamic_stage_anchor(spec: dict, *, context: str) -> tuple[str, str]:
    insert_after = spec.get("insertAfter")
    insert_before = spec.get("insertBefore")
    if bool(insert_after) == bool(insert_before):
        raise WorkflowCompileError(f"{context} must declare exactly one of insertAfter or insertBefore")
    if insert_after:
        return "insertAfter", _read_string(insert_after, context=f"{context}.insertAfter")
    return "insertBefore", _read_string(insert_before, context=f"{context}.insertBefore")


def _read_dynamic_stage(spec: object, *, context: str) -> dict:
    if not isinstance(spec, dict):
        raise WorkflowCompileError(f"{context} must be an object")

    stage_id = _read_string(spec.get("id"), context=f"{context}.id")
    phase = _read_string(spec.get("phase", "Dev"), context=f"{context}.phase")
    if phase != "Dev":
        raise WorkflowCompileError(f"{context}.phase currently only supports Dev")
    anchor_field, anchor_id = _dynamic_stage_anchor(spec, context=context)
    default_decision = spec.get("defaultDecision", "pending")
    if not isinstance(default_decision, str) or default_decision not in ALLOWED_DYNAMIC_STAGE_DEFAULTS:
        allowed = ", ".join(sorted(ALLOWED_DYNAMIC_STAGE_DEFAULTS))
        raise WorkflowCompileError(f"{context}.defaultDecision must be one of: {allowed}")

    raw_nodes = spec.get("nodes")
    if not isinstance(raw_nodes, list) or not raw_nodes:
        raise WorkflowCompileError(f"{context}.nodes must be a non-empty list")

    order = spec.get("order", 1000)
    if not isinstance(order, int):
        raise WorkflowCompileError(f"{context}.order must be an integer")

    return {
        "id": stage_id,
        "phase": phase,
        "label": spec.get("label", stage_id) if isinstance(spec.get("label", stage_id), str) else stage_id,
        "description": spec.get("description", "") if isinstance(spec.get("description", ""), str) else "",
        "choiceCheckpoint": _read_string(spec.get("choiceCheckpoint"), context=f"{context}.choiceCheckpoint"),
        "defaultDecision": default_decision,
        "enableTargetCheckpoint": _read_string(
            spec.get("enableTargetCheckpoint"),
            context=f"{context}.enableTargetCheckpoint",
        ),
        "skipTargetCheckpoint": _read_string(spec.get("skipTargetCheckpoint"), context=f"{context}.skipTargetCheckpoint"),
        "enableLabel": spec.get("enableLabel", "需要") if isinstance(spec.get("enableLabel", "需要"), str) else "需要",
        "skipLabel": spec.get("skipLabel", "不需要") if isinstance(spec.get("skipLabel", "不需要"), str) else "不需要",
        "enableDescription": (
            spec.get("enableDescription", "")
            if isinstance(spec.get("enableDescription", ""), str)
            else ""
        ),
        "skipDescription": (
            spec.get("skipDescription", "")
            if isinstance(spec.get("skipDescription", ""), str)
            else ""
        ),
        "order": order,
        "insertAnchorField": anchor_field,
        "insertAnchorId": anchor_id,
        "nodes": copy.deepcopy(raw_nodes),
    }


def configured_dynamic_stages(base_config: dict) -> tuple[dict, ...]:
    workflow = base_config.get("workflow")
    if not isinstance(workflow, dict):
        return ()
    raw_stages = workflow.get("dynamicStages", [])
    if raw_stages is None:
        return ()
    if not isinstance(raw_stages, list):
        raise WorkflowCompileError("workflow.dynamicStages must be a list")

    stages: list[dict] = []
    seen: set[str] = set()
    for index, raw_stage in enumerate(raw_stages):
        stage = _read_dynamic_stage(raw_stage, context=f"workflow.dynamicStages[{index}]")
        stage_id = stage["id"]
        if stage_id in seen:
            raise WorkflowCompileError(f"duplicate dynamic stage id: {stage_id}")
        seen.add(stage_id)
        stages.append(stage)
    return tuple(sorted(stages, key=lambda stage: (stage["order"], stage["id"])))


def load_profile_overlays(repo_root: Path, workspace: Path | None, profile: str) -> list[dict]:
    profile = normalize_workflow_profile(profile)
    if profile == BASE_WORKFLOW_PROFILE:
        return []

    selected: list[dict] = []
    for path in overlay_paths(repo_root, workspace):
        overlay = _overlay_for_profile(read_json(path), path, profile)
        if overlay is not None:
            selected.append(overlay)
    return selected


def _read_string(value: object, *, context: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise WorkflowCompileError(f"{context} must be a non-empty string")
    return value.strip()


def _read_string_list(value: object, *, context: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
        raise WorkflowCompileError(f"{context} must be a list of non-empty strings")
    return [item.strip() for item in value]


def _artifact_dicts(node: dict, direction: str) -> list[dict]:
    artifacts = node.get("artifacts")
    if isinstance(artifacts, dict):
        value = artifacts.get(direction, [])
        return value if isinstance(value, list) else []
    if direction == "outputs":
        legacy = node.get("artifactDefinitions", [])
        return legacy if isinstance(legacy, list) else []
    return []


def _phase_for_node(node: dict, *, context: str) -> str:
    phase = node.get("phase", node.get("group"))
    if not isinstance(phase, str) or phase not in ALLOWED_PHASES:
        allowed = ", ".join(sorted(ALLOWED_PHASES))
        raise WorkflowCompileError(f"{context}.phase must be one of: {allowed}")
    return phase


def _find_skill_file(repo_root: Path, skill: str) -> Path | None:
    skills_dir = repo_root / "skills"
    if not skills_dir.is_dir():
        return None
    for path in skills_dir.rglob("SKILL.md"):
        if path.parent.name == skill:
            return path
    return None


def _validate_skill(repo_root: Path | None, skill: str, *, context: str) -> None:
    if repo_root is None:
        return
    if _find_skill_file(repo_root, skill) is None:
        raise WorkflowCompileError(f"{context}.skill is not installed: {skill}")


def _build_next_action(skill: str, label: str) -> dict[str, str]:
    return {
        "slashSkill": skill,
        "userMessage": f"请使用 /{skill} 继续推进当前 Feature。",
        "dialogTips": f"当前阶段：{label}。",
    }


def _read_next_action_override(value: object, *, context: str) -> dict[str, dict[str, str]]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise WorkflowCompileError(f"{context}.nextAction must be an object")

    result: dict[str, dict[str, str]] = {}
    for state_id, action in value.items():
        if state_id not in {"not_started", "in_progress", "done", "archived"}:
            raise WorkflowCompileError(f"{context}.nextAction contains unknown state: {state_id}")
        if not isinstance(action, dict):
            raise WorkflowCompileError(f"{context}.nextAction.{state_id} must be an object")
        normalized: dict[str, str] = {}
        for field in NEXT_ACTION_FIELDS:
            item = action.get(field)
            if not isinstance(item, str) or not item.strip():
                raise WorkflowCompileError(
                    f"{context}.nextAction.{state_id}.{field} must be a non-empty string"
                )
            normalized[field] = item
        result[state_id] = normalized
    return result


def _build_dynamic_node(spec: dict, *, repo_root: Path | None, context: str) -> dict:
    if not isinstance(spec, dict):
        raise WorkflowCompileError(f"{context} must be an object")

    node_id = _read_string(spec.get("id"), context=f"{context}.id")
    label = _read_string(spec.get("label"), context=f"{context}.label")
    phase = _phase_for_node(spec, context=context)
    skill = _read_string(spec.get("skill"), context=f"{context}.skill")
    checkpoint_prefix = _read_string(spec.get("checkpointPrefix"), context=f"{context}.checkpointPrefix")
    if checkpoint_prefix.endswith("_in_progress") or checkpoint_prefix.endswith("_done"):
        raise WorkflowCompileError(f"{context}.checkpointPrefix must not include a checkpoint suffix")

    _validate_skill(repo_root, skill, context=context)
    guards = tuple(_read_string_list(spec.get("guards"), context=f"{context}.guards"))
    unknown_guards = sorted(set(guards) - ALLOWED_GUARDS)
    if unknown_guards:
        raise WorkflowCompileError(f"{context}.guards contains unknown guard: {', '.join(unknown_guards)}")

    artifacts = spec.get("artifacts", {})
    if artifacts is None:
        artifacts = {}
    if not isinstance(artifacts, dict):
        raise WorkflowCompileError(f"{context}.artifacts must be an object")

    states = spec.get("states", [])
    if states is None:
        states = []
    if not isinstance(states, list):
        raise WorkflowCompileError(f"{context}.states must be a list")

    return {
        "id": node_id,
        "label": label,
        "group": phase,
        "skill": skill,
        "description": spec.get("description", label),
        "checkpoints": [f"{checkpoint_prefix}_in_progress", f"{checkpoint_prefix}_done"],
        "artifacts": {
            "inputs": copy.deepcopy(artifacts.get("inputs", [])),
            "outputs": copy.deepcopy(artifacts.get("outputs", [])),
        },
        "validators": _read_string_list(spec.get("validators"), context=f"{context}.validators"),
        "guards": list(guards),
        "hookDefinitions": copy.deepcopy(spec.get("hookDefinitions", [])),
        "states": copy.deepcopy(states),
        "_dynamic": True,
        "_nextActionOverride": _read_next_action_override(spec.get("nextAction"), context=context),
    }


def _insert_dynamic_node(nodes: list[dict], node: dict, spec: dict, *, context: str) -> None:
    insert_after = spec.get("insertAfter")
    insert_before = spec.get("insertBefore")
    if bool(insert_after) == bool(insert_before):
        raise WorkflowCompileError(f"{context} must declare exactly one of insertAfter or insertBefore")

    anchor_id = _read_string(insert_after or insert_before, context=f"{context}.insertAnchor")
    for index, existing in enumerate(nodes):
        if existing.get("id") == anchor_id:
            nodes.insert(index + 1 if insert_after else index, node)
            return
    raise WorkflowCompileError(f"{context} references unknown insert anchor: {anchor_id}")


def _dynamic_stage_overlay(stage: dict) -> dict:
    nodes: list[dict] = []
    previous_node_id = ""
    for index, raw_node in enumerate(stage["nodes"]):
        if not isinstance(raw_node, dict):
            raise WorkflowCompileError(f"dynamicStage {stage['id']}.nodes[{index}] must be an object")
        node = copy.deepcopy(raw_node)
        if "insertAfter" not in node and "insertBefore" not in node:
            if index == 0:
                node[stage["insertAnchorField"]] = stage["insertAnchorId"]
            else:
                node["insertAfter"] = previous_node_id
        previous_node_id = _read_string(node.get("id"), context=f"dynamicStage {stage['id']}.nodes[{index}].id")
        nodes.append(node)
    return {"nodes": nodes}


def _state_id(state: dict) -> str:
    raw_status = state.get("nodeStatus", state.get("id"))
    if isinstance(raw_status, str) and raw_status in DERIVED_STATE_IDS:
        return raw_status
    return ""


def _find_state(node: dict, state_id: str) -> dict | None:
    for state in node.get("states", []):
        if isinstance(state, dict) and _state_id(state) == state_id:
            return state
    return None


def _normalize_state_identity(state: dict, state_id: str) -> dict:
    normalized = copy.deepcopy(state)
    normalized["id"] = state_id
    normalized["nodeStatus"] = state_id
    return normalized


def _default_state(state_id: str) -> dict:
    defaults = {
        "not_started": {"id": "not_started", "label": "未开始", "uiKind": "pending"},
        "in_progress": {"id": "in_progress", "label": "进行中", "uiKind": "active"},
        "done": {"id": "done", "label": "已完成", "uiKind": "done"},
        "archived": {"id": "archived", "label": "已归档", "uiKind": "archived"},
    }
    return copy.deepcopy(defaults[state_id])


def _state_template(node: dict, state_id: str) -> dict:
    state = _find_state(node, state_id)
    if state is None:
        return _default_state(state_id)
    template = _normalize_state_identity(state, state_id)
    template.pop("nextAction", None)
    return template


def _compatible_state(node: dict, state_id: str, target_skill: str) -> dict | None:
    state = _find_state(node, state_id)
    if state is None:
        return None
    action = state.get("nextAction")
    if not isinstance(action, dict) or action.get("slashSkill") != target_skill:
        return None
    return _normalize_state_identity(state, state_id)


def _build_archived_next_action(skill: str, label: str) -> dict[str, str]:
    return {
        "slashSkill": skill,
        "userMessage": f"请使用 /{skill} 查看当前 Feature 的归档状态。",
        "dialogTips": f"当前阶段：{label}。",
    }


def _derive_state(
    node: dict,
    state_id: str,
    target_skill: str,
    target_label: str,
    overrides: dict[str, dict[str, str]],
    *,
    archived: bool = False,
) -> dict:
    if state_id in overrides:
        state = _state_template(node, state_id)
        state["nextAction"] = overrides[state_id]
        return state

    compatible = _compatible_state(node, state_id, target_skill)
    if compatible is not None:
        return compatible

    state = _default_state(state_id)
    state["nextAction"] = (
        _build_archived_next_action(target_skill, target_label)
        if archived
        else _build_next_action(target_skill, target_label)
    )
    return state


def _next_node_skill(nodes: list[dict], index: int) -> tuple[str, str]:
    for next_node in nodes[index + 1 :]:
        if next_node.get("skipped"):
            continue
        skill = next_node.get("skill")
        label = next_node.get("label")
        if isinstance(skill, str) and skill and isinstance(label, str):
            return skill, label
    skill = nodes[index].get("skill", "")
    label = nodes[index].get("label", "")
    return str(skill), str(label)


def _derive_node_states(nodes: list[dict]) -> None:
    for index, node in enumerate(nodes):
        skill = str(node.get("skill", ""))
        label = str(node.get("label", ""))
        overrides = node.pop("_nextActionOverride", {})
        checkpoints = node.get("checkpoints", [])
        if checkpoints == ["archived"]:
            node["states"] = [
                _derive_state(
                    node,
                    "archived",
                    skill,
                    label,
                    overrides,
                    archived=True,
                )
            ]
            continue

        next_skill, next_label = _next_node_skill(nodes, index)
        states = []
        for state_id, target_skill, target_label in (
            ("not_started", skill, label),
            ("in_progress", skill, label),
            ("done", next_skill, next_label),
        ):
            states.append(_derive_state(node, state_id, target_skill, target_label, overrides))
        node["states"] = states


def _start_checkpoint(node: dict) -> str | None:
    checkpoints = node.get("checkpoints", [])
    if not isinstance(checkpoints, list):
        return None
    for checkpoint in checkpoints:
        if isinstance(checkpoint, str) and checkpoint.endswith("_in_progress"):
            return checkpoint
    if checkpoints == ["archived"]:
        return "archived"
    return None


def _done_checkpoint(node: dict) -> str | None:
    checkpoints = node.get("checkpoints", [])
    if not isinstance(checkpoints, list):
        return None
    for checkpoint in checkpoints:
        if isinstance(checkpoint, str) and checkpoint.endswith("_done"):
            return checkpoint
    if checkpoints == ["archived"]:
        return "archived"
    return None


def _derive_stage_labels(nodes: list[dict], base_labels: dict[str, str]) -> dict[str, str]:
    labels = dict(base_labels)
    for node in nodes:
        node_label = str(node.get("label", ""))
        group = str(node.get("group", ""))
        start = _start_checkpoint(node)
        done = _done_checkpoint(node)
        if start and start != "archived":
            labels.setdefault(start, f"{group} / {node_label}" if group else node_label)
        if done:
            labels.setdefault(done, "已归档" if done == "archived" else f"{node_label} 完成")
    return labels


def _derive_checkpoint_transitions(nodes: list[dict], base_checkpoint_config: dict) -> dict[str, list[str]]:
    old_transitions = base_checkpoint_config.get("transitions", {})
    old_transitions = old_transitions if isinstance(old_transitions, dict) else {}
    transitions: dict[str, list[str]] = {}

    for node in nodes:
        start = _start_checkpoint(node)
        done = _done_checkpoint(node)
        if start and done and start != done:
            targets = [done]
            if "needs_fix" in old_transitions.get(start, []):
                targets.append("needs_fix")
            transitions[start] = targets
        elif start:
            transitions[start] = []

    for index, node in enumerate(nodes):
        done = _done_checkpoint(node)
        if not done or done == "archived":
            continue
        next_start = _start_checkpoint(nodes[index + 1]) if index + 1 < len(nodes) else None
        transitions[done] = [next_start] if next_start else []

    old_needs_fix_targets = old_transitions.get("needs_fix", [])
    if isinstance(old_needs_fix_targets, list):
        known_starts = {item for item in (_start_checkpoint(node) for node in nodes) if item}
        dynamic_starts = {
            start
            for start in (
                _start_checkpoint(node) if node.get("_dynamic") else None for node in nodes
            )
            if start and start != "archived"
        }
        transitions["needs_fix"] = sorted((set(old_needs_fix_targets) & known_starts) | dynamic_starts)
    if "archived" in {checkpoint for node in nodes for checkpoint in node.get("checkpoints", [])}:
        transitions.setdefault("archived", [])
    return transitions


def _derive_initial_checkpoints(nodes: list[dict], base_checkpoint_config: dict) -> list[str]:
    known = {checkpoint for node in nodes for checkpoint in node.get("checkpoints", [])}
    initial = [
        checkpoint
        for checkpoint in base_checkpoint_config.get("initial", [])
        if isinstance(checkpoint, str) and checkpoint in known
    ]
    first_start = _start_checkpoint(nodes[0]) if nodes else None
    if first_start and first_start != "archived" and first_start not in initial:
        initial.insert(0, first_start)
    return initial


def _derive_ui_transitions(nodes: list[dict]) -> list[dict]:
    transitions: list[dict] = []
    for index, node in enumerate(nodes[:-1]):
        next_node = nodes[index + 1]
        from_state = "archived" if _done_checkpoint(node) == "archived" else "done"
        to_state = "archived" if _start_checkpoint(next_node) == "archived" else "in_progress"
        transitions.append(
            {
                "id": f"{node['id']}-to-{next_node['id']}",
                "from": {"nodeId": node["id"], "state": from_state},
                "to": {"nodeId": next_node["id"], "state": to_state},
            }
        )
    return transitions


def _validate_dynamic_stage_targets(nodes: list[dict], transitions: dict[str, list[str]], stages: Iterable[dict]) -> None:
    checkpoint_to_node = {
        checkpoint: node
        for node in nodes
        for checkpoint in node.get("checkpoints", [])
        if isinstance(checkpoint, str)
    }
    for stage in stages:
        enable_target = stage["enableTargetCheckpoint"]
        if enable_target not in checkpoint_to_node:
            raise WorkflowCompileError(
                f"dynamic stage {stage['id']} enableTargetCheckpoint is not declared: {enable_target}"
            )
        allowed = transitions.get(stage["choiceCheckpoint"], [])
        if enable_target not in allowed:
            allowed_text = ", ".join(allowed) if allowed else "none"
            raise WorkflowCompileError(
                f"dynamic stage {stage['id']} choiceCheckpoint {stage['choiceCheckpoint']} "
                f"does not transition to {enable_target}; allowed: {allowed_text}"
            )


def _validate_dynamic_stage_definitions(
    nodes: list[dict],
    dynamic_stages: Iterable[dict],
    *,
    repo_root: Path | None,
) -> None:
    node_ids = {node.get("id") for node in nodes if isinstance(node.get("id"), str)}
    known_checkpoints = {
        checkpoint
        for node in nodes
        for checkpoint in node.get("checkpoints", [])
        if isinstance(checkpoint, str)
    }

    for stage in dynamic_stages:
        if stage["insertAnchorId"] not in node_ids:
            raise WorkflowCompileError(
                f"dynamic stage {stage['id']} references unknown insert anchor: {stage['insertAnchorId']}"
            )
        for field in ("choiceCheckpoint", "skipTargetCheckpoint"):
            checkpoint = stage[field]
            if checkpoint not in known_checkpoints:
                raise WorkflowCompileError(f"dynamic stage {stage['id']} {field} is not declared: {checkpoint}")

        overlay = _dynamic_stage_overlay(stage)
        built_nodes = [
            _build_dynamic_node(raw_node, repo_root=repo_root, context=f"dynamic stage {stage['id']}.nodes[{index}]")
            for index, raw_node in enumerate(overlay["nodes"])
        ]
        enable_target = stage["enableTargetCheckpoint"]
        first_start = _start_checkpoint(built_nodes[0]) if built_nodes else None
        if enable_target != first_start:
            raise WorkflowCompileError(
                f"dynamic stage {stage['id']} enableTargetCheckpoint must match first node start checkpoint: "
                f"{first_start or 'none'}"
            )


def _validate_unique_nodes_and_checkpoints(nodes: list[dict]) -> None:
    seen_nodes: set[str] = set()
    seen_checkpoints: dict[str, str] = {}
    for node in nodes:
        node_id = str(node.get("id", ""))
        if node_id in seen_nodes:
            raise WorkflowCompileError(f"duplicate workflow node id: {node_id}")
        seen_nodes.add(node_id)
        for checkpoint in node.get("checkpoints", []):
            if checkpoint in seen_checkpoints:
                raise WorkflowCompileError(
                    f"checkpoint {checkpoint} is declared by both {seen_checkpoints[checkpoint]} and {node_id}"
                )
            seen_checkpoints[checkpoint] = node_id


def _validate_artifact_dependencies(nodes: list[dict]) -> None:
    available: set[str] = set()
    output_owner: dict[str, str] = {}
    for node in nodes:
        node_id = str(node.get("id", ""))
        input_paths = set()
        for artifact in _artifact_dicts(node, "inputs"):
            if not isinstance(artifact, dict):
                continue
            path = artifact.get("path")
            if not isinstance(path, str):
                continue
            input_paths.add(path)
            if artifact.get("required", True) and path not in available:
                raise WorkflowCompileError(f"{node_id} required input is not produced upstream: {path}")

        for artifact in _artifact_dicts(node, "outputs"):
            if not isinstance(artifact, dict):
                continue
            path = artifact.get("path")
            if not isinstance(path, str):
                continue
            previous = output_owner.get(path)
            if previous is not None and path not in input_paths:
                raise WorkflowCompileError(f"{node_id} output duplicates {previous} without update input: {path}")
            output_owner[path] = node_id
            available.add(path)


def _renumber_nodes(nodes: list[dict]) -> None:
    for index, node in enumerate(nodes, start=1):
        node["order"] = index * 10


def _enabled_phases(overlays: Iterable[dict]) -> set[str]:
    enabled = set(DEFAULT_ENABLED_DYNAMIC_PHASES)
    for overlay in overlays:
        declared = overlay.get("enabledDynamicPhases")
        if declared is None:
            continue
        phases = set(_read_string_list(declared, context="enabledDynamicPhases"))
        unknown = sorted(phases - ALLOWED_PHASES)
        if unknown:
            raise WorkflowCompileError(f"enabledDynamicPhases contains unknown phase: {', '.join(unknown)}")
        enabled.update(phases)
    return enabled


def _assemble_effective(
    effective: dict,
    workflow: dict,
    nodes: list[dict],
    *,
    profile: str,
    decisions: dict[str, str],
    enabled_stages: list[dict] | None = None,
) -> dict:
    """Validate nodes and derive states/checkpoints/transitions into the effective config.

    enabled_stages=None skips dynamic-stage target validation (subset workflows
    do not support dynamic stages). Nodes marked skipped stay in the node array
    for display but every contract derivation runs on the active sublist only,
    so transitions bridge over them and their checkpoints become unknown.
    """
    active = _active_nodes(nodes)
    _validate_unique_nodes_and_checkpoints(nodes)
    _validate_artifact_dependencies(active)
    _renumber_nodes(nodes)
    _derive_node_states(nodes)

    checkpoint_config = workflow.get("checkpoints", {})
    checkpoint_config = checkpoint_config if isinstance(checkpoint_config, dict) else {}
    base_labels = checkpoint_config.get("stageLabels", {})
    base_labels = base_labels if isinstance(base_labels, dict) else {}
    workflow["nodes"] = nodes
    workflow["checkpoints"] = {
        "initial": _derive_initial_checkpoints(active, checkpoint_config),
        "transitions": _derive_checkpoint_transitions(active, checkpoint_config),
        "stageLabels": _derive_stage_labels(active, base_labels),
    }
    if enabled_stages is not None:
        _validate_dynamic_stage_targets(active, workflow["checkpoints"]["transitions"], enabled_stages)
    workflow["transitions"] = _derive_ui_transitions(active)
    effective["workflowProfile"] = profile
    effective["workflowDecisions"] = decisions
    return effective


def compile_board_config(
    base_config: dict,
    *,
    repo_root: Path | None = None,
    workspace: Path | None = None,
    profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: object | None = None,
    overlays: list[dict] | None = None,
    skipped_nodes: object | None = None,
) -> dict:
    """Compile a profile-specific effective workflow config."""
    profile = normalize_workflow_profile(profile)
    decisions = normalize_workflow_decisions(workflow_decisions)
    skipped = normalize_workflow_skipped_nodes(skipped_nodes)
    dynamic_stages = configured_dynamic_stages(base_config)
    stage_by_id = {stage["id"]: stage for stage in dynamic_stages}
    unknown_decisions = sorted(set(decisions) - set(stage_by_id))
    if unknown_decisions:
        raise WorkflowCompileError(f"workflowDecisions contains unknown stage: {', '.join(unknown_decisions)}")

    effective = copy.deepcopy(base_config)
    loaded_overlays = overlays
    if loaded_overlays is None:
        root = repo_root
        if root is None:
            root = repo_root_for_config_path(default_config_path())
        loaded_overlays = []
        configured_overlay = _configured_profile_overlay(base_config, profile)
        if configured_overlay is not None:
            loaded_overlays.append(configured_overlay)
        loaded_overlays.extend(load_profile_overlays(root, workspace, profile))
        loaded_overlays.extend(
            _dynamic_stage_overlay(stage)
            for stage in dynamic_stages
            if decisions.get(stage["id"]) == ENABLED_WORKFLOW_DECISION
        )

    if not loaded_overlays and not skipped:
        workflow = effective.get("workflow")
        nodes = workflow.get("nodes") if isinstance(workflow, dict) else None
        if not isinstance(nodes, list):
            raise WorkflowCompileError("workflow.nodes must be a list")
        _validate_dynamic_stage_definitions(nodes, dynamic_stages, repo_root=repo_root)
        effective["workflowProfile"] = profile
        effective["workflowDecisions"] = decisions
        return effective

    workflow = effective.get("workflow")
    if not isinstance(workflow, dict):
        raise WorkflowCompileError("workflow must be an object")
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise WorkflowCompileError("workflow.nodes must be a list")
    nodes = copy.deepcopy(nodes)

    enabled_phases = _enabled_phases(loaded_overlays)
    for overlay_index, overlay in enumerate(loaded_overlays):
        overlay_nodes = overlay.get("nodes", [])
        if not isinstance(overlay_nodes, list):
            raise WorkflowCompileError(f"overlay[{overlay_index}].nodes must be a list")
        for node_index, spec in enumerate(overlay_nodes):
            context = f"overlay[{overlay_index}].nodes[{node_index}]"
            dynamic_node = _build_dynamic_node(spec, repo_root=repo_root, context=context)
            phase = dynamic_node["group"]
            if phase not in enabled_phases:
                raise WorkflowCompileError(
                    f"{context}.phase {phase} is supported by the compiler but disabled by phase policy"
                )
            _insert_dynamic_node(nodes, dynamic_node, spec, context=context)

    _validate_dynamic_stage_definitions(nodes, dynamic_stages, repo_root=repo_root)
    enabled_stages = [
        stage
        for stage in dynamic_stages
        if decisions.get(stage["id"]) == ENABLED_WORKFLOW_DECISION
    ]
    dropped: dict[str, list[str]] = {}
    if skipped:
        # Skips apply after overlay/dynamic insertion so dynamic nodes are
        # skippable too. Stages whose checkpoints left the active chain must
        # not be target-validated.
        active = _mark_skipped_nodes(nodes, skipped)
        dropped = _drop_broken_inputs(active)
        _filter_checkpoint_config(workflow, active)
        active_checkpoints = {
            checkpoint
            for node in active
            for checkpoint in node.get("checkpoints", [])
            if isinstance(checkpoint, str)
        }
        enabled_stages = [
            stage
            for stage in enabled_stages
            if stage["enableTargetCheckpoint"] in active_checkpoints
            and stage["choiceCheckpoint"] in active_checkpoints
        ]
    effective = _assemble_effective(
        effective,
        workflow,
        nodes,
        profile=profile,
        decisions=decisions,
        enabled_stages=enabled_stages,
    )
    if skipped:
        effective["workflowSkippedNodes"] = list(skipped)
        effective["workflowDroppedInputs"] = {
            node_id: list(paths) for node_id, paths in dropped.items()
        }
    return effective


def _drop_broken_inputs(nodes: list[dict]) -> dict[str, list[str]]:
    """Remove inputs whose producer is not in the active node list.

    Walks active nodes in order tracking produced output paths. Any input
    (required or optional) whose path is not produced upstream is removed
    from the node's inputs: it is not part of this workflow's contract, so
    skills neither read it nor ask the user for it. Returns the removed
    paths per node id, in input order.
    """
    available: set[str] = set()
    dropped: dict[str, list[str]] = {}
    for node in nodes:
        node_id = str(node.get("id", ""))
        artifacts = node.get("artifacts")
        kept: list = []
        for artifact in _artifact_dicts(node, "inputs"):
            if not isinstance(artifact, dict) or not isinstance(artifact.get("path"), str):
                kept.append(artifact)
                continue
            path = artifact["path"]
            if path in available:
                kept.append(artifact)
            else:
                dropped.setdefault(node_id, []).append(path)
        if isinstance(artifacts, dict):
            artifacts["inputs"] = kept
        for artifact in _artifact_dicts(node, "outputs"):
            if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
                available.add(artifact["path"])
    return dropped


def _filter_checkpoint_config(workflow: dict, nodes: list[dict]) -> None:
    """Restrict base checkpoint config to checkpoints declared by the given nodes.

    Keeps needs_fix so the shared repair checkpoint stays usable in every template.
    """
    checkpoint_config = workflow.get("checkpoints", {})
    checkpoint_config = checkpoint_config if isinstance(checkpoint_config, dict) else {}
    keep = {
        checkpoint
        for node in nodes
        for checkpoint in node.get("checkpoints", [])
        if isinstance(checkpoint, str)
    }
    keep.add("needs_fix")

    initial = checkpoint_config.get("initial", [])
    initial = initial if isinstance(initial, list) else []
    transitions = checkpoint_config.get("transitions", {})
    transitions = transitions if isinstance(transitions, dict) else {}
    stage_labels = checkpoint_config.get("stageLabels", {})
    stage_labels = stage_labels if isinstance(stage_labels, dict) else {}

    workflow["checkpoints"] = {
        "initial": [checkpoint for checkpoint in initial if checkpoint in keep],
        "transitions": {
            checkpoint: [target for target in targets if target in keep]
            for checkpoint, targets in transitions.items()
            if checkpoint in keep and isinstance(targets, list)
        },
        "stageLabels": {
            checkpoint: label
            for checkpoint, label in stage_labels.items()
            if checkpoint in keep
        },
    }


def compile_node_subset(
    base_config: dict,
    node_ids: Iterable[str],
    *,
    profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: object | None = None,
    skipped_nodes: object | None = None,
) -> dict:
    """Compile an effective workflow keeping only the selected base nodes.

    Nodes keep base array order; inputs whose producer is not in the subset
    are removed from the node's contract entirely. Dynamic stages and profile
    overlays are not applied to subset workflows. skipped_nodes marks subset
    members as mid-flight skipped: they stay in the node array but leave the
    contract chain.
    """
    profile = normalize_workflow_profile(profile)
    decisions = normalize_workflow_decisions(workflow_decisions)
    skipped = normalize_workflow_skipped_nodes(skipped_nodes)

    requested = [str(node_id).strip() for node_id in node_ids if str(node_id).strip()]
    if not requested:
        raise WorkflowCompileError("node subset must contain at least one node id")

    effective = copy.deepcopy(base_config)
    workflow = effective.get("workflow")
    if not isinstance(workflow, dict):
        raise WorkflowCompileError("workflow must be an object")
    base_nodes = workflow.get("nodes")
    if not isinstance(base_nodes, list):
        raise WorkflowCompileError("workflow.nodes must be a list")

    known_ids = {
        str(node.get("id", ""))
        for node in base_nodes
        if isinstance(node, dict) and isinstance(node.get("id"), str)
    }
    unknown = sorted(set(requested) - known_ids)
    if unknown:
        raise WorkflowCompileError(f"node subset references unknown nodes: {', '.join(unknown)}")

    selected = set(requested)
    nodes = [
        copy.deepcopy(node)
        for node in base_nodes
        if isinstance(node, dict) and str(node.get("id", "")) in selected
    ]

    active = _mark_skipped_nodes(nodes, skipped) if skipped else nodes
    dropped = _drop_broken_inputs(active)
    _filter_checkpoint_config(workflow, active)

    effective = _assemble_effective(
        effective,
        workflow,
        nodes,
        profile=profile,
        decisions=decisions,
        enabled_stages=None,
    )
    effective["workflowNodeSubset"] = [str(node.get("id", "")) for node in nodes]
    effective["workflowDroppedInputs"] = {
        node_id: list(paths) for node_id, paths in dropped.items()
    }
    if skipped:
        effective["workflowSkippedNodes"] = list(skipped)
    return effective


def load_effective_board_config(
    config_path: Path | None = None,
    *,
    repo_root: Path | None = None,
    workspace: Path | None = None,
    profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: object | None = None,
    overlays: list[dict] | None = None,
    skipped_nodes: object | None = None,
) -> dict:
    path = config_path or default_config_path()
    base_config = read_json(path)
    resolved_repo_root = repo_root or repo_root_for_config_path(path)
    return compile_board_config(
        base_config,
        repo_root=resolved_repo_root,
        workspace=workspace,
        profile=profile,
        workflow_decisions=workflow_decisions,
        overlays=overlays,
        skipped_nodes=skipped_nodes,
    )


def load_record_effective_board_config(
    config_path: Path | None = None,
    *,
    repo_root: Path | None = None,
    workspace: Path | None = None,
    record: dict,
) -> dict:
    """Compile the effective workflow config for a state record (template-aware)."""
    if not isinstance(record, dict):
        raise WorkflowCompileError("workflow record must be an object")
    path = config_path or default_config_path()
    base_config = read_json(path)
    profile = normalize_workflow_profile(record.get("workflowProfile"))
    decisions = normalize_workflow_decisions(record.get("workflowDecisions", {}))
    template = normalize_workflow_template(record.get("workflowTemplate"))
    skipped = normalize_workflow_skipped_nodes(record.get("workflowSkippedNodes"))
    subset = resolve_template_subset(
        base_config,
        template,
        workflow_nodes=record.get("workflowNodes"),
    )
    if subset is None:
        return compile_board_config(
            base_config,
            repo_root=repo_root or repo_root_for_config_path(path),
            workspace=workspace,
            profile=profile,
            workflow_decisions=decisions,
            skipped_nodes=skipped,
        )
    if profile != BASE_WORKFLOW_PROFILE:
        raise WorkflowCompileError(f"workflow template {template} 不支持 workflowProfile={profile}")
    if decisions:
        raise WorkflowCompileError(f"workflow template {template} 不支持 workflowDecisions")
    return compile_node_subset(base_config, subset, skipped_nodes=skipped)
