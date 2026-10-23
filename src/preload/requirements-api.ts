import { ipcRenderer } from "electron"

import type { RequirementRuntimeItem } from "../main/ipc/requirements"

export const requirementsApi = {
  list: (): Promise<RequirementRuntimeItem[]> => ipcRenderer.invoke("requirements:list"),
  getToken: () =>
    ipcRenderer.invoke("requirements:get-token") as Promise<{
      success: boolean
      token: string
      error?: string
    }>,
  saveToken: (token: string) =>
    ipcRenderer.invoke("requirements:save-token", token) as Promise<{
      success: boolean
      error?: string
    }>,
  create: (payload: {
    systemId: string
    title: string
    workDir: string
    source: {
      type: "file" | "text" | "link"
      fileName: string
      sourcePath?: string
      url?: string
      content?: string
      bytes?: ArrayBuffer
      initialDescription?: string
      attachments?: Array<{ fileName: string; bytes: ArrayBuffer }>
    }
  }) =>
    ipcRenderer.invoke("requirements:create", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      error?: string
    }>,
  getWorkDir: (): Promise<string | null> => ipcRenderer.invoke("requirements:get-work-dir"),
  selectWorkDir: (): Promise<{ success: boolean; workDir?: string | null; error?: string }> =>
    ipcRenderer.invoke("requirements:select-work-dir"),
  delete: (reqId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("requirements:delete", reqId),
  openWorkDir: (reqId: string): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke("requirements:open-work-dir", reqId),
  getSourcePreview: (reqId: string) =>
    ipcRenderer.invoke("requirements:get-source-preview", reqId) as Promise<{
      success: boolean
      content?: string
      error?: string
    }>,
  attachThread: (payload: { reqId: string; threadId: string }) =>
    ipcRenderer.invoke("requirements:attach-thread", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      error?: string
    }>,
  detachThread: (payload: { reqId: string; threadId: string }) =>
    ipcRenderer.invoke("requirements:detach-thread", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      error?: string
    }>,
  beginManifestSync: (payload: { reqId: string; threadId: string; requestId: string }) =>
    ipcRenderer.invoke("requirements:begin-manifest-sync", payload) as Promise<{
      success: boolean
      error?: string
    }>,
  rename: (payload: { reqId: string; title: string }) =>
    ipcRenderer.invoke("requirements:rename", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      error?: string
    }>,
  saveStepState: (payload: {
    reqId: string
    needDesign: "" | "0" | "1"
    currentStep: number
    functions: Array<{
      fr: string
      file: string
      htmlFile: string
      needDesign: "" | "0" | "1"
    }>
  }) =>
    ipcRenderer.invoke("requirements:save-step-state", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      manifestStatus?: "updated" | "missing" | "invalid"
      manifest?: RequirementRuntimeItem["prdManifest"]
      manifestError?: string
      error?: string
    }>,
  savePrd: (payload: {
    reqId: string
    version: string
    modules: Array<{
      moduleId: string
      name: string
      content: string
      description?: string
      keywords?: string[]
    }>
  }) =>
    ipcRenderer.invoke("requirements:save-prd", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      error?: string
    }>,
  savePrdFile: (payload: { reqId: string; filePath: string; content: string }) =>
    ipcRenderer.invoke("requirements:save-prd-file", payload) as Promise<{
      success: boolean
      error?: string
    }>,
  getFunctionHtml: (payload: { workspacePath: string; requirementFilePath: string }) =>
    ipcRenderer.invoke("requirements:get-function-html", payload) as Promise<{
      success: boolean
      htmlFile?: string
      htmlId?: string
      error?: string
    }>,
  updateFunctionHtml: (payload: {
    reqId: string
    workspacePath: string
    requirementFilePath: string
    htmlFile: string
    htmlId: string
  }) =>
    ipcRenderer.invoke("requirements:update-function-html", payload) as Promise<{
      success: boolean
      htmlFile?: string
      htmlId?: string
      error?: string
    }>,
  syncManifest: (payload: {
    reqId: string
    manifest: unknown
    threadId?: string
    requestId?: string
  }) =>
    ipcRenderer.invoke("requirements:sync-manifest", payload) as Promise<{
      success: boolean
      requirement?: RequirementRuntimeItem
      manifest?: RequirementRuntimeItem["prdManifest"]
      error?: string
    }>,
  saveFiles: (payload: {
    workspacePath: string
    requirementId: string
    source?: { filename: string; sourcePath?: string; content?: string }
    prd?: { filename: string; content: string }
  }): Promise<{ success: boolean; sourcePath?: string; prdPath?: string; error?: string }> =>
    ipcRenderer.invoke("requirements:save-files", payload) as Promise<{
      success: boolean
      sourcePath?: string
      prdPath?: string
      error?: string
    }>
}
