import {
  getThreadActiveSkills,
  getThreadActiveSkillSource,
  mergeThreadActiveSkills,
  setThreadActiveSkills
} from "./skill-evolution/proposal-window"
import { SkillUsageDetector } from "./skill-evolution/usage-detector"
import { setAdoptionContext } from "../services/adoption-tracker"

/**
 * Skill attribution for one turn, shared by every path that runs the standard
 * agent graph (desktop invoke, IM remote turns).
 *
 * Adoption statistics are the reason this is shared rather than duplicated.
 * `recordGen` lives inside the sandbox tools, so it fires for every path
 * already — but it reads `usedSkills` / `skillSource` off the per-thread
 * adoption context, and that context is populated here. A path that runs the
 * graph without driving this module emits code_gen events with no skill
 * attribution at all, and leaves the thread's sticky active-skill set stale for
 * whoever runs the next turn.
 */

/** The slice of TraceCollector this module needs. Structural so tests can fake it. */
export interface TurnAttributionTracer {
  setUsedSkills(skills: string[]): void
  setSkillSource(skillSource: string[]): void
  setEvolvedSkills(skills: string[]): void
}

/**
 * Code-gen attribution keeps a skill "active" for the rest of the thread once
 * used, so later turns that never re-read SKILL.md still attribute their code
 * to it. A turn that uses a different skill set supersedes the sticky one; a
 * skill-less turn leaves it intact. The trace's own usedSkills is the
 * current-run set only, which is why the two are computed separately below.
 */
function codeGenAttribution(
  threadId: string,
  currentRunSkills: string[],
  currentRunSkillSource: string[]
): ResolvedAttributionSkills {
  if (currentRunSkills.length > 0) {
    return { usedSkills: currentRunSkills, skillSource: currentRunSkillSource }
  }
  // Resolved together rather than through two accessors: this runs on the
  // streaming hot path, and each lookup can reach the sticky-skill store.
  return {
    usedSkills: getThreadActiveSkills(threadId),
    skillSource: getThreadActiveSkillSource(threadId)
  }
}

/** The skills + sources a generation on `threadId` should be attributed to. */
export interface ResolvedAttributionSkills {
  usedSkills: string[]
  skillSource: string[]
}

/**
 * Skill attribution for a sub-agent that owns its own thread (workflow agents,
 * coordinator workers). Their generated code is recorded against the *child*
 * thread, so the child's adoption context is what `recordGen` reads — and a
 * child that never re-reads a SKILL.md has nothing of its own to report.
 *
 * Falls back down the ownership chain: this run's skills → the child thread's
 * sticky set (it may have used a skill on an earlier turn) → the parent
 * thread's sticky set. Without the last hop, delegating work to a sub-agent
 * silently drops the plugin attribution the parent had already established.
 */
export function resolveSubagentAttributionSkills(input: {
  threadId: string
  parentThreadId?: string
  currentRunSkills: string[]
  currentRunSkillSource: string[]
}): ResolvedAttributionSkills {
  const { threadId, parentThreadId, currentRunSkills, currentRunSkillSource } = input
  if (currentRunSkills.length > 0) {
    return { usedSkills: currentRunSkills, skillSource: currentRunSkillSource }
  }
  const own = getThreadActiveSkills(threadId)
  if (own.length > 0) {
    return { usedSkills: own, skillSource: getThreadActiveSkillSource(threadId) }
  }
  if (!parentThreadId) return { usedSkills: [], skillSource: [] }
  return {
    usedSkills: getThreadActiveSkills(parentThreadId),
    skillSource: getThreadActiveSkillSource(parentThreadId)
  }
}

/**
 * Publish a sub-agent's attribution to its own thread's adoption context,
 * resolving the fallback chain first. Mirrors `syncTurnSkillAttribution` for
 * paths that drive their own detector instead of the standard graph stream.
 */
export function syncSubagentSkillAttribution(input: {
  threadId: string
  parentThreadId?: string
  currentRunSkills: string[]
  currentRunSkillSource: string[]
}): void {
  const { threadId, currentRunSkills, currentRunSkillSource } = input
  // A sub-agent that used a skill of its own keeps it for its later turns, but
  // in memory only: these thread ids are minted per run and never resumed, so a
  // persisted row would be dead weight in a database that is re-serialized
  // whole on every save. Across a restart the parent chain answers instead.
  if (currentRunSkills.length > 0) {
    setThreadActiveSkills(threadId, currentRunSkills, currentRunSkillSource, { persist: false })
  }
  setAdoptionContext(threadId, resolveSubagentAttributionSkills(input))
}

/**
 * Skill attribution for a sub-agent that shares its parent's filesystem
 * backend (Task sub-agents). Their writes are recorded against the *parent*
 * thread, so attribution has to travel up rather than down: a skill the child
 * read never reaches the parent's adoption context on its own, and the parent
 * is what `recordGen` will consult.
 *
 * Merged, never superseded — the parent may be running its own skill
 * concurrently, and several Task sub-agents can be live at once. The
 * consequence is that code the parent writes itself after this point also
 * carries the child's skill. That is intended: the bucket asks whether the work
 * was produced under plugin constraint, and it was.
 *
 * Known imprecision, deliberately not fixed: if the parent then reads a skill of
 * its own, `setThreadActiveSkills` supersedes the whole set and drops the
 * child's skill with it, because the sticky set has no notion of which turn a
 * skill came from and so cannot tell a cross-turn supersede from a same-turn
 * one. Bucketing is unaffected (it only asks whether *any* skill is attached);
 * only skill-sliced adoption rates lose the child's entry. It also self-heals:
 * `SoloTaskTraceMiddleware.beforeModel` re-syncs before every model call the
 * child makes, which merges the skill back. Teaching the store about turns
 * would change a rule the whole attribution chain rests on, and a mistake there
 * fails silently, so the trade is not worth it without data showing how often
 * parent and child really run different skills in one turn.
 */
export function syncTaskSubagentSkillAttribution(input: {
  parentThreadId: string
  currentRunSkills: string[]
  currentRunSkillSource: string[]
}): void {
  const { parentThreadId, currentRunSkills, currentRunSkillSource } = input
  if (!parentThreadId || currentRunSkills.length === 0) return
  mergeThreadActiveSkills(parentThreadId, currentRunSkills, currentRunSkillSource)
  setAdoptionContext(parentThreadId, {
    usedSkills: getThreadActiveSkills(parentThreadId),
    skillSource: getThreadActiveSkillSource(parentThreadId)
  })
}

/**
 * Publish the detector's current view to the tracer, the thread's sticky
 * active-skill set and the adoption context. Safe to call repeatedly — every
 * write is idempotent for an unchanged detector state.
 */
export function syncTurnSkillAttribution(input: {
  threadId: string
  tracer: TurnAttributionTracer
  detector: SkillUsageDetector
}): void {
  const { threadId, tracer, detector } = input
  const currentRunSkills = detector.getUsedSkillNames()
  const currentRunSkillSource = detector.getUsedSkillSourceRefs()
  tracer.setUsedSkills(currentRunSkills)
  tracer.setSkillSource(currentRunSkillSource)
  tracer.setEvolvedSkills(detector.getUsedEvolvedSkillNames())
  if (currentRunSkills.length > 0) {
    setThreadActiveSkills(threadId, currentRunSkills, currentRunSkillSource)
  }
  setAdoptionContext(
    threadId,
    codeGenAttribution(threadId, currentRunSkills, currentRunSkillSource)
  )
}

/** A tool call as it appears on a serialized stream message. */
export interface AttributionToolCall {
  name?: string
  args?: Record<string, unknown>
}

export interface ObservedToolCall {
  /** The detector's used-skill set grew — the caller must re-sync attribution. */
  skillHit: boolean
  /** Normalized path of a file this call writes, when it is a write/edit. */
  writePath?: string
}

const NO_OBSERVATION: ObservedToolCall = { skillHit: false }

function toolCallPath(args: Record<string, unknown> | undefined): string {
  const path = args?.path
  if (typeof path === "string" && path) return path
  const filePath = args?.file_path
  if (typeof filePath === "string" && filePath) return filePath
  return ""
}

/**
 * Attribution rules for a single tool call. This is the one place that decides
 * which tools mark a skill as used and which tools count as writing a file, so
 * a change here reaches every path at once.
 */
export function observeToolCallForAttribution(
  detector: SkillUsageDetector,
  call: AttributionToolCall | undefined
): ObservedToolCall {
  const name = call?.name
  if (!name) return NO_OBSERVATION
  if (name === "read_file") {
    const readPath = toolCallPath(call?.args)
    if (!readPath) return NO_OBSERVATION
    return { skillHit: detector.onReadFilePath(readPath) }
  }
  if (name === "write_file" || name === "edit_file") {
    const writePath = toolCallPath(call?.args)
    if (!writePath) return NO_OBSERVATION
    return { skillHit: false, writePath: writePath.replace(/\\/g, "/") }
  }
  return NO_OBSERVATION
}

/** A skill the turn activated explicitly, rather than by reading its SKILL.md. */
export interface ExplicitSkillActivation {
  name: string
  path: string
}

/**
 * An explicitly invoked skill never produces a read_file of its SKILL.md, so it
 * has to be registered and marked used by hand or it drops out of attribution.
 */
export function observeExplicitSkillActivation(
  detector: SkillUsageDetector,
  skill: ExplicitSkillActivation
): void {
  detector.onSkillsMetadata([{ name: skill.name, path: skill.path }])
  detector.onReadFilePath(skill.path)
}

interface SerializedStreamMessage {
  id?: unknown
  kwargs?: {
    id?: unknown
    type?: unknown
    tool_calls?: unknown
  }
}

function messageClassName(message: SerializedStreamMessage | undefined): string {
  const classId = Array.isArray(message?.id) ? (message.id as unknown[]) : []
  const last = classId[classId.length - 1]
  return typeof last === "string" ? last : ""
}

function isAssistantMessage(message: SerializedStreamMessage | undefined): boolean {
  return messageClassName(message).includes("AI") || message?.kwargs?.type === "ai"
}

function toolCallsOf(message: SerializedStreamMessage | undefined): AttributionToolCall[] {
  const toolCalls = message?.kwargs?.tool_calls
  return Array.isArray(toolCalls) ? (toolCalls as AttributionToolCall[]) : []
}

function messageId(message: SerializedStreamMessage | undefined): string {
  const id = message?.kwargs?.id
  return typeof id === "string" ? id : ""
}

/**
 * Drives skill attribution off the raw LangGraph stream.
 *
 * Both stream modes are consumed because neither alone is sufficient:
 * `messages` arrives first but its tool-call args are still being streamed (an
 * early chunk carries the id with `args: {}`), while `values` carries complete
 * args but only lands at step boundaries. Observations are idempotent — the
 * detector dedupes by skill and write paths are deduped here — so reading a
 * call from both modes costs nothing and neither mode can lose one.
 */
export class TurnAttributionRecorder {
  readonly detector: SkillUsageDetector
  private readonly threadId: string
  private readonly tracer: TurnAttributionTracer
  private readonly userMessageId: string
  private readonly writePaths = new Set<string>()
  private pendingSync = false

  constructor(input: {
    threadId: string
    tracer: TurnAttributionTracer
    /** Anchors the turn window inside a whole-thread `values` snapshot. */
    userMessageId?: string
    detector?: SkillUsageDetector
  }) {
    this.threadId = input.threadId
    this.tracer = input.tracer
    this.userMessageId = input.userMessageId ?? ""
    this.detector = input.detector ?? new SkillUsageDetector()
    // Publish the sticky set immediately, before the turn writes anything.
    //
    // Starting a trace resets the adoption context (a new trace is a new
    // ownership epoch), which drops the skills the previous turn published.
    // Every other sync here is conditional — it fires when the detector gains a
    // skill or a `values` snapshot carries skillsMetadata — so a turn that
    // never re-reads a SKILL.md used to generate code against an empty context
    // and be misfiled as vibecoding. Observed in the wild: a single turn whose
    // early writes carried no skill and whose later writes, after the agent
    // happened to read a SKILL.md, carried the right one.
    //
    // The detector is empty at this point, so this publishes exactly the
    // fallback chain (sticky set, else nothing) and never invents attribution.
    // Callers construct this after the tracer has started, so the reset has
    // already happened and cannot wipe what we write here.
    this.sync()
  }

  /** Files this turn wrote, in first-seen order. */
  getFileWritePaths(): string[] {
    return [...this.writePaths]
  }

  /** Publish the current attribution. Called after each batch of observations. */
  sync(): void {
    syncTurnSkillAttribution({
      threadId: this.threadId,
      tracer: this.tracer,
      detector: this.detector
    })
  }

  /** Register a skill the turn invoked explicitly and publish the new attribution. */
  onExplicitSkillActivated(skill: ExplicitSkillActivation): void {
    observeExplicitSkillActivation(this.detector, skill)
    this.sync()
  }

  private observe(call: AttributionToolCall | undefined): void {
    const observed = observeToolCallForAttribution(this.detector, call)
    if (observed.skillHit) this.pendingSync = true
    if (observed.writePath) this.writePaths.add(observed.writePath)
  }

  private flushPendingSync(): void {
    if (!this.pendingSync) return
    this.pendingSync = false
    this.sync()
  }

  /** Entry point for one raw `[mode, data]` chunk off the agent stream. */
  onStreamChunk(mode: string, data: unknown): void {
    try {
      if (mode === "messages") this.onMessagesPayload(data)
      else if (mode === "values") this.onValuesPayload(data)
    } catch (error) {
      // Attribution is a side effect of the turn; it must never break the run.
      console.error("[TurnAttribution] stream observation failed:", error)
    }
  }

  private onMessagesPayload(payload: unknown): void {
    const [message] = (Array.isArray(payload) ? payload : []) as [SerializedStreamMessage?]
    if (!isAssistantMessage(message)) return
    for (const call of toolCallsOf(message)) this.observe(call)
    this.flushPendingSync()
  }

  private onValuesPayload(payload: unknown): void {
    const state = payload as {
      skillsMetadata?: Array<{ name?: string; path?: string }>
      messages?: SerializedStreamMessage[]
    }
    const skillsMetadata = Array.isArray(state?.skillsMetadata) ? state.skillsMetadata : []
    if (skillsMetadata.length > 0) {
      this.detector.onSkillsMetadata(skillsMetadata)
      this.pendingSync = true
    }
    const messages = Array.isArray(state?.messages) ? state.messages : []
    for (let i = this.turnStartIndex(messages); i < messages.length; i += 1) {
      const message = messages[i]
      if (!isAssistantMessage(message)) continue
      for (const call of toolCallsOf(message)) this.observe(call)
    }
    this.flushPendingSync()
  }

  /**
   * A `values` snapshot carries the whole thread, so attribution must start at
   * this turn's user message — otherwise an earlier turn's read_file would
   * re-attribute its skill to this one and defeat the supersede rule that the
   * sticky active-skill set implements. Falling back to the last user message
   * keeps the window right when the anchor is absent; falling back to the whole
   * snapshot is correct for a first turn, whose history is the turn itself.
   */
  private turnStartIndex(messages: SerializedStreamMessage[]): number {
    if (this.userMessageId) {
      const anchored = messages.findIndex((message) => messageId(message) === this.userMessageId)
      if (anchored >= 0) return anchored + 1
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const className = messageClassName(messages[i])
      if (className.includes("Human") || messages[i]?.kwargs?.type === "human") return i + 1
    }
    return 0
  }
}
