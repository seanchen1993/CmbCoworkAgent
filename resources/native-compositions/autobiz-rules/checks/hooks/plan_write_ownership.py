"""Read-only rules extracted from hooks/plan_write_ownership.py. See provenance.json."""
from __future__ import annotations
from collections import defaultdict
from typing import Any, Iterable, Mapping

TEST_ASSET_ROOT_CONFIGS = frozenset({
    "pytest.ini",
    "tox.ini",
    ".coveragerc",
    "jest.config.js",
    "jest.config.cjs",
    "jest.config.mjs",
    "jest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "vitest.config.ts",
    "karma.conf.js",
    "playwright.config.js",
    "playwright.config.ts",
    "cypress.config.js",
    "cypress.config.ts",
})


def normalize_owned_path(value: Any, workspace_ref: Any) -> str | None:
    """Normalize the writer's ``Repo:path`` and ``Repo/path`` spellings.

    Plan artifacts historically used both forms.  The scheduler only needs a
    repository-relative path, so normalize both before deciding ownership.
    """

    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.replace("\\", "/").strip().strip("/")
    if not raw:
        return None
    repository = workspace_ref.strip() if isinstance(workspace_ref, str) else ""
    if repository:
        for prefix in (f"{repository}:", f"{repository}/"):
            if raw.startswith(prefix):
                raw = raw[len(prefix):].strip("/")
                break
    return raw or None


def is_test_asset_path(path: str) -> bool:
    """Return whether a repository-relative path belongs to UTest ownership."""

    parts = tuple(part for part in path.replace("\\", "/").split("/") if part)
    basename = parts[-1] if parts else ""
    return (
        (parts and parts[0] in {"test", "tests", "__tests__", "e2e", "playwright", "cypress"})
        or any(parts[index:index + 2] == ("src", "test") for index in range(len(parts) - 1))
        or basename in TEST_ASSET_ROOT_CONFIGS
        or basename.startswith("test_")
        or ".test." in basename
        or ".spec." in basename
    )


def task_write_paths(task: dict[str, Any]) -> set[str]:
    """Return Code-stage physical write paths for one Task.

    Test assets are generated only after business-code Review by the UTest
    stage. They cannot serialize Code Batches or be used as a Review
    completeness requirement.
    """

    workspace_ref = task.get("workspaceRef")
    raw_paths: list[Any] = []
    scope = task.get("scope")
    if isinstance(scope, dict) and isinstance(scope.get("paths"), list):
        raw_paths.extend(scope["paths"])
    if isinstance(task.get("expectedFiles"), list):
        raw_paths.extend(task["expectedFiles"])
    paths: set[str] = set()
    for value in raw_paths:
        path = normalize_owned_path(value, workspace_ref)
        if path is not None and not is_test_asset_path(path):
            paths.add(path)
    return paths


def task_write_targets(task: dict[str, Any]) -> dict[str, set[str] | None]:
    """Return physical paths and optional member anchors for one task.

    ``None`` denotes a whole-file claim for an observed ownership record.
    """

    workspace_ref = task.get("workspaceRef")
    declared: dict[str, set[str] | None] = {}
    raw_targets = task.get("writeTargets")
    if isinstance(raw_targets, list):
        for item in raw_targets:
            if not isinstance(item, dict):
                continue
            path = normalize_owned_path(item.get("path"), workspace_ref)
            if path is None or is_test_asset_path(path):
                continue
            raw_symbols = item.get("symbols")
            if not isinstance(raw_symbols, list) or any(
                not isinstance(symbol, str) or not symbol.strip() for symbol in raw_symbols
            ):
                declared[path] = None
                continue
            symbols = {symbol.strip() for symbol in raw_symbols}
            if not symbols:
                declared[path] = None
                continue
            prior = declared.get(path)
            declared[path] = None if prior is None and path in declared else (prior or set()) | symbols

    # scope.paths/expectedFiles remain physical source of truth. A target only
    # refines a matching path; no declared anchor can hide another file write.
    for path in task_write_paths(task):
        declared.setdefault(path, None)
    return declared


def write_ownership_violations(
    tasks: Iterable[dict[str, Any]],
    *,
    ownership_scope_by_task: Mapping[str, str] | None = None,
) -> list[dict[str, Any]]:
    """Return structured errors for files claimed by more than one Batch.

    Tasks in one Batch execute as one ordered delivery, so they may share an
    implementation file without reducing inter-Batch parallelism.  The
    ownership boundary is therefore a projected Batch, not an individual
    Task.  When a scope map is omitted each Task is treated as its own Batch;
    this is useful only for callers that do not have a Batch projection yet.
    """

    owners: dict[tuple[str, str], dict[str, dict[str, set[str] | None]]] = defaultdict(
        lambda: defaultdict(dict)
    )
    for task in tasks:
        if not isinstance(task, dict) or task.get("executionMode") == "external_dependency":
            continue
        task_id = task.get("id")
        workspace_ref = task.get("workspaceRef")
        if not isinstance(task_id, str) or not task_id.strip():
            continue
        if not isinstance(workspace_ref, str) or not workspace_ref.strip():
            continue
        scope = (
            ownership_scope_by_task.get(task_id, task_id)
            if ownership_scope_by_task is not None
            else task_id
        )
        for path, symbols in task_write_targets(task).items():
            scoped = owners[(workspace_ref.strip(), path)][scope]
            prior = scoped.get(task_id)
            if prior is None and task_id in scoped:
                continue
            if symbols is None:
                scoped[task_id] = None
            else:
                scoped[task_id] = (prior or set()) | symbols

    violations: list[dict[str, Any]] = []
    for (workspace_ref, path), scoped_claims in sorted(owners.items()):
        if len(scoped_claims) < 2:
            continue
        whole_file_scopes = {
            scope
            for scope, claims in scoped_claims.items()
            if any(symbols is None for symbols in claims.values())
        }
        symbol_scopes: dict[str, set[str]] = defaultdict(set)
        for scope, claims in scoped_claims.items():
            for symbols in claims.values():
                if symbols is not None:
                    for symbol in symbols:
                        symbol_scopes[symbol].add(scope)
        overlapping_symbols = sorted(
            symbol for symbol, scopes in symbol_scopes.items() if len(scopes) > 1
        )
        if not whole_file_scopes and not overlapping_symbols:
            continue
        violating_scopes = set(whole_file_scopes)
        if whole_file_scopes:
            violating_scopes.update(scoped_claims)
        for symbol in overlapping_symbols:
            violating_scopes.update(symbol_scopes[symbol])
        ordered_task_ids = sorted({
            task_id
            for scope, claims in scoped_claims.items()
            if scope in violating_scopes
            for task_id in claims
        })
        ownership_kind = "whole_file" if whole_file_scopes else "member_anchor"
        violations.append({
            "reason": "shared_write_path_requires_single_owner",
            "workspaceRef": workspace_ref,
            "path": path,
            "detail": (
                f"workspace={workspace_ref};path={path};"
                f"taskIds={','.join(ordered_task_ids)};ownership={ownership_kind}"
            ),
            "taskIds": ordered_task_ids,
            "field": "writeTargets" if ownership_kind == "member_anchor" else "touches",
            "repairTarget": "task_group",
            "repairSuggestion": (
                f"{workspace_ref}:{path} 被多个 Task 以 {ownership_kind} 方式声明。"
                "如确为同一 Controller/Service 的不同方法，可为每个 Task 在 writeTargets 中声明"
                "互不重叠的稳定 symbols；否则保留一个前置 owner Task，消费者通过 deps 消费其产出，"
                "并从 touches、scope.paths、expectedFiles 和 implementationPoints 中移除该文件。"
            ),
        })
    return violations


def write_ownership_error_codes(
    tasks: Iterable[dict[str, Any]],
    *,
    ownership_scope_by_task: Mapping[str, str] | None = None,
) -> list[str]:
    """Stable compact form for the low-level plan.json validator."""

    return [
        "{reason}:workspace={workspace}:path={path}:taskIds={task_ids}".format(
            reason=violation["reason"],
            workspace=violation["workspaceRef"],
            path=violation["path"],
            task_ids=",".join(violation["taskIds"]),
        )
        for violation in write_ownership_violations(
            tasks,
            ownership_scope_by_task=ownership_scope_by_task,
        )
    ]
