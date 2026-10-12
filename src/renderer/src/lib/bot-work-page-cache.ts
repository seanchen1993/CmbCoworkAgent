import type {
  BotWorkCursor,
  BotWorkScope,
  BotWorkCounts,
  BotWorkPageRequest
} from "../../../shared/bot-work-pages"
import { botWorkScopeKey } from "../../../shared/bot-work-pages"

export interface BotRendererWorkPage<T> {
  items: T[]
  counts?: BotWorkCounts
  loading: boolean
  error?: string
  pageIndex: number
  canPrevious: boolean
  canNext: boolean
}
interface Page<T> {
  hostId: string
  dataEpoch: string
  scope: BotWorkScope
  items: T[]
  counts: BotWorkCounts
  next: BotWorkCursor | null
}
/** One resident page. Cursor history is bounded and never causes automatic reads. */
export class BotWorkPageCache<T> {
  private authority = ""
  private generation = 0
  private open = false
  private cursors: (BotWorkCursor | undefined)[] = [undefined]
  private index = 0
  private baseIndex = 0
  private pending?: Promise<void>
  private page?: Page<T>
  private failure?: string
  bind(hostId: string, dataEpoch: string, scope: BotWorkScope): void {
    const key = JSON.stringify([hostId, dataEpoch, botWorkScopeKey(scope)])
    if (key === this.authority) return
    this.authority = key
    this.reset()
  }
  reset(): void {
    this.generation++
    this.cursors = [undefined]
    this.index = this.baseIndex = 0
    this.page = undefined
    this.failure = undefined
    this.pending = undefined
  }
  setOpen(open: boolean): void {
    if (this.open === open) return
    this.open = open
    if (!open) this.reset()
  }
  navigate(direction: "next" | "previous" | "first"): void {
    if (direction === "previous" && this.index > 0) this.index--
    else if (direction === "next" && this.page?.next) {
      this.cursors.splice(this.index + 1)
      this.cursors.push(this.page.next)
      this.index++
      if (this.cursors.length > 32) {
        this.cursors.shift()
        this.index--
        this.baseIndex++
      }
    } else if (direction === "first") {
      this.cursors = [undefined]
      this.index = this.baseIndex = 0
    } else return
    this.generation++
    this.pending = undefined
    this.page = undefined
    this.failure = undefined
  }
  project(): BotRendererWorkPage<T> {
    return {
      items: this.page?.items ?? [],
      counts: this.page?.counts,
      loading: !!this.pending,
      error: this.failure,
      pageIndex: this.baseIndex + this.index,
      canPrevious: this.index > 0,
      canNext: !!this.page?.next
    }
  }
  refresh(
    request: Omit<BotWorkPageRequest, "before" | "limit">,
    read: (input: BotWorkPageRequest) => Promise<Page<T>>,
    publish: () => void
  ): Promise<void> {
    if (!this.open) return Promise.resolve()
    this.bind(request.hostId, request.dataEpoch, request.scope)
    if (this.pending) return this.pending
    const generation = this.generation,
      authority = this.authority
    const before = this.cursors[this.index]
    const current = () =>
      this.open && generation === this.generation && authority === this.authority
    const job = Promise.resolve()
      .then(() => read({ ...request, ...(before ? { before } : {}), limit: 20 }))
      .then((page) => {
        if (!current()) return
        if (
          page.hostId !== request.hostId ||
          page.dataEpoch !== request.dataEpoch ||
          botWorkScopeKey(page.scope) !== botWorkScopeKey(request.scope) ||
          page.items.length > 20 ||
          (page.next &&
            (page.next.hostId !== request.hostId ||
              page.next.dataEpoch !== request.dataEpoch ||
              page.next.scopeKey !== botWorkScopeKey(request.scope)))
        )
          throw new Error("任务列表身份已变化，请刷新")
        this.page = page
        this.failure = undefined
      })
      .catch((error) => {
        if (current()) this.failure = error instanceof Error ? error.message : "任务列表读取失败"
      })
      .finally(() => {
        if (this.pending !== job) return
        this.pending = undefined
        if (current()) publish()
      })
    this.pending = job
    publish()
    return job
  }
}
