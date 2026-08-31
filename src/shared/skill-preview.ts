export interface SkillPreviewGrantRequest {
  id: string
  name: string
  source: "user" | "project"
  pluginId?: string
}

export type SkillPreviewGrantResult =
  | { success: true; grant: string; filePath: string }
  | { success: false; error: string }
