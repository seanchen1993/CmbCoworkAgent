import { discoverSkills } from "../../skills/discovery"
import { resolve } from "path"

/**
 * The default session capability preset for a newly-created requirement
 * conversation. Runtime authorization is driven by the session metadata,
 * so other conversation types can reuse it.
 */
export interface SessionCapabilityPreset {
  readonly allowedExperts: readonly string[]
  readonly allowedSkills: readonly string[]
}

export const REQUIREMENT_SESSION_CAPABILITIES: SessionCapabilityPreset = {
  allowedExperts: ["analyst"],
  allowedSkills: [
    "requirement-to-prd",
    "generate-feature",
    "publish-feature",
    "devclaw-in-app-browser"
  ]
}

export const REQUIREMENT_SYSTEM_PROMPT = `## Requirement Mode
Focus on clarifying the current requirement and producing an accurate PRD.

Before any PRD work, call the task subagent with subagent_type="analyst". Give it the current requirement and ask for missing questions, scope risks, assumptions, edge cases, and pass/fail acceptance criteria. When source materials exist, ask it to inspect them; for a text requirement, analyze the stated goal and identify the first questions needed to discover the requirement through conversation. Use its findings to drive clarification. Do not treat analyst suggestions as user-confirmed decisions.

Use the requirement-to-prd skill for PRD work. Generate the formal PRD only after the user has confirmed the requirement scope, key business rules, and outstanding questions. Publish only after the formal PRD is ready and the user has explicitly authorized publication.`

export function getRequirementRuntimeOptions(metadata: Record<string, unknown>): Record<string, unknown> {
  return typeof metadata.requirementId === "string" && metadata.requirementId.trim().length > 0
    ? { extraSystemPrompt: REQUIREMENT_SYSTEM_PROMPT }
    : {}
}

export function parseAllowedNames(metadata: Record<string, unknown>, key: string): string[] | undefined {
  const value = metadata[key]
  if (!Array.isArray(value)) return undefined
  return [
    ...new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    )
  ]
}

export async function resolveAllowedSkillRootDirs(
  sourceDirs: string[],
  allowedSkillNames: readonly string[]
): Promise<string[]> {
  const allowedNames = new Set(allowedSkillNames)
  return Array.from(
    new Map(
      (await Promise.all(sourceDirs.map((source) => discoverSkills(source))))
        .flat()
        .filter((skill) => allowedNames.has(skill.name))
        .map((skill) => [resolve(skill.rootDir), skill.rootDir])
    ).values()
  )
}

function normalizeBackendPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Restricts only SkillsMiddleware's source-directory enumeration. */
export function createAllowedSkillsBackend(
  backend: any,
  sourceDirs: string[],
  allowedSkillRootDirs: string[]
): any {
  const sourcePaths = new Set(sourceDirs.map(normalizeBackendPath))
  const allowedPaths = new Set(allowedSkillRootDirs.map(normalizeBackendPath))
  return new Proxy(backend, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== "lsInfo" || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value
      }
      return async (dirPath: string) => {
        const entries = await value.call(target, dirPath)
        if (!sourcePaths.has(normalizeBackendPath(dirPath))) return entries
        return entries.filter(
          (entry: { is_dir?: boolean; path?: string }) =>
            !entry.is_dir || (entry.path != null && allowedPaths.has(normalizeBackendPath(entry.path)))
        )
      }
    }
  })
}
