#!/usr/bin/env python3
"""Intelligent conflict resolution using AI models to preserve both sides' logic."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path
from typing import Any

from hooks.conflict_types import ConflictContext, ConflictType, ResolutionResult
from hooks.commit_message import CommitMessageError, build_commit_message


class ConflictAnalyzer:
    """Analyze merge conflicts to determine type and complexity."""

    def analyze(self, conflict_context: ConflictContext) -> dict[str, Any]:
        """Analyze all conflicted files and determine resolution strategy."""
        conflicts_by_type: dict[ConflictType, list[str]] = {
            ConflictType.APPEND_ONLY: [],
            ConflictType.LOCAL: [],
            ConflictType.STRUCTURAL: [],
            ConflictType.SEMANTIC: [],
            ConflictType.UNRESOLVABLE: [],
        }

        for file_path, content in conflict_context.conflict_markers.items():
            conflict_type = self._classify_conflict(file_path, content)
            conflicts_by_type[conflict_type].append(file_path)

        # Determine overall strategy
        append_only_files = conflicts_by_type[ConflictType.APPEND_ONLY]
        if append_only_files and len(append_only_files) == len(conflict_context.conflicted_files):
            strategy = "auto_merge_append_only"
            confidence = 0.9
        elif conflicts_by_type[ConflictType.STRUCTURAL] or conflicts_by_type[ConflictType.UNRESOLVABLE]:
            strategy = "model_assisted"
            confidence = 0.6
        else:
            strategy = "model_assisted"
            confidence = 0.7

        return {
            "conflicts_by_type": {k.value: v for k, v in conflicts_by_type.items()},
            "recommended_strategy": strategy,
            "confidence": confidence,
            "total_files": len(conflict_context.conflicted_files),
        }

    def _classify_conflict(self, file_path: str, content: str) -> ConflictType:
        """Classify a single file's conflict type."""
        # Parse conflict blocks
        blocks = self._parse_conflict_blocks(content)

        if not blocks:
            return ConflictType.UNRESOLVABLE

        # Check for append-only pattern
        if all(self._is_append_only(block) for block in blocks):
            return ConflictType.APPEND_ONLY

        # Check for structural changes (function/class signatures)
        if any(self._affects_structure(block) for block in blocks):
            return ConflictType.STRUCTURAL

        # Check for local modifications
        if all(self._is_local_modification(block) for block in blocks):
            return ConflictType.LOCAL

        # Default to semantic (needs deep understanding)
        return ConflictType.SEMANTIC

    def _parse_conflict_blocks(self, content: str) -> list[dict[str, str]]:
        """Parse conflict markers into blocks."""
        blocks = []
        lines = content.split("\n")
        i = 0
        while i < len(lines):
            if lines[i].startswith("<<<<<<<"):
                # Start of conflict block
                ours_lines = []
                theirs_lines = []
                base_lines = []
                i += 1
                # Collect "ours" section
                while i < len(lines) and not lines[i].startswith("======="):
                    if not lines[i].startswith("|||||||"):
                        ours_lines.append(lines[i])
                    else:
                        # diff3 style with base
                        i += 1
                        while i < len(lines) and not lines[i].startswith("======="):
                            base_lines.append(lines[i])
                            i += 1
                        break
                    i += 1
                if i < len(lines):
                    i += 1  # Skip "======="
                # Collect "theirs" section
                while i < len(lines) and not lines[i].startswith(">>>>>>>"):
                    theirs_lines.append(lines[i])
                    i += 1
                if i < len(lines):
                    i += 1  # Skip ">>>>>>>"

                blocks.append({
                    "ours": "\n".join(ours_lines),
                    "theirs": "\n".join(theirs_lines),
                    "base": "\n".join(base_lines) if base_lines else "",
                })
            else:
                i += 1
        return blocks

    def _is_append_only(self, block: dict[str, str]) -> bool:
        """Check if conflict is append-only (both sides adding, no deletions)."""
        ours = block["ours"].strip()
        theirs = block["theirs"].strip()

        # Both sides should be non-empty additions
        if not ours or not theirs:
            return False

        # Automatic resolution is deliberately limited to two distinct
        # function declarations.  Imports, constants and class declarations
        # have ordering/registration semantics that cannot be preserved by a
        # textual concatenation alone.
        declaration = re.compile(r"(?:async\s+)?(?:def|function)\s+([A-Za-z_]\w*)\b")
        ours_match = declaration.match(ours)
        theirs_match = declaration.match(theirs)
        return bool(ours_match and theirs_match and ours_match.group(1) != theirs_match.group(1))

    def _affects_structure(self, block: dict[str, str]) -> bool:
        """Check if conflict affects function/class signatures."""
        ours = block["ours"]
        theirs = block["theirs"]

        # Keywords that indicate structural changes
        structural_keywords = [
            r'\bclass\s+\w+',
            r'\bdef\s+\w+\s*\(',
            r'\bfunction\s+\w+\s*\(',
            r'\binterface\s+\w+',
            r'\benum\s+\w+',
            r'\btype\s+\w+',
        ]

        for pattern in structural_keywords:
            if re.search(pattern, ours) or re.search(pattern, theirs):
                return True

        return False

    def _is_local_modification(self, block: dict[str, str]) -> bool:
        """Check if conflict is a local modification (small, within function)."""
        ours = block["ours"]
        theirs = block["theirs"]

        # Heuristic: small changes (< 20 lines each)
        ours_lines = len(ours.split("\n"))
        theirs_lines = len(theirs.split("\n"))

        return ours_lines < 20 and theirs_lines < 20


class AutoMergeStrategy:
    """Automatic merge strategies for simple conflicts."""

    def merge_append_only(self, worktree_path: Path, file_path: str, content: str) -> str:
        """Merge append-only conflicts by keeping both sides."""
        result_lines = []
        lines = content.split("\n")
        i = 0

        while i < len(lines):
            if lines[i].startswith("<<<<<<<"):
                # Start of conflict
                ours_lines = []
                theirs_lines = []
                i += 1
                # Collect "ours"
                while i < len(lines) and not lines[i].startswith("======="):
                    ours_lines.append(lines[i])
                    i += 1
                if i < len(lines):
                    i += 1  # Skip "======="
                # Collect "theirs"
                while i < len(lines) and not lines[i].startswith(">>>>>>>"):
                    theirs_lines.append(lines[i])
                    i += 1
                if i < len(lines):
                    i += 1  # Skip ">>>>>>>"

                # Merge: keep both, ours first then theirs
                result_lines.extend(ours_lines)
                result_lines.extend(theirs_lines)
            else:
                result_lines.append(lines[i])
                i += 1

        return "\n".join(result_lines)


class ModelBasedResolver:
    """Use AI model to intelligently resolve conflicts."""

    def __init__(self, max_attempts: int = 2, enable_auto_commit: bool = False):
        self.max_attempts = max_attempts
        self.enable_auto_commit = enable_auto_commit  # Disabled by default for MVP
        self.analyzer = ConflictAnalyzer()
        self.auto_merge = AutoMergeStrategy()

    def resolve(self, conflict_context: ConflictContext) -> ResolutionResult:
        """Resolve conflicts using appropriate strategy.

        For MVP: Only analyze conflicts and provide guidance.
        Auto-commit is disabled by default to avoid unsafe automatic merges.
        """
        if conflict_context.attempts >= self.max_attempts:
            return ResolutionResult(
                status="manual_required",
                resolved_files=[],
                unresolved_files=conflict_context.conflicted_files,
                reason=f"Exceeded max attempts ({self.max_attempts})",
            )

        # Analyze conflicts
        analysis = self.analyzer.analyze(conflict_context)

        # MVP: Only provide analysis, do not auto-commit
        if not self.enable_auto_commit:
            return ResolutionResult(
                status="manual_required",
                resolved_files=[],
                unresolved_files=conflict_context.conflicted_files,
                reason=(
                    f"Automatic resolution disabled for safety. "
                    f"Conflict type: {analysis['recommended_strategy']}. "
                    f"Please resolve manually in worktree: {conflict_context.candidate_worktree}"
                ),
                strategy_used="analysis_only",
            )

        # Future: Try automatic strategies if enabled
        if analysis["recommended_strategy"] == "auto_merge_append_only":
            return self._resolve_append_only(conflict_context, analysis)

        # Fall back to model-assisted resolution
        return self._resolve_with_model(conflict_context, analysis)

    def _resolve_append_only(
        self, conflict_context: ConflictContext, analysis: dict[str, Any]
    ) -> ResolutionResult:
        """Automatically resolve append-only conflicts."""
        worktree_path = Path(conflict_context.candidate_worktree)
        resolved_files = []
        unresolved_files = []
        try:
            commit_message = build_commit_message(
                conflict_context.task_card_id,
                f"解决冲突 {', '.join(conflict_context.batch_ids)}",
            )
        except CommitMessageError as exc:
            return ResolutionResult(
                status="manual_required",
                resolved_files=[],
                unresolved_files=list(conflict_context.conflicted_files),
                reason=f"Failed to build commit message: {exc}",
                strategy_used="auto_merge_append_only",
            )

        for file_path, content in conflict_context.conflict_markers.items():
            try:
                # Merge both sides
                merged_content = self.auto_merge.merge_append_only(worktree_path, file_path, content)

                # Write back
                full_path = worktree_path / file_path
                full_path.write_text(merged_content, encoding="utf-8")

                # Mark as resolved
                subprocess.run(
                    ["git", "add", file_path],
                    cwd=worktree_path,
                    check=True,
                    capture_output=True,
                )

                resolved_files.append(file_path)
            except Exception as e:
                unresolved_files.append(file_path)

        if unresolved_files:
            return ResolutionResult(
                status="manual_required",
                resolved_files=resolved_files,
                unresolved_files=unresolved_files,
                reason=f"Failed to auto-merge {len(unresolved_files)} files",
                strategy_used="auto_merge_append_only",
            )

        # Commit resolution
        try:
            result = subprocess.run(
                [
                    "git",
                    "commit",
                    "--no-edit",
                    "-m",
                    commit_message,
                ],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                check=True,
            )
            new_sha = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                cwd=worktree_path,
                capture_output=True,
                text=True,
                check=True,
            ).stdout.strip()

            return ResolutionResult(
                status="resolved",
                resolved_files=resolved_files,
                unresolved_files=[],
                new_candidate_sha=new_sha,
                strategy_used="auto_merge_append_only",
            )
        except subprocess.CalledProcessError as e:
            return ResolutionResult(
                status="manual_required",
                resolved_files=resolved_files,
                unresolved_files=[],
                reason=f"Failed to commit: {getattr(e, 'stderr', str(e))}",
                strategy_used="auto_merge_append_only",
            )

    def _resolve_with_model(
        self, conflict_context: ConflictContext, analysis: dict[str, Any]
    ) -> ResolutionResult:
        """Use AI model to resolve complex conflicts."""
        # This is where we'd integrate with an AI model
        # For now, we'll generate a resolution prompt and return manual_required
        # Future: call agent with structured output to get resolved content

        resolution_prompt = self._build_resolution_prompt(conflict_context, analysis)

        # TODO: Integrate with AI model here
        # For MVP, return manual_required with helpful prompt

        return ResolutionResult(
            status="manual_required",
            resolved_files=[],
            unresolved_files=conflict_context.conflicted_files,
            reason="Model-assisted resolution requires manual review. See resolution prompt.",
            strategy_used="model_assisted",
        )

    def _build_resolution_prompt(
        self, conflict_context: ConflictContext, analysis: dict[str, Any]
    ) -> str:
        """Build a prompt for model-assisted resolution."""
        prompt_parts = [
            "# Merge Conflict Resolution",
            f"",
            f"## Context",
            f"- Batches: {', '.join(conflict_context.batch_ids)}",
            f"- Repository: {conflict_context.repository_ref}",
            f"- Base SHA: {conflict_context.base_sha}",
            f"",
            f"## Analysis",
            f"- Total files: {analysis['total_files']}",
            f"- Strategy: {analysis['recommended_strategy']}",
            f"- Confidence: {analysis['confidence']:.1%}",
            f"",
            f"## Conflicts",
        ]

        for file_path, content in conflict_context.conflict_markers.items():
            prompt_parts.extend([
                f"",
                f"### {file_path}",
                f"```",
                content[:500],  # Truncate for readability
                f"```",
            ])

        prompt_parts.extend([
            f"",
            f"## Task",
            f"Resolve the conflicts above by:",
            f"1. Understanding both sides' intent",
            f"2. Preserving all business logic from both branches",
            f"3. Ensuring code remains syntactically valid",
            f"4. Maintaining code style consistency",
            f"",
            f"Return the fully resolved content for each file.",
        ])

        return "\n".join(prompt_parts)


class ConflictResolutionAgent:
    """Main entry point for conflict resolution."""

    def __init__(self, max_attempts: int = 2, enable_auto_commit: bool = False):
        self.resolver = ModelBasedResolver(max_attempts=max_attempts, enable_auto_commit=enable_auto_commit)

    def resolve_conflict(self, conflict_context: ConflictContext) -> ResolutionResult:
        """Attempt to resolve conflicts in the candidate worktree."""
        return self.resolver.resolve(conflict_context)

    def notify_manual_intervention(self, conflict_context: ConflictContext) -> str:
        """Generate notification message for manual intervention."""
        worktree_name = Path(conflict_context.candidate_worktree).name

        message_parts = [
            "",
            "╔══════════════════════════════════════════════════════════════",
            "║ CONFLICT RESOLUTION REQUIRED",
            "╠══════════════════════════════════════════════════════════════",
            f"║ Batches:  {', '.join(conflict_context.batch_ids)}",
            f"║ Base SHA: {conflict_context.base_sha[:8]}",
            f"║ Worktree: {conflict_context.candidate_worktree}",
            "║",
            "║ Conflicted files:",
        ]

        for file_path in conflict_context.conflicted_files:
            message_parts.append(f"║   - {file_path}")

        message_parts.extend([
            "║",
            "║ Next steps:",
            f"║   1. cd {conflict_context.candidate_worktree}",
            "║   2. Manually resolve conflicts in the files above",
            "║   3. Preserve both sides' business logic where possible",
            "║   4. git add <resolved_files>",
            "║   5. git commit",
            f"║   6. Run: autobiz resume-merge-train --candidate {worktree_name}",
            "║",
            f"║ Or: autobiz discard-candidate --candidate {worktree_name}",
            "╚══════════════════════════════════════════════════════════════",
            "",
        ])

        return "\n".join(message_parts)
