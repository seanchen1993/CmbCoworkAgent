import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { SubAgent } from "deepagents"
import { tool } from "langchain"
import { z } from "zod"
import type {
  CoordinatorWorkerRole,
  CoordinatorWorkerSnapshot,
  CoordinatorWorkerWorkload
} from "./coordinator-worker-manager"

export type AgentMode = "normal" | "coordinator"

const COORDINATOR_BASE_DIR = ".cmbdevclaw/coordinator"
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKER_THREAD_DELIMITER = "__worker__"
const SKILL_USE_TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"
const SELECTED_SKILL_PROMPT_MARKER = "[[CMB_COORDINATOR_SELECTED_SKILL_V1]]"
const coordinatorWorkerSubagentSchema = z.enum(["worker"])
const workerRoleSchema = z.enum(["implementer", "verifier"])
const workerWorkloadSchema = z.enum(["read_only", "verify", "write"])

interface CoordinatorRequest {
  enabled: boolean
  message: string
  shouldPersist: boolean
  source?: "message-prefix" | "metadata" | "environment"
}

interface CoordinatorPromptOptions {
  threadId: string
  workspacePath: string
  platform: string
  shell: string
  timezone: string
  currentTime: string
  projectInstructions?: string | null
  turnContext?: string | null
  hasBrowserTool: boolean
  hasCodeExecTool: boolean
  deferredToolIds: string[]
}

interface CoordinatorTimeContext {
  timezone: string
  currentTime: string
}

interface CoordinatorWorkerToolOptions {
  workspacePath: string
  threadId: string
  workerTools?: CoordinatorWorkerToolDelegate
  onNotificationsConsumed?: (notificationIds: string[]) => void
  selectedSkill?: CoordinatorSelectedSkill
  explicitSelectedSkill?: CoordinatorSelectedSkill
  notificationSelectedSkills?: Record<string, CoordinatorSelectedSkill | undefined>
}

interface CoordinatorWorkerToolDelegate {
  startWorker: (input: {
    role: CoordinatorWorkerRole
    workload?: CoordinatorWorkerWorkload
    description: string
    prompt: string
    selectedSkill?: CoordinatorSelectedSkill
  }) => Promise<CoordinatorWorkerSnapshot>
  continueWorker: (input: {
    workerId: string
    workload?: CoordinatorWorkerWorkload
    prompt: string
    selectedSkill?: CoordinatorSelectedSkill
  }) => Promise<CoordinatorWorkerSnapshot>
  cancelWorker: (input: {
    workerId?: string
    reason?: string
  }) => Promise<CoordinatorWorkerSnapshot[]>
}

export interface CoordinatorSelectedSkill {
  skillName: string
  skillPath: string
  description?: string
  whenToUse?: string
  allowedTools?: string
}

type CoordinatorWorkerToolSnapshot = Omit<
  CoordinatorWorkerSnapshot,
  "owned_files" | "base_workload"
>

function truthy(value: unknown): boolean {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return false
  return ["1", "true", "yes", "on", "coordinator"].includes(value.toLowerCase())
}

export function isCoordinatorModeForcedByEnvironment(): boolean {
  return truthy(process.env.CMB_COORDINATOR_MODE)
}

function normalizeThreadId(threadId: string): string {
  const normalized = threadId.trim()
  if (!THREAD_ID_PATTERN.test(normalized)) {
    throw new Error(`Invalid coordinator threadId: ${threadId}`)
  }
  if (normalized.includes(WORKER_THREAD_DELIMITER)) {
    throw new Error(
      `Invalid coordinator threadId: ${threadId}. Thread ids may not contain the reserved ${WORKER_THREAD_DELIMITER} delimiter.`
    )
  }
  return normalized
}

function getCoordinatorDir(threadId?: string): string {
  return threadId
    ? `${COORDINATOR_BASE_DIR}/${normalizeThreadId(threadId)}`
    : `${COORDINATOR_BASE_DIR}/<threadId>`
}

export function getCoordinatorScratchpadDir(threadId?: string): string {
  return `${getCoordinatorDir(threadId)}/scratchpad`
}

function toCoordinatorWorkerToolSnapshot(
  snapshot: CoordinatorWorkerSnapshot
): CoordinatorWorkerToolSnapshot {
  const { owned_files, base_workload, ...publicSnapshot } = snapshot
  void owned_files
  void base_workload
  return publicSnapshot
}

function toCoordinatorWorkerToolSnapshots(
  snapshots: CoordinatorWorkerSnapshot[]
): CoordinatorWorkerToolSnapshot[] {
  return snapshots.map(toCoordinatorWorkerToolSnapshot)
}

function renderTimeContext(options: CoordinatorTimeContext): string {
  return `- Timezone: ${options.timezone}
- Current time: ${options.currentTime}
- Timestamp rule: Do not invent dates or timestamps. If a timestamp is useful, use the current time above; otherwise omit it.`
}

function unescapeSkillXml(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
}

function parseTrailingSkillUseBlock(message: string): {
  skillName: string
  skillPath: string
  description?: string
  whenToUse?: string
  allowedTools?: string
  rest: string
} | null {
  const openTag = `<${SKILL_USE_TAG_NAME}>`
  const closeTag = `</${SKILL_USE_TAG_NAME}>`
  const closeAt = message.lastIndexOf(closeTag)
  if (closeAt < 0) return null
  const openAt = message.lastIndexOf(openTag, closeAt)
  if (openAt < 0) return null
  if (message.slice(closeAt + closeTag.length).trim() !== "") return null

  const block = message.slice(openAt, closeAt + closeTag.length)
  const tagText = (tag: string): string | undefined => {
    const match = block.match(new RegExp(`<${tag}>\\s*([^<]*)\\s*<\\/${tag}>`))
    const value = match ? unescapeSkillXml(match[1]).trim() : ""
    return value || undefined
  }
  const skillName = tagText("name")
  const skillPath = tagText("path")
  if (!skillName || !skillPath) return null

  return {
    skillName,
    skillPath,
    description: tagText("description"),
    whenToUse: tagText("when_to_use"),
    allowedTools: tagText("allowed_tools"),
    rest: message.slice(0, openAt).replace(/\s+$/, "")
  }
}

export function adaptCoordinatorSkillUseForWorkerDelegation(message: string): string {
  const parsed = parseTrailingSkillUseBlock(message)
  if (!parsed) return message

  const userRequest = parsed.rest.trim()
  const delegation = [
    "Coordinator skill delegation:",
    `- The user selected the "${parsed.skillName}" skill for this request.`,
    parsed.description ? `- Description: ${parsed.description}` : "",
    parsed.whenToUse ? `- When to use: ${parsed.whenToUse}` : "",
    parsed.allowedTools
      ? `- This skill grants workers additional tool permissions: ${parsed.allowedTools}`
      : "",
    "- Do not try to execute the skill in the coordinator main thread or read SKILL.md from the coordinator.",
    "- You MUST start or continue a worker for this request; do not answer it directly from the coordinator.",
    `- In the worker prompt, include this mandatory instruction verbatim: The user explicitly selected the /${parsed.skillName} skill. First use read_file to read ${parsed.skillPath}, then strictly follow that SKILL.md for this task before doing any other work. Do not skip, summarize, or generalize the skill steps. If the skill cannot be loaded, report BLOCKED with the reason.`,
    "- Worker runtimes receive enabled skills through their normal skill middleware, but the worker prompt must still explicitly require loading the selected SKILL.md first.",
    `- Skill path for worker reference: ${parsed.skillPath}`
  ]
    .filter(Boolean)
    .join("\n")

  return [userRequest || "The user selected a skill for this coordinator turn.", delegation].join(
    "\n\n"
  )
}

export function extractCoordinatorSelectedSkill(message: string): CoordinatorSelectedSkill | null {
  const parsed = parseTrailingSkillUseBlock(message)
  if (!parsed) return null
  return {
    skillName: parsed.skillName,
    skillPath: parsed.skillPath,
    description: parsed.description,
    whenToUse: parsed.whenToUse,
    allowedTools: parsed.allowedTools
  }
}

function resolveSelectedSkillForNotificationIds(
  notificationIds: string[] | undefined,
  notificationSelectedSkills: Record<string, CoordinatorSelectedSkill | undefined> | undefined
): CoordinatorSelectedSkill | undefined {
  if (!notificationIds || notificationIds.length === 0 || !notificationSelectedSkills)
    return undefined
  if (notificationIds.some((notificationId) => !notificationSelectedSkills[notificationId])) {
    return undefined
  }
  const uniqueByPath = new Map<string, CoordinatorSelectedSkill>()
  for (const notificationId of notificationIds) {
    const selectedSkill = notificationSelectedSkills[notificationId]
    if (!selectedSkill) continue
    uniqueByPath.set(`${selectedSkill.skillName}@@${selectedSkill.skillPath}`, selectedSkill)
  }
  if (uniqueByPath.size !== 1) return undefined
  return Array.from(uniqueByPath.values())[0]
}

function resolveWorkerPromptSelectedSkill(
  notificationIds: string[] | undefined,
  notificationSelectedSkills: Record<string, CoordinatorSelectedSkill | undefined> | undefined,
  selectedSkill: CoordinatorSelectedSkill | undefined,
  explicitSelectedSkill: CoordinatorSelectedSkill | undefined
): CoordinatorSelectedSkill | undefined {
  if (notificationIds && notificationIds.length > 0) {
    return (
      resolveSelectedSkillForNotificationIds(notificationIds, notificationSelectedSkills) ??
      explicitSelectedSkill
    )
  }
  return selectedSkill
}

export function injectSelectedSkillIntoWorkerPrompt(
  prompt: string,
  selectedSkill?: CoordinatorSelectedSkill
): string {
  if (!selectedSkill) return prompt
  const trimmedPrompt = prompt.trim()
  if (trimmedPrompt.includes(SELECTED_SKILL_PROMPT_MARKER)) {
    return prompt
  }

  const selectedSkillBlock = [
    SELECTED_SKILL_PROMPT_MARKER,
    "Coordinator-enforced selected skill:",
    `- The user explicitly selected the /${selectedSkill.skillName} skill for this request.`,
    selectedSkill.description ? `- Description: ${selectedSkill.description}` : "",
    selectedSkill.whenToUse ? `- When to use: ${selectedSkill.whenToUse}` : "",
    selectedSkill.allowedTools
      ? `- This skill grants workers additional tool permissions: ${selectedSkill.allowedTools}`
      : "",
    `- First use read_file to read ${selectedSkill.skillPath}, then strictly follow that SKILL.md for this task before doing any other work.`,
    "- Do not skip, summarize, or generalize the skill steps.",
    "- If the skill cannot be loaded, report BLOCKED with the reason."
  ]
    .filter(Boolean)
    .join("\n")

  return [selectedSkillBlock, trimmedPrompt].filter(Boolean).join("\n\n")
}

export function getAgentModeFromMetadata(metadata: Record<string, unknown>): AgentMode {
  if (metadata.agentMode === "normal") {
    return "normal"
  }
  if (metadata.agentMode === "coordinator" || truthy(metadata.coordinatorMode)) {
    return "coordinator"
  }
  return "normal"
}

export function resolveCoordinatorModeRequest(
  message: string,
  metadata: Record<string, unknown>
): CoordinatorRequest {
  const prefixPattern = /^\s*(?:\[coordinator\]|#coordinator)\s*[:-]?\s*/i
  const hasPrefix = prefixPattern.test(message)
  const strippedMessage = hasPrefix ? message.replace(prefixPattern, "") : message

  if (hasPrefix) {
    return {
      enabled: true,
      message: strippedMessage.trimStart(),
      shouldPersist: true,
      source: "message-prefix"
    }
  }

  if (isCoordinatorModeForcedByEnvironment()) {
    return {
      enabled: true,
      message,
      shouldPersist: false,
      source: "environment"
    }
  }

  if (getAgentModeFromMetadata(metadata) === "coordinator") {
    return {
      enabled: true,
      message,
      shouldPersist: false,
      source: "metadata"
    }
  }

  return { enabled: false, message, shouldPersist: false }
}

export function buildCoordinatorTaskPrompt(threadId?: string): string {
  const threadScope = threadId ? `\nCoordinator thread_id: ${threadId}\n` : "\n"
  const scratchpadDir = getCoordinatorScratchpadDir(threadId)
  return `## coordinator worker launcher

Coordinator mode uses async worker tools for delegation. Prefer start_worker / continue_worker for durable worker orchestration; do not rely on synchronous task subagents in coordinator mode.
${threadScope}

Available worker roles:
- implementer: researches, writes code or documents, edits files, runs checks when its tool access allows, and reports a concise verifier-ready handoff.
- verifier: independently checks the work against the original user request with concrete evidence.

Coordinator rules:
- Answer directly when possible for conceptual answers and simple status replies that do not require tools.
- For coding, document generation, app behavior changes, or long-running multi-worker work, keep the acceptance criteria in your own synthesis and worker prompts.
- For pure Q&A, keep the flow lightweight. If project files or commands are needed, use a small worker rather than creating ceremony files.
- Call start_worker with subagent_type="worker" for delegated work, matching Claude Code coordinator semantics.
- Use role="verifier" only for independent verification; otherwise use role="implementer" or omit role.
- Use workload="read_only" for investigation, workload="verify" for independent verification that may run tests/build/lint, and workload="write" for file-changing work.
- Only verifier workers may use workload="verify". If you need independent verification, spawn a fresh verifier instead of reusing an implementer as a self-verifying worker.
- Never use workload="write" with role="verifier"; verifier workers must not modify code.
- Launch independent read-only workers in parallel when useful.
- Treat write workers as whole-workspace implementers, matching Claude Code coordinator semantics. Avoid running overlapping write workers at the same time; use one implementer for related edits, then a fresh verifier for independent acceptance.
- Parallelism is useful for independent research. Launch independent read-only workers in the same turn when they cover different angles.
- Delegate implementation work to implementer.
- Delegate final acceptance to verifier.
- Do not treat implementer self-checks as final verification.
- Before launching verifier, synthesize the implementer result, changed/output files, answer draft, and approach taken into a self-contained verifier prompt.
- For deliverable work, do not report completion until verifier has returned PASS with concrete evidence, or report BLOCKED with a concrete blocker.
- After a task notification arrives, use its pushed <result> handoff to decide the next step. If the result is truncated or missing key evidence, continue that same worker and ask for a concise handoff; do not read archived output files from the coordinator.
- Do not poll workers after starting them; briefly tell the user what was launched and end the turn.
- Never fabricate or predict worker results. If the user asks before a notification arrives, report only that the worker is still running and what it was asked to do.
- If verifier returns FAIL, send a focused follow-up task to implementer. Prefer continue_worker for the same implementer; it can interrupt a running worker and reuse that worker checkpoint.
- Use cancel_worker only to stop work that should not continue. Cancelled workers are final; if you want to redirect a worker and preserve its context, use continue_worker directly.
- Scratchpad directory for durable cross-worker notes: ${scratchpadDir}. Use it only when long-running work needs a concise shared artifact. It is an ordinary workspace artifact path; normal tool availability, approval, hook, and access limits still apply.`
}

export function buildCoordinatorSystemPrompt(options: CoordinatorPromptOptions): string {
  const coordinatorDir = getCoordinatorDir(options.threadId)
  const scratchpadDir = getCoordinatorScratchpadDir(options.threadId)
  const projectInstructions = options.projectInstructions?.trim()
  const turnContext = options.turnContext?.trim()
  const browserLine = options.hasBrowserTool
    ? "- Browser/runtime verification is available to workers through browser_playwright."
    : "- Browser/runtime verification may not be available; workers should use the strongest available runtime checks."
  const codeExecLine = options.hasCodeExecTool
    ? "- code_exec may be available to unrestricted workers for reusable scripted checks when useful; constrained workers may not receive it."
    : "- code_exec is not available; workers should rely on shell, tests, and browser tools."
  const deferredLine =
    options.deferredToolIds.length > 0
      ? `- Deferred tools exist for workers: ${options.deferredToolIds.join(", ")}.`
      : "- No deferred worker tools are currently registered."

  return `You are CmbCowork Coordinator Mode.

You orchestrate software engineering work across async workers. Your goal is to help the user achieve their objective with the least process that still gives reliable results.

Every message you send is to the user. Worker results and system notifications are internal signals, not conversation partners. Never thank or acknowledge notifications; summarize new information for the user when it matters.

## 1. Role

- Answer directly when possible. Do not delegate work that you can complete without tools.
- Use workers for research, implementation, and independent verification.
- Synthesize worker results yourself. Never hand off understanding from one worker to another.
- Maintain durable state only when it improves reliability for a deliverable or long task.

## 2. Tools

- start_worker: spawn an async worker.
- continue_worker: continue an existing worker with the same worker_id/thread context.
- cancel_worker: stop running workers.
- Skills: the coordinator main thread does not load full skill instructions. Workers receive enabled skills through their normal runtime; delegate skill invocations to workers.

When calling start_worker:
- Always use subagent_type="worker", matching Claude Code coordinator semantics.
- Use role="verifier" only for independent verification. Use role="implementer" or omit role for implementation, research that feeds implementation, and file creation.
- Use workload="read_only" for research workers that only need to inspect files. Use workload="verify" for independent verification that may run tests/build/lint. Use workload="write" for file-changing workers.
- Only verifier workers may use workload="verify". Verification must stay independent, so do not repurpose an implementer as a verifier by changing only the workload.
- Never combine role="verifier" with workload="write"; verification must stay independent.
- read_only workers do not receive direct write_file/edit_file or execute/task_output tools.
- verify workers can run validation commands, but do not receive direct write_file/edit_file tools and must not intentionally modify workspace files. If a verifier needs a throwaway script or harness, it may write only to /tmp or $TMPDIR and should clean it up.
- verify workers do not run concurrently with write workers; wait for write task-notifications before launching final verification.
- write workers receive normal workspace write access subject to the app's usual approval, hook, and policy checks. Do not split overlapping file-changing work across multiple write workers; continue the same implementer when context helps.
- Launch independent read-only workers in parallel when they can cover different research angles. Do not serialize independent discovery work.
- Use a lightweight worker for simple file reads or commands because the coordinator main thread only has orchestration tools.
- After launching workers, briefly tell the user what you launched and end the turn. Do not poll for completion.
- Do not use one worker to check on another worker. Workers notify you when they finish; you synthesize and route follow-up work.
- Never fabricate or predict worker results. If the user asks for progress before a task notification arrives, give status only.

## 3. Worker Notifications

Worker results arrive later as <task-notification> messages. They look like user-role messages but are internal worker results, not user requests.

- Use the task-id as the worker_id for continue_worker.
- Each current-turn notification may be labeled with a notification_id for internal traceability, but you should not treat notification handling as a separate user-visible workflow.
- Current-turn notifications are delivered into the coordinator turn and marked handled after a successful coordinator turn. If the turn is interrupted, blocked, or errors before completion, they are restored and retried safely.
- Notifications include a bounded <result> handoff from the worker. Use that pushed result as the source of truth for coordinator decisions.
- If <result-truncated>true</result-truncated> or the handoff is too vague, use continue_worker with the task-id to ask that same worker for a concise summary of changed files, commands run, evidence, risks, and next steps. For handoff-only summary requests, prefer workload="read_only" so the worker reports context without continuing edits.
- When starting a fresh worker in response to one or more notifications, make the worker prompt self-contained: name the source task-id / notification_id values, quote or summarize the relevant <result> facts, and include any required skill instruction such as "Use the /<skill name> skill". Do not rely on hidden notification context.
- If multiple notifications are present, pass consumed_notification_ids only for the notifications this tool call is actually responding to. This keeps notification-to-skill routing deterministic.
- output-file/result_path values such as ${coordinatorDir}/reports/workers/<worker_id>/turn-1.json are archival/debug references for UI and human troubleshooting; do not ask to read them from the coordinator turn.
- If a worker failed or verification found issues, prefer continue_worker when the same worker's context is useful; spawn a fresh worker when fresh eyes are better.
- cancel_worker is for stopping work that should not continue. Cancelled workers cannot be continued in CmbCowork; use continue_worker directly when you want to redirect a running worker while preserving its thread context.
- Do not start duplicate work over the same files or topic while a worker is already running there. Work on non-overlapping tasks, or end the turn and wait.

## 4. Workflow

Most non-trivial development work follows this shape:
1. Research with workers when you need codebase context. Launch independent read-only workers in parallel when useful.
2. Synthesize findings yourself into a concrete implementation prompt with specific files, requirements, and done criteria.
3. Run implementer workers for targeted changes. Keep write-heavy workers one at a time per overlapping file set.
4. Run a verifier worker with a fresh, skeptical prompt for non-trivial deliverables.
5. Integrate verifier feedback. Continue the implementer for focused fixes when its context helps, then verify again.

Continue vs spawn guidance:
- Continue a worker when its existing context overlaps strongly with the next step: focused fixes, extending its own change, or correcting its own failed checks.
- Spawn a fresh worker when fresh eyes matter: final verification, retrying after a wrong approach, or moving to a mostly unrelated area.
- Never tell a worker "based on your findings" without restating the concrete files, facts, and acceptance criteria you synthesized.

Verification gates:
- Do not skip verifier for file changes, documentation creation, code changes, build/test analysis, or app behavior changes.
- Do not report success from implementer output alone. Implementer output is a handoff, not acceptance.
- Do not launch verifier without a concrete implementer result. If the implementer output is too vague, continue implementer and ask for changed/output files, commands run, risks, and a handoff.
- Do not report success from verifier text alone unless it includes concrete evidence: commands/tests/browser checks, checked files, and findings.
- Do not leave running workers behind. Before reporting final completion, rely on worker notifications and the current coordinator worker context.

## 5. Writing Worker Prompts

Workers cannot see your conversation. Every worker prompt must be self-contained.

- Include the original user goal, relevant file paths, constraints, and expected output.
- State the source of the task: the current user request, your synthesized plan, a previous worker handoff, or one or more task notifications.
- Add a purpose statement so the worker can calibrate depth.
- If the worker is responding to a task notification, include a "Source notification" section with task-id, notification_id if present, the relevant worker result facts, and the next action you want from this worker.
- For research: say "do not modify files".
- For implementation: say what to change, how to verify, and what report/handoff to write.
- For verification: pass the original request, changed/output files or answer_draft, and require evidence.
- Never write lazy prompts like "based on your findings". Read findings, synthesize them, then give a concrete prompt.

Coordinator constraints:
- Running workers can be updated with continue_worker. This interrupts the current run and continues the same worker thread/checkpoint with the new instruction.
- Treat write workers as exclusive for overlapping implementation work. Read-only workers can run in parallel.
- Do not edit application files directly.
- Do not run shell/build/browser tools directly from the coordinator. Workers have those tools.
- If the user selected a skill, include "Use the /<skill name> skill" in the worker prompt instead of trying to use that skill directly.
- Keep state concise. Worker results are persisted under ${coordinatorDir}/reports/workers/ by the worker manager when available; summarize only what matters in chat.
- Scratchpad directory: ${scratchpadDir}. For long-running tasks, ask workers with write access to place concise shared notes there only when future workers need durable context. Treat it like any other workspace artifact path; do not store secrets there. Normal tool availability, approval, hook, and access limits still apply.
- Be practical: for small requests, keep acceptance criteria small; for app changes, insist on a real build/test/runtime check from an implementer or verifier.

Worker capability summary:
${browserLine}
${codeExecLine}
${deferredLine}

System environment:
- Workspace root: ${options.workspacePath}
- Operating system: ${options.platform}
- Default shell: ${options.shell}
${renderTimeContext(options)}

Verifier standard:
- PASS means the requested behavior is implemented and checked by commands/tests/browser evidence.
- FAIL means anything material is missing, untested, broken, or only self-claimed by implementer.
- UNKNOWN/BLOCKED is allowed only when verification cannot run; explain the exact blocker and best evidence gathered.

Final response rules:
- State the result plainly.
- Mention verifier status and the strongest evidence.
- If there is no verifier PASS with concrete evidence for non-trivial deliverables, do not say the task is complete.
- Mention remaining risks only if real.

${projectInstructions ? `## Project Instructions\n\n${projectInstructions}` : ""}

${turnContext ? `## Current Turn Internal Context\n\n${turnContext}` : ""}`
}

export function buildCoordinatorWorkerSubagents(
  projectInstructions?: string | null,
  skillSources?: string[],
  _threadId?: string,
  timeContext?: CoordinatorTimeContext
): SubAgent[] {
  const timeBlock = timeContext ? `\n\nSystem time:\n${renderTimeContext(timeContext)}` : ""
  const projectBlock = projectInstructions?.trim()
    ? `\n\n## Project Instructions\n\n${projectInstructions.trim()}`
    : ""
  const skills = skillSources?.length ? skillSources : undefined

  return [
    {
      name: "implementer",
      description:
        "Worker for implementation and research tasks. Edits files when asked, runs checks when available, and returns a concise verifier-ready handoff.",
      systemPrompt: `You are an implementer worker in CmbCowork coordinator mode.

Role:
- Implement the coordinator's requested change in the workspace.
- Make the smallest correct code changes that satisfy the coordinator's self-contained prompt.
- Run appropriate checks when your available tools permit it: typecheck, lint, tests, build, or targeted commands.
- If shell/runtime/browser tools are unavailable, do not claim checks you could not run; instead leave a precise verification handoff for a verifier.
- For frontend/app behavior, prepare the app for browser verification when feasible, or clearly call out the exact browser/runtime checks a verifier should run.

Boundaries:
- You are not the final evaluator.
- Do not mark the whole task complete just because your own checks pass.
- Do not wait for user confirmation unless blocked by missing credentials, destructive actions, or unavailable external services.

Before returning:
- For coding or document tasks, include output files and files changed.
- For research or Q&A tasks with no user-facing file, include the concrete answer draft.
- Include evidence, commands run, checked files, risks, and a handoff for verifier.
- Do not invent completion_time/generated_at values. Use the provided system time only when needed.
- Return STATUS, SUMMARY, OUTPUT_FILES or ANSWER_DRAFT, COMMANDS_RUN, RISKS, and HANDOFF_FOR_VERIFIER.
${timeBlock}
${projectBlock}`,
      ...(skills ? { skills } : {})
    },
    {
      name: "verifier",
      description:
        "Independent evaluator worker. Checks work against the original request with tests/build/browser evidence and returns PASS/FAIL/BLOCKED.",
      systemPrompt: `You are a verifier worker in CmbCowork coordinator mode.

Role:
- Independently evaluate whether the implementation satisfies the user's request and coordinator prompt.
- Be strict, skeptical, and evidence-driven.
- Inspect code as needed, run relevant commands, and use browser/runtime verification for UI or full-stack behavior when feasible.
- Do not create, modify, or delete files in the project workspace. If inline commands are not enough, you may write ephemeral verification scripts only under /tmp or $TMPDIR and should clean them up.

Evaluation rules:
- PASS only when behavior is implemented and supported by concrete evidence.
- FAIL when requirements are missing, code is broken, tests/build fail, UI behavior is unverified when it should be verified, or claims are unsupported.
- BLOCKED only when verification cannot proceed because of an explicit environmental blocker.

Before returning:
- Verify the concrete implementer handoff in your prompt. If it contains output_files, verify those files. If it contains answer_draft, verify that draft against source evidence.
- Do not invent completion_time/generated_at values. Use the provided system time only when needed.
- Return STATUS (PASS/FAIL/BLOCKED), EVIDENCE, COMMANDS_RUN, CHECKED_FILES, FINDINGS, and NEXT_FIX if not PASS.
${timeBlock}
${projectBlock}`,
      ...(skills ? { skills } : {})
    }
  ]
}

export function createCoordinatorWorkerTools(
  options: CoordinatorWorkerToolOptions
): DynamicStructuredTool[] {
  const tools: DynamicStructuredTool[] = []

  if (options.workerTools) {
    const startWorker = tool(
      async (input: {
        subagent_type: "worker"
        role?: CoordinatorWorkerRole
        workload?: CoordinatorWorkerWorkload
        consumed_notification_ids?: string[]
        description: string
        prompt: string
      }) => {
        const role = input.role ?? (input.workload === "verify" ? "verifier" : "implementer")
        const selectedSkill = resolveWorkerPromptSelectedSkill(
          input.consumed_notification_ids,
          options.notificationSelectedSkills,
          options.selectedSkill,
          options.explicitSelectedSkill
        )
        const snapshot = await options.workerTools!.startWorker({
          role,
          workload: input.workload,
          description: input.description,
          prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, selectedSkill),
          selectedSkill
        })
        options.onNotificationsConsumed?.(input.consumed_notification_ids ?? [])
        console.log("[CoordinatorMode] start_worker", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: snapshot.worker_id,
          role: snapshot.role
        })
        return JSON.stringify(
          {
            message:
              "Worker started asynchronously. Do not poll, duplicate this worker's files/topics, or predict results. Briefly tell the user what was launched and end this turn; a task notification will be delivered when the worker finishes.",
            worker: toCoordinatorWorkerToolSnapshot(snapshot)
          },
          null,
          2
        )
      },
      {
        name: "start_worker",
        description:
          'Start an asynchronous coordinator worker. Always use subagent_type="worker"; use role only as an optional coordinator-facing classification.',
        schema: z.object({
          subagent_type: coordinatorWorkerSubagentSchema.describe(
            'Always "worker" in coordinator mode, matching Claude Code coordinator.'
          ),
          role: workerRoleSchema
            .optional()
            .describe(
              'Optional coordinator-facing role. Use "verifier" for independent verification; omit or use "implementer" otherwise.'
            ),
          workload: workerWorkloadSchema
            .optional()
            .describe(
              'Use "read_only" for research, "verify" for independent checks that may run tests/build/lint, and "write" for implementers that may edit files. Only role="verifier" may use workload="verify". Do not use "write" with role="verifier". Defaults to write for implementer and verify for verifier.'
            ),
          consumed_notification_ids: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "notification_id values from the current turn's task notifications that this fresh worker launch is actually responding to. Use this only for notifications whose result facts are included in the prompt. This supports notification-to-skill routing and traceability; successful turns acknowledge delivered notifications as a batch."
            ),
          description: z.string().trim().min(1).describe("Short user-visible task description."),
          prompt: z
            .string()
            .trim()
            .min(1)
            .describe(
              "Full self-contained worker instruction, including the task source, acceptance criteria, expected outputs, and verification hints. If responding to worker notifications, include source task-id/notification_id and relevant result facts."
            )
        })
      }
    )

    const continueWorker = tool(
      async (input: {
        worker_id: string
        workload?: CoordinatorWorkerWorkload
        consumed_notification_ids?: string[]
        prompt: string
      }) => {
        const selectedSkill = resolveWorkerPromptSelectedSkill(
          input.consumed_notification_ids,
          options.notificationSelectedSkills,
          options.selectedSkill,
          options.explicitSelectedSkill
        )
        const snapshot = await options.workerTools!.continueWorker({
          workerId: input.worker_id,
          workload: input.workload,
          prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, selectedSkill),
          selectedSkill
        })
        options.onNotificationsConsumed?.(input.consumed_notification_ids ?? [])
        console.log("[CoordinatorMode] continue_worker", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: snapshot.worker_id,
          role: snapshot.role,
          turns: snapshot.turns
        })
        return JSON.stringify(
          {
            message:
              "Worker continued asynchronously with the same worker context. Do not poll for completion; wait for the task notification.",
            worker: toCoordinatorWorkerToolSnapshot(snapshot)
          },
          null,
          2
        )
      },
      {
        name: "continue_worker",
        description:
          "Continue an existing coordinator worker with the same worker context/checkpoint. If the worker is currently running, this interrupts the active run and starts a new run on the same worker thread.",
        schema: z.object({
          worker_id: z.string().trim().min(1).describe("Worker id returned by start_worker."),
          workload: workerWorkloadSchema
            .optional()
            .describe(
              'Optional updated workload for this run. Only verifier workers may use "verify"; do not use "write" for verifier workers. For handoff-only summary requests after truncated or vague results, set workload="read_only".'
            ),
          consumed_notification_ids: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "notification_id values from the current turn's task notifications that this worker continuation is actually responding to. Use this only for notifications whose result facts are included in the prompt. This supports notification-to-skill routing and traceability; successful turns acknowledge delivered notifications as a batch."
            ),
          prompt: z.string().trim().min(1).describe("Follow-up instruction for the same worker.")
        })
      }
    )

    const cancelWorker = tool(
      async (input: {
        worker_id?: string
        reason?: string
        consumed_notification_ids?: string[]
      }) => {
        const workers = await options.workerTools!.cancelWorker({
          workerId: input.worker_id,
          reason: input.reason
        })
        options.onNotificationsConsumed?.(input.consumed_notification_ids ?? [])
        console.log("[CoordinatorMode] cancel_worker", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: input.worker_id ?? null,
          workers: workers.length
        })
        return JSON.stringify({ workers: toCoordinatorWorkerToolSnapshots(workers) }, null, 2)
      },
      {
        name: "cancel_worker",
        description:
          "Cancel one running coordinator worker, or all workers for this coordinator thread when worker_id is omitted.",
        schema: z.object({
          worker_id: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Worker id to cancel. Omit to cancel all running workers for this coordinator thread."
            ),
          consumed_notification_ids: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "notification_id values from the current turn's task notifications that this cancellation is responding to. This supports notification-to-skill routing and traceability; successful turns acknowledge delivered notifications as a batch."
            ),
          reason: z.string().trim().min(1).optional().describe("Cancellation reason.")
        })
      }
    )

    tools.push(startWorker, continueWorker, cancelWorker)
  }

  return tools
}
