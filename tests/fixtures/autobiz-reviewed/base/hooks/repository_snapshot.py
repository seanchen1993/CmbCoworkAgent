#!/usr/bin/env python3
"""Shared Git repository snapshot helpers."""

from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path
from typing import Any, Dict


RepositoryMap = Dict[str, Path]
REQUIRED_IGNORED_RUNTIME_PATHS = (".cmbdevclaw/large_tool_results/",)
# Dynamic Workflow owns the complete .cmbdevclaw directory in the host
# repository. Its journals, sidecars, tool streams, and setup marker are
# platform runtime state rather than business-source changes.
PLATFORM_RUNTIME_DIRECTORY = ".cmbdevclaw/"
WORKFLOW_RUNTIME_DIRECTORY = f"{PLATFORM_RUNTIME_DIRECTORY}workflows/"
_PLATFORM_RUNTIME_EXCLUDE = f":(exclude){PLATFORM_RUNTIME_DIRECTORY}**"


class RepositorySnapshotError(ValueError):
    pass


def _run_text(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    """Run Git with a stable text codec on every supported platform.

    Windows commonly reports the active code page as GBK while Git emits UTF-8
    paths.  Relying on ``text=True`` alone therefore makes repositories with
    CJK path segments fail before the actual Git operation is evaluated.
    """
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def git_status_porcelain(repo: Path) -> subprocess.CompletedProcess[str]:
    """Return Git status while excluding platform-owned runtime files.

    The exclusion is intentionally narrow.  Any other tracked, untracked, or
    staged business file remains visible and continues to block a merge.
    """
    return _run_text(
        repo,
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--",
        ".",
        _PLATFORM_RUNTIME_EXCLUDE,
    )


def resolve_git_root(code_workspace: Path) -> Path:
    completed = _run_text(code_workspace, "rev-parse", "--show-toplevel")
    if completed.returncode != 0 or not completed.stdout.strip():
        # Preserve Git's diagnostic.  Platform worktree failures are otherwise
        # indistinguishable from a caller passing the artifact directory as a
        # code workspace, which led workers to attempt unsafe manual fallback.
        detail = completed.stderr.strip().replace("\n", " ")
        suffix = f":git_exit={completed.returncode}"
        if detail:
            suffix += f":{detail}"
        raise RepositorySnapshotError(f"code_workspace_not_git_repository:{code_workspace}{suffix}")
    return Path(completed.stdout.strip()).resolve()


def current_git_branch(repo: Path) -> str | None:
    """Return the checked-out branch using syntax supported by Git 2.20+.

    ``git branch --show-current`` was only added in Git 2.22.  Native
    worktree verification must also support the older Git bundled with many
    Windows enterprise environments, where ``symbolic-ref`` is available.
    Detached HEAD deliberately returns ``None`` and fails the caller's branch
    equality guard.
    """
    completed = _run_text(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
    value = completed.stdout.strip()
    return value if completed.returncode == 0 and value else None


def resolve_repositories(code_workspaces: Path | list[Path]) -> RepositoryMap:
    values = code_workspaces if isinstance(code_workspaces, list) else [code_workspaces]
    repositories: RepositoryMap = {}
    seen_roots: set[Path] = set()
    for workspace in values:
        root = resolve_git_root(workspace)
        if root in seen_roots:
            continue
        repository_id = root.name
        if repository_id in repositories:
            raise RepositorySnapshotError(f"duplicate_repository_id:{repository_id}")
        repositories[repository_id] = root
        seen_roots.add(root)
    if not repositories:
        raise RepositorySnapshotError("code_workspace_missing")
    return repositories


def unignored_runtime_artifact_paths(
    repo: Path,
    paths: tuple[str, ...] = REQUIRED_IGNORED_RUNTIME_PATHS,
) -> list[str]:
    unignored: list[str] = []
    for raw in paths:
        relative = raw.rstrip("/")
        probe = f"{relative}/.task-runner-ignore-probe"
        completed = _run_text(repo, "check-ignore", "--quiet", "--no-index", "--", probe)
        if completed.returncode == 1:
            unignored.append(raw)
        elif completed.returncode != 0:
            raise RepositorySnapshotError("git_ignore_check_failed")
    return unignored


def hash_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def capture_file_snapshot(repo: Path) -> dict[str, str | None]:
    completed = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "ls-files",
            "-co",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            _PLATFORM_RUNTIME_EXCLUDE,
        ],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RepositorySnapshotError("git_snapshot_failed")
    paths = sorted(
        {
            raw.decode("utf-8", errors="surrogateescape")
            for raw in completed.stdout.split(b"\0")
            if raw
        }
    )
    return {path: hash_file(repo / path) for path in paths}


def capture_untracked_files(repo: Path) -> list[str]:
    completed = subprocess.run(
        [
            "git",
            "-C",
            str(repo),
            "ls-files",
            "-o",
            "--exclude-standard",
            "-z",
            "--",
            ".",
            _PLATFORM_RUNTIME_EXCLUDE,
        ],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise RepositorySnapshotError("git_snapshot_failed")
    return sorted(
        {
            raw.decode("utf-8", errors="surrogateescape")
            for raw in completed.stdout.split(b"\0")
            if raw
        }
    )


def working_tree_changed_files(repo: Path) -> list[str]:
    """Return every business path differing from ``HEAD`` in this checkout.

    Task runs keep completed tasks' changes uncommitted until a Batch is
    sealed. Use NUL-delimited Git output so CJK and Windows paths remain
    lossless, and add untracked files explicitly.
    """
    completed = _run_text(
        repo,
        "diff",
        "--name-only",
        "-z",
        "HEAD",
        "--",
        ".",
        _PLATFORM_RUNTIME_EXCLUDE,
    )
    if completed.returncode != 0:
        raise RepositorySnapshotError("git_worktree_status_failed")
    changed = {
        raw.decode("utf-8", errors="surrogateescape")
        for raw in completed.stdout.encode("utf-8", errors="surrogateescape").split(b"\0")
        if raw
    }
    changed.update(capture_untracked_files(repo))
    return sorted(changed)


def capture_repository_snapshot(repo: Path, *, include_files: bool = True) -> dict[str, Any]:
    """Capture repository identity and, unless disabled, visible file hashes.

    Some callers only need the Git identity (HEAD plus index tree).  Keeping
    that path separate avoids hashing every working-tree file when a durable
    content reference can be recorded from Git instead.
    """
    head = _run_text(repo, "rev-parse", "HEAD")
    index = _run_text(repo, "write-tree")
    if head.returncode != 0:
        # A freshly initialized repository has a valid index and worktree but
        # no commit object yet. Keep a stable, explicit baseline instead of
        # treating the expected unborn HEAD as a broken Git repository.
        branch = _run_text(repo, "symbolic-ref", "--quiet", "--short", "HEAD")
        if branch.returncode != 0 or not branch.stdout.strip():
            raise RepositorySnapshotError("git_snapshot_failed")
        head_commit = f"unborn:{branch.stdout.strip()}"
    else:
        head_commit = head.stdout.strip()
    if index.returncode != 0:
        raise RepositorySnapshotError("git_snapshot_failed")
    snapshot = {
        "headCommit": head_commit,
        "indexTree": index.stdout.strip(),
    }
    if include_files:
        snapshot["files"] = capture_file_snapshot(repo)
    return snapshot


def file_kind(path: str) -> str:
    suffix = Path(path).suffix.lower()
    if suffix in {".md", ".rst", ".txt"}:
        return "docs"
    if suffix in {".json", ".yaml", ".yml", ".toml", ".ini", ".properties"}:
        return "config"
    if "test" in Path(path).parts or Path(path).name.lower().startswith("test"):
        return "test"
    return "source"


def snapshot_changes(
    before: dict[str, str | None],
    after: dict[str, str | None],
) -> list[dict[str, str]]:
    changes: list[dict[str, str]] = []
    deleted = {
        path: digest
        for path, digest in before.items()
        if (path not in after or after.get(path) is None) and isinstance(digest, str)
    }
    created = {
        path: digest
        for path, digest in after.items()
        if path not in before and isinstance(digest, str)
    }
    renamed_from: set[str] = set()
    renamed_to: set[str] = set()
    for old_path, old_digest in sorted(deleted.items()):
        new_path = next(
            (
                candidate
                for candidate, digest in sorted(created.items())
                if candidate not in renamed_to and digest == old_digest
            ),
            None,
        )
        if new_path is None:
            continue
        renamed_from.add(old_path)
        renamed_to.add(new_path)
        changes.append(
            {
                "path": new_path,
                "fromPath": old_path,
                "operation": "renamed",
                "kind": file_kind(new_path),
                "summary": f"Task execution renamed {old_path} to {new_path}",
                "reason": "Detected from matching task run file hashes",
            }
        )
    for path in sorted(set(before) | set(after)):
        if path in renamed_from or path in renamed_to:
            continue
        old = before.get(path)
        new = after.get(path)
        if old == new:
            continue
        if path not in before:
            operation = "created"
        elif path not in after or new is None:
            operation = "deleted"
        else:
            operation = "modified"
        changes.append(
            {
                "path": path,
                "operation": operation,
                "kind": file_kind(path),
                "summary": f"Task execution {operation} {path}",
                "reason": "Detected from the task run Git snapshot",
            }
        )
    return changes
