import type { HarnessWorkflowNextAction, SkillMetadata } from "@/types"
import {
  mergeChatSkills,
  selectSkillForSlashName
} from "@/features/slash-commands/skill-merge"
import { normalizeSkillId } from "./skill-ids"
import { normalizeHarnessNextAction } from "../../../shared/harness-run-next-action"

export { normalizeHarnessNextAction }

type Listener = () => void

const pendingNextActions = new Map<string, HarnessWorkflowNextAction>()
const listeners = new Set<Listener>()
let version = 0

function emitChange(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function setPendingHarnessNextAction(threadId: string, value: unknown): void {
  if (!threadId) return
  const nextAction = normalizeHarnessNextAction(value)
  if (nextAction) {
    pendingNextActions.set(threadId, nextAction)
  } else {
    pendingNextActions.delete(threadId)
  }
  emitChange()
}

export function getPendingHarnessNextAction(
  threadId: string | null | undefined
): HarnessWorkflowNextAction | undefined {
  return threadId ? pendingNextActions.get(threadId) : undefined
}

export function consumePendingHarnessNextAction(
  threadId: string | null | undefined
): HarnessWorkflowNextAction | undefined {
  if (!threadId) return undefined
  const nextAction = pendingNextActions.get(threadId)
  if (!nextAction) return undefined

  pendingNextActions.delete(threadId)
  emitChange()
  return nextAction
}

export function subscribePendingHarnessNextActions(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getPendingHarnessNextActionVersion(): number {
  return version
}

export async function resolveHarnessNextActionSkill(
  projectId: string,
  slashSkill: string
): Promise<SkillMetadata | null> {
  const pluginSkillsPromise =
    typeof window.api.skills.listPlugins === "function"
      ? window.api.skills.listPlugins().catch((error) => {
          console.warn("[HarnessNextAction] Failed to load plugin skills:", error)
          return []
        })
      : Promise.resolve([])
  const [loadedSkills, pluginSkills, disabledList] = await Promise.all([
    window.api.skills.list(),
    pluginSkillsPromise,
    window.api.skills.getDisabled()
  ])
  let preferredPlugin: { id?: string; name?: string } | null = null
  try {
    const projects = await window.api.harnessBoard.listProjects()
    const project = projects.find((item) => item.projectId === projectId)
    if (project) {
      preferredPlugin = {
        id: project.harnessAdapter.id,
        name: project.harnessAdapter.name
      }
    }
  } catch {
    // Keep the same non-critical fallback as the chat skill loader.
  }

  const availableSkills = loadedSkills.filter(
    (skill) => skill.source === "project" || skill.source === "user"
  )
  const merged = mergeChatSkills(
    availableSkills,
    pluginSkills,
    new Set(disabledList.map(normalizeSkillId)),
    preferredPlugin
  )
  return selectSkillForSlashName(merged, slashSkill, preferredPlugin)
}
