import { BrowserWindow } from "electron"
import type { AgentTrace } from "../trace/types"
import { evaluateTraceSkills } from "./evaluator"
import { appendSkillEvalRecords } from "./store"

function notifySkillEvalUpdated(traceId: string, recordCount: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    win.webContents.send("skillEval:updated", { traceId, recordCount })
  }
}

export function recordSkillEvalForTrace(trace: AgentTrace): void {
  try {
    const records = evaluateTraceSkills(trace)
    if (records.length === 0) return
    appendSkillEvalRecords(records)
    notifySkillEvalUpdated(trace.traceId, records.length)
  } catch (error) {
    console.warn("[SkillEval] Failed to evaluate trace:", error)
  }
}
