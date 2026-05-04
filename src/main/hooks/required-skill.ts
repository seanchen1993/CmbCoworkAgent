import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { getEnabledSkillsSources } from "../storage"
import { runHooks } from "./runner"
import { joinHookText } from "./text"
import type { HookResult } from "./types"

const MAX_REQUIRED_SKILL_CHARS = 12_000

interface ResolvedSkillGuidance {
  name: string
  path: string
  content: string
}

function parseYamlFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return {}

  const yaml = match[1]
  const result: Record<string, string> = {}
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx <= 0) continue
    const key = line.slice(0, colonIdx).trim()
    const value = line.slice(colonIdx + 1).trim()
    result[key] = value
  }
  return result
}

function trimSkillContent(content: string): string {
  if (content.length <= MAX_REQUIRED_SKILL_CHARS) return content
  return `${content.slice(0, MAX_REQUIRED_SKILL_CHARS)}\n\n[skill content truncated at ${MAX_REQUIRED_SKILL_CHARS} chars]`
}

async function resolveSkillGuidance(requiredSkill: string): Promise<ResolvedSkillGuidance | null> {
  const normalized = requiredSkill.trim().toLowerCase()
  if (!normalized) return null

  const sourceDirs = await getEnabledSkillsSources()
  for (const sourceDir of sourceDirs) {
    if (!existsSync(sourceDir)) continue

    let entries
    try {
      entries = await readdir(sourceDir, { withFileTypes: true, encoding: "utf8" })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const skillMdPath = path.join(sourceDir, entry.name, "SKILL.md")
      if (!existsSync(skillMdPath)) continue

      try {
        const content = await readFile(skillMdPath, "utf-8")
        const frontmatter = parseYamlFrontmatter(content)
        const skillName = (frontmatter.name || entry.name).trim()
        const candidates = new Set([
          entry.name.trim().toLowerCase(),
          skillName.toLowerCase()
        ])
        if (!candidates.has(normalized)) continue

        return {
          name: skillName,
          path: skillMdPath,
          content: trimSkillContent(content)
        }
      } catch {
        continue
      }
    }
  }

  return null
}

function formatResolvedSkillGuidance(skill: ResolvedSkillGuidance): string {
  return [
    `Hook requires the skill "${skill.name}" before retrying.`,
    `Skill path: ${skill.path}`,
    "Follow this skill guidance for remediation:",
    skill.content
  ].join("\n\n")
}

function formatMissingSkillGuidance(requiredSkill: string): string {
  return [
    `Hook requested the skill "${requiredSkill}", but it was not found among enabled skills.`,
    "Use manage_skill(action='list') or enable the required skill before retrying."
  ].join("\n\n")
}

export async function enrichHookResultWithRequiredSkill(
  result: HookResult | null
): Promise<HookResult | null> {
  if (!result?.requiredSkill?.trim()) return result

  const resolved = await resolveSkillGuidance(result.requiredSkill)
  const guidance = resolved
    ? formatResolvedSkillGuidance(resolved)
    : formatMissingSkillGuidance(result.requiredSkill)

  const next: HookResult = {
    ...result,
    additionalContext: joinHookText(result.additionalContext, guidance, "\n\n")
  }

  const shouldSurfaceInPrimaryMessage =
    result.blocked ||
    result.decision === "block" ||
    result.continue === false

  if (!shouldSurfaceInPrimaryMessage) return next

  const surfacedReason = joinHookText(
    result.reason ?? result.stopReason ?? result.stdout,
    guidance,
    "\n\n"
  ) ?? guidance
  const surfacedStopReason = joinHookText(
    result.stopReason ?? result.reason ?? result.stdout,
    guidance,
    "\n\n"
  ) ?? guidance

  return {
    ...next,
    stdout: joinHookText(result.stdout, guidance, "\n\n") ?? guidance,
    reason: surfacedReason,
    stopReason: surfacedStopReason
  }
}

export async function runHooksEnriched(
  ...args: Parameters<typeof runHooks>
): Promise<HookResult | null> {
  return enrichHookResultWithRequiredSkill(await runHooks(...args))
}
