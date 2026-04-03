"""
thread / episode / family 构建模块。

这层是主流程里最重要的“结构化”步骤：

- thread:
  按 trace.threadId 直接聚合，是最原始的会话边界

- episode:
  在同一个 thread 中进一步切出一段连续问题求解过程
  这是 analyst 真正分析的最小单元

- family:
  将跨 thread 的相似 episode 聚成一组
  这是 patch merge 和“是否值得沉淀成 skill”判断的最小单元

V1 的切分和聚类都是启发式的，不依赖真实环境状态。
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone

from trace_evolver.schemas import Episode, ImportedTrace, TaskFamily
from trace_evolver.utils import jaccard_similarity, sha256_text, slugify, tokenize, trim_snippet


def _parse_ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


def _tool_signature(trace: ImportedTrace) -> list[str]:
    signature: list[str] = []
    for step in trace.steps:
        names = [tool.name for tool in step.toolCalls]
        signature.extend(names)
        signature.extend(f"{names[index]}->{names[index + 1]}" for index in range(len(names) - 1))
    return signature


def assemble_threads(traces: list[ImportedTrace]) -> dict[str, list[ImportedTrace]]:
    grouped: dict[str, list[ImportedTrace]] = defaultdict(list)
    for trace in traces:
        grouped[trace.threadId].append(trace)
    for items in grouped.values():
        items.sort(key=lambda trace: (trace.startedAt, trace.traceId))
    return grouped


def build_episodes(traces: list[ImportedTrace], gap_minutes: int) -> list[Episode]:
    """
    把 trace 切成 episode。

    这里不是严格状态机，而是基于多个连续性信号打分：
    - 时间接近
    - userMessage 相似
    - usedSkills 重叠
    - 工具序列相似
    - 失败后继续修复

    满足足够多信号就视为同一段问题求解过程。
    """
    threads = assemble_threads(traces)
    episodes: list[Episode] = []

    for thread_id, thread_traces in threads.items():
        current: list[ImportedTrace] = []
        for trace in thread_traces:
            if not current:
                current = [trace]
                continue
            prev = current[-1]
            rules_hit = 0
            # This is intentionally heuristic: V1 groups traces by continuity signals, not by exact replay state.
            if (_parse_ts(trace.startedAt) - _parse_ts(prev.endedAt)).total_seconds() <= gap_minutes * 60:
                rules_hit += 1
            if jaccard_similarity(tokenize(prev.userMessage), tokenize(trace.userMessage)) >= 0.25:
                rules_hit += 1
            if set(prev.usedSkills) & set(trace.usedSkills):
                rules_hit += 1
            if jaccard_similarity(_tool_signature(prev), _tool_signature(trace)) >= 0.20:
                rules_hit += 1
            if prev.outcome in {"error", "unknown"} and trace.outcome in {"error", "success"}:
                rules_hit += 1

            if rules_hit >= 2:
                current.append(trace)
            else:
                episodes.append(_episode_from_traces(thread_id, current))
                current = [trace]
        if current:
            episodes.append(_episode_from_traces(thread_id, current))
    return episodes


def _episode_from_traces(thread_id: str, traces: list[ImportedTrace]) -> Episode:
    trace_ids = [trace.traceId for trace in traces]
    summary = trim_snippet(
        f"{traces[0].userMessage} | outcomes={','.join(trace.outcome for trace in traces)} | tools={','.join(_tool_signature(traces[-1])[:6])}",
        220,
    )
    used_skills = sorted({skill for trace in traces for skill in trace.usedSkills})
    tool_signature = sorted({token for trace in traces for token in _tool_signature(trace)})
    outcomes = [trace.outcome for trace in traces]
    user_messages = [trace.userMessage for trace in traces]
    seed = f"{thread_id}:{trace_ids[0]}:{trace_ids[-1]}"
    return Episode(
        episode_id=f"ep-{slugify(seed, 'episode')}-{sha256_text(seed)[:8]}",
        thread_id=thread_id,
        trace_ids=trace_ids,
        start_ts=traces[0].startedAt,
        end_ts=traces[-1].endedAt,
        summary=summary,
        used_skills=used_skills,
        tool_signature=tool_signature,
        outcomes=outcomes,
        user_messages=user_messages,
    )


@dataclass
class _FamilyCluster:
    family_id: str
    token_signature: set[str]
    used_skills: set[str]
    episodes: list[Episode]


def build_families(episodes: list[Episode], threshold: float) -> list[TaskFamily]:
    # family 是“跨 thread 的相似问题簇”。
    # 它不是严格监督聚类，而是为了给 V1 提供一个可工作的跨轨迹归纳单元。
    families: list[_FamilyCluster] = []
    for episode in episodes:
        token_signature = tokenize(" ".join(episode.user_messages + episode.tool_signature + episode.used_skills))
        best_cluster: _FamilyCluster | None = None
        best_score = 0.0
        for cluster in families:
            score = jaccard_similarity(token_signature, cluster.token_signature | set(cluster.used_skills))
            if score > best_score:
                best_cluster = cluster
                best_score = score
        if best_cluster and best_score >= threshold:
            best_cluster.episodes.append(episode)
            best_cluster.token_signature |= token_signature
            best_cluster.used_skills |= set(episode.used_skills)
            continue

        seed = "|".join(sorted(token_signature)[:8]) or episode.thread_id
        families.append(
            _FamilyCluster(
                family_id=f"fam-{slugify(seed, 'family')}-{sha256_text(seed)[:8]}",
                token_signature=set(token_signature),
                used_skills=set(episode.used_skills),
                episodes=[episode],
            )
        )

    return [
        TaskFamily(
            family_id=cluster.family_id,
            episode_ids=[episode.episode_id for episode in cluster.episodes],
            cluster_signature=" ".join(sorted(cluster.token_signature)[:16]),
            token_signature=sorted(cluster.token_signature),
            used_skills=sorted(cluster.used_skills),
        )
        for cluster in families
    ]
