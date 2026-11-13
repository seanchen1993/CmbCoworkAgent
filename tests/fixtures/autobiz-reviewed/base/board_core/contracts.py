"""Workflow contract helpers backed by effective workflow config."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from board_core.workflow_compiler import (
    ALLOWED_GUARDS,
    BASE_WORKFLOW_PROFILE,
    WorkflowCompileError,
    compile_node_subset,
    load_effective_board_config,
    normalize_workflow_decisions,
    normalize_workflow_profile,
    normalize_workflow_skipped_nodes,
    normalize_workflow_template,
    read_json,
    resolve_template_subset,
)


class BoardConfigError(Exception):
    """Raised when board_config.json cannot be used as a workflow contract."""


@dataclass(frozen=True)
class ExtractSpec:
    """How to handle a missing input artifact (the degrade path)."""

    degrade: str = ""


@dataclass(frozen=True)
class ArtifactSpec:
    id: str
    label: str
    path: str
    kind: str = "file"
    required: bool = True
    extract: ExtractSpec | None = None


@dataclass(frozen=True)
class SkillContract:
    node_id: str
    label: str
    group: str
    skill: str
    checkpoints: tuple[str, ...]
    inputs: tuple[ArtifactSpec, ...]
    outputs: tuple[ArtifactSpec, ...]
    validators: tuple[str, ...]
    guards: tuple[str, ...] = ()

    @property
    def required_inputs(self) -> tuple[str, ...]:
        return tuple(artifact.path for artifact in self.inputs if artifact.required)

    @property
    def required_outputs(self) -> tuple[str, ...]:
        return tuple(artifact.path for artifact in self.outputs if artifact.required)


@dataclass(frozen=True)
class WorkflowContracts:
    nodes: tuple[dict, ...]
    profile: str
    skill_contracts: dict[str, SkillContract]
    known_checkpoints: frozenset[str]
    initial_checkpoints: frozenset[str]
    allowed_next: dict[str, frozenset[str]]
    stage_labels: dict[str, str]
    start_checkpoint_to_skill: dict[str, str]
    end_checkpoint_to_skill: dict[str, str]
    skipped_skills: dict[str, str] = field(default_factory=dict)

    def contract_for_skill(self, skill: str) -> SkillContract:
        try:
            return self.skill_contracts[skill]
        except KeyError as exc:
            skipped_node = self.skipped_skills.get(skill)
            if skipped_node:
                raise BoardConfigError(
                    f"skill {skill} 所属节点 {skipped_node} 已在当前 workflow 中被跳过"
                ) from exc
            raise BoardConfigError(f"unknown skill in board_config.json: {skill}") from exc


def default_config_path() -> Path:
    return Path(__file__).resolve().with_name("board_config.json")


def config_path_for_repo(repo_root: Path) -> Path:
    return repo_root / "board_core" / "board_config.json"


def load_board_config(config_path: Path | None = None) -> dict:
    path = config_path or default_config_path()
    if not path.is_file():
        raise BoardConfigError(f"board_config.json not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise BoardConfigError(f"invalid board_config.json: {path}:{exc.lineno}:{exc.colno}") from exc


def artifact_dicts(node: dict, direction: str = "outputs") -> list[dict]:
    artifacts = node.get("artifacts")
    if isinstance(artifacts, dict):
        value = artifacts.get(direction, [])
        if isinstance(value, list):
            return value
        return []
    if direction == "outputs":
        legacy = node.get("artifactDefinitions", [])
        if isinstance(legacy, list):
            return legacy
    return []


def _read_string_list(value: object, *, context: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) or not item for item in value):
        raise BoardConfigError(f"{context} must be a list of non-empty strings")
    return tuple(value)


def _read_extract_spec(value: object, *, context: str) -> ExtractSpec | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise BoardConfigError(f"{context}.extract must be an object")
    degrade = value.get("degrade", "")
    if not isinstance(degrade, str):
        raise BoardConfigError(f"{context}.extract.degrade must be a string")
    return ExtractSpec(degrade=degrade)


def _read_artifact_specs(items: object, *, context: str) -> tuple[ArtifactSpec, ...]:
    if not isinstance(items, list):
        raise BoardConfigError(f"{context} must be a list")

    specs: list[ArtifactSpec] = []
    seen_paths: set[str] = set()
    for index, item in enumerate(items):
        item_context = f"{context}[{index}]"
        if not isinstance(item, dict):
            raise BoardConfigError(f"{item_context} must be an object")

        artifact_id = item.get("id")
        path = item.get("path")
        if not isinstance(artifact_id, str) or not artifact_id:
            raise BoardConfigError(f"{item_context}.id must be a non-empty string")
        if not isinstance(path, str) or not path:
            raise BoardConfigError(f"{item_context}.path must be a non-empty string")
        if path in seen_paths:
            raise BoardConfigError(f"{context} contains duplicate path: {path}")
        seen_paths.add(path)

        label = item.get("label", item.get("name", artifact_id))
        kind = item.get("artifactType", "file")
        required = item.get("required", True)
        if not isinstance(label, str):
            raise BoardConfigError(f"{item_context}.label must be a string")
        if not isinstance(kind, str) or not kind:
            raise BoardConfigError(f"{item_context}.artifactType must be a non-empty string")
        if not isinstance(required, bool):
            raise BoardConfigError(f"{item_context}.required must be a boolean")
        extract = _read_extract_spec(item.get("extract"), context=item_context)

        specs.append(
            ArtifactSpec(
                id=artifact_id,
                label=label,
                path=path,
                kind=kind,
                required=required,
                extract=extract,
            )
        )
    return tuple(specs)


def _flatten_transition_values(transitions: dict[str, Iterable[str]]) -> set[str]:
    result: set[str] = set()
    for values in transitions.values():
        result.update(values)
    return result


def _node_uses_lifecycle(node: dict) -> bool:
    return isinstance(node.get("skill"), str) and bool(node.get("skill"))


def load_workflow_contracts(
    config_path: Path | None = None,
    *,
    repo_root: Path | None = None,
    workspace: Path | None = None,
    profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: object | None = None,
    overlays: list[dict] | None = None,
    node_subset: list[str] | tuple[str, ...] | None = None,
    skipped_nodes: object | None = None,
) -> WorkflowContracts:
    profile = normalize_workflow_profile(profile)
    try:
        if node_subset is not None:
            config = compile_node_subset(
                read_json(config_path or default_config_path()),
                node_subset,
                profile=profile,
                workflow_decisions=workflow_decisions,
                skipped_nodes=skipped_nodes,
            )
        else:
            config = load_effective_board_config(
                config_path,
                repo_root=repo_root,
                workspace=workspace,
                profile=profile,
                workflow_decisions=workflow_decisions,
                overlays=overlays,
                skipped_nodes=skipped_nodes,
            )
    except WorkflowCompileError as exc:
        raise BoardConfigError(str(exc)) from exc
    workflow = config.get("workflow")
    if not isinstance(workflow, dict):
        raise BoardConfigError("workflow must be an object")

    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise BoardConfigError("workflow.nodes must be a list")

    checkpoint_config = workflow.get("checkpoints")
    if not isinstance(checkpoint_config, dict):
        raise BoardConfigError("workflow.checkpoints must be an object")

    initial = frozenset(_read_string_list(checkpoint_config.get("initial", []), context="workflow.checkpoints.initial"))
    raw_stage_labels = checkpoint_config.get("stageLabels", {})
    if not isinstance(raw_stage_labels, dict) or any(
        not isinstance(key, str) or not key or not isinstance(value, str)
        for key, value in raw_stage_labels.items()
    ):
        raise BoardConfigError("workflow.checkpoints.stageLabels must be an object of string labels")
    stage_labels = dict(raw_stage_labels)

    raw_transitions = checkpoint_config.get("transitions", {})
    if not isinstance(raw_transitions, dict):
        raise BoardConfigError("workflow.checkpoints.transitions must be an object")
    allowed_next: dict[str, frozenset[str]] = {}
    for checkpoint, targets in raw_transitions.items():
        if not isinstance(checkpoint, str) or not checkpoint:
            raise BoardConfigError("workflow.checkpoints.transitions keys must be non-empty strings")
        allowed_next[checkpoint] = frozenset(
            _read_string_list(targets, context=f"workflow.checkpoints.transitions.{checkpoint}")
        )

    checkpoint_owner: dict[str, str] = {}
    skill_contracts: dict[str, SkillContract] = {}
    start_checkpoint_to_skill: dict[str, str] = {}
    end_checkpoint_to_skill: dict[str, str] = {}
    skipped_skills: dict[str, str] = {}

    for index, node in enumerate(nodes):
        if not isinstance(node, dict):
            raise BoardConfigError(f"workflow.nodes[{index}] must be an object")

        node_id = node.get("id")
        label = node.get("label")
        group = node.get("group", "")
        skill = node.get("skill")
        if not isinstance(node_id, str) or not node_id:
            raise BoardConfigError(f"workflow.nodes[{index}].id must be a non-empty string")
        if not isinstance(label, str) or not label:
            raise BoardConfigError(f"workflow.nodes[{index}].label must be a non-empty string")
        if not isinstance(group, str):
            raise BoardConfigError(f"{node_id}.group must be a string")
        if skill is not None and (not isinstance(skill, str) or not skill):
            raise BoardConfigError(f"{node_id}.skill must be a non-empty string")

        if node.get("skipped"):
            # Mid-flight skipped node: stays in the display chain but declares
            # no checkpoints, no skill contract, and no lifecycle mapping, so
            # transition checks, pre/postchecks, and validators never see it.
            if isinstance(skill, str) and skill:
                skipped_skills[skill] = node_id
            continue

        checkpoints = _read_string_list(node.get("checkpoints", []), context=f"{node_id}.checkpoints")
        for checkpoint in checkpoints:
            previous_owner = checkpoint_owner.get(checkpoint)
            if previous_owner is not None:
                raise BoardConfigError(
                    f"checkpoint {checkpoint} is declared by both {previous_owner} and {node_id}"
                )
            checkpoint_owner[checkpoint] = node_id

        inputs = _read_artifact_specs(artifact_dicts(node, "inputs"), context=f"{node_id}.artifacts.inputs")
        outputs = _read_artifact_specs(artifact_dicts(node, "outputs"), context=f"{node_id}.artifacts.outputs")
        validators = _read_string_list(node.get("validators", []), context=f"{node_id}.validators")
        guards = _read_string_list(node.get("guards", []), context=f"{node_id}.guards")
        unknown_guards = sorted(set(guards) - ALLOWED_GUARDS)
        if unknown_guards:
            raise BoardConfigError(f"{node_id}.guards contains unknown guard: {', '.join(unknown_guards)}")

        if skill:
            if skill in skill_contracts:
                raise BoardConfigError(f"skill {skill} is declared by multiple workflow nodes")
            skill_contracts[skill] = SkillContract(
                node_id=node_id,
                label=label,
                group=group,
                skill=skill,
                checkpoints=checkpoints,
                inputs=inputs,
                outputs=outputs,
                validators=validators,
                guards=guards,
            )

            if _node_uses_lifecycle(node):
                for checkpoint in checkpoints:
                    if checkpoint.endswith("_in_progress"):
                        start_checkpoint_to_skill[checkpoint] = skill
                        end_checkpoint_to_skill[checkpoint] = skill

    declared_checkpoints = set(checkpoint_owner) | set(stage_labels)
    missing_initial = initial - declared_checkpoints
    if missing_initial:
        raise BoardConfigError(f"initial checkpoints are not declared: {', '.join(sorted(missing_initial))}")

    transition_checkpoints = set(allowed_next) | _flatten_transition_values(allowed_next)
    missing_transition_checkpoints = transition_checkpoints - declared_checkpoints
    if missing_transition_checkpoints:
        raise BoardConfigError(
            "transition checkpoints are not declared in nodes or stageLabels: "
            + ", ".join(sorted(missing_transition_checkpoints))
        )

    missing_stage_labels = declared_checkpoints - set(stage_labels)
    if missing_stage_labels:
        raise BoardConfigError(f"stage labels are missing for: {', '.join(sorted(missing_stage_labels))}")

    known_checkpoints = frozenset(declared_checkpoints)
    normalized_allowed_next = {
        checkpoint: allowed_next.get(checkpoint, frozenset())
        for checkpoint in known_checkpoints
    }

    return WorkflowContracts(
        nodes=tuple(nodes),
        profile=profile,
        skill_contracts=skill_contracts,
        known_checkpoints=known_checkpoints,
        initial_checkpoints=initial,
        allowed_next=normalized_allowed_next,
        stage_labels=stage_labels,
        start_checkpoint_to_skill=start_checkpoint_to_skill,
        end_checkpoint_to_skill=end_checkpoint_to_skill,
        skipped_skills=skipped_skills,
    )


def load_repo_workflow_contracts(
    repo_root: Path,
    *,
    workspace: Path | None = None,
    profile: str = BASE_WORKFLOW_PROFILE,
    workflow_decisions: object | None = None,
    overlays: list[dict] | None = None,
    node_subset: list[str] | tuple[str, ...] | None = None,
    skipped_nodes: object | None = None,
) -> WorkflowContracts:
    return load_workflow_contracts(
        config_path_for_repo(repo_root),
        repo_root=repo_root,
        workspace=workspace,
        profile=profile,
        workflow_decisions=workflow_decisions,
        overlays=overlays,
        node_subset=node_subset,
        skipped_nodes=skipped_nodes,
    )


def load_record_workflow_contracts(
    repo_root: Path,
    record: dict,
    *,
    workspace: Path | None = None,
) -> WorkflowContracts:
    """Resolve contracts from a state record's workflow fields (template-aware).

    Reads workflowProfile/workflowDecisions/workflowTemplate plus, for custom
    templates, workflowNodes. nodeSubset and custom templates reject
    non-standard profiles and workflow decisions.
    """
    if not isinstance(record, dict):
        raise BoardConfigError("workflow record must be an object")
    profile = normalize_workflow_profile(record.get("workflowProfile"))
    template = normalize_workflow_template(record.get("workflowTemplate"))
    config_path = config_path_for_repo(repo_root)
    try:
        decisions = normalize_workflow_decisions(record.get("workflowDecisions", {}))
        skipped = normalize_workflow_skipped_nodes(record.get("workflowSkippedNodes"))
        subset = resolve_template_subset(
            load_board_config(config_path),
            template,
            workflow_nodes=record.get("workflowNodes"),
        )
    except WorkflowCompileError as exc:
        raise BoardConfigError(str(exc)) from exc

    if subset is None:
        return load_workflow_contracts(
            config_path,
            repo_root=repo_root,
            workspace=workspace,
            profile=profile,
            workflow_decisions=decisions,
            skipped_nodes=skipped,
        )

    if profile != BASE_WORKFLOW_PROFILE:
        raise BoardConfigError(f"workflow template {template} 不支持 workflowProfile={profile}")
    if decisions:
        raise BoardConfigError(f"workflow template {template} 不支持 workflowDecisions")
    return load_workflow_contracts(
        config_path,
        repo_root=repo_root,
        workspace=workspace,
        node_subset=subset,
        skipped_nodes=skipped,
    )
