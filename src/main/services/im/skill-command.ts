import { createHash } from "node:crypto"
import { dirname } from "node:path"
import type { SkillUseBlockMetadata } from "../../../shared/skill-use-block"
import { getHarnessAgentContext } from "../../agent/standard-thread-turn"
import { getThread, type ThreadRow } from "../../db"
import { listAllSkills, listPluginSkills } from "../../ipc/skills"
import {
  getDisabledSkillRuntimePolicy,
  isStandaloneSkillDisabledByRuntimePolicy
} from "../../storage"
import type { SkillMetadata } from "../../types"
import { normalizeSkillId } from "../../skills/ids"
import {
  imConversationStateStore,
  type ImConversationStateStore,
  type ImTargetSnapshot
} from "./conversation-state"
import { imInboxService, type ImInboxService } from "./inbox-service"

const IM_SKILL_COMMAND = "技能"
const IM_SKILL_CODE_PATTERN = /^S[A-F0-9]{8}$/u
const MAX_LISTED_SKILLS = 50
const SKILL_USE_TAG_PATTERN = /<(\/?)CMBDEVCLAW-SKILL-USE-V1(?=[\s>])/giu

export interface ImResolvedSkill {
  code: string
  name: string
  description: string
  sourceLabel: string
  use: SkillUseBlockMetadata
}

export type ImPreparedSkillMessage =
  | { kind: "control"; reply: string }
  | {
      kind: "ordinary"
      visibleText: string
      explicitSkill?: ImResolvedSkill
    }

interface ImSkillCommandDependencies {
  conversations: ImConversationStateStore
  inbox: ImInboxService
  getThread: typeof getThread
  listStandaloneSkills: typeof listAllSkills
  listPluginSkills: typeof listPluginSkills
  getHarnessAgentContext: typeof getHarnessAgentContext
}

function normalizeSkillName(value: string): string {
  return normalizeSkillId(value)
}

function samePlugin(skill: SkillMetadata, preferred: { id?: string; name?: string }): boolean {
  const pluginId = normalizeSkillName(skill.pluginId ?? "")
  const pluginName = normalizeSkillName(skill.pluginName ?? "")
  const preferredId = normalizeSkillName(preferred.id ?? "")
  const preferredName = normalizeSkillName(preferred.name ?? "")
  return Boolean(
    (preferredId && pluginId === preferredId) || (preferredName && pluginName === preferredName)
  )
}

function sourceLabel(skill: SkillMetadata): string {
  const pluginName = skill.pluginName?.trim()
  if (pluginName) return `插件：${pluginName}`
  return skill.source === "user" ? "本地技能" : "内置技能"
}

function skillCode(skill: SkillMetadata): string {
  const identity = `${skill.pluginId ?? "standalone"}\0${skill.path}`
  return `S${createHash("sha256").update(identity).digest("hex").slice(0, 8).toUpperCase()}`
}

function toResolvedSkill(skill: SkillMetadata): ImResolvedSkill {
  return {
    code: skillCode(skill),
    name: skill.name.trim(),
    description: skill.description?.trim() ?? "",
    sourceLabel: sourceLabel(skill),
    use: {
      name: skill.name.trim(),
      path: skill.path,
      description: skill.description,
      metadata: skill.metadata,
      allowedTools: skill.allowedTools
    }
  }
}

function isProjectTargetMetadata(metadata: Record<string, unknown>): boolean {
  return Boolean(metadata.harnessFeature || metadata.harnessProjectSession)
}

function parseThreadMetadata(thread: ThreadRow): Record<string, unknown> {
  try {
    const parsed = thread.metadata ? (JSON.parse(thread.metadata) as unknown) : {}
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function skillSelectorMatches(skill: ImResolvedSkill, selector: string): boolean {
  if (IM_SKILL_CODE_PATTERN.test(selector.toUpperCase())) {
    return skill.code === selector.toUpperCase()
  }
  return normalizeSkillName(skill.name) === normalizeSkillName(selector)
}

function formatSkillChoices(skills: readonly ImResolvedSkill[]): string {
  return skills.map((skill) => `${skill.code}  /${skill.name}（${skill.sourceLabel}）`).join("\n")
}

function explicitSkillUsage(): string {
  return "用法：/技能 <技能名或短码> <任务内容>。发送 /技能 可查看当前会话可用技能。"
}

/**
 * An IM user must never be able to manufacture the desktop's trusted skill
 * transport marker. Keep the text visible to the model, but rename the tag so
 * the standard prompt preparer cannot interpret it as an explicit selection.
 */
export function neutralizeImSkillUseMarkers(message: string): string {
  return message.replace(SKILL_USE_TAG_PATTERN, "<$1CMBDEVCLAW-SKILL-USE-USER-TEXT")
}

export class ImSkillCommandService {
  private readonly dependencies: ImSkillCommandDependencies

  constructor(dependencies: Partial<ImSkillCommandDependencies> = {}) {
    this.dependencies = {
      conversations: dependencies.conversations ?? imConversationStateStore,
      inbox: dependencies.inbox ?? imInboxService,
      getThread: dependencies.getThread ?? getThread,
      listStandaloneSkills: dependencies.listStandaloneSkills ?? listAllSkills,
      listPluginSkills: dependencies.listPluginSkills ?? listPluginSkills,
      getHarnessAgentContext: dependencies.getHarnessAgentContext ?? getHarnessAgentContext
    }
  }

  async prepareForIngress(input: {
    message: string
    conversationKey: string
    principalId: string
  }): Promise<ImPreparedSkillMessage> {
    const message = input.message.trim()
    if (message.startsWith("//")) {
      return {
        kind: "ordinary",
        visibleText: neutralizeImSkillUseMarkers(message.slice(1))
      }
    }

    const target = await this.resolveCurrentTarget(input)
    return this.prepareForTarget(message, target)
  }

  async prepareForExecution(input: {
    message: string
    target: ImTargetSnapshot
  }): Promise<Extract<ImPreparedSkillMessage, { kind: "ordinary" }>> {
    const prepared = await this.prepareForTarget(input.message.trim(), input.target)
    if (prepared.kind === "control") {
      throw new ImSkillCommandError(prepared.reply)
    }
    return prepared
  }

  private async prepareForTarget(
    message: string,
    target: ImTargetSnapshot
  ): Promise<ImPreparedSkillMessage> {
    if (message.startsWith("//")) {
      return {
        kind: "ordinary",
        visibleText: neutralizeImSkillUseMarkers(message.slice(1))
      }
    }

    const slash = message.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/u)
    if (!slash) {
      return { kind: "ordinary", visibleText: neutralizeImSkillUseMarkers(message) }
    }

    const commandOrSkill = slash[1]
    const argument = (slash[2] ?? "").trim()
    const skills = await this.listAvailableSkills(target)

    if (commandOrSkill === IM_SKILL_COMMAND) {
      if (!argument) return { kind: "control", reply: this.formatSkillList(skills) }
      return this.resolveExplicitInvocation(argument, skills)
    }

    const shorthandMatches = skills.filter((skill) => skillSelectorMatches(skill, commandOrSkill))
    if (shorthandMatches.length === 0) {
      // Backwards compatibility: an unknown /xxx is ordinary Agent input.
      return { kind: "ordinary", visibleText: neutralizeImSkillUseMarkers(message) }
    }
    if (shorthandMatches.length > 1) {
      return {
        kind: "control",
        reply: [
          `“${commandOrSkill}”对应多个技能，请使用短码指定：`,
          formatSkillChoices(shorthandMatches),
          "发送 /技能 <短码> <任务内容>。"
        ].join("\n")
      }
    }
    if (!argument) return { kind: "control", reply: explicitSkillUsage() }
    return {
      kind: "ordinary",
      visibleText: neutralizeImSkillUseMarkers(argument),
      explicitSkill: shorthandMatches[0]
    }
  }

  private resolveExplicitInvocation(
    argument: string,
    skills: readonly ImResolvedSkill[]
  ): ImPreparedSkillMessage {
    const codeInvocation = argument.match(/^(S[A-Fa-f0-9]{8})(?:\s+([\s\S]+))?$/u)
    if (codeInvocation) {
      const matches = skills.filter((skill) => skillSelectorMatches(skill, codeInvocation[1]))
      if (matches.length !== 1) {
        return { kind: "control", reply: "技能短码已失效，请重新发送 /技能 获取列表。" }
      }
      const task = (codeInvocation[2] ?? "").trim()
      if (!task) return { kind: "control", reply: explicitSkillUsage() }
      return {
        kind: "ordinary",
        visibleText: neutralizeImSkillUseMarkers(task),
        explicitSkill: matches[0]
      }
    }

    // Prefer the longest exact name prefix so a skill name may itself contain
    // spaces. The remaining text is the task sent to the Agent.
    const nameMatches = skills
      .map((skill) => ({ skill, name: skill.name.trim() }))
      .filter(({ name }) => {
        if (!name) return false
        if (normalizeSkillName(argument) === normalizeSkillName(name)) return true
        return (
          normalizeSkillName(argument.slice(0, name.length)) === normalizeSkillName(name) &&
          /^\s/u.test(argument.slice(name.length))
        )
      })
      .sort((left, right) => right.name.length - left.name.length)

    if (nameMatches.length === 0) {
      const selector = argument.split(/\s+/u, 1)[0]
      return {
        kind: "control",
        reply: `未找到可用技能“${selector}”。请发送 /技能 查看当前会话可用技能。`
      }
    }

    const longestLength = nameMatches[0].name.length
    const longest = nameMatches.filter((candidate) => candidate.name.length === longestLength)
    const selectedName = longest[0].name
    const sameName = longest.filter(
      (candidate) => normalizeSkillName(candidate.name) === normalizeSkillName(selectedName)
    )
    if (sameName.length > 1) {
      return {
        kind: "control",
        reply: [
          `“${selectedName}”对应多个技能，请使用短码指定：`,
          formatSkillChoices(sameName.map((candidate) => candidate.skill)),
          "发送 /技能 <短码> <任务内容>。"
        ].join("\n")
      }
    }

    const task = argument.slice(selectedName.length).trim()
    if (!task) return { kind: "control", reply: explicitSkillUsage() }
    return {
      kind: "ordinary",
      visibleText: neutralizeImSkillUseMarkers(task),
      explicitSkill: sameName[0].skill
    }
  }

  private async resolveCurrentTarget(input: {
    conversationKey: string
    principalId: string
  }): Promise<ImTargetSnapshot> {
    await this.dependencies.conversations.ensureConversation(input)
    const selected = this.dependencies.conversations.getSelectedTarget(input.conversationKey)
    if (selected?.state === "active" && this.dependencies.getThread(selected.snapshot.threadId)) {
      return selected.snapshot
    }
    return this.dependencies.inbox.ensureInbox(input)
  }

  private async listAvailableSkills(target: ImTargetSnapshot): Promise<ImResolvedSkill[]> {
    const thread = this.dependencies.getThread(target.threadId)
    if (!thread) return []
    const metadata = parseThreadMetadata(thread)
    const [standalone, pluginSkills] = await Promise.all([
      this.dependencies.listStandaloneSkills(),
      this.dependencies.listPluginSkills()
    ])
    const disabledPolicy = getDisabledSkillRuntimePolicy()
    const enabledStandalone = standalone.filter(
      (skill) =>
        !isStandaloneSkillDisabledByRuntimePolicy(
          {
            name: skill.name,
            sourceDir: dirname(dirname(skill.path)),
            rootDir: dirname(skill.path),
            skillMdPath: skill.path,
            relativePath: skill.relativePath ?? skill.id ?? skill.name,
            depth: 0
          },
          disabledPolicy
        )
    )

    let visiblePluginSkills = pluginSkills
    if (isProjectTargetMetadata(metadata)) {
      const context: Awaited<ReturnType<typeof getHarnessAgentContext>> = await this.dependencies
        .getHarnessAgentContext(metadata, { workspacePath: target.workspacePath })
        .catch(() => ({}))
      const preferred = { id: context.pluginId, name: context.pluginName }
      visiblePluginSkills =
        preferred.id || preferred.name
          ? pluginSkills.filter((skill) => samePlugin(skill, preferred))
          : []
    }

    const byPath = new Map<string, ImResolvedSkill>()
    for (const skill of [...enabledStandalone, ...visiblePluginSkills]) {
      if (!skill.name.trim() || !skill.path.trim()) continue
      byPath.set(skill.path, toResolvedSkill(skill))
    }
    return [...byPath.values()].sort(
      (left, right) =>
        left.name.localeCompare(right.name, "zh-CN") ||
        left.sourceLabel.localeCompare(right.sourceLabel, "zh-CN")
    )
  }

  private formatSkillList(skills: readonly ImResolvedSkill[]): string {
    if (skills.length === 0) return "当前会话没有可用技能。"
    const visible = skills.slice(0, MAX_LISTED_SKILLS)
    return [
      "当前会话可用技能：",
      ...visible.map((skill) =>
        [
          `${skill.code}  /${skill.name}（${skill.sourceLabel}）`,
          skill.description ? `  ${skill.description}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      ),
      skills.length > visible.length
        ? `另有 ${skills.length - visible.length} 个技能未展示，可直接使用 /技能 <技能名> <任务内容>。`
        : "",
      "发送 /<技能名> <任务内容>，或 /技能 <短码> <任务内容>。"
    ]
      .filter(Boolean)
      .join("\n")
  }
}

export class ImSkillCommandError extends Error {
  readonly reasonCode = "REMOTE_SKILL_UNAVAILABLE"

  constructor(readonly publicReply: string) {
    super(publicReply)
    this.name = "ImSkillCommandError"
  }
}

export const imSkillCommandService = new ImSkillCommandService()
