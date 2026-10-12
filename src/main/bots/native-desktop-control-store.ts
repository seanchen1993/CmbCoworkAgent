import type { BotStore } from "./store"
import * as v from "./validation"

/** Only the held flag survives a Host restart. HWNDs, element tokens and client
 * connections never become restored authority. Browser login state stays with
 * its existing owner and is not reused as native control state. */
export class NativeDesktopControlStore {
  constructor(private readonly store: BotStore) {}
  private key(botId: string, taskRunId?: string): string {
    this.store.getBot(v.identifier(botId))
    if (taskRunId) this.store.taskBrowsers.assertOwner(botId, taskRunId)
    return taskRunId ? `task:${v.identifier(taskRunId)}` : "bot"
  }
  held(botId: string, taskRunId?: string): boolean {
    const key = this.key(botId, taskRunId)
    return Boolean(
      this.store.db.exec(
        "SELECT 1 FROM bot_native_desktop_controls WHERE bot_id=? AND target_key=?",
        [botId, key]
      )[0]?.values.length
    )
  }
  save(botId: string, taskRunId: string | undefined, held: boolean): void {
    this.store.transaction(() => {
      const key = this.key(botId, taskRunId)
      if (held)
        this.store.db.run(
          `INSERT INTO bot_native_desktop_controls(bot_id,target_key,run_id,human_held,updated_at) VALUES(?,?,?,1,?)
         ON CONFLICT(bot_id,target_key) DO UPDATE SET updated_at=excluded.updated_at`,
          [botId, key, taskRunId ?? null, this.store.now()]
        )
      else
        this.store.db.run(
          "DELETE FROM bot_native_desktop_controls WHERE bot_id=? AND target_key=?",
          [botId, key]
        )
    })
  }
}
