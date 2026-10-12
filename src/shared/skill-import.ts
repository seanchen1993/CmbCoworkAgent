export const SKILL_IMPORT_MAX_BYTES = 5 * 1024 * 1024
export const SKILL_IMPORT_MARKDOWN_BYTES = 256 * 1024

export interface SkillImportPreview {
  name: string
  description: string
  compatibility: string
  dependencies?: import("./skill-dependencies").SkillDependencyDeclaration
  markdown: string
  resourceCount: number
  hasHooks: boolean
  unsupportedBotHooks: string[]
  sha256: string
}

export interface SkillImportFile {
  buffer: ArrayBuffer
  fileName: string
}

export type SkillImportResult =
  | { success: true; preview: SkillImportPreview; file: SkillImportFile }
  | { success: false; error: string }

export type SkillImportRequest = { kind: "url"; url: string } | ({ kind: "file" } & SkillImportFile)
