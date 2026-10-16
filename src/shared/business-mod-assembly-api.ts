import type {
  BusinessModAssemblyRequest,
  BusinessModCopy,
  BusinessModExport,
  BusinessModInspection,
  BusinessModPreview
} from "./business-mods"

export interface BusinessModScope {
  threadId: string
  expectedWorkspace: string
}
export interface BusinessModSource {
  pluginId: string
  name: string
  description?: string
}
export interface BusinessModCopyRequest extends BusinessModScope {
  copyId: string
  expectedDigest: string
}
export interface BusinessModAssemblyApi {
  sources(input: BusinessModScope): Promise<BusinessModSource[]>
  inspect(input: BusinessModScope & { pluginId?: string }): Promise<BusinessModInspection | null>
  preview(
    input: BusinessModScope & { request: BusinessModAssemblyRequest }
  ): Promise<BusinessModPreview>
  create(
    input: BusinessModScope & { previewId: string; requestId: string }
  ): Promise<BusinessModCopy>
  list(input: BusinessModScope): Promise<BusinessModCopy[]>
  check(input: BusinessModCopyRequest): Promise<BusinessModCopy>
  install(input: BusinessModCopyRequest): Promise<BusinessModCopy>
  export(input: BusinessModCopyRequest): Promise<BusinessModExport | null>
}
