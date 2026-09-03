import type { AgentProfile } from "../agent-registry"
import { discoverSkills } from "../../skills/discovery"
import { ANALYST_PROFILE } from "./analyst"
import { resolve } from "path"

/**
 * Restriction profile for the requirement-management conversation mode.
 *
 * The runtime reads this config to filter the subagent profiles the main
 * agent may call via the task tool, and the skills the main agent may
 * invoke. Everything else in requirement mode (System Prompt, tool gating,
 * coordinator bypass) is driven by the `requirementMode` flag plumbed
 * through `CreateAgentRuntimeOptions` / `createDeepAgent`.
 *
 * Extend requirement mode by appending entries to the arrays below — the
 * runtime never needs to change. Keep this list curated: every entry here
 * is what the requirement-mode main agent is allowed to use, nothing more.
 */
export interface RestrictedModeConfig {
  /** Subagent profiles the main agent may call via the task tool. */
  readonly subagentProfiles: readonly AgentProfile[]
  /** Skill names the main agent may invoke. Empty = no skills. */
  readonly skillNames: readonly string[]
}

export const REQUIREMENT_MODE_CONFIG: RestrictedModeConfig = {
  subagentProfiles: [ANALYST_PROFILE],
  skillNames: ["requirement-to-prd"]
}

export const REQUIREMENT_MODE_SYSTEM_PROMPT = `## Requirement Mode
You are handling one requirement-management conversation only.

Allowed work: understand the current requirement, inspect its requirement workspace, clarify business rules, assess scope and acceptance criteria, generate or review PRD documents through the requirement-to-prd skill, and publish only after explicit user authorization.

Recognized in-conversation commands (these are legitimate requirement-mode operations; do NOT reject them as unrelated):
- "发布到需求空间" — explicit user authorization to publish the current PRD to the requirement space. Proceed with the publish workflow via the requirement-to-prd skill.
- "精益之星身份令牌-Token：" — user-provided Leanstar authentication token for the publishing workflow. Use this token when the publish workflow requires authentication.

Do not write application code, design UI, run Git operations, create schedules, or answer unrelated questions. When a request is outside the current requirement, reply exactly: "当前处于需求模式，请补充、澄清、评审或确认当前需求；其他任务请新建普通会话。"

Before any PRD work, call the task subagent with subagent_type="analyst". Give it the current requirement and ask for missing questions, scope risks, assumptions, edge cases, and pass/fail acceptance criteria. When source materials exist, ask it to inspect them; for a text requirement, analyze the stated goal and identify the first questions needed to discover the requirement through conversation. Use its findings to drive clarification. Do not treat analyst suggestions as user-confirmed decisions.

Use the requirement-to-prd skill for PRD work. Do not generate a formal PRD before the user has confirmed the initial PRD. Do not publish unless the user has explicitly authorized publication after the formal PRD is ready.`

export function getRequirementRuntimeOptions(metadata: Record<string, unknown>): {
  requirementMode: boolean
  runtimeOptions: Record<string, unknown>
} {
  const requirementMode =
    typeof metadata.requirementId === "string" && metadata.requirementId.trim().length > 0
  return {
    requirementMode,
    runtimeOptions: requirementMode
      ? {
          requirementMode: true,
          extraSystemPrompt: REQUIREMENT_MODE_SYSTEM_PROMPT,
          enableAgentsPrompt: false,
          noSchedulerTool: true,
          disableSubagents: false
        }
      : {}
  }
}

export async function resolveRequirementSkillRootDirs(sourceDirs: string[]): Promise<string[]> {
  return Array.from(
    new Map(
      (await Promise.all(sourceDirs.map((source) => discoverSkills(source))))
        .flat()
        .filter((skill) => REQUIREMENT_MODE_CONFIG.skillNames.includes(skill.name))
        .map((skill) => [resolve(skill.rootDir), skill.rootDir])
    ).values()
  )
}

function normalizeBackendPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Restricts only SkillsMiddleware's source-directory enumeration. */
export function createRequirementSkillsBackend(
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
