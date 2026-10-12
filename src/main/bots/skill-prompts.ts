import { HumanMessage, type BaseMessage } from "@langchain/core/messages"
import { z } from "zod"
import { prepareUserPromptCore } from "../agent/prompt-preparation"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import { readSkillHookReceipt, skillLifecycleKey } from "./skill-hook-state"
import { prepareBotUserPrompt } from "./prompt-preparation"

const submitted = z.object({
  result: z
    .object({
      exitCode: z.number().int().nullable(),
      stdout: z.string(),
      stderr: z.string(),
      blocked: z.boolean(),
      continue: z.boolean().optional(),
      stopReason: z.string().optional(),
      decision: z.enum(["approve", "block"]).optional(),
      reason: z.string().optional(),
      additionalContext: z.string().optional(),
      systemMessage: z.string().optional(),
      updatedInput: z.record(z.string(), z.unknown()).optional()
    })
    .nullable()
})

/** Submit only actual accepted task inputs. A dynamically read skill does not
 * retroactively intercept past inputs; even a no-hook result is recorded once.
 * Preparation runs before the model transport, after the durable inbox injection.
 * Hook decisions survive checkpoint replay while current model middleware keeps
 * ownership of the surrounding messages and system prompt. */
export class BotSkillPrompts {
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly hooks: BotSkillHooks
  ) {}

  async prepare(messages: readonly BaseMessage[]): Promise<BaseMessage[]> {
    const { store, run, lease, signal } = this.request
    const accepted = new Set([run.messageId, ...store.steering.acceptedMessageIds(run.id)])
    const output: BaseMessage[] = []
    for (const message of messages) {
      if (!HumanMessage.isInstance(message) || !message.id || !accepted.has(message.id)) {
        output.push(message)
        continue
      }
      signal.throwIfAborted()
      store.assertDispatch(lease)
      const original = store.message({ conversationId: run.conversationId, id: message.id })
      if (original.sender !== "user") {
        output.push(message)
        continue
      }
      if (typeof message.content !== "string")
        throw new BotDomainError("hook_input_format", "任务输入检查暂不支持此消息格式")
      const key = skillLifecycleKey(message.id, 1, "prompt")
      const input = { messageId: original.id, text: original.text }
      const saved = readSkillHookReceipt(store, run.id, key)
      const result =
        saved === undefined
          ? submitted.parse({
              result: await this.hooks.run(
                "UserPromptSubmit",
                {
                  userPrompt: original.text,
                  toolArgs: { message: original.text, rawMessage: original.text }
                },
                message.id
              )
            })
          : submitted.parse(saved)
      if (JSON.stringify(result).length > 96_000)
        throw new BotDomainError("hook_input_context_limit", "输入检查的结果过长，请精简后重试")
      store.toolOnce(lease, key, input, () => {
        if (result.result?.systemMessage?.trim())
          store.activity(lease, result.result.systemMessage.trim().slice(0, 4000))
        return result
      })
      const prepared = await prepareUserPromptCore({
        rawMessage: original.text,
        initialModelInput: message.content,
        submit: async () => result.result,
        rewriteModelInput: (text) =>
          prepareBotUserPrompt({
            store,
            lease,
            signal,
            message: { ...original, text },
            // Keep Grok's group envelope and other speakers intact. Only the
            // accepted triggering user's body changes, never stored history.
            modelInput:
              original.id === run.messageId
                ? store.groups.scope(run.id, { messageId: original.id, text })?.prompt
                : undefined
          }),
        isPreparationCurrent: () => {
          signal.throwIfAborted()
          store.assertDispatch(lease)
          store.skillReferences.assertCurrent(store.skillReferences.forRun(run.id))
          store.skillLibrary.assertRun(run.id)
          return true
        }
      })
      if (!prepared.accepted) throw new BotDomainError("hook_input_blocked", prepared.reason)
      output.push(
        new HumanMessage({
          id: message.id,
          content: prepared.content,
          name: message.name,
          additional_kwargs: message.additional_kwargs,
          response_metadata: message.response_metadata
        })
      )
    }
    return output
  }
}
