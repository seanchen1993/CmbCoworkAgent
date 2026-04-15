from __future__ import annotations

import logging

from trace_evolver.config import Settings
from trace_evolver.llm import LLMClient
from trace_evolver.schemas import Episode, EpisodeRouteDecision, ImportedTrace
from trace_evolver.utils import trim_snippet

logger = logging.getLogger(__name__)


class EpisodeRouteClassifier:
    """Lightweight LLM gate for all-success episodes.

    The goal is not to prove true task success. It only asks whether the episode
    looks trustworthy enough to become a positive success-distillation example.
    Any low-confidence or malformed result should be treated conservatively and
    routed to ErrorAnalyst instead.
    """

    def __init__(self, settings: Settings):
        self.settings = settings

    def classify(self, episode: Episode, traces: list[ImportedTrace]) -> EpisodeRouteDecision:
        llm = LLMClient(self.settings.llm)
        messages = self._build_messages(episode, traces)
        result = llm.chat_json(messages, temperature=0.1)
        return EpisodeRouteDecision.model_validate(result)

    def _build_messages(self, episode: Episode, traces: list[ImportedTrace]) -> list[dict[str, str]]:
        selected = traces[-self.settings.episode_route_max_traces :]
        total_steps = sum(len(trace.steps) for trace in traces)
        total_tool_calls = sum(trace.totalToolCalls for trace in traces)

        trace_summaries: list[str] = []
        for idx, trace in enumerate(selected, start=1):
            final_assistant = ""
            if trace.steps:
                final_assistant = trace.steps[-1].assistantText
            trace_summaries.append(
                "\n".join(
                    [
                        f"Trace {idx}:",
                        f"- trace_id: {trace.traceId}",
                        f"- outcome: {trace.outcome}",
                        f"- step_count: {len(trace.steps)}",
                        f"- tool_call_count: {trace.totalToolCalls}",
                        f"- user_message: {trim_snippet(trace.userMessage, self.settings.episode_route_user_chars)}",
                        f"- final_assistant_text: {trim_snippet(final_assistant, self.settings.episode_route_assistant_chars)}",
                        f"- error_message: {trim_snippet(trace.errorMessage or '', self.settings.episode_route_error_chars)}",
                    ]
                )
            )

        user_prompt = "\n".join(
            [
                "Episode summary:",
                f"- episode_id: {episode.episode_id}",
                f"- trace_count: {len(traces)}",
                f"- outcomes: {episode.outcomes}",
                f"- used_skills: {episode.used_skills}",
                f"- total_steps: {total_steps}",
                f"- total_tool_calls: {total_tool_calls}",
                "",
                "Compressed trace view:",
                "\n\n".join(trace_summaries),
                "",
                "Classify whether this all-success episode is trustworthy enough to be treated as a success-distillation example.",
            ]
        )

        return [
            {
                "role": "system",
                "content": (
                    "You are an episode routing classifier for offline skill evolution.\n"
                    "Only judge whether the episode is trustworthy enough to be routed to SuccessAnalyst.\n"
                    "Do not assume hidden context or external artifacts.\n"
                    "If the episode looks tentative, unresolved, partially completed, or likely to trigger user follow-up, "
                    "do NOT label it clean_success.\n"
                    "Return strict JSON only:\n"
                    "{\n"
                    '  "label": "clean_success | suspect_success | error_like",\n'
                    '  "confidence": 0.0,\n'
                    '  "reason": "one sentence"\n'
                    "}\n"
                ),
            },
            {
                "role": "user",
                "content": user_prompt,
            },
        ]
