import { BotDomainError } from "../../shared/bot-types"
import type { BotBrowserDownloadNotice, BotStore } from "./store"

export type BotDownloadAddress = {
  botId: string
  conversationId: string
  runId: string | null
  threadRootId: string | null
}
type PendingDownload = BotDownloadAddress & { guid: string }

/** Only in-flight identities are retained. No URL, cookie, filename or partial bytes.
 * The Host lifetime lock must be held before recovering abandoned downloads. */
export class BotBrowserDownloadJournal {
  constructor(
    private readonly store: BotStore,
    private readonly notice: (input: BotBrowserDownloadNotice) => void
  ) {}

  private rows(guid?: string): PendingDownload[] {
    const rows =
      this.store.db.exec(
        `SELECT guid,bot_id,conversation_id,run_id,thread_root_id FROM bot_browser_downloads
       ${guid === undefined ? "ORDER BY guid LIMIT 64" : "WHERE guid=?"}`,
        guid === undefined ? [] : [guid]
      )[0]?.values ?? []
    return rows.map(([id, botId, conversationId, runId, threadRootId]) => ({
      guid: String(id),
      botId: String(botId),
      conversationId: String(conversationId),
      runId: runId === null ? null : String(runId),
      threadRootId: threadRootId === null ? null : String(threadRootId)
    }))
  }

  private assertAddress(current: BotDownloadAddress, expected: BotDownloadAddress): void {
    if (
      current.botId !== expected.botId ||
      current.conversationId !== expected.conversationId ||
      current.runId !== expected.runId ||
      current.threadRootId !== expected.threadRootId
    )
      throw new BotDomainError("artifact_scope", "下载身份已绑定其他对话或任务")
  }

  started(guid: string, address: BotDownloadAddress): void {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(guid))
      throw new BotDomainError("invalid_input", "下载身份无效")
    this.store.transaction(() => {
      this.store.getBot(address.botId)
      if (!this.store.getConversation(address.conversationId).members.includes(address.botId))
        throw new BotDomainError("artifact_scope", "Bot 已离开该对话")
      if (address.threadRootId)
        this.store.threads.root(address.conversationId, address.threadRootId)
      if (address.runId) {
        const run = this.store.getRun(address.runId)
        this.assertAddress(
          { ...run, runId: run.id, threadRootId: run.threadRootId ?? null },
          address
        )
      }
      const current = this.rows(guid)[0]
      if (current) return this.assertAddress(current, address)
      this.store.db.run("INSERT INTO bot_browser_downloads VALUES(?,?,?,?,?)", [
        guid,
        address.botId,
        address.conversationId,
        address.runId,
        address.threadRootId
      ])
    })
  }

  /** Called after artifact publication, or with a sanitized failure reason.
   * A crash between publication and cleanup cannot turn a saved file into a failure. */
  settled(guid: string, address: BotDownloadAddress, reason?: string): void {
    this.store.transaction(() => {
      const pending = this.rows(guid)[0]
      if (!pending) return
      this.assertAddress(pending, address)
      this.finish(pending, reason)
    })
  }

  private finish(pending: PendingDownload, reason?: string): void {
    const published = this.store.db.exec("SELECT 1 FROM bot_artifacts WHERE id=?", [
      `browser-download:${pending.guid}`
    ])[0]?.values.length
    if (!published) {
      if (reason === undefined) throw new BotDomainError("artifact_scope", "下载文件尚未保存")
      // Do not send to a new private conversation, deleted Bot or former group.
      const active = this.store.db.exec(
        `SELECT 1 FROM bot_members m JOIN bots b ON b.id=m.bot_id
         WHERE m.bot_id=? AND m.conversation_id=? AND b.deleted_at IS NULL`,
        [pending.botId, pending.conversationId]
      )[0]?.values.length
      if (active)
        this.notice({
          nonce: `browser-download-failure:${pending.guid}`,
          botId: pending.botId,
          conversationId: pending.conversationId,
          runId: pending.runId,
          ...(pending.threadRootId ? { threadRootId: pending.threadRootId } : {}),
          text: `下载未完成：${reason}`
        })
    }
    // The failure notice and deletion commit together. Retrying cannot duplicate it.
    this.store.db.run("DELETE FROM bot_browser_downloads WHERE guid=?", [pending.guid])
  }

  recoverAtStartup(): number {
    let recovered = 0
    for (;;) {
      const pending = this.rows()
      if (!pending.length) return recovered
      this.store.transaction(() => {
        for (const download of pending) this.finish(download, "后台重启，下载已中断，请重新下载")
      })
      recovered += pending.length
    }
  }
}
