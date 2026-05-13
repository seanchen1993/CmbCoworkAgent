import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { existsSync, readFileSync } from "fs"
import { v4 as uuid } from "uuid"
import type { AgentTrace } from "../trace/types"
import { getCustomSkillsDir } from "../../storage"
import type { SkillOptimizationCandidate } from "./skill-optimizer"
import { discoverSkillsSync } from "../../skills/discovery"
import { getDiscoveredSkillId } from "../../skills/ids"

export type TraceRunStatus = "pending" | "running" | "completed" | "failed"

export interface TraceOptimizerRunProgress {
  runId: string
  traceId: string
  index: number
  total: number
  status: TraceRunStatus
  message?: string
  candidateCount?: number
}

export interface TraceOptimizerAgentResult {
  candidates: SkillOptimizationCandidate[]
  tracesAnalyzed: number
  failedTraceIds: string[]
}

interface TraceOptimizerAgentOptions {
  runId: string
  model: ChatOpenAI
  traces: AgentTrace[]
  emitProgress?: (event: TraceOptimizerRunProgress) => void
}

const SUBAGENT_SYSTEM_PROMPT = `You are a task subagent that analyzes exactly one AI agent trace.

Your task:
1. Understand what the agent did in this trace.
2. Decide whether a reusable skill should be created or updated.
3. Output ONLY JSON array with zero or more proposals.

JSON schema:
[
  {
    "skillId": "relative_path_identifier",
    "name": "Human Readable Name",
    "description": "When this skill should be loaded.",
    "rationale": "Why this skill helps for this trace.",
    "content": "Full SKILL.md content with frontmatter",
    "action": "create"
  }
]

Rules:
- Output valid JSON only.
- Maximum 2 proposals.
- If no useful skill is needed, output [].
- Be concrete and specific.`

function readExistingCustomSkills(): string {
  const dir = getCustomSkillsDir()
  if (!existsSync(dir)) return "(no custom skills yet)"
  try {
    const skills = discoverSkillsSync(dir).map((skill) => {
      const content = readFileSync(skill.skillMdPath, "utf-8").slice(0, 400)
      return `--- ${getDiscoveredSkillId(skill)} ---\n${content}`
    })
    return skills.length ? skills.join("\n\n") : "(no custom skills yet)"
  } catch {
    return "(error reading skills)"
  }
}

function summarizeTrace(trace: AgentTrace): string {
  const stepSummaries = trace.steps
    .map((s) => {
      const tools = s.toolCalls
        .map((tc) => `${tc.name}(${JSON.stringify(tc.args).slice(0, 120)})`)
        .join("; ")
      const text = s.assistantText.slice(0, 220).replace(/\n/g, " ")
      return `Step ${s.index}: [${tools || "no tools"}] ${text}`
    })
    .join("\n")

  return `Trace ${trace.traceId}
Outcome: ${trace.outcome}
Tool calls: ${trace.totalToolCalls}
Used skills: ${trace.usedSkills.join(", ") || "(none)"}
User message: ${trace.userMessage.slice(0, 200)}
Steps:
${stepSummaries || "(none)"}`
}

function parseJson(raw: string): Array<{
  skillId: string
  name: string
  description: string
  rationale?: string
  content: string
  action?: "create" | "patch"
}> {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim()

  try {
    const parsed = JSON.parse(cleaned) as Array<{
      skillId: string
      name: string
      description: string
      rationale?: string
      content: string
      action?: "create" | "patch"
    }>
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function dedupeCandidates(candidates: SkillOptimizationCandidate[]): SkillOptimizationCandidate[] {
  const map = new Map<string, SkillOptimizationCandidate>()

  for (const candidate of candidates) {
    const existing = map.get(candidate.skillId)
    if (!existing) {
      map.set(candidate.skillId, candidate)
      continue
    }

    const mergedSource = [...new Set([...existing.sourceTraceIds, ...candidate.sourceTraceIds])]
    existing.sourceTraceIds = mergedSource
  }

  return [...map.values()]
}

export class TraceOptimizerAgent {
  private readonly runId: string
  private readonly model: ChatOpenAI
  private readonly traces: AgentTrace[]
  private readonly emitProgress?: (event: TraceOptimizerRunProgress) => void

  constructor(options: TraceOptimizerAgentOptions) {
    this.runId = options.runId
    this.model = options.model
    this.traces = options.traces
    this.emitProgress = options.emitProgress
  }

  async run(): Promise<TraceOptimizerAgentResult> {
    const allCandidates: SkillOptimizationCandidate[] = []
    const failedTraceIds: string[] = []
    const total = this.traces.length
    const existingSkills = readExistingCustomSkills()

    for (let i = 0; i < this.traces.length; i++) {
      const trace = this.traces[i]
      const index = i + 1

      this.emitProgress?.({
        runId: this.runId,
        traceId: trace.traceId,
        index,
        total,
        status: "running",
        message: `分析 trace ${index}/${total}`
      })

      try {
        const traceSummary = summarizeTrace(trace)
        const userPrompt = `# Existing Custom Skills
${existingSkills}

# Trace to optimize
${traceSummary}

Please propose at most 2 reusable skills for this trace.
Only include skills not already covered by existing skills.
Return JSON array only.`

        const response = await this.model.invoke([
          new SystemMessage(SUBAGENT_SYSTEM_PROMPT),
          new HumanMessage(userPrompt)
        ])
        const raw = typeof response.content === "string"
          ? response.content
          : JSON.stringify(response.content)
        const proposals = parseJson(raw)
        const now = new Date().toISOString()
        const converted = proposals
          .filter((p) => p.skillId && p.name && p.description && p.content)
          .map((p) => ({
            candidateId: uuid(),
            action: (p.action === "patch" ? "patch" : "create") as "patch" | "create",
            skillId: p.skillId,
            name: p.name,
            description: p.description,
            proposedContent: p.content,
            rationale: p.rationale ?? "",
            sourceTraceIds: [trace.traceId],
            generatedAt: now,
            status: "pending" as const
          }))

        allCandidates.push(...converted)

        this.emitProgress?.({
          runId: this.runId,
          traceId: trace.traceId,
          index,
          total,
          status: "completed",
          candidateCount: converted.length,
          message: `完成（${converted.length} 个候选）`
        })
      } catch (error) {
        failedTraceIds.push(trace.traceId)
        this.emitProgress?.({
          runId: this.runId,
          traceId: trace.traceId,
          index,
          total,
          status: "failed",
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return {
      candidates: dedupeCandidates(allCandidates),
      tracesAnalyzed: this.traces.length,
      failedTraceIds
    }
  }
}
