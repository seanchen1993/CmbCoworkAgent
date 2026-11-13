"""Dependency closure solver for custom workflow node selections."""

from __future__ import annotations

from dataclasses import dataclass

from board_core.workflow_compiler import WorkflowCompileError, _artifact_dicts


@dataclass(frozen=True)
class ClosureResult:
    """Closure outcome over the base node array.

    nodes: closed selection in base array order.
    added: producer nodes pulled in to satisfy required inputs (auto mode only).
    entry_nodes: chain head plus nodes whose required inputs were dropped
        (they start from user-provided context).
    dropped: node id -> input paths that compilation will remove because the
        producer is not in the selection (includes optional inputs).
    suggestions: node id -> {dropped input path -> producer node id};
        advisory only, the UI may offer these as optional upstream additions.
    """

    nodes: tuple[str, ...]
    added: tuple[str, ...]
    entry_nodes: tuple[str, ...]
    dropped: dict[str, tuple[str, ...]]
    suggestions: dict[str, dict[str, str]]


def _base_nodes(base_config: dict) -> list[dict]:
    workflow = base_config.get("workflow")
    if not isinstance(workflow, dict):
        raise WorkflowCompileError("workflow must be an object")
    nodes = workflow.get("nodes")
    if not isinstance(nodes, list):
        raise WorkflowCompileError("workflow.nodes must be a list")
    return [node for node in nodes if isinstance(node, dict) and isinstance(node.get("id"), str)]


def _producer_index(nodes: list[dict]) -> dict[str, str]:
    producers: dict[str, str] = {}
    for node in nodes:
        for artifact in _artifact_dicts(node, "outputs"):
            if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
                producers.setdefault(artifact["path"], str(node["id"]))
    return producers


def _input_paths(node: dict) -> list[tuple[str, bool]]:
    paths: list[tuple[str, bool]] = []
    for artifact in _artifact_dicts(node, "inputs"):
        if not isinstance(artifact, dict):
            continue
        path = artifact.get("path")
        if not isinstance(path, str):
            continue
        paths.append((path, bool(artifact.get("required", True))))
    return paths


def solve_node_closure(
    base_config: dict,
    selected_node_ids: object,
    *,
    auto_include_producers: bool = False,
) -> ClosureResult:
    """Resolve a custom node selection against its input dependencies.

    Upstream nodes are never hard dependencies: inputs whose producer is not
    in the selection are dropped from the compiled contract entirely, and the
    node becomes an entry point when required inputs are affected. suggestions
    reports which base node would produce each dropped input, for the UI to
    offer as optional additions. With auto_include_producers the solver
    instead pulls producers of required inputs in transitively (opt-in
    full-chain mode).
    """
    if not isinstance(selected_node_ids, (list, tuple)):
        raise WorkflowCompileError("selected nodes must be a list of node ids")
    requested = [str(node_id).strip() for node_id in selected_node_ids if str(node_id).strip()]
    if not requested:
        raise WorkflowCompileError("node selection must contain at least one node id")

    nodes = _base_nodes(base_config)
    node_order = [str(node["id"]) for node in nodes]
    node_by_id = {str(node["id"]): node for node in nodes}

    unknown = sorted(set(requested) - set(node_order))
    if unknown:
        raise WorkflowCompileError(f"node selection references unknown nodes: {', '.join(unknown)}")

    selected = set(requested)
    added: set[str] = set()
    if auto_include_producers:
        producers = _producer_index(nodes)
        changed = True
        while changed:
            changed = False
            for node_id in sorted(selected):
                for path, required in _input_paths(node_by_id[node_id]):
                    if not required:
                        continue
                    producer = producers.get(path)
                    if producer and producer != node_id and producer not in selected:
                        selected.add(producer)
                        added.add(producer)
                        changed = True

    ordered = [node_id for node_id in node_order if node_id in selected]

    # Anything still unsatisfied gets dropped from the compiled contract; the
    # node is an entry point when required inputs are affected. For each
    # dropped input with an in-base producer, record a suggestion.
    producers = _producer_index(nodes)
    available: set[str] = set()
    dropped: dict[str, tuple[str, ...]] = {}
    suggestions: dict[str, dict[str, str]] = {}
    entry_nodes: list[str] = [ordered[0]] if ordered else []
    for node_id in ordered:
        node = node_by_id[node_id]
        inputs = _input_paths(node)
        broken = tuple(path for path, _ in inputs if path not in available)
        if broken:
            dropped[node_id] = broken
            broken_required = {path for path, required in inputs if required and path not in available}
            if broken_required and node_id not in entry_nodes:
                entry_nodes.append(node_id)
            hints = {
                path: producers[path]
                for path in broken
                if path in producers and producers[path] != node_id
            }
            if hints:
                suggestions[node_id] = hints
        for artifact in _artifact_dicts(node, "outputs"):
            if isinstance(artifact, dict) and isinstance(artifact.get("path"), str):
                available.add(artifact["path"])

    return ClosureResult(
        nodes=tuple(ordered),
        added=tuple(node_id for node_id in node_order if node_id in added),
        entry_nodes=tuple(entry_nodes),
        dropped=dropped,
        suggestions=suggestions,
    )
