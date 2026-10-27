import type { AgentRunExecutionContext } from "../agent/agent-run-service"
import type { RemoteTurnPolicy } from "../agent/standard-thread-turn"
export const BOT_MOCK_TOOL_NAMES = [
  "bot_work_list",
  "bot_work_create",
  "bot_work_send",
  "bot_work_complete",
  "bot_work_continue"
]
export const BOT_SCOPED_MEMORY_TOOLS = [
  "bot_memory_search",
  "bot_memory_list",
  "bot_memory_get",
  "bot_remember",
  "bot_forget"
]
export function botMockRemotePolicy(memoryEnabled = false): RemoteTurnPolicy {
  return botTextOnlyRemotePolicy([
    ...BOT_MOCK_TOOL_NAMES,
    ...(memoryEnabled ? BOT_SCOPED_MEMORY_TOOLS : [])
  ])
}
/** Text-only receipts and external text scopes cannot execute local actions. */
export function botTextOnlyRemotePolicy(allowedToolNames: string[]): RemoteTurnPolicy {
  return {
    allowedToolNames: [...allowedToolNames],
    allowedSkillNames: [],
    allowedExpertNames: [],
    disableHooks: true,
    disableMessageControls: true,
    omitPromptExtensions: true,
    disableScheduler: true,
    disableSkillEvolution: true,
    disableRequestUserInput: true,
    disableSubagents: true,
    disableMemoryInjection: true,
    sharedTaskContext: true,
    disableAgentsPrompt: true,
    disableMcpTools: true,
    filesystemAccess: {
      disallowedTools: ["read_file", "write_file", "edit_file", "ls", "glob", "grep", "execute"],
      shellAccess: "none"
    }
  }
}
/** Persistent external scope cannot be invoked/resumed as an ordinary owner thread. */
export function assertBotMockThreadEntry(
  metadata: Record<string, unknown>,
  context?: AgentRunExecutionContext
): void {
  if (!metadata.botMockBindingId) return
  const policy = context?.remotePolicy
  if (
    context?.source !== "bot" ||
    !context.verifyResolvedThread ||
    !policy?.disableHooks ||
    !policy.omitPromptExtensions ||
    !policy.disableMessageControls ||
    !policy.disableMcpTools ||
    !policy.disableMemoryInjection ||
    !policy.disableAgentsPrompt ||
    !policy.disableSubagents ||
    !policy.sharedTaskContext ||
    policy.allowedSkillNames?.length !== 0 ||
    policy.allowedExpertNames?.length !== 0 ||
    !policy.allowedToolNames ||
    BOT_MOCK_TOOL_NAMES.some((name) => !policy.allowedToolNames!.includes(name)) ||
    policy.allowedToolNames.some(
      (name) => ![...BOT_MOCK_TOOL_NAMES, ...BOT_SCOPED_MEMORY_TOOLS].includes(name)
    )
  )
    throw new Error("外部渠道会话只能经已授权的 Bot 绑定执行；请返回原任务或接入渠道继续。")
}
export function botMockMetadataSafe(metadata: Record<string, unknown>): boolean {
  return Object.keys(metadata).every(
    (key) =>
      !/^(?:harness|plugin|project|feature|systemId)/i.test(key) ||
      metadata[key] == null ||
      metadata[key] === false
  )
}
