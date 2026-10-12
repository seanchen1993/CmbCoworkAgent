import { createMiddleware, SystemMessage } from "langchain"
import { Command } from "@langchain/langgraph"
import { registry } from "@langchain/langgraph/zod"
import { z } from "zod"
import type { BaseMessage } from "@langchain/core/messages"
import {
  activateSkillLifecycleCore,
  formatSkillHookContext
} from "../agent/skill-lifecycle/activation-core"
import {
  mergePostSkillUseResults,
  shouldPreventContinuation,
  shouldRequestRevision
} from "../agent/skill-lifecycle/completion-policy"
import type { HookContext } from "../hooks/runner-core"
import type { HookResult } from "../hooks/types"
import { BotDomainError } from "../../shared/bot-types"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import {
  readSkillActivation,
  readSkillHookReceipt,
  skillLifecycleKey,
  skillCompletionReceipt
} from "./skill-hook-state"
import { acceptBotPendingInput, BotSteeringInterrupt } from "./steering"
import { BotSkillPrompts } from "./skill-prompts"
import { BotSessionLifecycle } from "./session-lifecycle"

/** Reuses desktop activation/completion policy. The Bot adapter adds durable
 * activation and PostSkillUse receipts; a process restart cannot forget either. */
export class BotSkillLifecycle {
  private readonly prompts: BotSkillPrompts
  readonly session: BotSessionLifecycle
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly hooks: BotSkillHooks
  ) {
    this.prompts = new BotSkillPrompts(request, hooks)
    this.session = new BotSessionLifecycle(request, hooks)
  }

  async activate(
    id: string,
    version: number,
    invocation: string,
    toolName = "read_skill"
  ): Promise<string | null> {
    const { store, run, bot, lease } = this.request
    store.assertDispatch(lease)
    if (!id.startsWith("desktop:")) return null
    store.skillLibrary.current(bot.id, id, version)
    const source = store.externalSkills.source(bot.id, id, version)
    const match = {
      name: source.name,
      path: source.filePath,
      rootDir: source.rootPath,
      pluginId: source.pluginId ?? undefined,
      pluginName: source.pluginName ?? undefined
    }
    const prior = readSkillActivation(store, run.id, id, version)
    if (prior)
      return prior.invocation === invocation ? formatSkillHookContext(match, prior.notes) : null
    const trigger = toolName === "user_selection" ? "explicit" : "read_file"
    const result = await activateSkillLifecycleCore(
      {
        skill: match,
        trigger,
        toolName,
        toolArgs: { id, version },
        workspacePath: bot.workspacePath ?? undefined,
        sessionId: run.id,
        turnId: invocation,
        resolveHooks: () => []
      },
      (_candidates, event, context) => this.hooks.run(event, context, invocation, id)
    )
    if (result.blocked)
      throw new BotDomainError("skill_activation_blocked", result.reason ?? "技能启用检查未通过")
    store.externalSkills.source(bot.id, id, version)
    if (JSON.stringify(result.notes).length > 96_000)
      throw new BotDomainError("skill_hook_context_limit", "技能启用检查输出过长，请精简后重试")
    store.toolOnce(lease, skillLifecycleKey(id, version), { id, version }, () => ({
      invocation,
      trigger,
      toolName,
      notes: result.notes
    }))
    return formatSkillHookContext(match, result.notes)
  }

  async acceptPendingInput(state: unknown) {
    return acceptBotPendingInput(this.request.store, this.request.lease, state)
  }

  /** Shared preparation for both model turns and explicit plugin commands. */
  async prepareInput(messages: readonly BaseMessage[]): Promise<BaseMessage[]> {
    for (const ref of this.request.store.skillReferences.forRun(this.request.run.id))
      await this.activate(
        ref.id,
        ref.version,
        `selection:${ref.id}:${ref.version}`,
        "user_selection"
      )
    await this.session.start()
    return this.prompts.prepare(messages)
  }

  middleware() {
    return createMiddleware({
      name: "BotSkillActivation",
      stateSchema: z.object({
        // A model-wrapper Command may be propagated by multiple outer wrappers.
        // Repeating the same checkpoint marker is idempotent; afterModel clears
        // it in the following graph step after the input is durably committed.
        cmbBotInputCheckpoint: z
          .boolean()
          .default(false)
          .register(registry, {
            reducer: { fn: (_current: boolean, next: boolean) => next },
            default: () => false
          })
      }),
      afterModel: {
        canJumpTo: ["model"],
        hook: (state) =>
          state.cmbBotInputCheckpoint
            ? { cmbBotInputCheckpoint: false, jumpTo: "model" as const }
            : undefined
      },
      // The Cmb queue commits accepted steering in beforeModel. Activation here
      // runs after that injection and before any provider request, on every model
      // turn (including resumed checkpoints). Pending input still fences effects.
      wrapModelCall: async (modelRequest, handler) => {
        const { store, run, bot } = this.request
        const injectPending = async () =>
          new Command({
            update: {
              ...(await this.acceptPendingInput(modelRequest.state)),
              cmbBotInputCheckpoint: true
            }
          })
        if (store.steering.hasPending(run.id)) return injectPending()
        const notes: string[] = []
        let preparedMessages = modelRequest.messages
        try {
          preparedMessages = await this.prepareInput(modelRequest.messages)
        } catch (error) {
          if (error instanceof BotSteeringInterrupt && store.steering.hasPending(run.id))
            return injectPending()
          throw error
        }
        // Rehydrate Hook guidance for both selected and dynamically read skills
        // after checkpoint recovery or summarization; never execute Pre twice.
        const refs = new Map(
          [
            ...store.skillReferences.forRun(run.id),
            ...store.skillLibrary.referencesForRun(run.id)
          ].map((ref) => [ref.id, ref])
        )
        for (const ref of refs.values()) {
          store.skillLibrary.current(bot.id, ref.id, ref.version)
          const active = readSkillActivation(store, run.id, ref.id, ref.version)
          if (!active || !active.notes.length) continue
          const source = store.externalSkills.source(bot.id, ref.id, ref.version)
          const note = formatSkillHookContext(
            { name: source.name, path: source.filePath, rootDir: source.rootPath },
            active.notes
          )
          if (note) notes.push(note)
        }
        if (!notes.length) return handler({ ...modelRequest, messages: preparedMessages })
        if (notes.join("\n\n").length > 96_000)
          throw new BotDomainError(
            "skill_hook_context_limit",
            "已启用技能的检查输出总量过长，请精简后重试"
          )
        return handler({
          ...modelRequest,
          messages: preparedMessages,
          systemMessage: new SystemMessage({
            content: [
              ...(typeof modelRequest.systemMessage.content === "string"
                ? [{ type: "text" as const, text: modelRequest.systemMessage.content }]
                : modelRequest.systemMessage.content),
              { type: "text" as const, text: notes.join("\n\n") }
            ]
          })
        })
      }
    })
  }

  async review(
    context: HookContext,
    invocation: string
  ): Promise<{ event: "PostSkillUse" | "Stop"; result: HookResult } | null> {
    const { store, run, bot, lease } = this.request
    await this.hooks.refresh()
    const refs = new Map(
      [...store.skillReferences.forRun(run.id), ...store.skillLibrary.referencesForRun(run.id)].map(
        (ref) => [ref.id, ref]
      )
    )
    const results: HookResult[] = []
    for (const ref of refs.values()) {
      if (!ref.id.startsWith("desktop:")) continue
      const active = readSkillActivation(store, run.id, ref.id, ref.version)
      if (!active) continue
      const source = store.externalSkills.source(bot.id, ref.id, ref.version)
      const key = skillLifecycleKey(ref.id, ref.version, "completion")
      const saved = readSkillHookReceipt(store, run.id, key)
      const prior = saved === undefined ? undefined : skillCompletionReceipt.parse(saved)
      if (prior && prior.invocation !== invocation) continue
      const result = prior
        ? prior.result
        : await this.hooks.run(
            "PostSkillUse",
            {
              ...context,
              toolName: active.toolName,
              toolArgs: {
                trigger: active.trigger,
                skillName: source.name,
                skillPath: source.filePath
              },
              skillName: source.name,
              skillPath: source.filePath,
              skillRoot: source.rootPath,
              pluginId: source.pluginId ?? undefined,
              pluginName: source.pluginName ?? undefined,
              skillTriggerToolName: active.toolName
            },
            invocation,
            ref.id
          )
      // Desktop semantics: PostSkillUse fires once per activation, including a
      // requested revision. Stop may recheck each revised answer. Persist only
      // after a definite result; cancellation/uncertainty must remain visible.
      store.toolOnce(lease, key, { id: ref.id, version: ref.version, invocation, context }, () =>
        skillCompletionReceipt.parse({ invocation, result })
      )
      if (result) results.push(result)
    }
    const post = mergePostSkillUseResults(results)
    if (post && (shouldPreventContinuation(post) || shouldRequestRevision(post)))
      return { event: "PostSkillUse", result: post }
    const stop = await this.hooks.run("Stop", context, invocation)
    return stop ? { event: "Stop", result: stop } : null
  }
}
