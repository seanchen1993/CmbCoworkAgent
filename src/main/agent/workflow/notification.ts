import { toJsonSafe } from "./engine"
import {
  WORKFLOW_TOOL_RESULT_MAX_CHARS,
  truncateText,
  type PersistedWorkflowRun,
  type WorkflowRunStats
} from "./types"

/**
 * Model-facing completion notification for a background workflow run.
 * Electron-free so the format is unit-testable.
 *
 * First line is a machine marker (the renderer hides the message; the main
 * process marks the run delivered on sight); the body mirrors Claude Code's
 * <task-notification> shape so mid-tier models treat it exactly like other
 * internal task results.
 */

export const WORKFLOW_NOTIFICATION_MARKER_PREFIX = "[[CMB_WORKFLOW_NOTIFICATION_V1:"

/** Renderer-submitted trigger; the main process expands it into the real notification. */
export const WORKFLOW_NOTIFICATION_TURN_TRIGGER = "[[CMB_WORKFLOW_NOTIFICATION_TURN]]"

/**
 * The EXACT content the renderer submits for an internal notification turn. The main
 * process treats a message as internal plumbing ONLY when it matches this in FULL —
 * a user can paste the short TRIGGER prefix (e.g. from a log or code sample), but not
 * this whole prompt, so their message won't be wrongly swallowed (#1). MUST stay
 * byte-identical to the renderer's WORKFLOW_NOTIFICATION_TURN_PROMPT
 * (message-display-helpers.ts) — a workflow-engine test pins them equal, because a
 * silent drift would break every workflow completion notification.
 */
export const WORKFLOW_NOTIFICATION_TURN_PROMPT = `${WORKFLOW_NOTIFICATION_TURN_TRIGGER}
Process the completed workflow task-notification. This is an internal system turn, not a new user request.`

/**
 * Escapes XML metacharacters so a subagent result containing `</result>`,
 * a forged `<task-notification>` tag, or injected instructions cannot break the
 * notification structure or smuggle directives into the model's context.
 */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Truncate to `max`, escape XML metachars, then HARD-cap the escaped output to
 * `max` characters. escapeXml expands the input (`<` → `&lt;`, `&` → `&amp;`, up
 * to 5×), so truncating only BEFORE escaping could still let the payload blow
 * past `max` and bloat the notification context. We cap the escaped string and
 * trim a trailing partial entity (e.g. a dangling `&lt`) so the XML stays
 * well-formed. The pre-escape truncate keeps escapeXml off a possibly huge input.
 */
function escapeAndCap(text: string, max: number): string {
  const escaped = escapeXml(truncateText(text, max))
  if (escaped.length <= max) return escaped
  let cut = escaped.slice(0, max)
  const lastAmp = cut.lastIndexOf("&")
  if (lastAmp >= 0 && !cut.slice(lastAmp).includes(";")) cut = cut.slice(0, lastAmp)
  return cut
}

export function buildWorkflowNotificationMessage(
  run: PersistedWorkflowRun,
  outputFilePath?: string
): string {
  const stats: WorkflowRunStats = run.stats
  // The COMPLETE result is always persisted to disk; surface its path so the model can
  // read the full result with its file tools when the inline <result> below is
  // truncated (mirrors Claude Code's <output-file>).
  const escapedOutputFile = outputFilePath ? escapeXml(outputFilePath) : ""
  const lines: string[] = [
    `${WORKFLOW_NOTIFICATION_MARKER_PREFIX}${run.runId}]]`,
    "[SYSTEM NOTIFICATION - NOT USER INPUT]",
    "This is an automated background-workflow completion event, not a message from the user.",
    "",
    "<task-notification>",
    `<task-id>${escapeXml(run.runId)}</task-id>`,
    `<workflow-name>${escapeXml(run.workflowName)}</workflow-name>`
  ]
  if (escapedOutputFile) lines.push(`<output-file>${escapedOutputFile}</output-file>`)
  lines.push(`<status>${escapeXml(run.status)}</status>`)
  // One-line task summary (meta.description) — an overview the model still has even
  // when <result> is truncated.
  const summary = run.description ?? run.workflowName
  if (summary) lines.push(`<summary>${escapeAndCap(summary, 1_000)}</summary>`)
  if (run.status === "completed") {
    const resultJson = JSON.stringify(toJsonSafe(run.result) ?? null, null, 2)
    const capped = escapeAndCap(resultJson, WORKFLOW_TOOL_RESULT_MAX_CHARS)
    if (resultJson.length > WORKFLOW_TOOL_RESULT_MAX_CHARS) {
      // Truncated: tell the model HOW MUCH was cut and WHERE the full result lives, so
      // it reads the complete value instead of working off half-cut JSON (mirrors
      // Claude Code's "(truncated N chars, full result in <path>)").
      const dropped = resultJson.length - WORKFLOW_TOOL_RESULT_MAX_CHARS
      const where = escapedOutputFile ? `, full result in ${escapedOutputFile}` : ""
      lines.push(`<result>${capped} ... (truncated ${dropped} chars${where})</result>`)
    } else {
      lines.push(`<result>${capped}</result>`)
    }
    if (run.warning) {
      lines.push(`<warning>${escapeAndCap(run.warning, 2_000)}</warning>`)
    }
  } else {
    lines.push(`<error>${escapeAndCap(run.error ?? "unknown error", 2_000)}</error>`)
    lines.push(
      `<resume>For a TRANSIENT failure, call the workflow tool with {"resumeFromRunId": "${escapeXml(run.runId)}"} alone — the saved script reloads and completed agents replay from the journal. For a SCRIPT BUG, re-send the corrected script: a changed script (or changed args) discards the journal and re-runs from scratch, so it does NOT replay completed agents — do not keep resuming the same buggy script.</resume>`
    )
  }
  // Surface WHICH agents failed (label + reason) so the model/user can diagnose a
  // failure or partial completion, not just see the top-level result/error. The
  // full per-agent record lives in the journal; this is a bounded digest.
  const failedAgents = run.agents.filter((agent) => agent.status === "error")
  if (failedAgents.length > 0) {
    const shown = failedAgents
      .slice(0, 20)
      .map(
        (agent) =>
          `  - ${escapeXml(agent.label)}: ${escapeAndCap(agent.error ?? "unknown error", 300)}`
      )
      .join("\n")
    const more = failedAgents.length > 20 ? `\n  … and ${failedAgents.length - 20} more` : ""
    lines.push(`<failed-agents>\n${shown}${more}\n</failed-agents>`)
  }
  lines.push(
    `<usage><agents>${stats.agentsTotal}</agents><cached>${stats.agentsCached}</cached><failed>${stats.agentsFailed}</failed><output_tokens>${stats.outputTokens}</output_tokens><duration_ms>${stats.durationMs}</duration_ms></usage>`,
    "</task-notification>",
    "",
    "Summarize this workflow outcome for the user in your own words (use their language). Do not call the workflow tool again unless the user asks or a failed run should be resumed."
  )
  return lines.join("\n")
}
