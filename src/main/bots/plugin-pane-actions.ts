import { botPluginPaneAction, type BotPluginPaneAction } from "../../shared/bot-plugin-panes"
import { BotDomainError, type BotRunLease, type BotSendReceipt } from "../../shared/bot-types"
import type { BotStore } from "./store"
import { canonicalJson } from "./validation"

export const BOT_PLUGIN_PANE_SOURCE = "plugin-pane"

/** Human UI intents join the same durable queue as other Bot work. The opening
 * message is a navigation anchor, never the source of execution permission. */
export class BotPluginPaneActions {
  constructor(
    private readonly store: BotStore,
    private readonly receipt: <T>(nonce: string, input: unknown, operation: () => T) => T,
    private readonly enqueue: (input: BotPluginPaneAction, messageId: string) => string
  ) {}

  submit(raw: unknown, origin: (input: BotPluginPaneAction) => string): BotSendReceipt {
    const input = botPluginPaneAction.parse(raw)
    return this.store.transaction(() =>
      this.receipt(`plugin-pane:${input.action.intentId}`, input, () => {
        this.store.getBot(input.botId)
        const conversation = this.store.getConversation(input.conversationId)
        if (!conversation.members.includes(input.botId))
          throw new BotDomainError("plugin_pane_scope", "插件面板不属于当前对话")
        const queued = this.store.db.exec(
          "SELECT count(*) FROM bot_runs WHERE bot_id=? AND source=? AND status IN ('queued','running','waiting_input','cancelling')",
          [input.botId, BOT_PLUGIN_PANE_SOURCE]
        )[0]?.values[0]?.[0]
        if (Number(queued) >= 32)
          throw new BotDomainError("plugin_pane_busy", "面板操作较多，请等待当前操作完成")
        if (input.threadRootId) this.store.threads.root(input.conversationId, input.threadRootId)
        const messageId = origin(input)
        const message = this.store.message({ conversationId: input.conversationId, id: messageId })
        if (!message || message.threadRootId !== input.threadRootId)
          throw new BotDomainError("plugin_pane_scope", "插件面板不属于当前讨论")
        const runId = this.enqueue(input, messageId)
        this.store.db.run("INSERT INTO bot_plugin_pane_actions(run_id,request) VALUES(?,?)", [
          runId,
          JSON.stringify(input)
        ])
        return { messageId, runIds: [runId] }
      })
    )
  }

  read(runId: string): BotPluginPaneAction | undefined {
    const row = this.store.db.exec("SELECT request FROM bot_plugin_pane_actions WHERE run_id=?", [
      runId
    ])[0]?.values[0]
    if (!row) return undefined
    const input = botPluginPaneAction.parse(JSON.parse(String(row[0])))
    const run = this.store.getRun(runId)
    if (
      run.source !== BOT_PLUGIN_PANE_SOURCE ||
      run.lane !== "user" ||
      run.botId !== input.botId ||
      run.conversationId !== input.conversationId ||
      run.threadRootId !== input.threadRootId
    )
      throw new BotDomainError("plugin_pane_scope", "插件操作与任务范围不一致")
    return input
  }

  start(lease: BotRunLease, input: BotPluginPaneAction): void {
    const current = this.read(lease.runId)
    if (!current || canonicalJson(current) !== canonicalJson(input))
      throw new BotDomainError("plugin_pane_scope", "缺少用户面板操作记录")
    if (this.store.hasToolResult(lease, "plugin-pane:started"))
      throw new BotDomainError(
        "plugin_pane_interrupted",
        "该面板操作已开始但结果未确认；请核对结果后在当前面板重新操作"
      )
    this.store.toolOnce(lease, "plugin-pane:started", input, () => true)
  }
}
