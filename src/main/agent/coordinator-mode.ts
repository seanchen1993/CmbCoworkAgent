import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { SubAgent } from "deepagents"
import { tool } from "langchain"
import { z } from "zod"
import type {
  CoordinatorWorkerRole,
  CoordinatorWorkerResultRead,
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
    ownedFiles?: string[]
    description: string
    prompt: string
    selectedSkill?: CoordinatorSelectedSkill
  }) => Promise<CoordinatorWorkerSnapshot>
  continueWorker: (input: {
    workerId: string
    workload?: CoordinatorWorkerWorkload
    ownedFiles?: string[]
    prompt: string
    selectedSkill?: CoordinatorSelectedSkill
  }) => Promise<CoordinatorWorkerSnapshot>
  readWorkerState: (input: {
    workerId?: string
    block?: boolean
    timeoutMs?: number
    pollIntervalMs?: number
  }) => Promise<CoordinatorWorkerSnapshot[]>
  readWorkerResult: (input: {
    workerId: string
    includeTranscript?: boolean
    maxChars?: number
  }) => Promise<CoordinatorWorkerResultRead>
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

function parseTrailingSkillUseBlock(
  message: string
): {
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

export function extractCoordinatorSelectedSkill(
  message: string
): CoordinatorSelectedSkill | null {
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
  if (!notificationIds || notificationIds.length === 0 || !notificationSelectedSkills) return undefined
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
- For write workers, declare owned_files when known for targeted edits that can hand verification to a separate verifier; do not run overlapping write workers over the same files. If you mean a directory that does not exist yet, end the path with / so it is treated as a directory scope rather than a single file.
- If the same write worker must run build/test/browser checks itself, omit owned_files and treat it as an unrestricted workspace writer instead of a scoped editor.
- Delegate implementation work to implementer.
- Delegate final acceptance to verifier.
- Do not treat implementer self-checks as final verification.
- Before launching verifier, synthesize the implementer result, changed/output files, answer draft, and approach taken into a self-contained verifier prompt.
- For deliverable work, do not report completion until verifier has returned PASS with concrete evidence, or report BLOCKED with a concrete blocker.
- After a task notification arrives, read the worker result only if the summary is insufficient, then decide the next step.
- Do not poll workers after starting them; briefly tell the user what was launched and end the turn.
- If verifier returns FAIL, send a focused follow-up task to implementer. Prefer continue_worker for the same implementer; it can interrupt a running worker and reuse that worker checkpoint.`
}

export function buildCoordinatorSystemPrompt(options: CoordinatorPromptOptions): string {
  const coordinatorDir = getCoordinatorDir(options.threadId)
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
- read_worker_state: fallback status/output reader. Worker notifications are the primary path.
- read_worker_result: read the full bounded worker result file when a notification summary is insufficient.
- mark_notifications_handled: explicitly mark current-turn notification_id values as fully processed when no worker action will consume them.
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
- Declare owned_files for write workers whenever you know the target files and the worker only needs targeted edits plus a verifier handoff. If owned_files is declared, direct write_file/edit_file access is limited to those paths and shell execution, browser_playwright, and deferred execution are disabled to avoid bypassing the file guard. If you mean a directory that does not exist yet, end the path with / so it is treated as a directory scope rather than a single file. If the same write worker must run build/test/browser checks itself, omit owned_files and treat it as a whole-workspace writer instead. If owned_files is omitted for a write worker, it is treated as owning the whole workspace and will conflict with every other write worker.
- Use a lightweight worker for simple file reads or commands because the coordinator main thread only has orchestration tools.
- After launching workers, briefly tell the user what you launched and end the turn. Do not poll for completion.

## 3. Worker Notifications

Worker results arrive later as internal <task-notification> messages. They are not user requests.

- Use the task-id as the worker_id for continue_worker.
- Each current-turn notification is labeled with a notification_id in the internal coordinator context.
- If a worker action directly responds to one or more current-turn notifications, include those notification_id values in consumed_notification_ids on start_worker, continue_worker, or cancel_worker.
- If you fully process a notification without launching, continuing, or cancelling a worker, call mark_notifications_handled(notification_ids) before ending the turn so unhandled notifications can be retried safely.
- If a notification includes output-file/result_path such as ${coordinatorDir}/reports/workers/<worker_id>.json and the summary is insufficient, use read_worker_result(worker_id) to inspect the bounded full result.
- Do not call read_worker_state repeatedly after start_worker. Use it only for explicit user status checks, recovery, or final safety checks when notification context is missing.
- If a worker failed or verification found issues, prefer continue_worker when the same worker's context is useful; spawn a fresh worker when fresh eyes are better.

## 4. Workflow

Most non-trivial development work follows this shape:
1. Research with workers when you need codebase context. Launch independent read-only workers in parallel when useful.
2. Synthesize findings yourself into a concrete implementation prompt with specific files, requirements, and done criteria.
3. Run implementer workers for targeted changes. Keep write-heavy workers one at a time per overlapping file set.
4. Run a verifier worker with a fresh, skeptical prompt for non-trivial deliverables.
5. Integrate verifier feedback. Continue the implementer for focused fixes when its context helps, then verify again.

Verification gates:
- Do not skip verifier for file changes, documentation creation, code changes, build/test analysis, or app behavior changes.
- Do not report success from implementer output alone. Implementer output is a handoff, not acceptance.
- Do not launch verifier without a concrete implementer result. If the implementer output is too vague, continue implementer and ask for changed/output files, commands run, risks, and a handoff.
- Do not report success from verifier text alone unless it includes concrete evidence: commands/tests/browser checks, checked files, and findings.
- Do not leave running workers behind. Before reporting final completion, rely on worker notifications and the right-panel worker state; use read_worker_state only as a recovery/debug fallback if notification context is missing.

## 5. Writing Worker Prompts

Workers cannot see your conversation. Every worker prompt must be self-contained.

- Include the original user goal, relevant file paths, constraints, and expected output.
- Add a purpose statement so the worker can calibrate depth.
- For research: say "do not modify files".
- For implementation: say what to change, how to verify, and what report/handoff to write.
- For verification: pass the original request, changed/output files or answer_draft, and require evidence.
- Never write lazy prompts like "based on your findings". Read findings, synthesize them, then give a concrete prompt.

Coordinator constraints:
- Running workers can be updated with continue_worker. This interrupts the current run and continues the same worker thread/checkpoint with the new instruction.
- Treat write workers as exclusive unless they declare disjoint owned_files. Read-only workers can run in parallel.
- Do not edit application files directly.
- Do not run shell/build/browser tools directly from the coordinator. Workers have those tools.
- If the user selected a skill, include "Use the /<skill name> skill" in the worker prompt instead of trying to use that skill directly.
- Keep state concise. Worker results are persisted under ${coordinatorDir}/reports/workers/ by the worker manager when available; summarize only what matters in chat.
- Be practical: for small requests, keep acceptance criteria small; for app changes, insist on a real build/test/runtime check, but do not expect scoped owned_files writers to claim checks they do not have tool access to run.

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
- If you are a scoped owned_files writer, shell/runtime/browser tools may be unavailable. In that case, do not claim checks you could not run; instead leave a precise verification handoff for a verifier or unrestricted writer.
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
    const runningReadWorkerStateKeys = new Set<string>()

    const startWorker = tool(
      async (input: {
        subagent_type: "worker"
        role?: CoordinatorWorkerRole
        workload?: CoordinatorWorkerWorkload
        owned_files?: string[]
        consumed_notification_ids?: string[]
        description: string
        prompt: string
      }) => {
        const role =
          input.role ?? (input.workload === "verify" ? "verifier" : "implementer")
        const selectedSkill = resolveWorkerPromptSelectedSkill(
          input.consumed_notification_ids,
          options.notificationSelectedSkills,
          options.selectedSkill,
          options.explicitSelectedSkill
        )
        const snapshot = await options.workerTools!.startWorker({
          role,
          workload: input.workload,
          ownedFiles: input.owned_files,
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
              "Worker started asynchronously. Do not poll for completion. Briefly tell the user what was launched and end this turn; a task notification will wake the coordinator when the worker finishes.",
            worker: snapshot
          },
          null,
          2
        )
      },
      {
        name: "start_worker",
        description:
          "Start an asynchronous coordinator worker. Always use subagent_type=\"worker\"; use role only as an optional coordinator-facing classification.",
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
          owned_files: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "Files this write worker owns. Declare when known so disjoint write workers can run safely. Use a trailing / if you mean a directory that does not exist yet; otherwise a non-existent path is treated as a single file. Omit only when the worker may touch the whole workspace; omitted owned_files conflicts with every other write worker."
            ),
          consumed_notification_ids: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "notification_id values from the current turn's task notifications that this worker launch is responding to."
            ),
          description: z.string().trim().min(1).describe("Short user-visible task description."),
          prompt: z
            .string()
            .trim()
            .min(1)
            .describe(
              "Full worker instruction, including acceptance criteria, expected outputs, and verification hints."
            )
        })
      }
    )

    const continueWorker = tool(
      async (input: {
        worker_id: string
        workload?: CoordinatorWorkerWorkload
        owned_files?: string[]
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
          ownedFiles: input.owned_files,
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
            worker: snapshot
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
            .describe('Optional updated workload for this run. Only verifier workers may use "verify"; do not use "write" for verifier workers.'),
          owned_files: z
            .array(z.string().trim().min(1))
            .optional()
            .describe("Optional updated owned files for write-safety checks."),
          consumed_notification_ids: z
            .array(z.string().trim().min(1))
            .optional()
            .describe(
              "notification_id values from the current turn's task notifications that this worker continuation is responding to."
            ),
          prompt: z.string().trim().min(1).describe("Follow-up instruction for the same worker.")
        })
      }
    )

    const readWorkerState = tool(
      async (input: {
        worker_id?: string
        block?: boolean
        timeout_ms?: number
        poll_interval_ms?: number
      }) => {
        const queryKey = input.worker_id ?? "__all__"
        const requestedBlock = input.block ?? Boolean(input.worker_id)
        const suppressRepeatedWaitRequest = requestedBlock && runningReadWorkerStateKeys.has(queryKey)
        const workers = await options.workerTools!.readWorkerState({
          workerId: input.worker_id,
          block: suppressRepeatedWaitRequest ? false : requestedBlock,
          timeoutMs: input.timeout_ms,
          pollIntervalMs: input.poll_interval_ms
        })
        const running = workers.filter((worker) => worker.status === "running").length
        const completed = workers.filter((worker) => worker.status === "completed").length
        const failed = workers.filter((worker) => worker.status === "failed").length
        const cancelled = workers.filter((worker) => worker.status === "cancelled").length
        const retrievalStatus =
          input.worker_id && workers.length === 0
            ? "not_found"
            : running > 0
              ? "running"
              : "complete"
        if (running > 0) {
          runningReadWorkerStateKeys.add(queryKey)
        } else {
          runningReadWorkerStateKeys.delete(queryKey)
        }
        const suppressRepeatedWait = suppressRepeatedWaitRequest && running > 0
        console.log("[CoordinatorMode] read_worker_state", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: input.worker_id ?? null,
          block: suppressRepeatedWaitRequest ? false : requestedBlock,
          pollingSuppressed: suppressRepeatedWait,
          workers: workers.length
        })
        const message =
          retrievalStatus === "not_found"
            ? `Worker ${input.worker_id} was not found for this coordinator thread. Use the full worker_id from start_worker, task notification, or list all workers with worker_id omitted.`
            : suppressRepeatedWait
              ? "Repeated blocking read_worker_state was suppressed because this worker query already returned running in this coordinator turn. Do not call read_worker_state again for the same worker now; briefly tell the user the worker is still running and wait for the task notification or a later turn."
              : retrievalStatus === "running"
                ? "Worker is still running. Do not loop read_worker_state for this same worker query; wait for the task notification or end this turn with a short progress note."
                : undefined
        return JSON.stringify(
          {
            workers,
            retrieval_status: retrievalStatus,
            polling_suppressed: suppressRepeatedWait,
            message,
            running,
            completed,
            failed,
            cancelled
          },
          null,
          2
        )
      },
      {
        name: "read_worker_state",
        description:
          "Fallback status/output reader for async coordinator workers, similar to Claude Code TaskOutput. Do not use for normal waiting after start_worker; task notifications are the primary path.",
        schema: z.object({
          worker_id: z
            .string()
            .trim()
            .min(1)
            .optional()
            .describe(
              "Specific worker id to inspect. Omit to list all workers for this coordinator thread."
            ),
          block: z
            .boolean()
            .optional()
            .describe(
              "Whether to wait for running workers. Defaults to true when worker_id is provided, and false when listing all workers."
            ),
          timeout_ms: z
            .number()
            .int()
            .min(1_000)
            .max(120_000)
            .optional()
            .describe("Maximum wait time when block=true. Defaults to 30000; minimum 1000."),
          poll_interval_ms: z
            .number()
            .int()
            .min(50)
            .max(10_000)
            .optional()
            .describe("Internal wait poll interval. Defaults to 1000.")
        })
      }
    )

    const readWorkerResult = tool(
      async (input: {
        worker_id: string
        include_transcript?: boolean
        max_chars?: number
      }) => {
        const result = await options.workerTools!.readWorkerResult({
          workerId: input.worker_id,
          includeTranscript: input.include_transcript,
          maxChars: input.max_chars
        })
        console.log("[CoordinatorMode] read_worker_result", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: input.worker_id,
          includeTranscript: input.include_transcript ?? false,
          resultChars: result.result_chars ?? 0,
          transcriptChars: result.transcript_chars ?? 0
        })
        return JSON.stringify(result, null, 2)
      },
      {
        name: "read_worker_result",
        description:
          "Read a bounded worker result file when a task notification or read_worker_state summary is insufficient. Use this instead of asking another worker to restate an existing result.",
        schema: z.object({
          worker_id: z.string().trim().min(1).describe("Worker id whose result file should be read."),
          include_transcript: z
            .boolean()
            .optional()
            .describe("Also include the worker transcript JSONL when needed. Defaults to false."),
          max_chars: z
            .number()
            .int()
            .min(1_000)
            .max(80_000)
            .optional()
            .describe("Maximum characters to return per file. Defaults to 20000.")
        })
      }
    )

    const markNotificationsHandled = tool(
      async (input: { notification_ids: string[] }) => {
        options.onNotificationsConsumed?.(input.notification_ids)
        return JSON.stringify(
          {
            message:
              "Marked the specified current-turn notifications as handled. Use this when you fully processed a notification without starting, continuing, or cancelling a worker.",
            notification_ids: input.notification_ids
          },
          null,
          2
        )
      },
      {
        name: "mark_notifications_handled",
        description:
          "Mark current-turn task notifications as fully handled when no worker action will consume them. Use this after you have integrated a worker result directly into your response or conclusion.",
        schema: z.object({
          notification_ids: z
            .array(z.string().trim().min(1))
            .min(1)
            .describe(
              "notification_id values from the current turn's task notifications that have been fully handled without a worker action."
            )
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
        return JSON.stringify({ workers }, null, 2)
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
              "notification_id values from the current turn's task notifications that this cancellation is responding to."
            ),
          reason: z.string().trim().min(1).optional().describe("Cancellation reason.")
        })
      }
    )

    tools.push(
      startWorker,
      continueWorker,
      readWorkerState,
      readWorkerResult,
      markNotificationsHandled,
      cancelWorker
    )
  }

  return tools
}
