import type { DerivationFile } from "./derivation-source"
import { parseSkillNameFromFrontmatterYaml } from "../skills/frontmatter"

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/** Static differences and external bindings, never execution or semantic-equivalence proof. */
export function businessModIntegrityDiagnostics(
  board: Record<string, unknown>,
  files: readonly DerivationFile[],
  skillSearchRoots: readonly string[] = ["skills"]
): {
  diagnostics: string[]
  requiresFixedWorkflowAcknowledgement: boolean
  missingProviders: string[]
} {
  const diagnostics: string[] = []
  const missingProviders: string[] = []
  const knowledge = object(board.knowledge_config)
  const action = object(knowledge?.nextAction)
  if (typeof action?.slashSkill === "string") {
    const skill = action.slashSkill
    const found = files.some(
      (file) =>
        skillSearchRoots.some((root) => file.path.startsWith(`${root}/`)) &&
        /(?:^|\/)SKILL\.md$/i.test(file.path) &&
        (file.path.endsWith(`/${skill}/SKILL.md`) ||
          parseSkillNameFromFrontmatterYaml(file.bytes.toString("utf8")) === skill)
    )
    if (!found) {
      missingProviders.push(skill)
      diagnostics.push(
        `依赖未提供：知识入口引用 Skill ${skill.slice(0, 100)}，生成包未包含该实现；需绑定真实提供者，不能将入口当作可执行能力。`
      )
    }
  }
  const commands = object(board.inspectCommands)
  if (commands) {
    const roots = new Set(
      Object.values(commands).flatMap((value) => {
        const config = object(value),
          target = config?.knowledge_path
        if (typeof target !== "string") return []
        const portableTarget = target.replace(/\\/g, "/")
        if (!portableTarget.startsWith("${pluginPath}/")) return []
        const relative = portableTarget
          .slice("${pluginPath}/".length)
          .replace(/\\/g, "/")
          .replace(/\/$/, "")
        if (!relative || relative.split("/").some((part) => part === ".." || part === "."))
          return []
        return files.some((file) => file.path === relative || file.path.startsWith(relative + "/"))
          ? []
          : [relative]
      })
    )
    for (const root of roots)
      diagnostics.push(
        `外部知识待绑定：${root.slice(0, 100)} 不在生成源码中；安装或生成成功不代表知识已装载，必需知识应在运行前核对。`
      )
  }
  return { diagnostics, requiresFixedWorkflowAcknowledgement: false, missingProviders }
}
