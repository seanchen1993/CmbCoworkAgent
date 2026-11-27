import type { DesignSystemInfo } from "./design-system"
import { formatMarketVersion, isSystemVersionCompatible } from "./design-market-semver"

/** Stable across personal and market design-system revisions; never a display name or file path. */
export function designSystemKey(system?: DesignSystemInfo | null): string | null {
  if (!system) return null
  if (system.ownership === "market" && system.marketSystemId) {
    return `market:${system.marketSystemId}`
  }
  return system.libraryId ? `user:${system.libraryId}` : `builtin:${system.id}`
}

export function normalizeTemplateSystemKey(value: unknown): string | null {
  if (value == null) return null
  if (
    typeof value !== "string" ||
    value.length > 200 ||
    !/^(builtin|user|market):[^\s/\\:\0]+$/.test(value)
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

export interface TemplateSystemCompatibility {
  visible: boolean
  compatible: boolean
  reason?: string
}

export function checkTemplateSystemCompatibility(
  template: {
    designSystemKey?: string | null
    marketMinSystemVersion?: string | null
  },
  currentSystem?: DesignSystemInfo | null
): TemplateSystemCompatibility {
  if (template.designSystemKey == null) {
    return { visible: true, compatible: true }
  }
  const currentKey = designSystemKey(currentSystem)
  if (!currentSystem || !currentKey || template.designSystemKey !== currentKey) {
    return { visible: false, compatible: false }
  }
  if (template.marketMinSystemVersion) {
    if (currentSystem.ownership !== "market" || !currentSystem.marketVersion) {
      return {
        visible: true,
        compatible: false,
        reason: `需要所属设计系统 ${formatMarketVersion(template.marketMinSystemVersion)} 及以上兼容版本`
      }
    }
    if (!isSystemVersionCompatible(currentSystem.marketVersion, template.marketMinSystemVersion)) {
      return {
        visible: true,
        compatible: false,
        reason: `最低适配 ${formatMarketVersion(template.marketMinSystemVersion)}（当前 ${formatMarketVersion(currentSystem.marketVersion)}）`
      }
    }
  }
  return { visible: true, compatible: true }
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
  previewImageDataUrl?: string
  pages?: string[]
  source?: "builtin" | "local" | "market"
  marketTemplateId?: string
  marketSystemId?: string
  marketVersion?: string
  marketVersionId?: string
  marketMinSystemVersion?: string
  marketOwnerName?: string
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
  source?: "builtin" | "local" | "market"
  marketTemplateId?: string
  marketSystemId?: string
  marketVersion?: string
  marketVersionId?: string
  marketMinSystemVersion?: string
  marketOwnerName?: string
  previewImageDataUrl?: string
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
