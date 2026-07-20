/**
 * Stage × Skill attribution buckets for project-mode work (conversations + code).
 *
 * Two orthogonal per-turn signals decide whether work was "plugin-driven":
 *  - Stage axis  — `harnessNodeStatus`, the workflow stage status at turn time.
 *    Recorded as a stable default label (see DEFAULT_NODE_STATUS_LABELS in
 *    src/main/harness-board/service.ts), so we match on the label string here.
 *  - Skill axis  — whether the event/turn carries a plugin Skill attribution
 *    (`usedSkills`). Skill attribution is sticky per thread, so a conversation
 *    that never invoked a Skill carries none.
 *
 * The decisive signal for "constrained by the plugin" is whether a Skill was
 * actually invoked. A user can open a fresh conversation inside an active stage
 * and bypass the plugin (no Skill) — that output isn't plugin-driven, so it
 * counts as vibecoding just like free output after a stage completes.
 */
export type StageBucket = "plugin_constrained" | "vibecoding" | "unattributed"

/**
 * Default node-status labels we key on. These mirror DEFAULT_NODE_STATUS_LABELS
 * for `in_progress` / `done`; `resolveHarnessFeatureCurrentStage` deliberately
 * records the default label (not any plugin-custom one) so these stay stable.
 */
export const STAGE_IN_PROGRESS_LABEL = "进行中"
export const STAGE_DONE_LABEL = "已完成"

/**
 * Classify one turn's / code event's (stage status, skill-presence) into a bucket.
 *  - 进行中 + 有 Skill 归因 → plugin_constrained（阶段进行中且实际调用插件）
 *  - 进行中 + 无 Skill 归因 → vibecoding（阶段开着但绕过插件，本质是自由产出）
 *  - 已完成（不论 Skill）   → vibecoding（流程完成后的自由产出）
 *  - 其余状态 / 无状态/历史 → unattributed
 */
export function classifyHarnessStageBucket(
  statusLabel: string | null | undefined,
  hasSkill: boolean
): StageBucket {
  const label = statusLabel?.trim()
  if (label === STAGE_IN_PROGRESS_LABEL) {
    return hasSkill ? "plugin_constrained" : "vibecoding"
  }
  if (label === STAGE_DONE_LABEL) return "vibecoding"
  return "unattributed"
}

/** Display order for the buckets (most "constrained" → least). */
export const STAGE_BUCKET_ORDER: readonly StageBucket[] = [
  "plugin_constrained",
  "vibecoding",
  "unattributed"
]

/** Short Chinese labels for each bucket, for dashboard rendering. */
export const STAGE_BUCKET_LABELS: Record<StageBucket, string> = {
  plugin_constrained: "插件约束（Harness）",
  vibecoding: "VibeCoding",
  unattributed: "未归因"
}

/** One-line meaning per bucket, for tooltips / InfoHint copy. */
export const STAGE_BUCKET_HINTS: Record<StageBucket, string> = {
  plugin_constrained: "工作流阶段进行中，且对话实际调用了插件 Skill —— 真正受插件流程约束的产出。",
  vibecoding:
    "未受插件约束的自由产出：阶段进行中但未调用插件 Skill（如新开对话绕过插件），或阶段已完成后的产出。",
  unattributed: "其余阶段状态（未开始/阻断/…）或无阶段状态的历史数据，无法判定。"
}
