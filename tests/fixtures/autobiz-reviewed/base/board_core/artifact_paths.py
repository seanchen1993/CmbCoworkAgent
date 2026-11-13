"""Filesystem helpers for workflow artifact paths."""

from __future__ import annotations

from pathlib import Path


GLOB_CHARS = frozenset("*?[")


def has_glob(path: str) -> bool:
    return any(char in path for char in GLOB_CHARS)


def resolve_exact_relative_path(root: Path, relative_path: str | Path) -> Path | None:
    """Resolve a child path only when every path component matches case exactly."""
    rel = Path(relative_path)
    if rel.is_absolute():
        return None

    current = root
    for part in rel.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            return None
        try:
            entries = {entry.name: entry for entry in current.iterdir()}
        except OSError:
            return None
        next_path = entries.get(part)
        if next_path is None:
            return None
        current = next_path
    return current


def is_nonempty_file_exact(root: Path, relative_path: str | Path) -> bool:
    target = resolve_exact_relative_path(root, relative_path)
    return target is not None and target.is_file() and target.stat().st_size > 0


def _is_within(root: Path, target: Path) -> bool:
    try:
        target.relative_to(root)
    except ValueError:
        return False
    return True


def _resolved_nonempty_file(root: Path, candidate: Path) -> Path | None:
    try:
        relative_candidate = candidate.relative_to(root)
    except ValueError:
        return None
    exact_candidate = resolve_exact_relative_path(root, relative_candidate)
    if exact_candidate is None or not exact_candidate.is_file():
        return None
    try:
        resolved = exact_candidate.resolve()
        if not _is_within(root, resolved) or resolved.stat().st_size <= 0:
            return None
    except (OSError, RuntimeError):
        return None
    return resolved


def resolve_artifact_files_exact(feature_dir: Path, artifact_path: str) -> tuple[Path, ...]:
    """Resolve an artifact contract to sorted, non-empty files inside the feature dir."""
    try:
        root = feature_dir.resolve()
    except (OSError, RuntimeError):
        return ()
    relative = Path(artifact_path)
    if relative.is_absolute() or ".." in relative.parts:
        return ()

    if has_glob(artifact_path):
        candidates = root.glob(artifact_path)
    else:
        target = resolve_exact_relative_path(root, relative)
        if target is None:
            return ()
        try:
            resolved_target = target.resolve()
        except (OSError, RuntimeError):
            return ()
        if not _is_within(root, resolved_target):
            return ()
        candidates = resolved_target.rglob("*") if resolved_target.is_dir() else (resolved_target,)

    resolved_by_path: dict[str, Path] = {}
    for candidate in candidates:
        resolved = _resolved_nonempty_file(root, candidate)
        if resolved is not None:
            resolved_by_path[str(resolved)] = resolved
    return tuple(resolved_by_path[path] for path in sorted(resolved_by_path))


def artifact_exists_exact(feature_dir: Path, artifact_path: str) -> bool:
    return bool(resolve_artifact_files_exact(feature_dir, artifact_path))
