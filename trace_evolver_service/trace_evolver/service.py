"""
离线技能进化服务的主编排模块。

对齐 Trace2Skill 论文的三阶段流水线：

Stage 1: Trajectory Generation & Normalization
- 读取本地 trace 输入 → 组装 thread → 切分 episode → 构建 family → 扫描 skill catalog

Stage 2: Parallel Multi-Agent Patch Proposal
- 对每个 episode 选择 SuccessAnalyst(𝒜⁺) 或 ErrorAnalyst(𝒜⁻)
- analyst 独立工作在 frozen S₀ 上，无互相可见性

Stage 3: Conflict-Free Consolidation
- 按 (target_skill, family) 分桶
- 桶内做 anchor 级冲突拆分
- 有 LLM 时走 hierarchical merge（论文 ℳ 算子）：dedup / conflict resolution / prevalent pattern bias
- 无 LLM 时走 hash 精确去重 fallback
- PatchEngine 物化 candidate bundle → 评估 → 导出
"""

from __future__ import annotations

import logging
import math
import shutil
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from trace_evolver.analysis import ErrorAnalyst, SuccessAnalyst
from trace_evolver.catalog import match_skill_bundle, scan_skill_roots
from trace_evolver.config import Settings
from trace_evolver.db import (
    CandidateRecord,
    CandidateScoreRecord,
    EpisodeRecord,
    FamilyRecord,
    PatchRecord,
    RunRecord,
    TraceFileRecord,
    session_scope,
)
from trace_evolver.episodes import build_episodes, build_families
from trace_evolver.evaluate import evaluate_candidate
from trace_evolver.llm import LLMClient
from trace_evolver.patching import PatchEngine, generate_summary_markdown
from trace_evolver.schemas import (
    AnchorSpec,
    CandidateDetailResponse,
    EditOp,
    HypothesisPatch,
    RunCreateRequest,
    RunDetailResponse,
    RunResponse,
)
from trace_evolver.source import LocalTraceSource, load_imported_traces
from trace_evolver.utils import is_allowed_markdown_relative_path, json_dumps, sha256_text, slugify, trim_snippet, utc_now

logger = logging.getLogger(__name__)

# Hierarchical merge batch size.
# 论文用 B_merge ≈ 32（Qwen-122B + 128 sub-agents），但我们的场景：
# - 真实数据，同一技能通常只有 3-15 个 patches
# - MiniMax-M2.7 处理大量 patch 的能力有限
# - 适中 batch 让每次 LLM 调用有足够上下文做语义去重，又不至于太长
_MERGE_BATCH_SIZE = 8


class TraceEvolutionService:
    """
    整个离线系统的主编排器。

    主流程固定为：
    1. 读取本地 trace 文件并标准化
    2. 按 thread 聚合，再切分 episode
    3. 将相似 episode 聚成 family
    4. 对每个 episode 跑 SuccessAnalyst / ErrorAnalyst，得到 HypothesisPatch
    5. 在 family 维度做 hierarchical merge（Trace2Skill Stage 3）
    6. 用 Python patch engine 物化 candidate bundle
    7. 做离线评分，写出 diff / lineage / evaluation / summary
    """

    def __init__(self, settings: Settings, session_factory: sessionmaker[Session]):
        self.settings = settings
        self.session_factory = session_factory
        self.source = LocalTraceSource()
        self.success_analyst = SuccessAnalyst(settings)
        self.error_analyst = ErrorAnalyst(settings)
        self.patch_engine = PatchEngine()

    def create_run(self, request: RunCreateRequest) -> RunResponse:
        run_id = f"run-{uuid.uuid4().hex[:12]}"
        created_at = utc_now()
        with session_scope(self.session_factory) as session:
            session.add(
                RunRecord(
                    id=run_id,
                    status="running",
                    input_path=request.input_path,
                    output_root=request.output_root,
                    created_at=created_at,
                )
            )
        try:
            self._execute_run(run_id, request)
            status = "exported"
        except Exception as exc:
            with session_scope(self.session_factory) as session:
                record = session.get(RunRecord, run_id)
                if record:
                    record.status = "failed"
                    record.error = str(exc)
                    record.finished_at = utc_now()
            raise
        return RunResponse(run_id=run_id, status=status)

    def get_run(self, run_id: str) -> RunDetailResponse:
        with session_scope(self.session_factory) as session:
            run = session.get(RunRecord, run_id)
            if run is None:
                raise KeyError(run_id)
            candidate_count = session.scalar(select(func.count()).select_from(CandidateRecord).where(CandidateRecord.run_id == run_id))
            return RunDetailResponse(
                run_id=run.id,
                status=run.status,
                input_path=run.input_path,
                output_root=run.output_root,
                error=run.error,
                candidate_count=int(candidate_count or 0),
                created_at=run.created_at,
                finished_at=run.finished_at,
            )

    def list_candidates(self, run_id: str) -> list[CandidateDetailResponse]:
        with session_scope(self.session_factory) as session:
            rows = session.scalars(
                select(CandidateRecord).where(CandidateRecord.run_id == run_id).order_by(CandidateRecord.candidate_id)
            ).all()
            return [
                CandidateDetailResponse(
                    candidate_id=row.candidate_id,
                    run_id=row.run_id,
                    status=row.status,
                    recommendation=row.recommendation,
                    base_skill_id=row.base_skill_id,
                    full_bundle_path=row.full_bundle_path,
                    files_changed=_json_loads(row.files_changed_json),
                    source_trace_ids=_json_loads(row.source_trace_ids_json),
                    source_thread_ids=_json_loads(row.source_thread_ids_json),
                )
                for row in rows
            ]

    def get_candidate(self, run_id: str, candidate_id: str) -> CandidateDetailResponse:
        for candidate in self.list_candidates(run_id):
            if candidate.candidate_id == candidate_id:
                return candidate
        raise KeyError(candidate_id)

    def _execute_run(self, run_id: str, request: RunCreateRequest) -> None:
        output_root = Path(request.output_root).resolve()
        output_root.mkdir(parents=True, exist_ok=True)
        run_dir = output_root / "runs" / run_id
        if run_dir.exists():
            shutil.rmtree(run_dir)
        traces_dir = run_dir / "traces"
        candidates_dir = run_dir / "candidates"
        traces_dir.mkdir(parents=True, exist_ok=True)
        candidates_dir.mkdir(parents=True, exist_ok=True)

        # Stage 1: 输入标准化
        materialized = self.source.materialize(request.input_path, traces_dir)
        imported = load_imported_traces(materialized)
        if request.thread_ids:
            imported = [trace for trace in imported if trace.threadId in set(request.thread_ids)]
        if request.since_ts:
            imported = [trace for trace in imported if trace.startedAt >= request.since_ts]
        if request.max_traces:
            imported = imported[: request.max_traces]

        bundles = scan_skill_roots(request.skills_roots)
        trace_map = {trace.traceId: trace for trace in imported}

        episodes = build_episodes(imported, self.settings.episode_gap_minutes)
        families = build_families(episodes, self.settings.family_similarity_threshold)
        family_by_id = {family.family_id: family for family in families}
        family_of_episode = {
            episode_id: family.family_id
            for family in families
            for episode_id in family.episode_ids
        }

        # Stage 2: 并行 patch 提议（所有 analyst 工作在 frozen S₀ 上，无互相可见性）
        all_patches = []
        for episode in episodes:
            episode_traces = [trace_map[trace_id] for trace_id in episode.trace_ids]
            bundle = match_skill_bundle(episode.used_skills, bundles)
            family_id = family_of_episode.get(episode.episode_id, "")
            if any(outcome != "success" for outcome in episode.outcomes):
                hypotheses, patches, notes = self.error_analyst.analyze(episode, episode_traces, bundle)
            else:
                hypotheses, patches = self.success_analyst.analyze(episode, episode_traces, bundle)
                notes = []

            for patch in patches:
                patch.family_id = family_id
            all_patches.extend(patches)
            self._persist_episode_artifacts(run_id, episode, family_id, hypotheses, patches, notes)

        # Stage 3: Conflict-Free Consolidation（Trace2Skill ℳ 算子）
        candidate_groups = self._merge_patches(all_patches)
        for group_index, patch_group in enumerate(candidate_groups):
            candidate_id = f"cand-{group_index + 1:03d}-{sha256_text(run_id + str(group_index))[:8]}"
            base_bundle = next((bundle for bundle in bundles if bundle.skill_id == patch_group[0].target_skill_id), None)
            apply_result = self.patch_engine.apply(candidate_id, patch_group, base_bundle, candidates_dir / candidate_id)
            family_id = patch_group[0].family_id if patch_group else ""
            family_episode_count = len(family_by_id.get(family_id).episode_ids) if family_id in family_by_id else 0
            report = evaluate_candidate(
                apply_result.candidate,
                patch_group,
                family_episode_count=family_episode_count,
                base_bundle_root=base_bundle.root_path if base_bundle else None,
            )
            self._write_candidate_artifacts(candidates_dir / candidate_id, apply_result, report, base_bundle)
            self._persist_candidate(run_id, apply_result.candidate, report)

        self._write_run_artifacts(run_dir, imported, episodes, families)
        with session_scope(self.session_factory) as session:
            run = session.get(RunRecord, run_id)
            if run:
                run.status = "exported"
                run.finished_at = utc_now()

    # -----------------------------------------------------------------------
    # Stage 3: Merge
    # -----------------------------------------------------------------------

    def _merge_patches(self, patches: list) -> list[list]:
        """Merge analyst patches into candidate groups.

        1. Group by (target_skill, family)
        2. Within each group, split anchor-level conflicts into separate buckets
        3. Consolidate each bucket:
           - LLM available → hierarchical merge (Trace2Skill ℳ)
           - LLM unavailable → hash-based exact dedup (fallback)
        """
        grouped: dict[tuple[str | None, str], list] = {}
        for patch in patches:
            key = (patch.target_skill_id, patch.family_id)
            grouped.setdefault(key, []).append(patch)

        all_groups: list[list] = []
        for patches_for_key in grouped.values():
            buckets: list[list] = []
            for patch in patches_for_key:
                placed = False
                for bucket in buckets:
                    if not self._has_conflict(bucket, patch):
                        bucket.append(patch)
                        placed = True
                        break
                if not placed:
                    buckets.append([patch])

            for bucket in buckets:
                if self._has_llm() and len(bucket) > 1:
                    merged = self._hierarchical_merge(bucket)
                else:
                    merged = self._dedupe_bucket(bucket)
                all_groups.append(merged)
        return all_groups

    def _has_llm(self) -> bool:
        return bool(self.settings.llm.api_key)

    def _get_llm(self) -> LLMClient:
        return LLMClient(self.settings.llm)

    def _hierarchical_merge(self, bucket: list) -> list:
        """Hierarchical merge following Trace2Skill ℳ operator.

        论文公式: L = ⌈log_{B_merge}|P|⌉ levels
        每层把 current_level 按 _MERGE_BATCH_SIZE 分组，每组 LLM 合并成 1 个 patch。
        层层归并直到只剩 1 个 patch（或达到层数上限）。

        LLM merge 失败时的 fallback 策略：
        - 对失败 batch 做 hash 精确去重（而非直接放弃）
        - 确保每一层都严格收敛
        """
        current_level = list(bucket)
        level = 0
        # 论文: L = ceil(log_{B_merge}(|P|))，以 batch size 为底
        max_levels = max(1, math.ceil(math.log(max(len(current_level), 2), max(_MERGE_BATCH_SIZE, 2)))) + 1

        while len(current_level) > 1 and level < max_levels:
            next_level: list = []
            for i in range(0, len(current_level), _MERGE_BATCH_SIZE):
                batch = current_level[i : i + _MERGE_BATCH_SIZE]
                if len(batch) == 1:
                    next_level.append(batch[0])
                    continue
                merged = self._llm_merge_batch(batch)
                if merged is not None:
                    next_level.append(merged)
                else:
                    # LLM merge failed — fall back to hash dedup so the level still converges.
                    # This guarantees next_level is strictly smaller than current_level.
                    deduped = self._dedupe_bucket(batch)
                    next_level.extend(deduped)
                    logger.warning(
                        "LLM merge failed for batch of %d patches at level %d; "
                        "fell back to hash dedup (%d remaining)",
                        len(batch), level, len(deduped),
                    )
            current_level = next_level
            level += 1
            logger.info("Hierarchical merge level %d: %d patches remaining", level, len(current_level))

        return current_level

    def _llm_merge_batch(self, batch: list[HypothesisPatch]) -> HypothesisPatch | None:
        """Use LLM to consolidate a batch of patches into one.

        Implements the Trace2Skill ℳ operator:
        - Dedup semantically identical edits (keep best version)
        - Resolve conflicts (strongest justification wins)
        - Bias toward prevalent patterns (recurring across patches)
        - Preserve unique non-redundant insights
        - Discard edits appearing in only 1 patch as potentially idiosyncratic (when batch >= 4)
        """
        llm = self._get_llm()

        # Serialize all patches' ops for the LLM
        patches_description: list[str] = []
        for idx, patch in enumerate(batch):
            ops_text = "\n".join(
                f"  - [{op.action}] {op.file_path} (intent={op.intent}): {trim_snippet(op.content, 600)}"
                for op in patch.ops
            )
            patches_description.append(
                f"### Patch {idx + 1} (source={patch.source_kind}, confidence={patch.confidence:.2f}, "
                f"traces={len(patch.source_trace_ids)})\n"
                f"Rationale: {patch.rationale}\n"
                f"Ops:\n{ops_text}"
            )

        patches_text = "\n\n".join(patches_description)

        prevalence_hint = ""
        if len(batch) >= 6:
            # 只有 batch 足够大时才启用 idiosyncratic 过滤
            # batch=4 时 "只出现 1 次就丢" 会丢掉 25%，太激进
            prevalence_hint = (
                "\n**Prevalence rule**: Edits appearing in only 1 patch out of "
                f"{len(batch)} should be treated as potentially idiosyncratic and discarded, "
                "unless they provide clearly unique and valuable guidance. "
                "Edits appearing in 2+ patches are considered supported.\n"
            )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a skill-evolution merge operator (Trace2Skill ℳ).\n\n"
                    "You receive multiple skill patches proposed independently by different analysts. "
                    "Your job is to consolidate them into a single unified set of edits.\n\n"
                    "**Merge guidelines**:\n"
                    "1. **Deduplication**: When multiple patches propose identical or semantically similar edits, "
                    "retain only the best-written version.\n"
                    "2. **Conflict resolution**: When patches contradict each other on the same topic, "
                    "choose the one with stronger justification or synthesize both into a coherent edit.\n"
                    "3. **Prevalent pattern bias**: Edits appearing consistently across multiple independent patches "
                    "are more likely to reflect systematic task properties — prioritize them.\n"
                    "4. **Unique insight preservation**: Include all non-redundant edits that provide genuinely "
                    "new guidance, even if mentioned by only one patch.\n"
                    "5. **Independence**: Edits in the merged result MUST be line-level independent — "
                    "no two edits may target the same section of the same file.\n"
                    "6. **Atomic create/link pairs**: If a references/*.md file is created, the SKILL.md link "
                    "to it must also be included — keep both or drop both.\n"
                    "7. **Conciseness**: Every sentence must change agent behavior. Remove vague advice.\n"
                    f"{prevalence_hint}\n"
                    "Return JSON:\n"
                    "{\n"
                    '  "reasoning": "string — explain your dedup/conflict/prevalence decisions",\n'
                    '  "edits": [\n'
                    "    {\n"
                    '      "file": "SKILL.md or references/xxx.md",\n'
                    '      "op": "insert_after or create",\n'
                    '      "target_section": "heading text or null",\n'
                    '      "content": "markdown content",\n'
                    '      "intent": "trigger|workflow|guardrail|example|reference|metadata",\n'
                    '      "prevalence": "number of source patches that proposed similar content"\n'
                    "    }\n"
                    "  ],\n"
                    '  "dropped": ["list of edit summaries that were dropped and why"],\n'
                    '  "confidence": "float 0.5-0.95"\n'
                    "}\n"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"## Patches to consolidate ({len(batch)} total)\n\n"
                    f"{patches_text}\n\n"
                    "Consolidate these patches following the merge guidelines."
                ),
            },
        ]

        try:
            result = llm.chat_json(messages, temperature=0.2, max_tokens=8192)
        except Exception:
            logger.warning("LLM merge failed, falling back to hash dedup", exc_info=True)
            return None

        raw_edits = result.get("edits", [])
        if not raw_edits:
            return None

        # Build consolidated ops
        VALID_INTENTS = {"trigger", "workflow", "guardrail", "example", "reference", "metadata"}
        ops: list[EditOp] = []
        visible_existing_files = sorted({f for p in batch for f in p.visible_files})
        visible_existing_set = set(visible_existing_files)
        for raw in raw_edits[:8]:
            file_path = raw.get("file", "SKILL.md")
            if not isinstance(file_path, str):
                continue
            content = raw.get("content", "")
            if not content.strip():
                continue
            intent = raw.get("intent", "guardrail")
            if intent not in VALID_INTENTS:
                intent = "guardrail"
            op_type = raw.get("op", "insert_after")
            target_section = raw.get("target_section")

            if op_type == "create" and file_path != "SKILL.md":
                if not is_allowed_markdown_relative_path(file_path):
                    continue
                ops.append(EditOp(
                    file_path=file_path,
                    action="create_file",
                    content=content,
                    intent=intent,
                    source_visibility="created",
                ))
            else:
                if file_path not in visible_existing_set:
                    continue
                if not is_allowed_markdown_relative_path(file_path):
                    continue
                anchor = _build_anchor(target_section)
                ops.append(EditOp(
                    file_path=file_path,
                    action="insert_after",
                    anchor=anchor,
                    content=content,
                    intent=intent,
                    source_visibility="full",
                ))

        if not ops:
            return None

        # Accumulate all source metadata from the batch
        all_trace_ids = sorted({tid for p in batch for tid in p.source_trace_ids})
        all_thread_ids = sorted({tid for p in batch for tid in p.source_thread_ids})
        all_evidence = [span for p in batch for span in p.evidence_spans]

        reasoning = result.get("reasoning", "")
        dropped = result.get("dropped", [])
        if dropped:
            logger.info("Merge dropped %d edits: %s", len(dropped), "; ".join(str(d)[:80] for d in dropped[:5]))

        return HypothesisPatch(
            patch_id=f"merged-{sha256_text('|'.join(p.patch_id for p in batch))[:12]}",
            source_kind=batch[0].source_kind,
            target_skill_id=batch[0].target_skill_id,
            family_id=batch[0].family_id,
            source_trace_ids=all_trace_ids,
            source_thread_ids=all_thread_ids,
            base_bundle_hash=batch[0].base_bundle_hash,
            visible_files=visible_existing_files,
            ops=ops,
            confidence=float(result.get("confidence", max(p.confidence for p in batch))),
            rationale=f"Hierarchical merge of {len(batch)} patches. {reasoning}",
            risk_flags=[],
            evidence_spans=all_evidence,
        )

    def _has_conflict(self, bucket, candidate_patch) -> bool:
        existing_keys = {(op.file_path, op.action, _anchor_signature(op.anchor)) for patch in bucket for op in patch.ops}
        for op in candidate_patch.ops:
            key = (op.file_path, op.action, _anchor_signature(op.anchor))
            if op.anchor and op.anchor.anchor_type != "file_end" and key in existing_keys:
                return True
        return False

    def _dedupe_bucket(self, bucket: list) -> list:
        """Hash-based exact dedup fallback (when no LLM available)."""
        deduped: dict[str, Any] = {}
        for patch in bucket:
            signature = sha256_text(json_dumps([op.model_dump() for op in patch.ops]))
            if signature not in deduped:
                deduped[signature] = patch
                continue
            existing = deduped[signature]
            existing.source_trace_ids = sorted(set(existing.source_trace_ids) | set(patch.source_trace_ids))
            existing.source_thread_ids = sorted(set(existing.source_thread_ids) | set(patch.source_thread_ids))
            existing.evidence_spans.extend(patch.evidence_spans)
            existing.confidence = max(existing.confidence, patch.confidence)
        return list(deduped.values())

    # -----------------------------------------------------------------------
    # Persistence & artifact writing
    # -----------------------------------------------------------------------

    def _persist_episode_artifacts(
        self,
        run_id: str,
        episode,
        family_id: str,
        hypotheses,
        patches,
        notes,
    ) -> None:
        with session_scope(self.session_factory) as session:
            session.add(
                EpisodeRecord(
                    run_id=run_id,
                    episode_id=episode.episode_id,
                    thread_id=episode.thread_id,
                    payload_json=json_dumps(
                        {
                            "episode": episode.model_dump(),
                            "family_id": family_id,
                            "notes": notes,
                            "hypotheses": [item.model_dump() for item in hypotheses],
                        }
                    ),
                )
            )
            for patch in patches:
                session.add(
                    PatchRecord(
                        run_id=run_id,
                        patch_id=patch.patch_id,
                        family_id=family_id,
                        target_skill_id=patch.target_skill_id,
                        source_kind=patch.source_kind,
                        payload_json=json_dumps(patch.model_dump()),
                    )
                )

    def _persist_candidate(self, run_id: str, candidate, report) -> None:
        with session_scope(self.session_factory) as session:
            session.add(
                CandidateRecord(
                    run_id=run_id,
                    candidate_id=candidate.candidate_id,
                    status="exported",
                    recommendation=report.recommendation,
                    base_skill_id=candidate.base_skill_id,
                    full_bundle_path=candidate.full_bundle_path,
                    files_changed_json=json_dumps(candidate.files_changed),
                    source_trace_ids_json=json_dumps(candidate.source_trace_ids),
                    source_thread_ids_json=json_dumps(candidate.source_thread_ids),
                )
            )
            session.add(
                CandidateScoreRecord(
                    candidate_id=candidate.candidate_id,
                    scores_json=json_dumps(report.model_dump()),
                )
            )

    def _write_candidate_artifacts(self, candidate_dir: Path, apply_result, report, base_bundle) -> None:
        candidate_dir.mkdir(parents=True, exist_ok=True)
        (candidate_dir / "diff.patch").write_text(apply_result.diff_patch, encoding="utf-8")
        (candidate_dir / "diff.json").write_text(json_dumps(apply_result.diff_json), encoding="utf-8")
        (candidate_dir / "lineage.json").write_text(
            json_dumps(
                {
                    "candidate": apply_result.candidate.model_dump(),
                    "patch_ids": apply_result.candidate.patch_ids,
                    "base_skill_id": base_bundle.skill_id if base_bundle else None,
                }
            ),
            encoding="utf-8",
        )
        (candidate_dir / "evaluation.json").write_text(json_dumps(report.model_dump()), encoding="utf-8")
        (candidate_dir / "summary.md").write_text(
            generate_summary_markdown(apply_result.candidate, report.recommendation, report.notes),
            encoding="utf-8",
        )

    def _write_run_artifacts(self, run_dir: Path, imported, episodes, families) -> None:
        (run_dir / "run.json").write_text(
            json_dumps(
                {
                    "run_id": run_dir.name,
                    "trace_count": len(imported),
                    "episode_count": len(episodes),
                    "family_count": len(families),
                }
            ),
            encoding="utf-8",
        )
        (run_dir / "episodes.json").write_text(json_dumps([episode.model_dump() for episode in episodes]), encoding="utf-8")
        (run_dir / "families.json").write_text(json_dumps([family.model_dump() for family in families]), encoding="utf-8")

        with session_scope(self.session_factory) as session:
            for trace in imported:
                session.add(
                    TraceFileRecord(
                        run_id=run_dir.name,
                        trace_id=trace.traceId,
                        thread_id=trace.threadId,
                        local_path=trace.local_path,
                    )
                )
            for family in families:
                session.add(
                    FamilyRecord(
                        run_id=run_dir.name,
                        family_id=family.family_id,
                        payload_json=json_dumps(family.model_dump()),
                    )
                )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _anchor_signature(anchor) -> str:
    if anchor is None:
        return "none"
    if anchor.anchor_type == "heading":
        return "|".join(anchor.heading_path or []) or (anchor.text_hint or "heading")
    if anchor.anchor_type == "frontmatter_field":
        return anchor.field_name or "frontmatter"
    return anchor.text_hint or anchor.fingerprint or anchor.anchor_type


def _build_anchor(target_section: str | None) -> AnchorSpec:
    """Convert target_section from LLM merge into AnchorSpec."""
    if not target_section or target_section.lower() in ("null", "none", "end", "file_end"):
        return AnchorSpec(anchor_type="file_end", text_hint="append at file end")
    cleaned = target_section.lstrip("#").strip()
    if cleaned:
        return AnchorSpec(anchor_type="heading", heading_path=[cleaned], text_hint=cleaned)
    return AnchorSpec(anchor_type="file_end", text_hint="append at file end")


def _json_loads(payload: str) -> Any:
    import json

    return json.loads(payload)
