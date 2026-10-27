export interface DesignTemplateReference {
  id: string
  entryPath: string
}

export interface DesignTemplateSummary extends DesignTemplateReference {
  name: string
  sourceKind: "html" | "zip" | "directory"
  importedAt: string
  pages: string[]
  files: string[]
  totalBytes: number
  framework: string
}

export interface DesignTemplatePackage extends DesignTemplateSummary {
  rootDir: string
  html: string
  warnings: string[]
  previewUrl?: string
}

export interface DesignTemplateImportResult {
  canceled?: boolean
  template?: DesignTemplatePackage
  error?: string
}

export interface DesignTemplateApi {
  importTemplate: (source: "file" | "directory") => Promise<DesignTemplateImportResult>
  listImportedTemplates: () => Promise<DesignTemplateSummary[]>
  readTemplate: (reference: DesignTemplateReference) => Promise<DesignTemplateImportResult>
}
