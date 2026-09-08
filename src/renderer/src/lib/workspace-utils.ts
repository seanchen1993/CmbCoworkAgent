import { toast } from "sonner"
import { loadWorkspaceFilesDeduped, markWorkspaceFilesStale } from "./workspace-file-load"

export type WorkspaceSelectionResult =
  | { status: "success"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string }

export function getWorkspaceSelectionErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message.trim()
      : typeof error === "string"
        ? error.trim()
        : ""
  return message || "切换工作区失败，请重试。"
}

export async function selectWorkspaceFolder(
  currentThreadId: string | null,
  setWorkspacePath: (path: string | null) => void,
  setWorkspaceFiles: (files: Array<{ path: string; is_dir?: boolean; size?: number }>) => void,
  setLoading: (loading: boolean) => void,
  setOpen?: (open: boolean) => void
): Promise<WorkspaceSelectionResult> {
  if (!currentThreadId) return { status: "cancelled" }
  setLoading(true)
  try {
    const path = await window.api.workspace.select(currentThreadId)
    if (!path) {
      return { status: "cancelled" }
    }
    setWorkspacePath(path)
    markWorkspaceFilesStale(currentThreadId, path)
    const result = await loadWorkspaceFilesDeduped(currentThreadId, path, {
      requestTrailingRescan: true
    })
    if (result.success && result.files) {
      setWorkspaceFiles(result.files)
    }
    if (setOpen) setOpen(false)
    return { status: "success", path }
  } catch (e) {
    console.error("[WorkspacePicker] Select folder error:", e)
    const message = getWorkspaceSelectionErrorMessage(e)
    toast.error(message)
    return { status: "error", message }
  } finally {
    setLoading(false)
  }
}
