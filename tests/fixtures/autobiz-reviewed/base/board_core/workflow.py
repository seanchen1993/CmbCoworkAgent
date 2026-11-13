"""Workflow node resolution — checkpoint→node mapping, status derivation."""

from __future__ import annotations

import copy

from board_core.contracts import BoardConfigError, artifact_dicts


NEXT_ACTION_FIELDS = ("slashSkill", "userMessage", "dialogTips")
NODE_INTERNAL_FIELDS = {
    "checkpoints",
    "order",
    "skill",
    "artifacts",
    "validators",
    "validatorBindings",
    "guards",
    "rollback",
    "_dynamic",
    "_nextActionOverride",
}
NODE_STATUSES = {
    "not_started",
    "in_progress",
    "done",
    "blocked",
    "skipped",
    "archived",
    "unknown",
}
DEFAULT_NODE_STATUS_LABELS = {
    "not_started": "未开始",
    "in_progress": "进行中",
    "done": "已完成",
    "blocked": "已阻塞",
    "skipped": "已跳过",
    "archived": "已归档",
    "unknown": "未知",
}
ARTIFACT_TYPES = {
    "file",
    "directory",
    "markdown",
    "text",
    "log",
    "yaml",
    "json",
    "report",
    "external",
    "virtual",
    "unknown",
}


def extract_checkpoint_suffix(checkpoint: str) -> str | None:
    """Return the state suffix portion of a checkpoint.

    e.g. 'prd_in_progress' → 'in_progress'
         'code_done'           → 'done'
         'needs_fix'           → 'needs_fix'
         'archived'            → 'archived'
         'bogus'               → None
    """
    for suffix in ("in_progress", "done"):
        suffix_ = "_" + suffix
        if checkpoint.endswith(suffix_) and len(checkpoint) > len(suffix_):
            return suffix

    if checkpoint == "needs_fix":
        return "needs_fix"
    if checkpoint == "archived":
        return "archived"
    return None


def find_current_node(
    nodes: list[dict], checkpoint: str,
) -> tuple[int, str | None]:
    """Return (index_into_nodes, node_id) for the checkpoint.

    Returns (-1, None) when no match is found.
    """
    for idx, node in enumerate(nodes):
        if checkpoint in node.get("checkpoints", []):
            return idx, node["id"]
    return -1, None


def find_effective_current_node(
    nodes: list[dict],
    checkpoint: str,
    needs_fix_from_checkpoint: str | None = None,
    *,
    stage: str | None = None,
    stage_labels: dict[str, str] | None = None,
) -> tuple[int, str | None]:
    """Resolve the display/routing node for a checkpoint.

    ``needs_fix`` is a workflow-level checkpoint rather than a node-owned
    checkpoint.  Its source checkpoint preserves the node position while the
    real checkpoint still determines that node's blocked status.
    """
    if checkpoint != "needs_fix":
        return find_current_node(nodes, checkpoint)

    if needs_fix_from_checkpoint:
        return find_current_node(nodes, needs_fix_from_checkpoint)

    if not stage or not isinstance(stage_labels, dict):
        return -1, None

    matches: dict[str, int] = {}
    for idx, node in enumerate(nodes):
        for node_checkpoint in node.get("checkpoints", []):
            if stage_labels.get(node_checkpoint) == stage:
                matches[node["id"]] = idx
                break
    if len(matches) != 1:
        return -1, None
    node_id, idx = next(iter(matches.items()))
    return idx, node_id


def node_start_checkpoint(node: dict) -> str | None:
    """Return the checkpoint that enters the node (its *_in_progress or archived)."""
    checkpoints = node.get("checkpoints", [])
    if not isinstance(checkpoints, list):
        return None
    for checkpoint in checkpoints:
        if isinstance(checkpoint, str) and checkpoint.endswith("_in_progress"):
            return checkpoint
    if checkpoints == ["archived"]:
        return "archived"
    return None


def validate_skip_request(
    nodes: list[dict],
    current_checkpoint: str,
    skip_ids: list[str] | tuple[str, ...],
    *,
    locked_nodes: list[str] | tuple[str, ...] = (),
) -> list[str]:
    """Return error strings for a mid-flight node skip request.

    Rules: ids must be active chain members; locked nodes (skipPolicy) are
    rejected; only the current node (while at its *_in_progress checkpoint) or
    not-yet-started nodes may be skipped; the current checkpoint must belong to
    a node; skipping the current node requires a later active node to land on;
    at least one active node must remain.
    """
    skip_list = [str(item).strip() for item in skip_ids if str(item).strip()]
    if not skip_list:
        return ["未提供要跳过的节点"]
    if current_checkpoint == "needs_fix":
        return ["当前处于 needs_fix 阻断状态，不能跳过节点；请先按修复建议回流到对应节点"]

    errors: list[str] = []
    index_by_id = {str(node.get("id", "")): idx for idx, node in enumerate(nodes)}
    active_ids = {str(node.get("id", "")) for node in nodes if not node.get("skipped")}
    locked = {str(item).strip() for item in locked_nodes}

    current_idx, current_node_id = find_current_node(nodes, current_checkpoint)
    if current_idx < 0:
        return [f"当前 checkpoint '{current_checkpoint or 'empty'}' 不属于任何节点，无法跳过"]

    skip_set = set(skip_list)
    for node_id in skip_list:
        if node_id not in index_by_id:
            errors.append(f"未知节点: {node_id}")
            continue
        if node_id not in active_ids:
            errors.append(f"节点已被跳过: {node_id}")
            continue
        if node_id in locked:
            errors.append(f"节点被 skipPolicy.lockedNodes 锁定，不可跳过: {node_id}")
            continue
        idx = index_by_id[node_id]
        if idx < current_idx:
            errors.append(f"节点 {node_id} 已完成，不可跳过")
        elif idx == current_idx and not current_checkpoint.endswith("_in_progress"):
            errors.append(f"节点 {node_id} 已到 {current_checkpoint}，不可跳过")

    remaining_active = [
        node
        for node in nodes
        if not node.get("skipped") and str(node.get("id", "")) not in skip_set
    ]
    if not remaining_active:
        errors.append("不能跳过全部剩余节点")
    elif current_node_id in skip_set and not any(
        index_by_id[str(node.get("id", ""))] > current_idx for node in remaining_active
    ):
        errors.append("跳过当前节点后没有可落地的后续节点")
    return errors


def landing_checkpoint_after_skip(
    nodes: list[dict],
    current_checkpoint: str,
    skip_ids: list[str] | tuple[str, ...],
) -> str | None:
    """Return the checkpoint to land on after the skip, or None when unchanged.

    Only skipping the current node moves the checkpoint: it lands on the start
    checkpoint of the next node that is neither skipped nor being skipped.
    """
    current_idx, current_node_id = find_current_node(nodes, current_checkpoint)
    skip_set = {str(item).strip() for item in skip_ids}
    if current_idx < 0 or current_node_id not in skip_set:
        return None
    for node in nodes[current_idx + 1 :]:
        if node.get("skipped") or str(node.get("id", "")) in skip_set:
            continue
        return node_start_checkpoint(node)
    return None


def skippable_node_ids(
    nodes: list[dict],
    current_checkpoint: str,
    *,
    locked_nodes: list[str] | tuple[str, ...] = (),
) -> list[str]:
    """Return node ids that a single-node skip request would currently accept."""
    result: list[str] = []
    for node in nodes:
        if node.get("skipped"):
            continue
        node_id = str(node.get("id", ""))
        if not node_id:
            continue
        if not validate_skip_request(nodes, current_checkpoint, [node_id], locked_nodes=locked_nodes):
            result.append(node_id)
    return result


def _normalize_node_status(value: object) -> str:
    if isinstance(value, str) and value in NODE_STATUSES:
        return value
    return "unknown"


def _normalize_artifact_type(value: object) -> str:
    if isinstance(value, str) and value in ARTIFACT_TYPES:
        return value
    return "unknown"


def derive_node_status(
    node_idx: int,
    current_idx: int,
    current_checkpoint: str,
    node: dict,
    suffix_states: dict,
) -> str:
    """Return the board node status for a single node based on current position."""
    if node.get("skipped"):
        return "skipped"

    if current_checkpoint == "archived":
        return "archived" if node["id"] == "ops.archive" else "done"

    if current_idx < 0:
        return "unknown"

    if node_idx < current_idx:
        return "done"
    if node_idx > current_idx:
        return "not_started"

    suffix = extract_checkpoint_suffix(current_checkpoint)
    state = suffix_states.get(suffix, {"nodeStatus": "unknown"})
    return _normalize_node_status(state.get("nodeStatus"))


def derive_current_node_status(
    checkpoint: str, suffix_states: dict, current_idx: int,
) -> str:
    """Return the current run node status for project summaries."""
    if checkpoint == "needs_fix":
        return "blocked"
    if checkpoint == "archived":
        return "archived"
    if current_idx < 0:
        return "unknown"
    suffix = extract_checkpoint_suffix(checkpoint)
    if suffix is None:
        return "unknown"
    state = suffix_states.get(suffix, {"nodeStatus": "unknown"})
    return _normalize_node_status(state.get("nodeStatus"))


def node_status_label(node_status: str, node: dict | None = None) -> str:
    normalized_status = _normalize_node_status(node_status)
    if node is not None:
        for state in node.get("states", []):
            if not isinstance(state, dict):
                continue
            raw_status = state.get("nodeStatus", state.get("id"))
            if _normalize_node_status(raw_status) != normalized_status:
                continue
            label = state.get("label")
            if isinstance(label, str) and label.strip():
                return label
    return DEFAULT_NODE_STATUS_LABELS[normalized_status]


def derive_current_node_status_label(
    checkpoint: str,
    suffix_states: dict,
    current_idx: int,
    current_node: dict | None = None,
) -> str:
    current_node_status = derive_current_node_status(checkpoint, suffix_states, current_idx)
    if current_node is not None:
        return node_status_label(current_node_status, current_node)

    suffix = extract_checkpoint_suffix(checkpoint)
    if suffix is not None:
        state = suffix_states.get(suffix, {})
        label = state.get("label") if isinstance(state, dict) else None
        if isinstance(label, str) and label.strip():
            return label
    return DEFAULT_NODE_STATUS_LABELS[current_node_status]


def build_workflow_fallback_states(config: dict) -> list[dict]:
    """Build workflow-level fallback states for statuses not tied to a node."""
    by_status: dict[str, dict] = {
        "unknown": {
            "nodeStatus": "unknown",
        },
    }
    for state in config.get("checkpointSuffixState", {}).values():
        node_status = _normalize_node_status(state.get("nodeStatus"))
        by_status[node_status] = {
            "nodeStatus": node_status,
        }
    return list(by_status.values())


def _normalize_next_action(value: object, *, context: str) -> dict[str, str]:
    if not isinstance(value, dict):
        raise BoardConfigError(f"{context}.nextAction must be an object")

    next_action: dict[str, str] = {}
    for field in NEXT_ACTION_FIELDS:
        item = value.get(field)
        if not isinstance(item, str) or not item.strip():
            raise BoardConfigError(f"{context}.nextAction.{field} must be a non-empty string")
        next_action[field] = item
    return next_action


def _normalize_node_states(node: dict) -> list[dict]:
    node_id = node.get("id", "<unknown>")
    states = node.get("states", [])
    if not isinstance(states, list):
        raise BoardConfigError(f"{node_id}.states must be a list")

    clean_states: list[dict] = []
    for index, state in enumerate(states):
        context = f"{node_id}.states[{index}]"
        if not isinstance(state, dict):
            raise BoardConfigError(f"{context} must be an object")
        raw_status = state.get("nodeStatus", state.get("id"))
        node_status = _normalize_node_status(raw_status)
        if node_status == "unknown" and raw_status != "unknown":
            raise BoardConfigError(f"{context}.nodeStatus must be a supported node status")
        clean_state = {
            k: copy.deepcopy(v)
            for k, v in state.items()
            if k not in {"id", "nodeStatus", "nextAction"}
        }
        clean_state["id"] = node_status
        clean_state["nodeStatus"] = node_status
        clean_state["nextAction"] = _normalize_next_action(state.get("nextAction"), context=context)
        clean_states.append(clean_state)
    return clean_states


def _normalize_artifact_definitions(node: dict) -> list[dict]:
    node_id = node.get("id", "<unknown>")
    clean_artifacts: list[dict] = []
    for index, artifact in enumerate(artifact_dicts(node, "outputs")):
        context = f"{node_id}.artifactDefinitions[{index}]"
        artifact_type = _normalize_artifact_type(artifact.get("artifactType"))
        if artifact_type == "unknown" and artifact.get("artifactType") != "unknown":
            raise BoardConfigError(f"{context}.artifactType must be a supported artifact type")
        clean_artifacts.append({
            "id": artifact.get("id"),
            "artifactType": artifact_type,
            "required": artifact.get("required", False),
        })
    return clean_artifacts


def build_workflow_shell(config: dict) -> dict:
    """Build workflow shell from config — strips internal mapping fields.

    Removes from output:
    - top-level ``id``, ``version``, and ``kind``
    - workflow-level ``templates`` (create-feature options, not run display state)
    - workflow-level ``checkpoints`` (contract-only checkpoint matrix)
    - workflow-level ``transitions`` (the board currently treats nodes as a linear sequence)
    - node-level ``checkpoints`` (internal checkpoint→node mapping)
    - ``order``, ``skill``, ``artifacts``, ``validators``, and guards/internal fields from nodes
    - ``path`` from each output artifact definition
    """
    workflow = {
        k: v
        for k, v in config["workflow"].items()
            if k not in {
                "id",
                "version",
                "kind",
                "templates",
                "checkpoints",
                "transitions",
                "profiles",
                "dynamicStages",
                "skipPolicy",
            }
    }
    clean_nodes: list[dict] = []
    for node in workflow["nodes"]:
        clean = {
            k: v
            for k, v in node.items()
            if k not in NODE_INTERNAL_FIELDS
        }
        clean["states"] = _normalize_node_states(node)
        clean["artifactDefinitions"] = _normalize_artifact_definitions(node)
        clean_nodes.append(clean)
    workflow["nodes"] = clean_nodes
    return workflow
