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
  errorCount: number
  score: number
  pass: boolean
  checks: SkillEvalCheck[]
  warnings: string[]
}

export interface SkillEvalSkillSummary {
  skillName: string
  skillVersion?: string
  runs: number
  passRate: number
  averageScore: number
  averageToolCalls: number
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
  averageToolCalls: number
  averageDurationMs: number
  skills: SkillEvalSkillSummary[]
  recent: SkillEvalRecord[]
}

export interface SkillEvalListOptions {
  limit?: number
  skillName?: string
  threadId?: string
  pass?: boolean
}
