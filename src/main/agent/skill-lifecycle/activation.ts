import { runHooksEnriched } from "../../hooks/required-skill"
import type { HookContext, HookResultCallback } from "../../hooks/runner"
import type { HookConfig, HookEvent, HookResult } from "../../hooks/types"
import { throwIfHookHalt } from "../../hooks/halt"
import type { HookScopeController } from "../../hooks/scope"
import type { SkillLifecycleMatch } from "./registry"
import { getSkillUseKey, type SkillActivationTrigger, type SkillUseTracker } from "./tracker"

export interface SkillActivationOptions {
  skill: SkillLifecycleMatch
  trigger: SkillActivationTrigger
  toolName: string
  toolArgs?: Record<string, unknown>
  toolResult?: string
  workspacePath?: string
  sessionId?: string
  hookScope?: HookScopeController
  firedSkillKeys?: Set<string>
  skillUseTracker?: SkillUseTracker
  resolveHooks: (event: HookEvent, context: HookContext) => HookConfig[]
  onHookResult?: HookResultCallback
}

export interface SkillActivationResult {
  blocked: boolean
  reason?: string
  notes: string[]
  skipped: boolean
}

export function getSkillActivationKey(skill: SkillLifecycleMatch): string {
  return getSkillUseKey(skill)
}

function collectHookNotes(result: HookResult | null): string[] {
  if (!result) return []
  return [
    result.stdout,
    result.additionalContext,
    result.systemMessage,
    result.decision === "block" ? result.reason : undefined
  ].filter((item): item is string => Boolean(item?.trim()))
}

function getBlockReason(result: HookResult | null, skillName: string): string | undefined {
  if (!result) return undefined
  if (!result.blocked && result.continue !== false && result.decision !== "block") return undefined
  return (
    result.reason ||
    result.stopReason ||
    result.stdout ||
    result.stderr ||
    `Skill ${skillName} was blocked by a hook`
  )
}

function buildSkillContext(options: SkillActivationOptions): HookContext {
  return {
    toolName: options.toolName,
    toolArgs: options.toolArgs,
    toolResult: options.toolResult,
    workspacePath: options.workspacePath,
    sessionId: options.sessionId,
    skillName: options.skill.name,
    skillPath: options.skill.path,
    skillRoot: options.skill.rootDir,
    pluginId: options.skill.pluginId,
    pluginName: options.skill.pluginName,
    pluginRoot: options.skill.pluginRoot,
    skillTriggerToolName: options.toolName
  }
}

export async function activateSkillLifecycle(
  options: SkillActivationOptions
): Promise<SkillActivationResult> {
  const key = getSkillActivationKey(options.skill)
  if (options.firedSkillKeys?.has(key)) {
    options.hookScope?.activateSkill(
      options.skill.name,
      options.skill.pluginId,
      options.skill.rootDir
    )
    options.hookScope?.activatePersistentHooks(
      options.resolveHooks("PreToolUse", buildSkillContext(options))
    )
    return { blocked: false, notes: [], skipped: true }
  }

  const notes: string[] = []
  const preContext = buildSkillContext(options)
  const preResult = await runHooksEnriched(
    options.resolveHooks("PreSkillUse", preContext),
    "PreSkillUse",
    preContext,
    options.onHookResult
  )
  notes.push(...collectHookNotes(preResult))
  if (preResult) {
    options.hookScope?.activatePersistentHooks(options.resolveHooks("PreSkillUse", preContext))
  }
  throwIfHookHalt("PreSkillUse", preResult, `Skill ${options.skill.name} was stopped by a hook`)

  const blockReason = getBlockReason(preResult, options.skill.name)
  if (blockReason) {
    return { blocked: true, reason: blockReason, notes, skipped: false }
  }

  // Mark fired after Pre passes — the skill is now considered activated for
  // the rest of the run. PostSkillUse runs later at turn completion, so a later
  // read of the same skill should not re-run PreSkillUse.
  options.firedSkillKeys?.add(key)
  options.hookScope?.activateSkill(
    options.skill.name,
    options.skill.pluginId,
    options.skill.rootDir
  )
  options.hookScope?.activatePersistentHooks(options.resolveHooks("PreToolUse", preContext))
  options.skillUseTracker?.recordSkillUse(options.skill, {
    trigger: options.trigger,
    triggerToolName: options.toolName
  })

  return { blocked: false, notes, skipped: false }
}

export function formatSkillHookContext(skill: SkillLifecycleMatch, notes: string[]): string | null {
  const cleanNotes = notes.map((note) => note.trim()).filter(Boolean)
  if (cleanNotes.length === 0) return null
  return [
    "## Skill Hook Context",
    "The following guidance was produced by skill hooks. Treat it as run-scoped instruction for this turn.",
    "",
    `Skill: ${skill.name}`,
    `Skill path: ${skill.path}`,
    ...cleanNotes
  ].join("\n")
}
