import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import {
  getDisabledSkillRuntimePolicy,
  getEnabledPluginSkillSourceMetadata,
  getEnabledSkillsSources,
  isDisabledSkillRuntimePolicyCurrent,
  isStandaloneSkillDisabledByRuntimePolicy,
  type DisabledSkillRuntimePolicy,
  type PluginSkillSourceMetadata
} from "../storage"
import { renderPluginSkillMarkdownPlaceholders } from "../agent/markdown-placeholders"
import { discoverSkills } from "../skills/discovery"
import {
  getDiscoveredSkillAliases,
  normalizeSkillId
} from "../skills/ids"
import { runHooks, type HookContext, type HookResultCallback } from "./runner"
import { joinHookText } from "./text"
import type { HookConfig, HookEvent, HookResult } from "./types"

const MAX_REQUIRED_SKILL_CHARS = 12_000

interface ResolvedSkillGuidance {
  name: string
  path: string
  content: string
  pluginRoot?: string
  pluginId?: string
  pluginName?: string
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
  const normalized = normalizeSkillId(requiredSkill)
  if (!normalized) return null

  const maxAttempts = 2
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const sourceDirs = await getEnabledSkillsSources()
    const runtimePolicy = getDisabledSkillRuntimePolicy()
    let resolved: ResolvedSkillGuidance | null = null
    if (!runtimePolicy.denyAllStandaloneSkills) {
      for (const sourceDir of sourceDirs) {
        if (!existsSync(sourceDir)) continue

        resolved = await resolveSkillGuidanceFromSource({
          sourceDir,
          normalized,
          runtimePolicy
        })
        if (resolved) break
      }
    }
    if (!resolved) {
      for (const source of getEnabledPluginSkillSourceMetadata()) {
        if (!existsSync(source.sourceDir)) continue

        resolved = await resolveSkillGuidanceFromSource({
          sourceDir: source.sourceDir,
          normalized,
          maxDepth: source.maxDepth,
          plugin: source
        })
        if (resolved) break
      }
    }
    if (isDisabledSkillRuntimePolicyCurrent(runtimePolicy)) return resolved
  }

  return null
}

async function resolveSkillGuidanceFromSource({
  sourceDir,
  normalized,
  runtimePolicy,
  maxDepth,
  plugin
}: {
  sourceDir: string
  normalized: string
  runtimePolicy?: DisabledSkillRuntimePolicy
  maxDepth?: number
  plugin?: PluginSkillSourceMetadata
}): Promise<ResolvedSkillGuidance | null> {
  for (const skill of await discoverSkills(sourceDir, maxDepth)) {
    if (runtimePolicy && isStandaloneSkillDisabledByRuntimePolicy(skill, runtimePolicy)) {
      continue
    }
    try {
      const content = await readFile(skill.skillMdPath, "utf-8")
      const frontmatter = parseYamlFrontmatter(content)
      const skillName = (frontmatter.name || skill.name).trim()
      const candidates = new Set([...getDiscoveredSkillAliases(skill), normalizeSkillId(skillName)])
      if (!candidates.has(normalized)) continue

      return {
        name: skillName,
        path: skill.skillMdPath,
        content: trimSkillContent(content),
        pluginRoot: plugin?.pluginRoot,
        pluginId: plugin?.pluginId,
        pluginName: plugin?.pluginName
      }
    } catch {
      continue
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
  result: HookResult | null,
  hookContext?: HookContext
): Promise<HookResult | null> {
  if (!result?.requiredSkill?.trim()) return result

  const resolved = await resolveSkillGuidance(result.requiredSkill)
  const renderedResolved = resolved
    ? {
        ...resolved,
        content: renderPluginSkillMarkdownPlaceholders(resolved.content, resolved, {
          pluginWorkspace: hookContext?.pluginWorkspace,
          projectDir: hookContext?.projectDir,
          featureId: hookContext?.featureId,
          systemId: hookContext?.systemId
        })
      }
    : null
  const guidance = renderedResolved
    ? formatResolvedSkillGuidance(renderedResolved)
    : formatMissingSkillGuidance(result.requiredSkill)

  const next: HookResult = {
    ...result,
    additionalContext: joinHookText(result.additionalContext, guidance, "\n\n")
  }

  const shouldSurfaceInPrimaryMessage =
    result.blocked || result.decision === "block" || result.continue === false

  if (!shouldSurfaceInPrimaryMessage) return next

  const surfacedReason =
    joinHookText(result.reason ?? result.stopReason ?? result.stdout, guidance, "\n\n") ?? guidance
  const surfacedStopReason =
    joinHookText(result.stopReason ?? result.reason ?? result.stdout, guidance, "\n\n") ?? guidance

  return {
    ...next,
    stdout: joinHookText(result.stdout, guidance, "\n\n") ?? guidance,
    reason: surfacedReason,
    stopReason: surfacedStopReason
  }
}

export async function runHooksEnriched(
  hooks: HookConfig[],
  event: HookEvent,
  context: HookContext,
  onHookResult?: HookResultCallback
): Promise<HookResult | null> {
  return enrichHookResultWithRequiredSkill(
    await runHooks(hooks, event, context, onHookResult),
    context
  )
}
