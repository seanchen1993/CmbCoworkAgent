import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { SubAgent } from "deepagents"
import { tool } from "langchain"
import { z } from "zod"
import type {
  CoordinatorWorkerContinuationIntent,
  CoordinatorWorkerRole,
  CoordinatorWorkerSnapshot,
  CoordinatorWorkerWorkload
} from "./coordinator-worker-manager"

export type AgentMode = "normal" | "coordinator" | "workflow"

const COORDINATOR_BASE_DIR = ".cmbdevclaw/coordinator"
const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/
const WORKER_THREAD_DELIMITER = "__worker__"
const SKILL_USE_TAG_NAME = "CMBDEVCLAW-SKILL-USE-V1"
const SELECTED_SKILL_PROMPT_MARKER = "[[CMB_COORDINATOR_SELECTED_SKILL_V1]]"
const SELECTED_SKILL_PROMPT_HEADER = "Coordinator-enforced selected skill:"
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
  projectModeAdapterInstructions?: string | null
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
  turnPlanning?: CoordinatorWorkerTurnPlanningState
  disableTurnPlanningGuards?: boolean
}

export interface CoordinatorWorkerTurnPlanningState {
  starts: number
  readOnlyStarts: number
  writeOrVerifyStarts: number
  continues: number
  cancels: number
}

export function createCoordinatorWorkerTurnPlanningState(): CoordinatorWorkerTurnPlanningState {
  return {
    starts: 0,
    readOnlyStarts: 0,
    writeOrVerifyStarts: 0,
    continues: 0,
    cancels: 0
  }
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
    continuationIntent?: CoordinatorWorkerContinuationIntent
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
  const promptWithoutInjectedBlock = stripLeadingSelectedSkillPromptBlock(trimmedPrompt)
  const selectedSkillBlock = buildSelectedSkillPromptBlock(selectedSkill)
  return [selectedSkillBlock, promptWithoutInjectedBlock].filter(Boolean).join("\n\n")
}

function buildSelectedSkillPromptBlock(selectedSkill: CoordinatorSelectedSkill): string {
  return [
    SELECTED_SKILL_PROMPT_MARKER,
    SELECTED_SKILL_PROMPT_HEADER,
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
}

function stripLeadingSelectedSkillPromptBlock(prompt: string): string {
  if (!prompt.startsWith(SELECTED_SKILL_PROMPT_MARKER)) {
    return prompt
  }

  const separatorIndex = prompt.indexOf("\n\n")
  if (separatorIndex < 0) {
    return prompt
  }

  const candidateBlock = prompt.slice(0, separatorIndex)
  if (!isSelectedSkillPromptBlock(candidateBlock)) {
    return prompt
  }

  const remainder = prompt.slice(separatorIndex + 2)
  return remainder.trimStart()
}

function isSelectedSkillPromptBlock(block: string): boolean {
  const lines = block.split("\n")
  if (lines.length < 5) return false
  if (lines[0] !== SELECTED_SKILL_PROMPT_MARKER) return false
  if (lines[1] !== SELECTED_SKILL_PROMPT_HEADER) return false

  return (
    lines.some((line) => line.startsWith("- The user explicitly selected the /")) &&
    lines.some((line) => line.startsWith("- First use read_file to read ")) &&
    lines.includes("- Do not skip, summarize, or generalize the skill steps.") &&
    lines.includes("- If the skill cannot be loaded, report BLOCKED with the reason.")
  )
}

export function getAgentModeFromMetadata(metadata: Record<string, unknown>): AgentMode {
  if (metadata.agentMode === "normal") {
    return "normal"
  }
  if (metadata.agentMode === "workflow") {
    return "workflow"
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
- Default to one worker. Launch 2-3 read-only workers in parallel only when the research angles are clearly independent and each prompt owns a different question.
- Treat write workers as whole-workspace implementers, matching Claude Code coordinator semantics. Avoid running overlapping write workers at the same time; use one implementer for related edits, then a fresh verifier for independent acceptance.
- Do not launch implementation and verification in the same turn. Implementer finishes first, then verifier starts from the implementer task-notification.
- Delegate implementation work to implementer.
- Delegate final acceptance to verifier.
- Do not treat implementer self-checks as final verification.
- Before launching verifier, synthesize the implementer result, changed/output files, answer draft, and approach taken into a self-contained verifier prompt.
- For deliverable work, do not report completion until verifier has returned PASS with concrete evidence, or report BLOCKED with a concrete blocker.
- After a task notification arrives, use its pushed <result> handoff to decide the next step. If the result is truncated or missing key evidence, continue that same worker and ask for a concise handoff; do not read archived output files from the coordinator.
- Do not poll workers after starting them; briefly tell the user what was launched and end the turn.
- A coordinator turn is one assistant response after a user message or worker notification. Once you call a worker tool in that response, the next correct step is usually to stop using worker tools and let the next turn carry the result.
- Never fabricate or predict worker results. If the user asks before a notification arrives, report only that the worker is still running and what it was asked to do.
- If verifier returns FAIL, send a focused follow-up task to implementer. Prefer continue_worker for the same implementer after its task-notification, or use running continuation only to redirect active work.
- Use cancel_worker only to stop work that should not continue. Cancelled workers are final; if you want to redirect a worker and preserve its context, use continue_worker directly.
- A successful start_worker result means "worker launched", not "worker finished". Never follow a start_worker result with continue_worker to inspect status or results; wait for the worker task-notification.
- A worker action is a commitment for this coordinator turn. After a successful start_worker / continue_worker / cancel_worker, stop using worker tools and end the turn, except for an intentional 2-3 worker read-only research fan-out.
- If a worker planning guard rejects a tool call, do not recover by trying a different worker tool in the same turn. Tell the user the current state briefly and wait for the next task-notification or user message.
- Scratchpad directory for durable cross-worker notes: ${scratchpadDir}. Use it only when long-running work needs a concise shared artifact. It is an ordinary workspace artifact path; normal tool availability, approval, hook, and access limits still apply.`
}

export function buildCoordinatorSystemPrompt(options: CoordinatorPromptOptions): string {
  const coordinatorDir = getCoordinatorDir(options.threadId)
  const scratchpadDir = getCoordinatorScratchpadDir(options.threadId)
  const projectModeAdapterInstructions = options.projectModeAdapterInstructions?.trim()
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

Worker action budget per turn:
- A "turn" means this single coordinator response after the latest user message or <task-notification>. Tool calls in that response are part of the same turn.
- Prefer exactly one worker action unless there is a clear reason.
- You may start up to 3 read_only workers in one turn only for independent research angles.
- Start at most one write or verify worker in a turn.
- Do not mix start_worker with continue_worker or cancel_worker in the same turn.
- After starting any write or verify worker, briefly tell the user what was launched and end the turn.
- A successful start_worker tool result only confirms launch. It is not a worker result, completion signal, or invitation to continue_worker.
- If a worker tool is rejected by a planning guard, do not keep trying alternative worker-tool combinations in the same turn. Explain the current state briefly and wait for the next task-notification or user input.
- If you call continue_worker successfully, end the turn after a short user-facing status. Do not then start a replacement worker in the same turn, even if you suspect the previous worker was interrupted.
- If you call cancel_worker successfully, end the turn. Do not start the replacement until the next user message or task-notification turn.
- If the user asks "how is it going?" while workers are still running, do not call continue_worker. Answer from current worker context: what is running, what it was asked to do, and that results arrive by task notification.

Tool choice:
- Use start_worker for fresh independent work: first research, a focused implementation after synthesis, or a fresh verifier.
- Use continue_worker after a task-notification when the same worker's context helps: fix its own failed change, extend its own work, or request a concise handoff.
- Use continue_worker with continuation_intent="redirect_running_worker" only when a still-running worker needs replacement instructions because requirements changed or the approach is wrong.
- Use cancel_worker only when active work should stop and should not continue. Prefer continue_worker for redirecting a worker you still want to preserve.
- If you are unsure whether a worker is done, do not call tools. Wait for its task-notification and tell the user it is still running.

When calling start_worker:
- Always use subagent_type="worker", matching Claude Code coordinator semantics.
- Use role="verifier" only for independent verification. Use role="implementer" or omit role for implementation, research that feeds implementation, and file creation.
- Always set workload explicitly so long-running worker state is auditable after restore.
- Use workload="read_only" for research workers that only need to inspect files.
- Use workload="verify" for independent verification that may run tests/build/lint. Use workload="write" for file-changing workers. If workload is omitted for an implementer, the compatibility fallback is write, matching Claude Code's general worker capability model; do not rely on this fallback.
- Only verifier workers may use workload="verify". Verification must stay independent, so do not repurpose an implementer as a verifier by changing only the workload.
- Never combine role="verifier" with workload="write"; verification must stay independent.
- read_only workers do not receive direct write_file/edit_file tools, but they DO keep execute + task_output — execute is gated to provably read-only commands (ls, git log/diff/status, find, cat, head, tail; plus build-tool read-only inspection subcommands like npm ls, go list, cargo tree, mvn dependency:tree, gradle dependencies, dotnet list, and any tool's --version/--help; mutating/unknown commands and installs/builds are rejected). So a read_only worker can inspect dependencies — do NOT escalate to a verify/write worker just to read a dependency tree or run an inspection subcommand.
- verify workers can run validation commands, but do not receive direct write_file/edit_file tools and must not intentionally modify workspace files. If a verifier needs a throwaway script or harness, it may write only to /tmp or $TMPDIR and should clean it up.
- verify workers do not run concurrently with write workers; wait for write task-notifications before launching final verification.
- write workers receive normal workspace write access subject to the app's usual approval, hook, and policy checks. Do not split overlapping file-changing work across multiple write workers; continue the same implementer when context helps.
- Launch independent read-only workers in parallel only when they cover different research angles. Do not launch many workers for one undifferentiated task.
- Use a lightweight worker for simple file reads or commands because the coordinator main thread only has orchestration tools.
- After launching workers, briefly tell the user what you launched and end the turn. Do not poll for completion.
- Never call continue_worker immediately after start_worker just because the start_worker call returned OK. OK means launched asynchronously; the worker result arrives later as <task-notification>.
- Do not use one worker to check on another worker. Workers notify you when they finish; you synthesize and route follow-up work.
- Never fabricate or predict worker results. If the user asks for progress before a task notification arrives, give status only.

Turn examples:
- Good research turn: call start_worker for 1-3 independent read_only investigations, tell the user what was launched, then stop. Do not continue or cancel in that same response.
- Good notification turn: read one task-notification, synthesize its facts, optionally call exactly one continue_worker or one start_worker for the next phase, tell the user what is now in progress, then stop.
- Good redirect turn: if requirements changed while a worker is running, call continue_worker with continuation_intent="redirect_running_worker", tell the user you redirected it, then stop.
- Bad turn: start_worker returns OK, then continue_worker asks for status/results. OK only means launched.
- Bad turn: continue_worker returns OK or a planning guard error, then start_worker tries to "restart" the work. Stop and wait instead.
- Bad turn: cancel_worker stops a worker and start_worker immediately launches a replacement. Split that into two turns.

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
- Do not use continue_worker to check whether a running worker is done or to inspect partial results. Running workers notify you when finished. Only continue a running worker when you need to redirect or replace its active instructions, and set continuation_intent="redirect_running_worker".
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
- Continue a worker when its existing context overlaps strongly with the next step: focused fixes, extending its own change, correcting its own failed checks, or asking it for a concise handoff after a vague/truncated notification.
- Spawn a fresh worker when fresh eyes matter: final verification, retrying after a wrong approach, broad research from a clean slate, or moving to a mostly unrelated area.
- Never tell a worker "based on your findings" without restating the concrete files, facts, and acceptance criteria you synthesized.
- If the choice is ambiguous, prefer the safer turn boundary: summarize what you know to the user and wait for the next task-notification or user input instead of chaining worker tools.

Decision table:
| Situation | Tool | Parallel? |
|---|---|---|
| Need broad codebase understanding | start_worker read_only | Yes, 2-3 independent angles max |
| Need simple targeted file lookup | start_worker read_only | Usually one worker |
| Need implementation after research | start_worker or continue_worker write | One write worker; do not parallelize overlapping edits |
| Existing worker found/fixed something and needs a focused correction | continue_worker | One continuation |
| Worker is still running but requirements changed | continue_worker with continuation_intent="redirect_running_worker" | One redirect |
| Final verification of another worker's change | start_worker role="verifier" workload="verify" | One fresh verifier after implementer notification |
| Worker went in the wrong direction and should stop | cancel_worker | Do not also start replacements in the same turn |
| User asks progress while worker is running | no worker tool | Status only; wait for task-notification |
| Planning guard rejects a worker tool | no more worker tools | Explain briefly; wait for next turn |

Bad worker-tool patterns:
- start_worker -> continue_worker in the same turn to ask "are you done?" or "what happened?"
- start_worker write -> start_worker verifier before the write worker has sent a task-notification.
- cancel_worker -> start_worker replacement in the same turn; stop first, then wait for the next turn.
- continue_worker -> start_worker replacement in the same turn after deciding the continued worker is interrupted. Wait for the continuation task-notification first.
- Any worker-tool error -> another worker tool as a recovery attempt in the same turn.
- Multiple read_only workers with the same prompt or same file/topic.

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
- Running continue_worker requires continuation_intent="redirect_running_worker"; never use it for status/result polling.
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

${projectModeAdapterInstructions ? `## Project Mode Adapter Instructions\n\n${projectModeAdapterInstructions}\n` : ""}

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
    type PlanningReservation = () => void
    const turnPlanning = options.turnPlanning ?? createCoordinatorWorkerTurnPlanningState()
    const planningGuardsEnabled = options.disableTurnPlanningGuards !== true
    const reserveStartAllowed = (workload: CoordinatorWorkerWorkload): PlanningReservation => {
      if (!planningGuardsEnabled) return () => {}
      if (turnPlanning.continues > 0 || turnPlanning.cancels > 0) {
        throw new Error(
          "Do not mix start_worker with continue_worker or cancel_worker in the same coordinator turn. Do not try another worker tool as recovery. Finish this turn and wait for the next task-notification or user message."
        )
      }
      if (workload === "read_only") {
        if (turnPlanning.writeOrVerifyStarts > 0) {
          throw new Error(
            "Do not mix read-only research workers with write/verify workers in the same coordinator turn. Choose one phase and end the turn."
          )
        }
        if (turnPlanning.readOnlyStarts >= 3) {
          throw new Error(
            "Too many read-only workers in one coordinator turn. Launch at most 3 independent research workers, then end the turn."
          )
        }
        turnPlanning.readOnlyStarts += 1
      } else {
        if (turnPlanning.starts > 0) {
          throw new Error(
            "Start at most one write or verify worker in a coordinator turn, and do not mix it with other worker starts."
          )
        }
        turnPlanning.writeOrVerifyStarts += 1
      }
      turnPlanning.starts += 1
      return () => {
        turnPlanning.starts = Math.max(0, turnPlanning.starts - 1)
        if (workload === "read_only") {
          turnPlanning.readOnlyStarts = Math.max(0, turnPlanning.readOnlyStarts - 1)
        } else {
          turnPlanning.writeOrVerifyStarts = Math.max(0, turnPlanning.writeOrVerifyStarts - 1)
        }
      }
    }
    const reserveContinueAllowed = (): PlanningReservation => {
      if (!planningGuardsEnabled) return () => {}
      if (turnPlanning.starts > 0 || turnPlanning.cancels > 0) {
        throw new Error(
          "Do not mix continue_worker with start_worker or cancel_worker in the same coordinator turn. Do not try another worker tool as recovery. Choose the single next action and end the turn."
        )
      }
      if (turnPlanning.continues >= 1) {
        throw new Error(
          "Do not call continue_worker more than once in the same coordinator turn. Continue only the worker whose context is needed, then end the turn."
        )
      }
      turnPlanning.continues += 1
      return () => {
        turnPlanning.continues = Math.max(0, turnPlanning.continues - 1)
      }
    }
    const reserveCancelAllowed = (): PlanningReservation => {
      if (!planningGuardsEnabled) return () => {}
      if (turnPlanning.starts > 0 || turnPlanning.continues > 0) {
        throw new Error(
          "Do not mix cancel_worker with start_worker or continue_worker in the same coordinator turn. Do not try another worker tool as recovery. Stop work first, then wait for the next turn before launching replacements."
        )
      }
      if (turnPlanning.cancels >= 1) {
        throw new Error(
          "Do not call cancel_worker more than once in the same coordinator turn. Cancel the single worker or all workers, then end the turn."
        )
      }
      turnPlanning.cancels += 1
      return () => {
        turnPlanning.cancels = Math.max(0, turnPlanning.cancels - 1)
      }
    }

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
        const effectiveWorkload = input.workload ?? (role === "verifier" ? "verify" : "write")
        const releasePlanningReservation = reserveStartAllowed(effectiveWorkload)
        const selectedSkill = resolveWorkerPromptSelectedSkill(
          input.consumed_notification_ids,
          options.notificationSelectedSkills,
          options.selectedSkill,
          options.explicitSelectedSkill
        )
        let snapshot: CoordinatorWorkerSnapshot
        try {
          snapshot = await options.workerTools!.startWorker({
            role,
            workload: input.workload,
            description: input.description,
            prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, selectedSkill),
            selectedSkill
          })
        } catch (error) {
          releasePlanningReservation()
          throw error
        }
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
              "Worker started asynchronously. Do not poll, duplicate this worker's files/topics, or predict results. Do not continue or cancel workers in this turn. Briefly tell the user what was launched and end this turn; a task notification will be delivered when the worker finishes.",
            worker: toCoordinatorWorkerToolSnapshot(snapshot)
          },
          null,
          2
        )
      },
      {
        name: "start_worker",
        description:
          'Start an asynchronous coordinator worker. Always use subagent_type="worker"; use role only as an optional coordinator-facing classification. A successful result means launched, not completed; end the turn unless this is an intentional read_only research fan-out.',
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
              'Always set this explicitly for auditable long-running work. Use "read_only" for research, "verify" for independent checks that may run tests/build/lint, and "write" for implementers that may edit files. Only role="verifier" may use workload="verify". Do not use "write" with role="verifier". Compatibility fallback: write for implementer and verify for verifier.'
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
              "Full self-contained worker instruction, including the task source, acceptance criteria, expected outputs, and verification hints. If responding to worker notifications, include source task-id/notification_id and relevant result facts. Do not duplicate another running worker's files/topic."
            )
        })
      }
    )

    const continueWorker = tool(
      async (input: {
        worker_id: string
        continuation_intent?: CoordinatorWorkerContinuationIntent
        workload?: CoordinatorWorkerWorkload
        consumed_notification_ids?: string[]
        prompt: string
      }) => {
        const releasePlanningReservation = reserveContinueAllowed()
        const selectedSkill = resolveWorkerPromptSelectedSkill(
          input.consumed_notification_ids,
          options.notificationSelectedSkills,
          options.selectedSkill,
          options.explicitSelectedSkill
        )
        let snapshot: CoordinatorWorkerSnapshot
        try {
          snapshot = await options.workerTools!.continueWorker({
            workerId: input.worker_id,
            continuationIntent: input.continuation_intent,
            workload: input.workload,
            prompt: injectSelectedSkillIntoWorkerPrompt(input.prompt, selectedSkill),
            selectedSkill
          })
        } catch (error) {
          releasePlanningReservation()
          throw error
        }
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
              "Worker continued asynchronously with the same worker context. Do not start or cancel workers as recovery in this turn. Briefly tell the user what was redirected/continued and end this turn; wait for the task notification.",
            worker: toCoordinatorWorkerToolSnapshot(snapshot)
          },
          null,
          2
        )
      },
      {
        name: "continue_worker",
        description:
          "Continue an existing coordinator worker with the same worker context/checkpoint after its task-notification, or redirect a still-running worker when requirements changed. Do not call this immediately after start_worker to check status/results.",
        schema: z.object({
          worker_id: z.string().trim().min(1).describe("Worker id returned by start_worker."),
          continuation_intent: z
            .enum(["follow_up_after_notification", "redirect_running_worker"])
            .optional()
            .describe(
              'Use "follow_up_after_notification" after a worker task-notification. Use "redirect_running_worker" only when the worker is still running and you need to replace or redirect its active instructions. Never use continue_worker to poll status or inspect partial results.'
            ),
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
          prompt: z
            .string()
            .trim()
            .min(1)
            .describe(
              "Follow-up instruction for the same worker. Restate the concrete task-notification facts or the replacement instruction; never ask only for status/progress."
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
        const releasePlanningReservation = reserveCancelAllowed()
        let workers: CoordinatorWorkerSnapshot[]
        try {
          workers = await options.workerTools!.cancelWorker({
            workerId: input.worker_id,
            reason: input.reason
          })
        } catch (error) {
          releasePlanningReservation()
          throw error
        }
        options.onNotificationsConsumed?.(input.consumed_notification_ids ?? [])
        console.log("[CoordinatorMode] cancel_worker", {
          workspacePath: options.workspacePath,
          threadId: options.threadId,
          workerId: input.worker_id ?? null,
          workers: workers.length
        })
        return JSON.stringify(
          {
            message:
              "Worker cancellation was requested. Do not start replacement workers in this turn. Briefly tell the user what was stopped and wait for the next task-notification or user message.",
            workers: toCoordinatorWorkerToolSnapshots(workers)
          },
          null,
          2
        )
      },
      {
        name: "cancel_worker",
        description:
          "Cancel one running coordinator worker, or all workers for this coordinator thread when worker_id is omitted. Use only for work that should stop and should not continue; after canceling, end the turn.",
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
