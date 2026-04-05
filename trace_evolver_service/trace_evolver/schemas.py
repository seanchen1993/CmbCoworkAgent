from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class TraceToolCall(BaseModel):
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    result: str | None = None
    durationMs: int | None = None

    model_config = ConfigDict(extra="allow")


class TraceStep(BaseModel):
    index: int
    startedAt: str
    assistantText: str = ""
    toolCalls: list[TraceToolCall] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow")


class AgentTrace(BaseModel):
    traceId: str
    threadId: str
    startedAt: str
    endedAt: str
    durationMs: int
    userMessage: str
    modelId: str
    modelName: str | None = None
    steps: list[TraceStep]
    totalToolCalls: int
    outcome: Literal["success", "error", "cancelled", "unknown"]
    errorMessage: str | None = None
    usedSkills: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] | None = None

    model_config = ConfigDict(extra="allow")


class ImportedTrace(AgentTrace):
    source_path: str
    local_path: str
    ingested_at: str


class EvidenceSpan(BaseModel):
    trace_id: str
    step_index: int | None = None
    kind: Literal["assistant_text", "tool_call", "error_message", "episode_transition"]
    snippet: str


class Episode(BaseModel):
    episode_id: str
    thread_id: str
    trace_ids: list[str]
    start_ts: str
    end_ts: str
    summary: str
    used_skills: list[str]
    tool_signature: list[str]
    outcomes: list[str]
    user_messages: list[str]


class TaskFamily(BaseModel):
    family_id: str
    episode_ids: list[str]
    cluster_signature: str
    token_signature: list[str]
    used_skills: list[str]


class MarkdownFileMeta(BaseModel):
    file_path: str
    heading_tree: list[str]
    first_paragraph_summary: str
    linked_markdown_paths: list[str]
    token_estimate: int
    content_hash: str


class SkillBundleMeta(BaseModel):
    skill_id: str
    display_name: str
    root_path: str
    bundle_hash: str
    markdown_files: list[MarkdownFileMeta]


class SelectedSpan(BaseModel):
    file_path: str
    heading: str | None = None
    reason: str
    snippet: str


class FailureHypothesis(BaseModel):
    failure_surface: str
    suspected_root_cause: str
    evidence_spans: list[EvidenceSpan]
    confidence: float
    validation_level: Literal["trace_only"] = "trace_only"


class SuccessPattern(BaseModel):
    pattern_title: str
    pattern_description: str
    evidence_spans: list[EvidenceSpan]


class EditOp(BaseModel):
    file_path: str
    action: Literal["create_file", "edit", "append_file_end", "frontmatter_field"]
    content: str = ""
    old_string: str | None = None
    new_string: str | None = None
    field_name: str | None = None
    intent: Literal["trigger", "workflow", "guardrail", "example", "reference", "metadata"]
    source_visibility: Literal["full", "created"]


class HypothesisPatch(BaseModel):
    patch_id: str
    source_kind: Literal["success", "error"]
    validation_level: Literal["trace_only"] = "trace_only"
    target_skill_id: str | None = None
    family_id: str
    source_trace_ids: list[str]
    source_thread_ids: list[str]
    base_bundle_hash: str
    visible_files: list[str]
    ops: list[EditOp]
    confidence: float
    rationale: str
    risk_flags: list[str] = Field(default_factory=list)
    evidence_spans: list[EvidenceSpan] = Field(default_factory=list)


class CandidateBundle(BaseModel):
    candidate_id: str
    base_skill_id: str | None = None
    full_bundle_path: str
    files_changed: list[str]
    patch_ids: list[str]
    family_id: str
    source_trace_ids: list[str]
    source_thread_ids: list[str]
    unresolved_ops: list[str] = Field(default_factory=list)
    conflicts: list[str] = Field(default_factory=list)


class EvaluationScores(BaseModel):
    evidence_grounding: float
    cross_trace_recurrence: float
    generalization: float
    specificity: float
    conflict_risk: float
    bloat_risk: float
    novelty: float
    promotion_score: float


class EvaluationReport(BaseModel):
    recommendation: Literal["reject", "hold", "promotable"]
    scores: EvaluationScores
    risks: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class EpisodeRouteDecision(BaseModel):
    label: Literal["clean_success", "suspect_success", "error_like"]
    confidence: float
    reason: str


class RunCreateRequest(BaseModel):
    input_path: str
    skills_roots: list[str]
    output_root: str
    model_profile: str = "default"
    thread_ids: list[str] | None = None
    max_traces: int | None = None
    since_ts: str | None = None


class RunResponse(BaseModel):
    run_id: str
    status: str


class RunDetailResponse(BaseModel):
    run_id: str
    status: str
    input_path: str
    output_root: str
    error: str | None = None
    candidate_count: int = 0
    created_at: str
    finished_at: str | None = None


class CandidateDetailResponse(BaseModel):
    candidate_id: str
    run_id: str
    status: str
    recommendation: str | None
    base_skill_id: str | None
    full_bundle_path: str
    files_changed: list[str]
    source_trace_ids: list[str]
    source_thread_ids: list[str]
