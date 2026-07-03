import { IpcMain } from "electron"
import { readLocalCommitAdoptionLines } from "../services/adoption-tracker"

/**
 * Local (current-machine) line-level adoption 溯源. Distinct from the cloud
 * `dashboard:*` channels: this reads the local sqlite hashes + `git show` to
 * reconstruct which committed lines a generation was credited for. Only the
 * current user's own recent commits resolve; everything else degrades to
 * `available: false` per gen.
 */
export function registerAdoptionTraceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(
    "adoption:commitLines",
    async (_event, commitSha: string, genEventIds: string[]) => {
      try {
        const data = await readLocalCommitAdoptionLines(commitSha, genEventIds)
        return { success: true, data }
      } catch (e) {
        console.error("[AdoptionTrace] commitLines error:", e)
        return { success: false, error: e instanceof Error ? e.message : String(e) }
      }
    }
  )
}
