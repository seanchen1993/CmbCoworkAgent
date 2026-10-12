import { z } from "zod"
import type { BotRuntimeRequest } from "./host"
import type { BotSkillHooks } from "./skill-hooks"
import { BOT_SESSION_END_KEY, readSkillHookReceipt } from "./skill-hook-state"
import { BotSubagentLifecycle } from "./subagent-lifecycle"

const completion = z.object({ content: z.string().max(128_000) }).strict()
const startKey = "lifecycle:session-start"
const endKey = BOT_SESSION_END_KEY

/** A Bot run owns an execution session. Its start and successful settlement are
 * durable phases; resuming an end check must never ask the model to redo work. */
export class BotSessionLifecycle {
  constructor(
    private readonly request: BotRuntimeRequest,
    private readonly hooks: BotSkillHooks
  ) {}

  async start(): Promise<void> {
    const { store, run, lease, signal } = this.request
    signal.throwIfAborted()
    store.assertDispatch(lease)
    await this.hooks.initializeWorkspace()
    const prior = readSkillHookReceipt(store, run.id, startKey)
    if (prior !== undefined) {
      z.literal(true).parse(prior)
      return
    }
    await new BotSubagentLifecycle(this.request, this.hooks).start()
    await this.hooks.run("SessionStart", { sessionStartSource: "startup" }, startKey)
    signal.throwIfAborted()
    store.assertDispatch(lease)
    store.toolOnce(lease, startKey, { event: "SessionStart" }, () => true)
  }

  pending(): { content: string } | undefined {
    const value = readSkillHookReceipt(this.request.store, this.request.run.id, endKey)
    return value === undefined ? undefined : completion.parse(value)
  }

  async finish(content: string): Promise<string> {
    const { store, run, lease, signal } = this.request
    signal.throwIfAborted()
    store.assertDispatch(lease)
    const saved = completion.parse(
      store.toolOnce(lease, endKey, { event: "SessionEnd" }, () => completion.parse({ content }))
    )
    await new BotSubagentLifecycle(this.request, this.hooks).finish(false)
    const completed = readSkillHookReceipt(store, run.id, `${endKey}:completed`)
    if (completed !== undefined) z.literal(true).parse(completed)
    else {
      await this.hooks.run(
        "SessionEnd",
        { sessionEndReason: "other", stopContext: { assistantResponse: saved.content } },
        endKey
      )
      signal.throwIfAborted()
      store.assertDispatch(lease)
      store.toolOnce(lease, `${endKey}:completed`, { event: "SessionEnd" }, () => true)
    }
    return saved.content
  }
}
