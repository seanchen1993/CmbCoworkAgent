export const DEFAULT_SKILL_EVAL_TOOL_BUDGET = 40

export interface SkillEvalCheck {
  name: string
  label: string
  ok: boolean
  weight: number
  detail?: Record<string, unknown>
}

export interface SkillEvalRecord {
  id: string
  traceId: string
  threadId: string
  skillName: string
  skillVersion?: string
  rawSkillName: string
  startedAt: string
  endedAt: string
  evaluatedAt: string
  userMessage: string
  modelId: string
  modelName?: string
  outcome: string
  durationMs: number
  totalToolCalls: number
  modelCallCount: number
  totalInputTokens: number
  totalOutputTokens: number
  promptInputTokens: number
  totalTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  peakInputTokens: number
  /** @deprecated use peakInputTokens */
  maxContextTokens?: number
  errorCount: number
  processScore: number
  outcomeScore: number
  score: number
  outcomePass: boolean
  pass: boolean
  checks: SkillEvalCheck[]
  outcomeChecks: SkillEvalCheck[]
  warnings: string[]
  outcomeWarnings: string[]
}

export interface SkillEvalSkillSummary {
  skillName: string
  skillVersion?: string
  runs: number
  passRate: number
  averageScore: number
  averageProcessScore: number
  averageOutcomeScore: number
  averageToolCalls: number
  averageModelCalls: number
  averageInputTokens: number
  averageOutputTokens: number
  averagePromptInputTokens: number
  averageTotalTokens: number
  averagePeakInputTokens: number
  averageDurationMs: number
  failures: number
  lastRunAt: string
}

export interface SkillEvalSummary {
  generatedAt: string
  totalRuns: number
  totalSkills: number
  passRate: number
  averageScore: number
  averageProcessScore: number
  averageOutcomeScore: number
  averageToolCalls: number
  averageModelCalls: number
  totalInputTokens: number
  totalOutputTokens: number
  totalPromptInputTokens: number
  totalTokens: number
  averageInputTokens: number
  averageOutputTokens: number
  averagePromptInputTokens: number
  averageTotalTokens: number
  averagePeakInputTokens: number
  averageDurationMs: number
  skills: SkillEvalSkillSummary[]
  recent: SkillEvalRecord[]
}

export interface SkillEvalListOptions {
  limit?: number
  skillName?: string
  skillVersion?: string
  threadId?: string
  pass?: boolean
}

export type SkillResultEvalStatus = "completed" | "failed"

export interface SkillResultArtifact {
  type: "response" | "file" | "command" | "screenshot" | "log" | "other"
  label: string
  path?: string
  url?: string
  detail?: Record<string, unknown>
}

export interface SkillResultEvidence {
  finalResponseLength: number
  changedFiles: string[]
  validationCommands: string[]
  artifactSignals: string[]
  dangerousCommands: string[]
  subagentRuns: number
  subagentCompleted: number
  subagentFailed: number
  subagentResultLength: number
  toolResultErrors: number
  errorNodes: number
  modelCallCount: number
  toolCallCount: number
}

export interface SkillResultEvalRecord {
  id: string
  traceId: string
  threadId: string
  skillName: string
  skillVersion?: string
  rawSkillName: string
  status: SkillResultEvalStatus
  score: number
  pass: boolean
  checks: SkillEvalCheck[]
  artifacts: SkillResultArtifact[]
  evidence: SkillResultEvidence
  issues: string[]
  warnings: string[]
  startedAt: string
  endedAt: string
  evaluatedAt: string
}

export interface SkillResultEvalListOptions {
  limit?: number
  skillName?: string
  skillVersion?: string
  threadId?: string
  traceId?: string
  pass?: boolean
  status?: SkillResultEvalStatus
}
