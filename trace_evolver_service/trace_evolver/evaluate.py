"""
candidate 离线评估模块。

V1 的评估不是效果验证，而是"是否值得进入后续人工审阅"的 plausibility 评分。

改进点（相对 V1 初版）：
- recurrence 公式对低 trace 场景做了自适应：当总 trace 数少时不过度惩罚
- specificity 检测更多行为关键词
- evidence_grounding 上限从 4 提高到 6（配合 analysis.py 的改进）
"""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from trace_evolver.schemas import CandidateBundle, EvaluationReport, EvaluationScores, HypothesisPatch
from trace_evolver.utils import jaccard_similarity, tokenize


def evaluate_candidate(
    candidate: CandidateBundle,
    patch_group: list[HypothesisPatch],
    family_episode_count: int,
    base_bundle_root: str | None,
) -> EvaluationReport:
    support_traces = sorted({trace_id for patch in patch_group for trace_id in patch.source_trace_ids})
    support_threads = sorted({thread_id for patch in patch_group for thread_id in patch.source_thread_ids})
    evidence_count = sum(len(patch.evidence_spans) for patch in patch_group)
    patch_count = max(1, len(patch_group))

    # Evidence grounding: 证据密度 + 置信度
    evidence_grounding = min(1.0, (evidence_count / patch_count) / 4.0) * 0.6 + min(
        0.4, sum(patch.confidence for patch in patch_group) / patch_count * 0.4
    )

    # Cross-trace recurrence: 自适应阈值
    # 当 trace 少时（1-2个），不过度惩罚 recurrence，而是降低其权重影响
    trace_count = len(support_traces)
    thread_count = len(support_threads)
    if trace_count <= 2:
        # 小样本场景：给一个合理的基础分，避免好 patch 被自动 reject
        recurrence = min(1.0, 0.5 + 0.15 * trace_count + 0.15 * thread_count)
    else:
        recurrence = min(1.0, min(1.0, trace_count / 5.0) * 0.6 + min(1.0, thread_count / 3.0) * 0.4)

    generalization = min(1.0, 0.45 + 0.15 * min(len(candidate.files_changed), 3) + 0.20 * min(thread_count, 2))
    specificity = _specificity_score(patch_group)
    conflict_risk = min(1.0, 0.15 * len(candidate.unresolved_ops) + 0.10 * len(candidate.conflicts))
    bloat_risk = _bloat_risk(candidate, base_bundle_root)
    novelty = _novelty_score(candidate, base_bundle_root)

    promotion_score = (
        0.30 * evidence_grounding
        + 0.25 * recurrence
        + 0.20 * generalization
        + 0.10 * specificity
        + 0.05 * novelty
        - 0.05 * conflict_risk
        - 0.05 * bloat_risk
    )

    if promotion_score < 0.55:
        recommendation = "reject"
    elif promotion_score < 0.72:
        recommendation = "hold"
    else:
        recommendation = "promotable"

    notes = [
        f"support_traces={trace_count}",
        f"support_threads={thread_count}",
        f"family_episode_count={family_episode_count}",
    ]
    if candidate.unresolved_ops:
        notes.append(f"unresolved_ops={len(candidate.unresolved_ops)}")

    risks = []
    if conflict_risk > 0:
        risks.append("conflict-risk")
    if bloat_risk > 0.35:
        risks.append("bloat-risk")
    if trace_count < 3:
        risks.append("low-trace-support")

    return EvaluationReport(
        recommendation=recommendation,
        scores=EvaluationScores(
            evidence_grounding=round(evidence_grounding, 4),
            cross_trace_recurrence=round(recurrence, 4),
            generalization=round(generalization, 4),
            specificity=round(specificity, 4),
            conflict_risk=round(conflict_risk, 4),
            bloat_risk=round(bloat_risk, 4),
            novelty=round(novelty, 4),
            promotion_score=round(promotion_score, 4),
        ),
        risks=risks,
        notes=notes,
    )


def _specificity_score(patch_group: list[HypothesisPatch]) -> float:
    """Measure how specific and actionable the patch content is.

    Looks for conditional/actionable keywords that indicate concrete guidance
    rather than vague advice.
    """
    keywords = ("when", "if", "before", "after", "avoid", "must", "verify",
                "check", "ensure", "confirm", "never", "always", "first", "then")
    tokens = Counter()
    for patch in patch_group:
        for op in patch.ops:
            for keyword in keywords:
                if keyword in op.content.lower():
                    tokens[keyword] += 1
    return min(1.0, 0.30 + 0.08 * len(tokens))


def _bloat_risk(candidate: CandidateBundle, base_bundle_root: str | None) -> float:
    changed_lines = 0
    for file_path in candidate.files_changed:
        path = Path(candidate.full_bundle_path) / file_path
        if path.exists():
            changed_lines += len(path.read_text(encoding="utf-8").splitlines())
    if not base_bundle_root:
        return min(1.0, changed_lines / 120.0)
    base_total = 0
    for path in Path(base_bundle_root).rglob("*.md"):
        if path.is_file():
            base_total += len(path.read_text(encoding="utf-8").splitlines())
    if base_total == 0:
        return min(1.0, changed_lines / 120.0)
    return min(1.0, changed_lines / max(40, base_total))


def _novelty_score(candidate: CandidateBundle, base_bundle_root: str | None) -> float:
    if not base_bundle_root:
        return 0.8
    overlaps: list[float] = []
    for file_path in candidate.files_changed:
        new_path = Path(candidate.full_bundle_path) / file_path
        old_path = Path(base_bundle_root) / file_path
        if not new_path.exists() or not old_path.exists():
            overlaps.append(0.0)
            continue
        overlaps.append(
            jaccard_similarity(tokenize(new_path.read_text(encoding="utf-8")), tokenize(old_path.read_text(encoding="utf-8")))
        )
    if not overlaps:
        return 0.7
    return max(0.0, 1.0 - sum(overlaps) / len(overlaps))
