import { randomUUID } from "crypto"
import { readFileSync, realpathSync, statSync } from "fs"
import { basename, dirname, resolve } from "path"
import { tool } from "langchain"
import { z } from "zod"
import type { DynamicStructuredTool } from "@langchain/core/tools"
import type { ApprovalStore } from "../approval-store"
import type { ApprovalDecision, ApprovalRequest } from "../../types"
import { isPathInside } from "./paths"
import { WORKFLOW_TOOL_DESCRIPTION } from "./prompts"
import { loadAgentProfiles } from "../agent-registry"
import { workflowRunManager } from "./run-manager"
import {
  clearAllAgentToolStreams,
  generateWorkflowRunId,
  getWorkflowRunsDir,
  isValidWorkflowRunId,
  isWorkflowRunDirDisposed,
  loadWorkflowRunAsync,
  loadWorkflowRunForResumeAsync,
  sha256Hex
} from "./run-store"
import { MAX_WORKFLOW_SCRIPT_BYTES, validateWorkflowScript } from "./script"
import type { WorkflowSubagentDeps } from "./subagent"
import {
  resolveResumeArgsAndJournal,
  WorkflowFatalError,
  WorkflowScriptError,
  type ParsedWorkflowScript,
  type PersistedWorkflowRun
} from "./types"

/**
 * The `workflow` tool exposed to the main agent in Dynamic Workflows mode.
 *
 * Background execution (the Claude Code model): the script is validated
 * synchronously — invalid scripts fail the tool call immediately so the model
 * can fix them — then the run is LAUNCHED and the tool returns at once with
 * the run id. Live progress streams to the workflow panel; the outcome comes
 * back later as an internal <task-notification> turn.
 */

const workflowToolSchema = z.object({
  script: z
    .string()
    .optional()
    .describe(
      "The workflow script (plain JavaScript, no Markdown fences). Must start with `export const meta = { name, description, phases }` as a pure literal. Required unless scriptPath OR resumeFromRunId is set (a resume loads the script from the saved run)."
    ),
  scriptPath: z
    .string()
    .optional()
    .describe(
      "Path of a workflow script file to run instead of `script` (workspace-relative or a previously returned script path). Takes precedence over `script`."
    ),
  args: z
    .unknown()
    .optional()
    .describe(
      "Optional JSON value exposed to the script as the global `args`. Pass arrays/objects as real JSON values, not as a JSON-encoded string."
    ),
  resumeFromRunId: z
    .string()
    .optional()
    .describe(
      "Run ID (wf_…) of a prior run to resume. Pass it ALONE to re-run the SAME saved script: completed agent() calls replay from the journal, matched by content (prompt/opts hash) and NOT position, so reordered/concurrent calls still replay at 100% — the path for a transient failure or crash. NOTE: re-sending a CHANGED script (or changing args) discards the journal and re-runs the whole workflow from scratch (a control-flow edit can make an unchanged call's cached result stale, so an edited script is not partially replayed)."
    ),
  tokenBudget: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Optional output-token budget for the run, checked AT CALL TIME: once spent reaches it the next agent() fails. It is NOT exact under concurrency — agents already in flight when the check passes still finish, so the total can overshoot (budget-driven loops should keep a margin). Set it when the user asks to cap spend."
    )
})

export interface CreateWorkflowToolOptions {
  threadId: string
  workspacePath: string
  modelId?: string
  /** When true (YOLO), the run-before approval gate is skipped. */
  yoloMode?: boolean
  /** Caches an "Approve for this session" decision so re-runs don't re-prompt. */
  approvalStore?: ApprovalStore
  /** Surfaces the approval card on the parent thread's UI. */
  requestApproval?: (req: ApprovalRequest) => Promise<ApprovalDecision>
  subagentDeps: Omit<WorkflowSubagentDeps, "parentThreadId" | "defaultModelId">
  /** Run-level exclusive file-write lock, shared with subagent tool writes (both
   * keyed on the parent threadId) so script writeFile() and agent() writes serialize
   * together. Threaded to the engine via the launch request. (#2) */
  runExclusiveFileWrite?: <T>(fn: () => Promise<T>) => Promise<T>
}

/**
 * Append a live agentType catalogue to the static tool description so the
 * orchestrator sees exactly which roles exist in THIS workspace — built-in
 * explore/review/plan plus any user files under .cmbcoworkagent/agents/. Built
 * per workspace (not a shared constant) so user-added agents show up.
 */
function buildWorkflowToolDescription(workspacePath: string): string {
  let profiles: ReturnType<typeof loadAgentProfiles>
  try {
    profiles = loadAgentProfiles(workspacePath)
  } catch {
    return WORKFLOW_TOOL_DESCRIPTION
  }
  if (profiles.length === 0) return WORKFLOW_TOOL_DESCRIPTION
  const describeAccess = (p: (typeof profiles)[number]): string => {
    const parts: string[] = []
    if (p.disallowedTools.length > 0) parts.push(`no ${p.disallowedTools.join("/")}`)
    parts.push(
      p.shellAccess === "none"
        ? "no shell"
        : p.shellAccess === "read_only"
          ? "read-only shell"
          : "full shell"
    )
    return parts.join(", ")
  }
  const lines = profiles.map((p) => `  - "${p.name}" — ${p.description} [${describeAccess(p)}]`)
  return `${WORKFLOW_TOOL_DESCRIPTION}

agentType catalogue (pass as opts.agentType on an agent() call; omit for the default full-tool agent). A role's listed restrictions (disallowed tools / shell policy) are physically enforced — the blocked tools are removed from that subagent and a read-only shell only runs provably read-only commands — so use restricted roles for recon/verification fan-out and the default (or a write-capable custom) agent for anything that edits files:
${lines.join("\n")}
Add your own roles by dropping <name>.md files under .cmbcoworkagent/agents/ (frontmatter: description, optional model, and EITHER workload: read_only|verify|write OR CC-style tools/disallowedTools lists — CC tool names like Read/Bash/Edit are auto-mapped; the markdown body becomes that role's system prompt).`
}

export function createWorkflowTool(options: CreateWorkflowToolOptions): DynamicStructuredTool {
  const { threadId, workspacePath } = options
  const subagentDeps: WorkflowSubagentDeps = {
    ...options.subagentDeps,
    parentThreadId: threadId,
    defaultModelId: options.modelId
  }

  return tool(
    async (input: z.infer<typeof workflowToolSchema>) => {
      if (workflowRunManager.isActive(threadId)) {
        throw new Error(
          `A dynamic workflow (${workflowRunManager.activeRunId(threadId)}) is already running in this thread. Wait for its task-notification, or the user can cancel it from the workflow panel.`
        )
      }
      // Deleted-thread gate BEFORE the approval prompt (launch() re-checks, but
      // that guard sits after ensureWorkflowApproved): a foreground turn that
      // outlived its thread's deletion would otherwise pop an approval nobody
      // can answer — the thread's UI is gone — and hang this tool call.
      if (isWorkflowRunDirDisposed(workspacePath, threadId)) {
        throw new Error("This thread has been deleted; a workflow can no longer be launched on it.")
      }
      // No workspace-level lock: concurrent workflows over the same workspace on
      // different threads are intentionally allowed (matches Claude Code desktop).
      // Resolve the resume target first so its persisted script can serve as the
      // script source when the model passes only resumeFromRunId (self-contained
      // resume — it need not re-send the script).
      const resume = await resolveResumeRun(workspacePath, threadId, input.resumeFromRunId)
      const source = resolveScriptSource(
        workspacePath,
        threadId,
        input,
        resume.run?.script,
        resume.note
      )
      const parsed = validateWorkflowScript(source.script)
      const runId = resume.run?.runId ?? generateWorkflowRunId()
      // script-sha invalidation: when resuming, if the script changed since the
      // prior run its journal no longer corresponds to this script — replaying old
      // cached results onto changed code paths is unsound. The per-call content
      // hash catches an EDITED call, but a control-flow change that leaves a call's
      // own (prompt, opts) unchanged would otherwise replay a now-stale result.
      // Drop the journal so the run re-executes fresh. A legacy run with no stored
      // sha is treated as changed (can't verify → safe re-run).
      const currentScriptSha = sha256Hex(source.script)
      // Resume arg/journal policy (pure + unit-tested — see resolveResumeArgsAndJournal):
      // reuse the original run's args when none are passed (#1), and drop the
      // journal if the script OR the args changed (#2).
      const { effectiveArgs, effectiveResumeJournal, invalidatedReason } =
        resolveResumeArgsAndJournal(input.args, resume.run ?? null, currentScriptSha)
      const effectiveResumeNote =
        invalidatedReason === "script"
          ? `script changed since ${resume.run?.runId} — its journal was discarded; re-running from scratch`
          : invalidatedReason === "args"
            ? `args changed since ${resume.run?.runId} — its journal was discarded; re-running from scratch`
            : resume.note

      // Run-before approval gate. Reject → don't launch; return a plain message
      // so the model relays it to the user instead of retrying.
      const approved = await ensureWorkflowApproved(
        options,
        workspacePath,
        parsed,
        source.script,
        effectiveArgs,
        input.tokenBudget ?? null
      )
      if (!approved) {
        return JSON.stringify(
          {
            status: "rejected",
            name: parsed.meta.name,
            note: "The user declined to run this workflow. Do not retry; ask the user how they want to proceed."
          },
          null,
          2
        )
      }

      // Journal dropped (script/args changed) but the runId is REUSED: the fresh re-run's agents may
      // have different callHashes, orphaning the prior run's tool-stream sidecars (the per-agent
      // runner only clears the CURRENT key). Sweep them — AFTER approval (a rejected edit-and-resume
      // must NOT destroy the prior run's history) and BEFORE launch (no new sidecar exists yet to
      // race). Non-blocking by design: in-flight writes get an ordered delete on their op chain, not
      // an await, so display I/O can never stall the launch.
      if (invalidatedReason) clearAllAgentToolStreams(workspacePath, threadId, runId)

      // Approval can remain open while another window merges/discards/cleans a
      // retained deliverable. Re-read the reused run immediately before launch;
      // carrying the pre-approval snapshot forward would resurrect a terminal
      // worktree as ready/recoverable in the new run.json and live panel.
      const recoveredResumeRun = resume.run
        ? workflowRunManager.getFlushFailedRun(runId)
        : undefined
      const latestResumeRun = resume.run
        ? recoveredResumeRun?.threadId === threadId
          ? recoveredResumeRun
          : await loadWorkflowRunAsync(workspacePath, threadId, runId)
        : null
      if (resume.run && !latestResumeRun) {
        throw new Error(
          `Workflow ${runId} changed or disappeared while approval was pending; reload it before resuming.`
        )
      }

      const launch = workflowRunManager.launch({
        threadId,
        workspacePath,
        runId,
        parsed,
        script: source.script,
        scriptSha256: currentScriptSha,
        args: effectiveArgs,
        tokenBudget: input.tokenBudget ?? null,
        resumeJournal: effectiveResumeJournal,
        existingWorktrees: latestResumeRun?.worktrees,
        resumed: resume.run !== null,
        resumeNote: effectiveResumeNote,
        subagentDeps,
        runExclusiveFileWrite: options.runExclusiveFileWrite
      })

      // Make the run durable BEFORE telling the model it launched: the initial
      // snapshot persist is eager but async, so without this a reload/crash right
      // after this turn could find no run file (no panel entry, no resume). A write
      // fault never blocks shared-workspace execution, but isolated worktree calls
      // fail closed until this durable index exists so they cannot leave a
      // manifest-only checkout with no history/recovery entry.
      const initialPersisted = await launch.whenInitialPersisted

      return JSON.stringify(
        {
          status: "launched",
          runId: launch.runId,
          name: parsed.meta.name,
          scriptPath: launch.scriptFilePath,
          phases: (parsed.meta.phases ?? []).map((phase) => phase.title),
          ...(effectiveResumeNote ? { resumeNote: effectiveResumeNote } : {}),
          ...(initialPersisted
            ? {}
            : {
                warning:
                  "Could not write the initial run state to disk (disk full / permissions?). The workflow may not be resumable or appear in history, and isolated worktree agents will fail closed — tell the user."
              }),
          note: "The workflow now runs in the background; live progress is visible to the user in the workflow panel. Its outcome will arrive later as an internal <task-notification> message. Briefly tell the user what was launched and END your turn — do not poll, and do not call the workflow tool again for this task."
        },
        null,
        2
      )
    },
    {
      name: "workflow",
      description: buildWorkflowToolDescription(workspacePath),
      schema: workflowToolSchema
    }
  ) as unknown as DynamicStructuredTool
}

/**
 * Run-before approval gate. Returns true when the workflow may launch. Skipped
 * in YOLO mode or when approval plumbing is absent. "Approve for this session"
 * is cached under a single generic key so subsequent workflow launches in the
 * session don't re-prompt (mirrors Claude Code's Once/Always/Deny).
 */
async function ensureWorkflowApproved(
  options: CreateWorkflowToolOptions,
  workspacePath: string,
  parsed: ParsedWorkflowScript,
  script: string,
  args: unknown,
  tokenBudget: number | null
): Promise<boolean> {
  if (options.yoloMode) return true
  const { approvalStore, requestApproval } = options
  if (!approvalStore || !requestApproval) {
    // Fail CLOSED, not open: a workflow can fan out and execute many file/shell
    // agents, so a missing approval channel must NOT silently auto-approve.
    // Production always wires both (runtime.ts createWorkflowTool); reaching here
    // means a misconfigured/embedded caller — refuse rather than run unapproved.
    throw new Error(
      "Dynamic workflow approval is not configured (approvalStore/requestApproval missing); refusing to launch an unapproved workflow."
    )
  }

  // Key the approval by the SCRIPT CONTENT *and a fingerprint of the agent
  // registry*, so "approve for this session" only waives the prompt for an
  // identical script AND identical agent profiles. Without the registry
  // fingerprint, editing .cmbcoworkagent/agents/<name>.md (e.g. flipping Explore
  // from read-only to full-shell/write, or overriding a built-in) while keeping
  // the same script would silently reuse the prior approval and launch with the
  // new, higher-privilege profile — approval would decouple from what actually
  // runs (worsened by the subagents' autoApproveFileEdits). Mirrors the resume
  // callHash, which also folds in profile behaviour.
  const computeRegistryFingerprint = (): string =>
    sha256Hex(
      JSON.stringify(
        loadAgentProfiles(workspacePath)
          .map((p) => ({
            name: p.name,
            systemPrompt: p.systemPrompt,
            disallowedTools: [...p.disallowedTools].sort(),
            shellAccess: p.shellAccess,
            // model matters too: a profile's model feeds resolvedModel (engine.ts),
            // so changing an agent's `model:` changes what actually runs/costs — it
            // must invalidate the session approval just like the tool policy does.
            model: p.model ?? null,
            source: p.source
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
      )
    )
  const registryFingerprint = computeRegistryFingerprint()
  // args also drive the run (a generic script can use args to pick the target
  // dir / which files to touch / fan-out size), so they're part of "what was
  // approved" — fold them in so changing args re-prompts instead of silently
  // reusing a prior approve_session. Distinguish "no args" (undefined) from an
  // explicit `null` — a script reads `args === undefined` vs `=== null`
  // differently, so they are DIFFERENT approvals (don't fold both into one
  // approve_session); each still hashes stably → no churn for repeat launches.
  const argsFingerprint = sha256Hex(args === undefined ? "undefined" : JSON.stringify(args))
  // tokenBudget caps the run's spend/fan-out and the approval card explicitly
  // warns about token cost, so a raised budget is part of "what was approved" —
  // fold it in too (it's a small scalar, no need to hash).
  // The session-default model is what a no-model agent() actually runs on (the
  // engine folds it into the resume callHash for the same reason). Switching it
  // changes what runs / costs, so a prior "approve for this session" must NOT
  // silently waive the prompt for a DIFFERENT default — fold it into the approval
  // identity, mirroring the resume callHash. (#1 approve_session)
  const patternKey = `workflow:launch:${sha256Hex(script)}:${registryFingerprint}:${argsFingerprint}:tb=${tokenBudget ?? "null"}:m=${options.modelId ?? "default"}`
  const key = approvalStore.makeKey(patternKey, workspacePath, "workflow")
  const phases = (parsed.meta.phases ?? []).map((phase) => phase.title)
  // Surface args on the approval card (compact): args drive the run (target dir /
  // which files / fan-out size) and are part of the approval identity, so changing
  // them re-prompts — and the user must be able to SEE what changed, not just get
  // re-prompted blindly.
  const argsPreview = ((): string => {
    if (args === undefined) return "(none)"
    if (args === null) return "null"
    let s: string
    try {
      s = JSON.stringify(args)
    } catch {
      s = String(args)
    }
    return s.length > 800 ? `${s.slice(0, 800)}\n…` : s
  })()
  const decision = await approvalStore.withCachedApproval(
    key,
    patternKey,
    async () => {
      const approval = await requestApproval({
        id: randomUUID(),
        tool_call: {
          id: randomUUID(),
          name: "workflow",
          args: {
            name: parsed.meta.name,
            description: parsed.meta.description,
            phases,
            // The approval card is a SECURITY gate: show the WHOLE script so the
            // user can audit everything they approve (a hidden tail could carry
            // dangerous writeFile/edit logic). An INLINE script has no scriptPath to
            // fall back to at approval time (that only exists after launch), so
            // truncating here would leave part of it un-reviewable. Bounded by
            // MAX_WORKFLOW_SCRIPT_BYTES (512 KiB) upstream; the renderer card scrolls.
            scriptPreview: script,
            argsPreview,
            tokenBudget
          }
        },
        safety_level: "needs_approval",
        cwd: workspacePath,
        reason: `运行动态工作流「${parsed.meta.name}」前确认:将在后台启动多个子代理(可读写文件、执行命令、消耗较多 token)。Token 预算上限:${tokenBudget != null ? `${tokenBudget.toLocaleString()} tokens` : "未设置(无上限)"}。`,
        allowed_decisions: ["approve", "reject"],
        allowed_approval_types: ["approve", "approve_session", "reject"]
      } as ApprovalRequest)
      if (approval?.type !== "approve" && approval?.type !== "approve_session") {
        return "denied"
      }
      // TOCTOU guard: the agent registry could have been edited while this
      // approval dialog was open (the await above spans real user-interaction
      // time). The fingerprint folded into the approval key was computed BEFORE
      // the prompt; the run will re-load profiles AFTER it (engine.ts). Re-load +
      // re-fingerprint now and fail closed if it changed, so an approval can't be
      // applied to a different (e.g. higher-privilege) profile than the one it was
      // shown/keyed for. (Only runs on a fresh approval — a cached approve_session
      // hit never enters this callback.) The user re-runs to approve the current
      // profiles. The residual gap (this check → engine's load) has no user-await
      // and is negligible.
      if (computeRegistryFingerprint() !== registryFingerprint) {
        throw new Error(
          "Agent registry (.cmbcoworkagent/agents/) changed while this workflow's approval was open — not launching under a stale approval. Re-run the workflow to approve the current agent profiles."
        )
      }
      return approval.type === "approve" ? "approved" : "approved_session"
    },
    { allowPermanentMatch: false, allowPermanentStore: false }
  )
  return decision !== "denied"
}

function resolveScriptSource(
  workspacePath: string,
  threadId: string,
  input: { script?: string; scriptPath?: string },
  resumeScript?: string,
  resumeNote?: string
): { script: string } {
  // Precedence: scriptPath > inline script > persisted-run script (resume).
  if (input.scriptPath?.trim()) {
    const requested = input.scriptPath.trim()
    const resolved = resolveTopLevelWorkflowScriptPath(workspacePath, threadId, requested)
    try {
      const st = statSync(resolved)
      // Must be a REGULAR file: a FIFO/socket/device under the workspace would
      // make the synchronous readFileSync below block the entire main process
      // (a FIFO read parks until a writer appears). Reject anything non-regular.
      if (!st.isFile()) {
        throw new WorkflowScriptError(`scriptPath is not a regular file: ${resolved}`)
      }
      // Reject an oversized file BEFORE readFileSync pulls it fully into memory
      // (a huge synchronous read blocks the main process). validateWorkflowScript
      // re-checks the byte length post-read as the authoritative gate.
      if (st.size > MAX_WORKFLOW_SCRIPT_BYTES) {
        throw new WorkflowScriptError(
          `scriptPath file is too large: exceeds the ${MAX_WORKFLOW_SCRIPT_BYTES}-byte (512 KiB) limit`
        )
      }
      return { script: readFileSync(resolved, "utf-8") }
    } catch (error) {
      if (error instanceof WorkflowScriptError) throw error
      throw new WorkflowScriptError(`scriptPath not readable: ${resolved}`)
    }
  }
  if (input.script?.trim()) {
    return { script: input.script }
  }
  // Self-contained resume: no explicit source, but resumeFromRunId pointed at a
  // persisted run — replay its script.
  if (resumeScript?.trim()) {
    return { script: resumeScript }
  }
  // If a resumeFromRunId was given but couldn't be resolved (invalid id / no
  // journal), surface THAT reason — not the generic "need a source" message — so a
  // mid-tier model can self-correct instead of guessing. resumeNote is only set
  // when resume resolution failed (a successful resume returns a script above).
  throw new WorkflowScriptError(
    resumeNote
      ? `${resumeNote}. To run regardless, pass \`script\` or \`scriptPath\`.`
      : "one of `script`, `scriptPath`, or a resolvable `resumeFromRunId` is required"
  )
}

/**
 * A top-level launch accepts ordinary workspace scripts plus the exact
 * app-managed script files returned by an earlier launch in this thread. Keep
 * the exception deliberately narrow: another thread's script, run sidecars,
 * nested files, and symlink escapes remain outside the executable boundary.
 */
function resolveTopLevelWorkflowScriptPath(
  workspacePath: string,
  threadId: string,
  requested: string
): string {
  const requestedPath = resolve(workspacePath, requested)
  let workspaceRoot: string
  let resolved: string
  try {
    workspaceRoot = realpathSync(resolve(workspacePath))
    resolved = realpathSync(requestedPath)
  } catch {
    throw new WorkflowScriptError(`scriptPath not found at ${requestedPath}`)
  }

  if (isPathInside(workspaceRoot, resolved)) return resolved

  let workflowRunsRoot: string
  try {
    workflowRunsRoot = realpathSync(getWorkflowRunsDir(workspacePath, threadId))
  } catch {
    throw new WorkflowFatalError(
      `scriptPath must stay inside the workspace or reference a workflow script previously returned for this thread (got "${requested}")`
    )
  }

  const fileName = basename(resolved)
  const suffix = ".workflow.js"
  const runId = fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : ""
  if (dirname(resolved) === workflowRunsRoot && isValidWorkflowRunId(runId)) {
    return resolved
  }

  throw new WorkflowFatalError(
    `scriptPath must stay inside the workspace or reference a workflow script previously returned for this thread (got "${requested}")`
  )
}

async function resolveResumeRun(
  workspacePath: string,
  threadId: string,
  resumeFromRunId: string | undefined
): Promise<{ run: PersistedWorkflowRun | null; note?: string }> {
  if (!resumeFromRunId) return { run: null }
  const requested = resumeFromRunId.trim()
  if (!isValidWorkflowRunId(requested)) {
    return {
      run: null,
      note: `resumeFromRunId "${requested}" is not a valid run id (expected wf_…)`
    }
  }
  // A final disk flush can fail after the journal has advanced. In that narrow,
  // same-process recovery window, the manager's snapshot is the authoritative
  // complete run; reading the older run.json/journal pair would re-run agents that
  // already completed. After restart no such snapshot exists, so disk remains the
  // recovery source as before.
  const snapshot = workflowRunManager.getFlushFailedRun(requested)
  const run =
    snapshot?.threadId === threadId
      ? snapshot
      : await loadWorkflowRunForResumeAsync(workspacePath, threadId, requested)
  if (!run) {
    return {
      run: null,
      note: `no journal found for ${requested}`
    }
  }
  if (run.status === "running") {
    // A persisted "running" status with no in-process active run means the
    // process died mid-run (a clean abort finalizes the file) — crash
    // recovery is exactly what the journal is for.
    return {
      run,
      note: `run ${requested} did not finish cleanly (likely interrupted) — resuming from its journal`
    }
  }
  return { run }
}
