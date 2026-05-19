import { BrowserWindow } from "electron"
import type { AgentTrace } from "../trace/types"
import { evaluateTraceResults } from "./result-evaluator"
import { appendSkillResultEvalRecords } from "./result-store"
import type { SkillResultEvalRecord } from "../../../shared/skill-eval-types"

function parseSkill(raw: string): { skillName: string; skillVersion?: string } {
  const text = String(raw || "").trim()
  const match = text.match(/^(.*?)-(v\d+(?:\.\d+){0,3})$/)
  if (!match) return { skillName: text || "unknown" }
  return { skillName: match[1] || text, skillVersion: match[2] }
}

function skillVersionKey(skillName: string, skillVersion?: string): string {
  return `${skillName}:${skillVersion ?? ""}`
}

function notifySkillResultEvalUpdated(traceId: string, recordCount: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send("skillEval:resultUpdated", { traceId, recordCount })
  }
}

function failedRecordsForTrace(trace: AgentTrace, error: unknown): SkillResultEvalRecord[] {
  if (!Array.isArray(trace.usedSkills) || trace.usedSkills.length === 0) return []
  const evaluatedAt = new Date().toISOString()
  const message = error instanceof Error ? error.message : String(error)
  return trace.usedSkills.map((rawSkillName) => {
    const { skillName, skillVersion } = parseSkill(rawSkillName)
    return {
      id: `${trace.traceId}:${skillVersionKey(skillName, skillVersion)}:result`,
      traceId: trace.traceId,
      threadId: trace.threadId,
      skillName,
      ...(skillVersion ? { skillVersion } : {}),
      rawSkillName,
      status: "failed",
      score: 0,
      pass: false,
      checks: [
        {
          name: "result_eval_completed",
          label: "结果评估完成",
          ok: false,
          weight: 1,
          detail: { error: message }
        }
      ],
      artifacts: [],
      evidence: {
        finalResponseLength: 0,
        changedFiles: [],
        validationCommands: [],
        artifactSignals: [],
        dangerousCommands: [],
        subagentRuns: 0,
        subagentCompleted: 0,
        subagentFailed: 0,
        subagentResultLength: 0,
        toolResultErrors: 0,
        errorNodes: 0,
        modelCallCount: Array.isArray(trace.modelCalls) ? trace.modelCalls.length : 0,
        toolCallCount: typeof trace.totalToolCalls === "number" ? trace.totalToolCalls : 0
      },
      issues: [`结果评估失败: ${message}`],
      warnings: [],
      startedAt: trace.startedAt,
      endedAt: trace.endedAt,
      evaluatedAt
    }
  })
}

export function recordSkillResultEvalForTrace(trace: AgentTrace): void {
  void Promise.resolve()
    .then(() => {
      const records = evaluateTraceResults(trace)
      if (records.length === 0) return
      appendSkillResultEvalRecords(records)
      notifySkillResultEvalUpdated(trace.traceId, records.length)
    })
    .catch((error) => {
      console.warn(`[SkillEval] Failed to evaluate result for trace ${trace.traceId}:`, error)
      const failedRecords = failedRecordsForTrace(trace, error)
      if (failedRecords.length === 0) return
      appendSkillResultEvalRecords(failedRecords)
      notifySkillResultEvalUpdated(trace.traceId, failedRecords.length)
    })
}
