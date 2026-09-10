import {
  getThreadActiveSkills,
  getThreadActiveSkillSource,
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
function codeGenAttributionSkills(threadId: string, currentRunSkills: string[]): string[] {
  if (currentRunSkills.length > 0) return currentRunSkills
  return getThreadActiveSkills(threadId)
}

function codeGenAttributionSkillSource(
  threadId: string,
  currentRunSkills: string[],
  currentRunSkillSource: string[]
): string[] {
  if (currentRunSkills.length > 0) return currentRunSkillSource
  return getThreadActiveSkillSource(threadId)
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
  setAdoptionContext(threadId, {
    usedSkills: codeGenAttributionSkills(threadId, currentRunSkills),
    skillSource: codeGenAttributionSkillSource(threadId, currentRunSkills, currentRunSkillSource)
  })
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
