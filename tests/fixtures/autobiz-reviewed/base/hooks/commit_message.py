"""Build production Git commit messages for an AutoBiz workflow run.

The production Git hook requires a task-card prefix. A workflow chooses that
card once, persists it in its durable run manifest, and every plugin-owned
commit reads the same value from there.
"""

from __future__ import annotations

import re


_TASK_CARD_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class CommitMessageError(ValueError):
    """Raised when a workflow cannot construct a hook-compliant message."""


def normalize_task_card_id(value: object) -> str:
    """Return a safe task-card ID or fail before any Git side effect."""
    card_id = value.strip() if isinstance(value, str) else ""
    if not card_id:
        raise CommitMessageError("parallel_task_card_id_required")
    if not _TASK_CARD_ID_PATTERN.fullmatch(card_id):
        raise CommitMessageError("parallel_task_card_id_invalid")
    return card_id


def build_commit_message(task_card_id: object, summary: object) -> str:
    """Return the production hook format: ``<card> #comment <summary>``."""
    card_id = normalize_task_card_id(task_card_id)
    normalized_summary = " ".join(str(summary or "").split())
    if not normalized_summary:
        raise CommitMessageError("parallel_commit_summary_required")
    return f"{card_id} #comment {normalized_summary}"
