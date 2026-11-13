#!/usr/bin/env python3
"""Type definitions for conflict resolution in optimistic parallel execution."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class CandidateStatus(Enum):
    """Status of a merge candidate in the Merge Train."""
    BUILDING = "building"
    BUILT = "built"  # Successfully merged, waiting for verification
    VERIFIED = "verified"  # Validation passed, waiting for promotion
    PROMOTED = "promoted"  # Successfully promoted to main
    CANDIDATE_CONFLICTED = "candidate_conflicted"  # Git merge conflict detected
    VALIDATION_FAILED = "validation_failed"  # Reserved legacy validation failure
    NEEDS_RESOLUTION = "needs_resolution"  # Requires manual/Agent intervention
    DISCARDED = "discarded"  # Candidate intentionally removed before promotion
    FAILED = "failed"  # Generic failure
    STALE = "stale"  # Outdated, needs rebuild


@dataclass
class ConflictContext:
    """Context information for resolving merge conflicts."""
    base_sha: str  # SHA of main branch when candidate was created
    batch_ids: list[str]  # IDs of batches involved in this candidate
    conflicted_files: list[str]  # List of files with conflicts
    candidate_worktree: str  # Path to candidate worktree
    conflict_markers: dict[str, str]  # {file_path: conflict_content with <<<<, ====, >>>>}
    repository_ref: str  # Repository reference
    wave: int  # Wave number
    attempts: int = 0  # Number of resolution attempts
    error_message: str = ""  # Original error message from Git
    task_card_id: str = ""  # Workflow-scoped production commit context


@dataclass
class ResolutionResult:
    """Result of conflict resolution attempt."""
    status: str  # 'resolved' | 'manual_required'
    resolved_files: list[str]  # Files successfully resolved
    unresolved_files: list[str]  # Files that still have conflicts
    new_candidate_sha: str | None = None  # New SHA after resolution
    reason: str = ""  # Explanation of result
    strategy_used: str = ""  # Strategy that was applied


class ConflictType(Enum):
    """Types of merge conflicts."""
    APPEND_ONLY = "append_only"  # Different positions, both adding content
    LOCAL = "local"  # Same function/class, different lines
    STRUCTURAL = "structural"  # Affects function/class signatures
    SEMANTIC = "semantic"  # Requires understanding business logic
    UNRESOLVABLE = "unresolvable"  # Cannot auto-resolve safely
