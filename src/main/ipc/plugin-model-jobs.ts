import { IpcMain } from "electron"
import type { BackgroundJobListOptions, BackgroundJobStatusRecord } from "../../shared/plugin-model-jobs"
import { getPluginModelJob, listPluginModelJobs } from "../services/plugin-model-jobs"

function normalizeOptions(options: BackgroundJobListOptions | undefined): BackgroundJobListOptions {
  return {
    ...options,
    workspace: typeof options?.workspace === "string" && options.workspace.trim() ? options.workspace : undefined,
    pluginId: typeof options?.pluginId === "string" && options.pluginId.trim() ? options.pluginId : undefined,
    type: typeof options?.type === "string" && options.type.trim() ? options.type : undefined,
    limit: typeof options?.limit === "number" ? options.limit : 50
  }
}

export function registerPluginModelJobHandlers(ipcMain: IpcMain): void {
  ipcMain.handle("pluginJobs:list", async (_event, options?: BackgroundJobListOptions): Promise<BackgroundJobStatusRecord[]> => {
    const normalized = normalizeOptions(options)
    if (!normalized.workspace) return []
    return listPluginModelJobs(normalized)
  })

  ipcMain.handle(
    "pluginJobs:get",
    async (
      _event,
      params: { workspace?: string; pluginId?: string; jobId?: string }
    ): Promise<BackgroundJobStatusRecord | null> => {
      const workspace = params?.workspace?.trim()
      const pluginId = params?.pluginId?.trim()
      const jobId = params?.jobId?.trim()
      if (!workspace || !pluginId || !jobId) return null
      return getPluginModelJob(workspace, pluginId, jobId)
    }
  )
}
