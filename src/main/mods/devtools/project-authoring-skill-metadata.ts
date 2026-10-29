import type { AuthoringSourceBundle } from "./authoring-bundle"
import {
  nativeCompositionSchema,
  NATIVE_COMPOSITION_PATH,
  type NativeComposition
} from "../../plugins/native-composition"
import { parseSkillFrontmatter } from "../../skills/frontmatter"

export interface ProjectAuthoringSkillDiagnostic {
  readonly code: "PROJECT_SKILL_FRONTMATTER"
  readonly path: string
  readonly declarationPath: string
  readonly field: "name" | "description"
  readonly reason: "missing" | "empty" | "not-string"
  readonly message: string
}

/** New creator validation only. Retained Host execution and package reproduction stay compatible. */
export function projectAuthoringSkillDiagnostics(
  source: AuthoringSourceBundle
): readonly ProjectAuthoringSkillDiagnostic[] {
  const native = source.files.find((file) => file.path === NATIVE_COMPOSITION_PATH)
  if (!native) return []
  let composition: NativeComposition
  try {
    composition = nativeCompositionSchema.parse(JSON.parse(native.text))
  } catch {
    // Existing source/compile validation owns malformed composition declarations.
    return []
  }
  const diagnostics: ProjectAuthoringSkillDiagnostic[] = []
  for (const [index, module] of composition.modules.entries()) {
    const file = source.files.find((item) => item.path === module.skill)
    if (!file) continue
    const { frontmatter } = parseSkillFrontmatter(file.text)
    for (const field of ["name", "description"] as const) {
      const value = frontmatter[field]
      const reason = !Object.hasOwn(frontmatter, field)
        ? "missing"
        : typeof value !== "string"
          ? "not-string"
          : !value.trim()
            ? "empty"
            : undefined
      if (!reason || diagnostics.length >= 16) continue
      const safePath =
        module.skill.length <= 240 && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(module.skill)
      diagnostics.push(
        Object.freeze({
          code: "PROJECT_SKILL_FRONTMATTER",
          path: safePath ? module.skill : NATIVE_COMPOSITION_PATH,
          declarationPath: `/modules/${index}/skill`,
          field,
          reason,
          message: `新作者 Skill 的 YAML frontmatter 必须包含非空字符串 ${field}；请在对应作者源文件补填真实用途，再用最新 revision 编译。此诊断不表示存量 Host 固定路径技能不能执行。`
        })
      )
    }
  }
  return Object.freeze(diagnostics)
}

export class ProjectAuthoringSkillMetadataError extends Error {
  readonly diagnostics: readonly ProjectAuthoringSkillDiagnostic[]

  constructor(source: AuthoringSourceBundle) {
    super("PROJECT_AUTHORING_SKILL_METADATA_INVALID")
    this.diagnostics = projectAuthoringSkillDiagnostics(source)
    Object.defineProperty(this, "diagnostics", { writable: false, configurable: false })
  }
}

export function assertProjectAuthoringSkillMetadata(source: AuthoringSourceBundle): void {
  const error = new ProjectAuthoringSkillMetadataError(source)
  if (error.diagnostics.length) throw error
}
