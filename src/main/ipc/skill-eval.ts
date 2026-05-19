import type { IpcMain } from "electron"
import {
  clearSkillResultEvalRecords,
  getSkillResultEvalFilePath,
  listSkillResultEvalRecords
} from "../agent/skill-eval/result-store"
import {
  clearSkillEvalRecords,
  getSkillEvalFilePath,
  getSkillEvalSummary,
  listSkillEvalRecords
} from "../agent/skill-eval/store"
import type {
  SkillEvalListOptions,
  SkillEvalRecord,
  SkillEvalSummary,
  SkillResultEvalListOptions,
  SkillResultEvalRecord
} from "../../shared/skill-eval-types"

export function registerSkillEvalHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "skillEval:summary",
    async (_event, opts?: { limit?: number }): Promise<SkillEvalSummary> => {
      return getSkillEvalSummary(opts?.limit)
    }
  )

  ipcMain.handle(
    "skillEval:records",
    async (_event, opts?: SkillEvalListOptions): Promise<SkillEvalRecord[]> => {
      return listSkillEvalRecords(opts)
    }
  )

  ipcMain.handle(
    "skillEval:resultRecords",
    async (_event, opts?: SkillResultEvalListOptions): Promise<SkillResultEvalRecord[]> => {
      return listSkillResultEvalRecords(opts)
    }
  )

  ipcMain.handle("skillEval:clear", async (): Promise<void> => {
    clearSkillEvalRecords()
    clearSkillResultEvalRecords()
  })

  ipcMain.handle("skillEval:filePath", async (): Promise<string> => {
    return getSkillEvalFilePath()
  })

  ipcMain.handle("skillEval:resultFilePath", async (): Promise<string> => {
    return getSkillResultEvalFilePath()
  })
}
