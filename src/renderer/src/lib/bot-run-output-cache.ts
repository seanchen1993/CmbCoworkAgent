import {
  BOT_RUN_OUTPUT_MAX_CHARACTERS,
  type BotRunOutputPage,
  type BotRunOutputRequest
} from "../../../shared/bot-run-output"
import type { BotRun } from "../../../shared/bot-types"
import type { BotConversationTaskScope } from "./bot-conversation-tasks"

export interface BotCachedRunOutput {
  text: string
  hasMore: boolean
  error?: string
}
interface Entry {
  run: BotRun
  text: string
  through: number
  prefixSha256?: string
  cursor: number
  complete: boolean
  error?: string
  pending?: Promise<void>
}
/** Only the selected four inline tasks and one expanded row own text. Requests
 * share the existing workspace refresh and never create another polling loop. */
export class BotRunOutputCache {
  private authority = ""
  private hostId = ""
  private entries = new Map<string, Entry>()
  private active = 0
  private queue: {
    current: () => boolean
    resolve: (granted: boolean) => void
  }[] = []
  clear(): void {
    this.authority = ""
    this.entries.clear()
    for (const queued of this.queue.splice(0)) queued.resolve(false)
  }
  reconcile(scope: BotConversationTaskScope, hostId: string, runs: readonly BotRun[]): void {
    const authority = JSON.stringify([
      hostId,
      scope.dataEpoch,
      scope.conversationId,
      scope.threadRootId ?? null
    ])
    if (authority !== this.authority) {
      this.clear()
      this.authority = authority
    }
    this.hostId = hostId
    const wanted = new Set(runs.slice(0, 5).map((run) => run.id))
    for (const id of this.entries.keys()) if (!wanted.has(id)) this.entries.delete(id)
    for (const run of runs.slice(0, 5)) {
      const old = this.entries.get(run.id)
      if (!old || old.run.revision !== run.revision || old.run.fence !== run.fence)
        this.entries.set(run.id, {
          run,
          text: "",
          through: 0,
          cursor: run.hasOutput ? -1 : (run.outputCursor ?? 0),
          complete: !run.hasOutput
        })
      else old.run = run
    }
  }
  private async request<T>(current: () => boolean, read: () => Promise<T>): Promise<T | undefined> {
    if (this.active >= 2) {
      const granted = await new Promise<boolean>((resolve) => this.queue.push({ current, resolve }))
      if (!granted) return undefined
    } else this.active++
    try {
      return current() ? await read() : undefined
    } finally {
      let queued = this.queue.shift()
      while (queued && !queued.current()) {
        queued.resolve(false)
        queued = this.queue.shift()
      }
      if (queued)
        queued.resolve(true) // Transfer the reserved slot without a race.
      else this.active--
    }
  }
  async refresh(
    scope: BotConversationTaskScope,
    read: (input: BotRunOutputRequest) => Promise<BotRunOutputPage>
  ): Promise<void> {
    const authority = this.authority
    await Promise.all(
      [...this.entries.values()].map((entry) => {
        if (entry.complete && entry.cursor >= (entry.run.outputCursor ?? 0)) return
        if (entry.pending) return entry.pending
        const current = () =>
          this.authority === authority && this.entries.get(entry.run.id) === entry
        const work = async () => {
          try {
            for (let page = 0; page < 2 && current(); page++) {
              const run = entry.run
              const response = await this.request(current, () =>
                read({
                  conversationId: scope.conversationId,
                  ...(scope.threadRootId ? { threadRootId: scope.threadRootId } : {}),
                  runId: run.id,
                  dataEpoch: scope.dataEpoch ?? "initial",
                  revision: run.revision,
                  fence: run.fence,
                  offset: entry.through,
                  ...(entry.prefixSha256 ? { prefixSha256: entry.prefixSha256 } : {})
                })
              )
              if (!current() || !response) return
              if (
                response.hostId !== this.hostId ||
                response.runId !== run.id ||
                response.conversationId !== scope.conversationId ||
                response.threadRootId !== scope.threadRootId ||
                response.dataEpoch !== scope.dataEpoch ||
                response.revision !== run.revision ||
                response.fence !== run.fence
              )
                throw new Error("任务输出身份已变化，请重新读取")
              if (
                response.nextOffset !==
                  (response.through < response.total ? response.through : null) ||
                [...response.text].length !== response.through - response.offset ||
                !/^[a-f0-9]{64}$/.test(response.prefixSha256) ||
                response.total > BOT_RUN_OUTPUT_MAX_CHARACTERS ||
                response.through < response.offset ||
                response.through > response.total ||
                (!response.reset && response.offset !== entry.through) ||
                (response.reset && response.offset !== 0)
              )
                throw new Error("任务输出分页位置无效")
              const text = (response.reset ? "" : entry.text) + response.text
              // Production streamOutput already enforces this UTF16 body limit.
              if (text.length > BOT_RUN_OUTPUT_MAX_CHARACTERS)
                throw new Error("任务输出超出读取上限")
              entry.text = text
              entry.through = response.through
              entry.prefixSha256 = response.prefixSha256
              entry.cursor = response.outputCursor
              entry.complete = response.nextOffset === null
              entry.error = undefined
              if (entry.complete) break
            }
          } catch (error) {
            if (current()) entry.error = error instanceof Error ? error.message : "读取实时输出失败"
          }
        }
        entry.pending = work().finally(() => {
          entry.pending = undefined
        })
        return entry.pending
      })
    )
  }
  projectFor(runs: readonly BotRun[]): Record<string, BotCachedRunOutput> {
    const current = new Map(runs.map((run) => [run.id, run]))
    return this.project((id, entry) => {
      const run = current.get(id)
      return !!run && run.revision === entry.run.revision && run.fence === entry.run.fence
    })
  }
  project(
    include: (id: string, entry: Entry) => boolean = () => true
  ): Record<string, BotCachedRunOutput> {
    return Object.fromEntries(
      [...this.entries]
        .filter(([id, entry]) => include(id, entry))
        .map(([id, entry]) => [
          id,
          {
            text: entry.text,
            hasMore: !entry.complete,
            ...(entry.error ? { error: entry.error } : {})
          }
        ])
    )
  }
}
