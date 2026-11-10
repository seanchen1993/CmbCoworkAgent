import type { DesignSystemInfo } from "./design-system"

/** Stable across personal design-system revisions; never a display name or file path. */
export function designSystemKey(system?: DesignSystemInfo | null): string | null {
  if (!system) return null
  return system.libraryId ? `user:${system.libraryId}` : `builtin:${system.id}`
}

export function normalizeTemplateSystemKey(value: unknown): string | null {
  if (value == null) return null
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^(builtin|user):[^\s/\\:\0]+$/.test(value)
  )
    throw new Error("模板关联的设计系统无效")
  return value
}

export function isTemplateVisible(
  template: { designSystemKey?: string | null },
  currentSystemKey: string | null
): boolean {
  return template.designSystemKey == null || template.designSystemKey === currentSystemKey
}

export interface DesignTemplateReference {
  id: string
  entryPath: string
}

export interface DesignTemplateInfo {
  designSystemKey?: string | null
  name: string
  description: string
  path: string
  mode: string
  platform: string | null
  scenario: string
  previewHtml: string
  previewPath: string
  package?: DesignTemplateReference
}

export interface DesignTemplateSummary extends DesignTemplateReference {
  /** Missing on legacy packages, which are public. */
  designSystemKey?: string | null
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
  importTemplate: (
    source: "file" | "directory",
    designSystemKey?: string | null
  ) => Promise<DesignTemplateImportResult>
  updateTemplateAssociation: (
    reference: DesignTemplateReference,
    designSystemKey: string | null
  ) => Promise<DesignTemplateImportResult>
  listImportedTemplates: () => Promise<DesignTemplateSummary[]>
  readTemplate: (reference: DesignTemplateReference) => Promise<DesignTemplateImportResult>
}
