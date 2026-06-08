/**
 * Agent Trace Collector
 *
 * Collects execution data during a single agent run and writes the completed
 * trace to a local JSONL file.  Remote reporting is delegated to an
 * ITraceReporter (default: NoopTraceReporter).
 *
 * Usage (from ipc/agent.ts):
 *
 *   const tracer = new TraceCollector(threadId, userMessage, modelId)
 *   tracer.beginStep()
 *   tracer.recordToolCall({ name, args, result, durationMs })
 *   tracer.endStep(assistantText)
 *   await tracer.finish("success")
 */

import { join } from "path"
import { homedir } from "os"
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  existsSync,
  unlinkSync,
  rmdirSync,
  writeFileSync,
  statSync
} from "fs"
import { v4 as uuid } from "uuid"
import type {
  AgentTrace,
  TraceSkillEvalExtension,
  TraceStep,
  TraceToolCall,
  TraceModelCall,
  TraceNode,
  TraceNodeStatus,
  TraceOutcome,
  TraceTriggerSource,
  ITraceReporter,
  RoutingTrace
} from "./types"
import { NoopTraceReporter } from "./types"
import { app } from "electron"
import { getLocalIP } from "../../net-utils"
import { getUserInfo } from "../../storage"
import { listAllSkills } from "../../ipc/skills"
import { getHarnessProjectAdapterSnapshot } from "../../harness-board/service"
import { nowIsoLocal } from "../../util/local-time"
import {
  DEFAULT_SKILL_VERSION,
  ensureVersionedSkillIdentifier,
  parseSkillIdentifier
} from "../../utils/skill-identifiers"
import { setAdoptionContext, clearAdoptionContext } from "../../services/adoption-tracker"
import { sanitizeTraceForCloudUpload } from "./sanitizer"
import { buildSkillEvalTraceExtension } from "../skill-eval/documents"
import {
  appendSkillEvalWindowTurn,
  getSkillEvalWindowAssistantText,
  getSkillEvalWindowContextByRawName
} from "../skill-eval/window"

// ─────────────────────────────────────────────────────────
// Global reporter registry
// ─────────────────────────────────────────────────────────

let _reporter: ITraceReporter = new NoopTraceReporter()

/** Replace the global reporter (call at app startup for remote upload). */
export function setTraceReporter(reporter: ITraceReporter): void {
  _reporter = reporter
}

export function getTraceReporter(): ITraceReporter {
  return _reporter
}

// ─────────────────────────────────────────────────────────
// Storage helpers
// ─────────────────────────────────────────────────────────

function getOpenworkDir(): string {
  return process.env.CMB_COWORK_AGENT_HOME || join(homedir(), ".cmbcoworkagent")
}

function getTracesRootDir(): string {
  return process.env.CMB_COWORK_TRACES_DIR || join(getOpenworkDir(), "traces")
}

function getThreadTracesDir(threadId: string): string {
  return join(getTracesRootDir(), threadId)
}

const MAX_TRACES_PER_THREAD = 50

function writeTraceFile(trace: AgentTrace): void {
  try {
    const dir = getThreadTracesDir(trace.threadId)
    mkdirSync(dir, { recursive: true })
    const filePath = join(dir, `${trace.traceId}.jsonl`)
    appendFileSync(filePath, JSON.stringify(trace) + "\n", "utf-8")
    console.log(`[Tracer] Written trace ${trace.traceId} to ${filePath}`)
    // Prune oldest traces if over the per-thread limit.
    pruneOldTraces(trace.threadId)
  } catch (e) {
    console.warn("[Tracer] Failed to write trace file:", e)
  }
}

/** Delete the oldest trace files in a thread directory, keeping at most MAX_TRACES_PER_THREAD. */
function pruneOldTraces(threadId: string): void {
  try {
    const dir = getThreadTracesDir(threadId)
    if (!existsSync(dir)) return

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((name) => {
        const filePath = join(dir, name)
        try {
          return { name, filePath, mtimeMs: statSync(filePath).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((e): e is { name: string; filePath: string; mtimeMs: number } => e !== null)

    if (files.length <= MAX_TRACES_PER_THREAD) return

    // Sort newest first, delete the tail.
    files.sort((a, b) => b.mtimeMs - a.mtimeMs)
    const toDelete = files.slice(MAX_TRACES_PER_THREAD)

    for (const entry of toDelete) {
      try {
        unlinkSync(entry.filePath)
        console.log(`[Tracer] Pruned old trace: ${entry.name} (thread ${threadId})`)
      } catch (e) {
        console.warn(`[Tracer] Failed to prune trace ${entry.name}:`, e)
      }
    }
  } catch (e) {
    console.warn("[Tracer] Failed to prune old traces:", e)
  }
}

function normalizeTrace(parsed: AgentTrace): AgentTrace {
  return {
    ...parsed,
    usedSkills: Array.isArray(parsed.usedSkills) ? parsed.usedSkills : [],
    evolvedSkills: Array.isArray(parsed.evolvedSkills) ? parsed.evolvedSkills : [],
    triggerSource: parsed.triggerSource ?? "chat"
  }
}

function deriveUpperOrgLevels(
  pathName?: string
): Pick<AgentTrace, "upperOrgLv0" | "upperOrgLv1" | "upperOrgLv2" | "upperOrgLv3"> {
  const emptyLevels = {
    upperOrgLv0: "",
    upperOrgLv1: "",
    upperOrgLv2: "",
    upperOrgLv3: ""
  }
  const parts =
    typeof pathName === "string"
      ? pathName
          .split("/")
          .map((part) => part.trim())
          .filter(Boolean)
      : []
  const itDeptIndex = parts.findIndex((part) => part.includes("信息技术部"))
  if (itDeptIndex < 0) return emptyLevels

  const lowerParts = parts.slice(itDeptIndex + 1)
  const startsWithTeam = lowerParts[0]?.includes("团队") ?? false
  if (startsWithTeam) {
    return {
      upperOrgLv0: lowerParts[2] ?? "",
      upperOrgLv1: lowerParts[1] ?? "",
      upperOrgLv2: lowerParts[0] ?? "",
      upperOrgLv3: "本部团队"
    }
  }

  return {
    upperOrgLv0: lowerParts[3] ?? "",
    upperOrgLv1: lowerParts[2] ?? "",
    upperOrgLv2: lowerParts[1] ?? "",
    upperOrgLv3: lowerParts[0] ?? ""
  }
}

function getAppVersionForTrace(): string {
  try {
    return typeof app?.getVersion === "function" ? app.getVersion() : "unknown"
  } catch {
    return "unknown"
  }
}

function getSkillAuthor(skill: {
  metadata?: Record<string, string>
  pluginName?: string
}): string | undefined {
  const metadataAuthor = skill.metadata?.author || skill.metadata?.owner
  if (metadataAuthor) return metadataAuthor
  return skill.pluginName
}

function buildSkillAuthorByRawName(
  rawSkillNames: string[],
  skills: Array<{
    name: string
    version: string
    metadata?: Record<string, string>
    pluginName?: string
  }>
): Record<string, string | undefined> {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))
  const byVersionedName = new Map(
    skills.map((skill) => [ensureVersionedSkillIdentifier(skill.name, skill.version), skill])
  )
  const result: Record<string, string | undefined> = {}

  for (const rawSkillName of rawSkillNames) {
    const parsed = parseSkillIdentifier(rawSkillName)
    const skill = byVersionedName.get(rawSkillName) ?? byName.get(parsed.name)
    const author = skill ? getSkillAuthor(skill) : undefined
    if (author) result[rawSkillName] = author
  }

  return result
}

// ─────────────────────────────────────────────────────────
// TraceCollector class
// ─────────────────────────────────────────────────────────

export class TraceCollector {
  private readonly traceId: string
  private readonly threadId: string
  private readonly startedAt: string
  private readonly userMessage: string
  private modelId: string
  private modelName: string | undefined
  private routingTrace: RoutingTrace | undefined
  private readonly triggerSource: TraceTriggerSource
  private readonly harnessFeature: { projectId: string; slug: string } | undefined

  private steps: TraceStep[] = []
  private usedSkills: string[] = []
  private evolvedSkills: string[] = []
  private modelCalls: TraceModelCall[] = []
  private nodes: TraceNode[] = []
  private nodeIndexById = new Map<string, number>()
  private llmNodeByMessageId = new Map<string, string>()
  private toolNodeByCallId = new Map<string, string>()
  private readonly rootNodeId: string
  private terminalNodeAdded = false

  /** The step currently being built (between beginStep / endStep). */
  private currentStepIndex = 0
  private currentStepStartedAt: string = nowIsoLocal()
  private currentToolCalls: TraceToolCall[] = []

  constructor(
    threadId: string,
    userMessage: string,
    modelId: string,
    options: {
      triggerSource?: TraceTriggerSource
      harnessFeature?: { projectId: string; slug: string }
    } = {}
  ) {
    this.traceId = uuid()
    this.threadId = threadId
    this.userMessage = userMessage
    this.modelId = modelId
    this.triggerSource = options.triggerSource ?? "chat"
    this.harnessFeature = options.harnessFeature
    this.startedAt = nowIsoLocal()
    this.rootNodeId = `trace:${this.traceId}`
    this.pushNode({
      id: this.rootNodeId,
      type: "trace",
      parentId: null,
      name: "Agent Trace",
      status: "running",
      startedAt: this.startedAt,
      input: { userMessage },
      metadata: {
        traceId: this.traceId,
        threadId: this.threadId,
        modelId: this.modelId,
        triggerSource: this.triggerSource
      }
    })
    // Publish context to adoption tracker (side-effect only). Project-mode
    // conversations also carry their harness project / adapter so emitted
    // code_gen/code_adopt events can be sliced by project / plugin directly.
    try {
      let harnessAdapter: { name?: string; version?: string } = {}
      if (this.harnessFeature) {
        try {
          const adapter = getHarnessProjectAdapterSnapshot(this.harnessFeature.projectId)
          if (adapter) harnessAdapter = { name: adapter.name, version: adapter.version }
        } catch {
          // best-effort: leave adapter fields absent on resolution failure
        }
      }
      setAdoptionContext(this.threadId, {
        traceId: this.traceId,
        modelId: this.modelId,
        ...(this.harnessFeature
          ? {
              harnessProjectId: this.harnessFeature.projectId,
              harnessFeatureSlug: this.harnessFeature.slug,
              harnessAdapterName: harnessAdapter.name,
              harnessAdapterVersion: harnessAdapter.version
            }
          : {})
      })
    } catch {
      // never block trace setup
    }
  }

  /** Update the modelId (can be resolved after construction). */
  setModelId(id: string): void {
    this.modelId = id
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), modelId: id }
    }
    try {
      setAdoptionContext(this.threadId, { modelId: id })
    } catch {
      // ignore
    }
  }

  /** Set the human-readable model name (e.g. "minmax") for display in trace UI. */
  setModelName(name: string): void {
    this.modelName = name
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), modelName: name }
    }
    try {
      setAdoptionContext(this.threadId, { modelName: name })
    } catch {
      // ignore
    }
  }

  /**
   * Attach the routing funnel record to this trace.
   * Side-effect only — never throws.
   */
  setRoutingTrace(rt: RoutingTrace): void {
    try {
      this.routingTrace = rt
      const root = this.getNode(this.rootNodeId)
      if (root) {
        root.metadata = { ...(root.metadata ?? {}), routingTrace: rt }
      }
    } catch (e) {
      console.warn("[Tracer] setRoutingTrace failed:", e)
    }
  }

  /**
   * Set which skills were actually used for this run (feeds the trace document's
   * own `usedSkills`).
   *
   * NOTE: this intentionally does NOT write the adoption context's usedSkills.
   * Code-gen skill attribution is sticky across the thread and is owned solely
   * by the caller (ipc/agent.ts `syncUsedSkillsContext`), which writes the
   * adoption context with the thread's active skill set right after this call.
   * Writing current-run skills here would only be a value the caller overwrites,
   * and risks bypassing the sticky attribution if ever called on its own.
   */
  setUsedSkills(skills: string[]): void {
    this.usedSkills = [...skills]
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), usedSkills: [...skills] }
    }
  }

  /** Set which used skills came from cloud trace evolution. */
  setEvolvedSkills(skills: string[]): void {
    this.evolvedSkills = [...skills]
    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.metadata = { ...(root.metadata ?? {}), evolvedSkills: [...skills] }
    }
  }

  /** Return the root trace node id. */
  getRootNodeId(): string {
    return this.rootNodeId
  }

  /**
   * Called when the model starts producing a new message
   * (i.e. before tool calls for that step are known).
   */
  beginStep(): void {
    this.currentStepStartedAt = nowIsoLocal()
    this.currentToolCalls = []
  }

  /** Record a tool call within the current step. */
  recordToolCall(call: TraceToolCall): void {
    this.currentToolCalls.push(call)
  }

  /** Record one LLM run (input context + output message). */
  recordModelCall(call: TraceModelCall): void {
    this.modelCalls.push(call)
  }

  beginLlmNode(params?: {
    messageId?: string
    startedAt?: string
    input?: unknown
    name?: string
    metadata?: Record<string, unknown>
  }): string {
    const messageId = params?.messageId
    if (messageId) {
      const existing = this.llmNodeByMessageId.get(messageId)
      if (existing) return existing
    }

    const id = `llm:${uuid()}`
    this.pushNode({
      id,
      type: "llm",
      parentId: this.rootNodeId,
      name: params?.name ?? "LLM Call",
      status: "running",
      startedAt: params?.startedAt ?? nowIsoLocal(),
      input: params?.input,
      metadata: {
        ...(params?.metadata ?? {}),
        ...(messageId ? { messageId } : {})
      }
    })
    if (messageId) this.llmNodeByMessageId.set(messageId, id)
    return id
  }

  addToolNode(params: {
    name: string
    input?: unknown
    parentId?: string
    llmMessageId?: string
    toolCallId?: string
    startedAt?: string
    metadata?: Record<string, unknown>
  }): string {
    if (params.toolCallId) {
      const existing = this.toolNodeByCallId.get(params.toolCallId)
      if (existing) return existing
    }

    const byMessage = params.llmMessageId
      ? this.llmNodeByMessageId.get(params.llmMessageId)
      : undefined
    const parentId = params.parentId ?? byMessage ?? this.rootNodeId
    const id = `tool:${uuid()}`

    this.pushNode({
      id,
      type: "tool",
      parentId,
      name: params.name,
      status: "running",
      startedAt: params.startedAt ?? nowIsoLocal(),
      input: params.input,
      metadata: {
        ...(params.metadata ?? {}),
        ...(params.toolCallId ? { toolCallId: params.toolCallId } : {})
      }
    })

    if (params.toolCallId) this.toolNodeByCallId.set(params.toolCallId, id)
    return id
  }

  addToolResultNode(params: {
    output?: unknown
    parentId?: string
    toolCallId?: string
    startedAt?: string
    status?: TraceNodeStatus
    metadata?: Record<string, unknown>
  }): string {
    const parentId =
      params.parentId ??
      (params.toolCallId ? this.toolNodeByCallId.get(params.toolCallId) : undefined) ??
      this.rootNodeId
    const id = `tool_result:${uuid()}`
    const now = params.startedAt ?? nowIsoLocal()

    this.pushNode({
      id,
      type: "tool_result",
      parentId,
      name: "Tool Result",
      status: params.status ?? "success",
      startedAt: now,
      endedAt: now,
      output: params.output,
      metadata: params.metadata
    })

    if (parentId !== this.rootNodeId) {
      this.endNode(parentId, params.status ?? "success")
    }
    return id
  }

  endLlmNode(params: {
    nodeId?: string
    messageId?: string
    status?: TraceNodeStatus
    endedAt?: string
    output?: unknown
    metadata?: Record<string, unknown>
  }): void {
    const targetId =
      params.nodeId ??
      (params.messageId ? this.llmNodeByMessageId.get(params.messageId) : undefined)
    if (!targetId) return
    const node = this.getNode(targetId)
    if (!node) return

    node.status = params.status ?? "success"
    node.endedAt = params.endedAt ?? nowIsoLocal()
    if (params.output !== undefined) node.output = params.output
    if (params.metadata) node.metadata = { ...(node.metadata ?? {}), ...params.metadata }
  }

  addTerminalNode(params: {
    type: "message" | "error" | "cancel"
    name?: string
    status?: TraceNodeStatus
    output?: unknown
    metadata?: Record<string, unknown>
    startedAt?: string
    endedAt?: string
  }): string {
    this.terminalNodeAdded = true
    const id = `${params.type}:${uuid()}`
    this.pushNode({
      id,
      type: params.type,
      parentId: this.rootNodeId,
      name:
        params.name ??
        (params.type === "error"
          ? "Run Error"
          : params.type === "cancel"
            ? "Run Cancelled"
            : "Run Completed"),
      status:
        params.status ??
        (params.type === "error" ? "error" : params.type === "cancel" ? "cancelled" : "success"),
      startedAt: params.startedAt ?? nowIsoLocal(),
      endedAt: params.endedAt ?? nowIsoLocal(),
      output: params.output,
      metadata: params.metadata
    })
    return id
  }

  /**
   * Called after the model message + its tool calls are complete.
   * @param assistantText - The assistant's text reasoning for this step.
   */
  endStep(assistantText: string): void {
    const step: TraceStep = {
      index: this.currentStepIndex++,
      startedAt: this.currentStepStartedAt,
      assistantText,
      toolCalls: [...this.currentToolCalls]
    }
    this.steps.push(step)
    this.currentToolCalls = []
  }

  /**
   * Finalize the trace, write to disk, and (optionally) report remotely.
   * Safe to call multiple times — only the first call takes effect.
   */
  async finish(outcome: TraceOutcome, errorMessage?: string): Promise<AgentTrace> {
    const endedAt = nowIsoLocal()
    const durationMs = Date.now() - new Date(this.startedAt).getTime()
    const totalToolCalls = this.steps.reduce((sum, s) => sum + s.toolCalls.length, 0)

    // Resolve skill versions and merge into "name-version" format
    let skillAuthorByRawName: Record<string, string | undefined> = {}
    const resolveSkillVersions = async (
      skills: string[],
      collectAuthors = false
    ): Promise<string[]> => {
      if (skills.length === 0) return []
      try {
        const allSkills = await listAllSkills()
        const skillVersionMap = new Map(allSkills.map((s) => [s.name, s.version]))
        const resolved = Array.from(
          new Set(
            skills
              .map((skill) => {
                const parsed = parseSkillIdentifier(skill)
                const listedVersion = skillVersionMap.get(parsed.name)
                const resolvedVersion =
                  parsed.version && parsed.version !== DEFAULT_SKILL_VERSION
                    ? parsed.version
                    : (listedVersion ?? parsed.version)
                return ensureVersionedSkillIdentifier(parsed.name, resolvedVersion)
              })
              .filter(Boolean)
          )
        )
        if (collectAuthors) {
          skillAuthorByRawName = buildSkillAuthorByRawName(resolved, allSkills)
        }
        return resolved
      } catch (e) {
        console.warn("[Tracer] Failed to resolve skill versions:", e)
        return Array.from(
          new Set(skills.map((skill) => ensureVersionedSkillIdentifier(skill)).filter(Boolean))
        )
      }
    }

    const usedSkillsWithVersions = await resolveSkillVersions(this.usedSkills, true)
    const evolvedSkillsWithVersions = await resolveSkillVersions(this.evolvedSkills)

    const userInfo = getUserInfo()
    const upperOrgLevels = deriveUpperOrgLevels(userInfo?.pathName)

    // Project-mode traces also record the bound adapter plugin's version, so
    // operations analytics can attribute a project conversation to a plugin
    // version. Best-effort: any resolution failure leaves the fields absent.
    let harnessAdapterFields: {
      harnessAdapterId?: string
      harnessAdapterName?: string
      harnessAdapterVersion?: string
    } = {}
    if (this.harnessFeature) {
      try {
        const adapter = getHarnessProjectAdapterSnapshot(this.harnessFeature.projectId)
        if (adapter) {
          harnessAdapterFields = {
            harnessAdapterId: adapter.id,
            harnessAdapterName: adapter.name,
            harnessAdapterVersion: adapter.version
          }
        }
      } catch (e) {
        console.warn("[Tracer] Failed to resolve harness adapter for trace:", e)
      }
    }

    const trace: AgentTrace = {
      traceId: this.traceId,
      threadId: this.threadId,
      startedAt: this.startedAt,
      endedAt,
      durationMs,
      userMessage: this.userMessage,
      modelId: this.modelId,
      ...(this.modelName ? { modelName: this.modelName } : {}),
      userIp: getLocalIP(),
      userName: userInfo?.userName,
      sapId: userInfo?.sapId,
      ystId: userInfo?.ystId,
      originOrgId: userInfo?.originOrgId,
      orgName: userInfo?.orgName,
      pathName: userInfo?.pathName,
      pathId: userInfo?.originPathId,
      upperOrgLv0: upperOrgLevels.upperOrgLv0,
      upperOrgLv1: upperOrgLevels.upperOrgLv1,
      upperOrgLv2: upperOrgLevels.upperOrgLv2,
      upperOrgLv3: upperOrgLevels.upperOrgLv3,
      appVersion: getAppVersionForTrace(),
      steps: this.steps,
      modelCalls: this.modelCalls,
      nodes: this.finalizeNodes(
        outcome,
        endedAt,
        usedSkillsWithVersions,
        evolvedSkillsWithVersions,
        errorMessage
      ),
      totalToolCalls,
      outcome,
      ...(errorMessage ? { errorMessage } : {}),
      usedSkills: usedSkillsWithVersions,
      evolvedSkills: evolvedSkillsWithVersions,
      triggerSource: this.triggerSource,
      ...(this.harnessFeature
        ? {
            harnessProjectId: this.harnessFeature.projectId,
            harnessFeatureSlug: this.harnessFeature.slug,
            ...harnessAdapterFields
          }
        : {}),
      ...(this.routingTrace ? { metadata: { routingTrace: this.routingTrace } } : {})
    }
    let skillEval: TraceSkillEvalExtension | undefined
    try {
      const windowTurn = appendSkillEvalWindowTurn({
        traceId: trace.traceId,
        threadId: trace.threadId,
        startedAt: trace.startedAt,
        endedAt: trace.endedAt,
        usedSkills: usedSkillsWithVersions,
        userMessage: trace.userMessage,
        assistantText: getSkillEvalWindowAssistantText(trace),
        outcome: trace.outcome
      })
      const evalRawSkillNames = windowTurn.evalSkillNames
      const windowContextByRawName = getSkillEvalWindowContextByRawName(
        trace.threadId,
        evalRawSkillNames
      )
      skillEval = buildSkillEvalTraceExtension(trace, {
        skillAuthorByRawName,
        windowContextByRawName,
        evalRawSkillNames
      })
    } catch (e) {
      console.warn("[Tracer] buildSkillEvalTraceExtension failed:", e)
    }
    const traceWithEval: AgentTrace = skillEval ? { ...trace, skillEval } : trace

    writeTraceFile(traceWithEval)

    // Fire-and-forget: trace upload is a side-channel operation and must
    // never block the main agent flow. Errors are logged and swallowed.
    void Promise.resolve()
      .then(() => _reporter.report(sanitizeTraceForCloudUpload(traceWithEval)))
      .catch((e) => {
        console.warn("[Tracer] Reporter.report() threw:", e)
      })

    // Clear adoption context — subsequent write_file calls on this thread
    // will no longer carry this trace's attribution.
    try {
      clearAdoptionContext(this.threadId)
    } catch {
      // ignore
    }

    return traceWithEval
  }

  private finalizeNodes(
    outcome: TraceOutcome,
    endedAt: string,
    resolvedUsedSkills: string[],
    resolvedEvolvedSkills: string[],
    errorMessage?: string
  ): TraceNode[] {
    const finalStatus: TraceNodeStatus =
      outcome === "error"
        ? "error"
        : outcome === "cancelled"
          ? "cancelled"
          : outcome === "unknown"
            ? "unknown"
            : "success"
    for (const node of this.nodes) {
      if (node.type === "llm" || node.type === "tool") {
        if (node.status === "running") {
          node.status = finalStatus
        }
        if (!node.endedAt) node.endedAt = endedAt
      }
    }

    if (!this.terminalNodeAdded) {
      if (outcome === "error") {
        this.addTerminalNode({
          type: "error",
          output: errorMessage ?? "Unknown error",
          status: "error",
          startedAt: endedAt,
          endedAt
        })
      } else if (outcome === "cancelled") {
        this.addTerminalNode({
          type: "cancel",
          status: "cancelled",
          startedAt: endedAt,
          endedAt
        })
      } else if (outcome === "unknown") {
        this.addTerminalNode({
          type: "message",
          name: "Run Ended",
          output: errorMessage ?? "Run ended without a final success signal",
          status: "unknown",
          startedAt: endedAt,
          endedAt
        })
      } else {
        this.addTerminalNode({
          type: "message",
          output: "Run completed",
          status: "success",
          startedAt: endedAt,
          endedAt
        })
      }
    }

    const root = this.getNode(this.rootNodeId)
    if (root) {
      root.status = finalStatus
      root.endedAt = endedAt
      root.output = {
        outcome,
        totalSteps: this.steps.length,
        totalToolCalls: this.steps.reduce((sum, s) => sum + s.toolCalls.length, 0),
        ...(errorMessage ? { errorMessage } : {})
      }
      root.metadata = {
        ...(root.metadata ?? {}),
        usedSkills: [...resolvedUsedSkills],
        evolvedSkills: [...resolvedEvolvedSkills],
        triggerSource: this.triggerSource
      }
    }

    return this.nodes
  }

  private pushNode(node: TraceNode): void {
    const index = this.nodes.push(node) - 1
    this.nodeIndexById.set(node.id, index)
  }

  private getNode(id: string): TraceNode | undefined {
    const idx = this.nodeIndexById.get(id)
    if (idx === undefined) return undefined
    return this.nodes[idx]
  }

  private endNode(id: string, status: TraceNodeStatus): void {
    const node = this.getNode(id)
    if (!node) return
    node.status = status
    node.endedAt = nowIsoLocal()
  }
}

// ─────────────────────────────────────────────────────────
// Trace reading utilities (used by optimizer)
// ─────────────────────────────────────────────────────────

/** List all threadIds that have trace files. */
export function listTracedThreads(): string[] {
  const tracesDir = getTracesRootDir()
  if (!existsSync(tracesDir)) return []
  try {
    return readdirSync(tracesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
}

/** Read all traces for a given thread, sorted by startedAt ascending. */
export function readThreadTraces(threadId: string): AgentTrace[] {
  const dir = getThreadTracesDir(threadId)
  if (!existsSync(dir)) return []
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    const traces: AgentTrace[] = []
    for (const file of files) {
      const raw = readFileSync(join(dir, file), "utf-8")
      for (const line of raw.trim().split("\n")) {
        if (!line.trim()) continue
        try {
          traces.push(normalizeTrace(JSON.parse(line) as AgentTrace))
        } catch {
          /* skip malformed lines */
        }
      }
    }
    return traces.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  } catch {
    return []
  }
}

/** Read one trace by ID across all threads. */
export function readTraceById(traceId: string): AgentTrace | null {
  const location = findTraceLocation(traceId)
  if (!location) return null
  try {
    const raw = readFileSync(location.filePath, "utf-8")
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue
      const parsed = normalizeTrace(JSON.parse(line) as AgentTrace)
      if (parsed.traceId === traceId) return parsed
    }
  } catch {
    return null
  }
  return null
}

/** Read the N most recent traces across all threads. */
export function readRecentTraces(limit = 20): AgentTrace[] {
  const threads = listTracedThreads()
  const all: AgentTrace[] = []
  for (const t of threads) {
    all.push(...readThreadTraces(t))
  }
  return all.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit)
}

function findTraceLocation(traceId: string): { threadId: string; filePath: string } | null {
  for (const threadId of listTracedThreads()) {
    const dir = getThreadTracesDir(threadId)
    const directPath = join(dir, `${traceId}.jsonl`)
    if (existsSync(directPath)) {
      return { threadId, filePath: directPath }
    }
    try {
      const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      for (const file of files) {
        const filePath = join(dir, file)
        const raw = readFileSync(filePath, "utf-8")
        const lines = raw.split("\n").filter((line) => line.trim().length > 0)
        for (const line of lines) {
          try {
            const parsed = normalizeTrace(JSON.parse(line) as AgentTrace)
            if (parsed.traceId === traceId) return { threadId, filePath }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch {
      // ignore this thread and continue
    }
  }
  return null
}

export function deleteTraceById(traceId: string): {
  success: boolean
  threadId?: string
  error?: string
} {
  const location = findTraceLocation(traceId)
  if (!location) return { success: true }
  try {
    const raw = readFileSync(location.filePath, "utf-8")
    const lines = raw.split("\n")
    const keptLines: string[] = []
    let removed = false

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const parsed = normalizeTrace(JSON.parse(line) as AgentTrace)
        if (parsed.traceId === traceId) {
          removed = true
          continue
        }
      } catch {
        // Keep malformed lines to avoid destructive data loss.
      }
      keptLines.push(line)
    }

    if (!removed) return { success: true, threadId: location.threadId }

    if (keptLines.length === 0) {
      unlinkSync(location.filePath)
    } else {
      writeFileSync(location.filePath, `${keptLines.join("\n")}\n`, "utf-8")
    }

    const threadDir = getThreadTracesDir(location.threadId)
    if (existsSync(threadDir) && readdirSync(threadDir).length === 0) {
      rmdirSync(threadDir)
    }
    return { success: true, threadId: location.threadId }
  } catch (e) {
    return {
      success: false,
      threadId: location.threadId,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

export function deleteTraces(traceIds: string[]): {
  deletedIds: string[]
  failed: Array<{ traceId: string; error: string }>
} {
  const deletedIds: string[] = []
  const failed: Array<{ traceId: string; error: string }> = []
  const uniqueIds = [...new Set(traceIds)]

  for (const traceId of uniqueIds) {
    const result = deleteTraceById(traceId)
    if (result.success) {
      deletedIds.push(traceId)
    } else {
      failed.push({ traceId, error: result.error ?? "Unknown error" })
    }
  }

  return { deletedIds, failed }
}

/** Return the traces directory path (for display purposes). */
export function getTracesDir(): string {
  return getTracesRootDir()
}
