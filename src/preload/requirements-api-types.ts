import type { RequirementRuntimeItem } from "../main/ipc/requirements"

type RequirementResult = {
  success: boolean
  requirement?: RequirementRuntimeItem
  error?: string
}

type RequirementManifestResult = RequirementResult & {
  manifest?: RequirementRuntimeItem["prdManifest"]
}

export interface RequirementsApi {
  list: () => Promise<RequirementRuntimeItem[]>
  getToken: () => Promise<{ success: boolean; token: string; error?: string }>
  saveToken: (token: string) => Promise<{ success: boolean; error?: string }>
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
      backgroundUrls?: string[]
    }
  }) => Promise<RequirementResult>
  getWorkDir: () => Promise<string | null>
  createDesignWorkspace: (payload: { requirementId: string; title: string }) => Promise<{
    success: boolean
    workspacePath?: string | null
    error?: string
  }>
  importHtml: (payload: { requirementId: string; title: string }) => Promise<{
    success: boolean
    canceled?: boolean
    htmlFile?: string
    error?: string
  }>
  deleteImportedHtml: (htmlFile: string) => Promise<{ success: boolean; error?: string }>
  selectWorkDir: () => Promise<{ success: boolean; workDir?: string | null; error?: string }>
  delete: (reqId: string) => Promise<{ success: boolean; error?: string }>
  openWorkDir: (reqId: string) => Promise<{ success: boolean; error?: string }>
  getSourcePreview: (reqId: string) => Promise<{
    success: boolean
    content?: string
    error?: string
  }>
  attachThread: (payload: {
    reqId: string
    threadId: string
    development?: boolean
  }) => Promise<RequirementResult>
  detachThread: (payload: { reqId: string; threadId: string }) => Promise<RequirementResult>
  resetDevelopment: (reqId: string) => Promise<
    RequirementResult & {
      threadIds?: string[]
    }
  >
  beginManifestSync: (payload: { reqId: string; threadId: string; requestId: string }) => Promise<{
    success: boolean
    error?: string
  }>
  rename: (payload: { reqId: string; title: string }) => Promise<RequirementResult>
  updateSystem: (payload: { reqId: string; systemId: string }) => Promise<RequirementResult>
  saveDesignState: (payload: {
    reqId: string
    needDesign: "" | "0" | "1"
    functions: Array<{
      fr: string
      file: string
      htmlFile: string
      needDesign: "" | "0" | "1"
    }>
  }) => Promise<
    RequirementManifestResult & {
      manifestStatus?: "updated" | "missing" | "invalid"
      manifestError?: string
    }
  >
  clearDesign: (payload: {
    reqId: string
    function?: { fr: string; file: string }
    functions?: Array<{ fr: string; file: string }>
  }) => Promise<RequirementManifestResult>
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
  }) => Promise<RequirementResult>
  savePrdFile: (payload: {
    reqId: string
    filePath: string
    content: string
  }) => Promise<{ success: boolean; error?: string }>
  uploadPrdAsset: (payload: {
    reqId: string
    prdFilePath: string
    fileName: string
    bytes: ArrayBuffer
  }) => Promise<{
    success: boolean
    relativePath?: string
    error?: string
  }>
  readPrdImage: (payload: { reqId: string; filePath: string }) => Promise<{
    success: boolean
    bytes?: Uint8Array<ArrayBuffer>
    mimeType?: string
    error?: string
  }>
  readPrdHtml: (payload: { reqId: string; filePath: string }) => Promise<{
    success: boolean
    content?: string
    error?: string
  }>
  syncPrototypeToPrd: (payload: {
    reqId: string
    prdFilePath: string
    prototypeFilePath: string
    workspacePath: string
  }) => Promise<{
    success: boolean
    relativePath?: string
    error?: string
  }>
  getFunctionHtml: (payload: { workspacePath: string; requirementFilePath: string }) => Promise<{
    success: boolean
    htmlFile?: string
    htmlId?: string
    error?: string
  }>
  updateFunctionHtml: (payload: {
    reqId: string
    workspacePath: string
    requirementFilePath: string
    requirementFilePaths?: string[]
    htmlFile?: string
    htmlId: string
    fullPrd?: boolean
  }) => Promise<{
    success: boolean
    htmlFile?: string
    htmlId?: string
    error?: string
  }>
  syncManifest: (payload: {
    reqId: string
    manifest: unknown
    threadId?: string
    requestId?: string
  }) => Promise<RequirementManifestResult>
  saveFiles: (payload: {
    workspacePath: string
    requirementId: string
    source?: { filename: string; sourcePath?: string; content?: string }
    prd?: { filename: string; content: string }
  }) => Promise<{ success: boolean; sourcePath?: string; prdPath?: string; error?: string }>
}
