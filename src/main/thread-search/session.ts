import type { ThreadIncarnationSnapshot } from "../../shared/thread-incarnation"
import {
  createChatSearchPlanQueryFilter,
  findChatTextRanges,
  iterateChatSearchLocations,
  projectChatSearchPlan
} from "../../shared/chat-search-index"
import { createThreadSearchMessagePlan } from "../../shared/thread-search-projection"
import {
  formatGoalUserEventMessage,
  isVisibleGoalUserEventMessage
} from "../../shared/goal-events"
import type {
  SearchCoverageReason,
  ThreadSearchPage,
  ThreadSearchResult,
  ThreadSearchRoute,
  ThreadSearchStartRequest
} from "../../shared/thread-search-types"
import type { createThreadSearchReader } from "./reader"
import type { ProjectSearchCatalog } from "./protocol"

type Reader = ReturnType<typeof createThreadSearchReader>
type Cursor = NonNullable<ReturnType<Reader["readMessages"]>["next"]>
export class ThreadSearchSession {
  private candidates
  private titleMatches = new Set<string>()
  private index = 0
  private titlePhase = true
  private before: Cursor | null = null
  private goalBefore: number | null = null
  private messagePhase = true
  private reasons = new Set<SearchCoverageReason>()
  private scannedThreads = 0
  private skippedRows = 0
  private pendingThreads = 0
  private failedThreads = 0
  private totalMatches = 0
  private activeMs = 0
  private sequence = 0
  private epoch: number | null = null
  private retries = 0
  private lastCursor: string | null = null
  private lastPage: ThreadSearchPage | null = null
  private limit: number
  private readonly flag: Int32Array
  private readonly mayMatch: ReturnType<typeof createChatSearchPlanQueryFilter>
  private pendingMatch: ThreadSearchResult | null = null

  constructor(
    private readonly id: string,
    private readonly request: ThreadSearchStartRequest,
    private readonly reader: Reader,
    cancellation: SharedArrayBuffer,
    private readonly audit: (
      threadId: string,
      incarnation: ThreadIncarnationSnapshot,
      epoch: number,
      route?: ThreadSearchRoute
    ) => "verified" | "pending" | "failed" | "foreground-required" | "projection-truncated" | "legacy-unverified",
    catalog?: ProjectSearchCatalog
  ) {
    const started = performance.now()
    this.flag = new Int32Array(cancellation)
    this.mayMatch = createChatSearchPlanQueryFilter(request.query)
    this.limit = request.limit ?? 20
    const workspace = request.scope?.kind === "ordinary" ? request.scope.workspacePath : request.workspacePath
    const directory = reader.captureCandidates(workspace, this.flag, request.scope, catalog)
    this.candidates = directory.candidates
    if (directory.limited) this.reasons.add("candidate-limit")
    if (directory.catalogUnavailable) this.reasons.add("project-catalog-unavailable")
    if (directory.routeUnavailable) this.reasons.add("project-route-unavailable")
    this.activeMs = performance.now() - started
  }

  noteCheckpointDirectoryChange(): void {
    this.reasons.add("changed-during-search")
    if (this.lastPage) {
      this.lastPage.coverage.completeness = "partial"
      this.lastPage.coverage.reasons = [...this.reasons]
    }
  }

  page(cursor: string | null): ThreadSearchPage | null {
    if (this.lastPage && cursor === this.lastCursor) return this.lastPage
    if (this.lastPage && (!cursor || cursor !== this.lastPage.nextCursor)) return null
    const started = performance.now()
    const results: ThreadSearchResult[] = []
    let bytes = 2048
    const add = (match: ThreadSearchResult): boolean => {
      if (this.request.scope && this.request.scope.kind !== "ordinary" &&
          !this.reader.matchesSearchRoute(match.threadId, match.route)) {
        this.reasons.add("project-catalog-changed")
        return true
      }
      const cost = Buffer.byteLength(JSON.stringify(match)) + 1
      if (cost > 128 * 1024 - 2048) {
        this.reasons.add("projection-truncated")
        this.skippedRows += 1
        return true
      }
      if (bytes + cost > 128 * 1024) {
        this.pendingMatch = match
        return false
      }
      results.push(match)
      this.totalMatches += 1
      bytes += cost
      return true
    }
    if (this.pendingMatch) {
      const pending = this.pendingMatch
      this.pendingMatch = null
      add(pending)
    }
    const scan = () => {
      while (
        !Atomics.load(this.flag, 0) &&
        results.length < this.limit &&
        this.totalMatches < 1000 &&
        performance.now() - started < 50 &&
        this.activeMs + performance.now() - started < 30_000
      ) {
        const entry = this.candidates[this.index]
        if (!entry) {
          if (!this.titlePhase) break
          this.index = 0
          this.titlePhase = false
          // Publish titles before doing any body reads.
          break
        }
        const { hasGoalEvents, ...candidate } = entry
        if (this.titlePhase) {
          this.index += 1
          const range = findChatTextRanges(candidate.title, this.request.query, 1)[0]
          if (!range) continue
          this.titleMatches.add(candidate.threadId)
          const start = Math.max(0, range.start - 80)
          if (
            !add({
              ...candidate,
              matchedBy: "title",
              target: null,
              navigation: "threadOnly",
              snippet: candidate.title.slice(start, range.end + 80),
              snippetRanges: [{ start: range.start - start, end: range.end - start }]
            })
          )
            break
          continue
        }
        const completeThread = () => {
          this.scannedThreads += 1
          this.index += 1
          this.before = null
          this.goalBefore = null
          this.messagePhase = true
          this.epoch = null
          this.retries = 0
        }
        const auditThread = (epoch: number) => {
          const status = this.audit(candidate.threadId, candidate.incarnation, epoch, candidate.route)
          if (status === "pending") {
            this.pendingThreads += 1
            this.reasons.add("legacy-pending")
          } else if (status === "foreground-required") {
            this.failedThreads += 1
            this.reasons.add("legacy-foreground-required")
          } else if (status === "failed") {
            this.failedThreads += 1
            this.reasons.add("unavailable-source")
          } else if (status === "projection-truncated" || status === "legacy-unverified") {
            this.reasons.add(status)
          }
        }
        if (this.titleMatches.has(candidate.threadId)) {
          auditThread(this.reader.structureEpoch(candidate.threadId))
          completeThread()
          continue
        }
        const epoch = this.reader.structureEpoch(candidate.threadId)
        if (this.epoch !== null && epoch !== this.epoch) {
          this.before = null
          this.goalBefore = null
          this.messagePhase = true
          this.retries += 1
          if (this.retries > 2) {
            this.reasons.add("changed-during-search")
            completeThread()
            continue
          }
        }
        this.epoch = epoch
        const wasGoal = !this.messagePhase
        let result: ThreadSearchResult | undefined
        if (this.messagePhase) {
          const batch = this.reader.readMessages(candidate, this.before, this.flag)
          if (batch.staleIdentity) {
            this.reasons.add("changed-during-search")
            completeThread()
            continue
          }
          this.skippedRows += batch.skippedRows
          if (batch.skippedRows) this.reasons.add("oversized-row")
          for (const row of batch.rows) {
            if (Atomics.load(this.flag, 0)) break
            const plan = createThreadSearchMessagePlan(
              row.role,
              row.content,
              row.fragments,
              row.toolCallsJson,
              row.reasoningSample,
              row.reasoningOmitted
            )
            if (!plan) continue
            if (!this.mayMatch(plan)) {
              if (plan.truncated) this.reasons.add("projection-truncated")
              continue
            }
            const projected = projectChatSearchPlan(plan, true)
            if (plan.truncated) this.reasons.add("projection-truncated")
            const location = iterateChatSearchLocations(projected, this.request.query, 1).next()
              .value
            if (!location) continue
            const target = row.messageId
              ? {
                  kind: "durableMessage" as const,
                  messageId: row.messageId,
                  ordinalHint: row.ordinal,
                  structureEpoch: epoch,
                  location
                }
              : null
            const match = {
              ...candidate,
              matchedBy: "message" as const,
              snippet: location.context,
              snippetRanges: [{ start: location.contextStart, end: location.contextEnd }]
            }
            result = target && !plan.reasoningVisibilityUnverified
              ? { ...match, navigation: "exact", target }
              : { ...match, navigation: "threadOnly", target: null }
            break
          }
          this.before = batch.next
          this.messagePhase = batch.next !== null
        } else {
          const batch = this.reader.readGoalEvents(candidate, this.goalBefore)
          if (batch.staleIdentity) {
            this.reasons.add("changed-during-search")
            completeThread()
            continue
          }
          if (batch.skippedRows) this.reasons.add("oversized-row")
          this.skippedRows += batch.skippedRows
          for (const event of batch.rows) {
            if (!isVisibleGoalUserEventMessage(event.message)) continue
            const command = formatGoalUserEventMessage(event.message)
            const plan = createThreadSearchMessagePlan(
              "user",
              command,
              [],
              null
            )
            if (!plan) continue
            const projected = projectChatSearchPlan(plan, true)
            if (plan.truncated) this.reasons.add("projection-truncated")
            const location = iterateChatSearchLocations(projected, this.request.query, 1).next()
              .value
            if (!location) continue
            const anchor = this.reader.readGoalAnchor(candidate.threadId, event.id)
            const anchorMessageId =
              typeof anchor?.transcript_message_id === "string"
                ? anchor.transcript_message_id
                : null
            const ordinalHint =
              typeof anchor?.transcript_ordinal === "number" ? anchor.transcript_ordinal : null
            const duplicate = this.reader.goalCommandHasDurableCopy(
              candidate.threadId, anchorMessageId, command, event.scope, this.flag)
            if (duplicate === true) continue
            if (duplicate === null) {
              this.reasons.add("legacy-unverified")
              continue
            }
            result = {
              ...candidate,
              matchedBy: "message",
              navigation:
                anchorMessageId && ordinalHint !== null
                  ? "exact"
                  : "threadOnly",
              snippet: location.context,
              snippetRanges: [{ start: location.contextStart, end: location.contextEnd }],
              target: {
                kind: "goalEvent",
                eventId: String(event.id),
                anchorMessageId,
                ordinalHint,
                structureEpoch: epoch,
                location
              }
            }
            break
          }
          this.goalBefore = batch.next
        }
        const exhausted =
          !this.messagePhase && (!hasGoalEvents || (wasGoal && this.goalBefore === null))
        if (result || exhausted) auditThread(epoch)
        if (result) {
          completeThread()
          if (!add(result)) break
        } else if (exhausted) {
          completeThread()
        }
      }
    }
    // One bounded slice shares a WAL snapshot. Resuming rechecks the epoch
    // before it reuses an unfinished conversation's cursors.
    if (this.titlePhase) scan()
    else this.reader.readSnapshot(scan)

    this.activeMs += performance.now() - started
    if (this.activeMs >= 30_000 || this.totalMatches >= 1000) this.reasons.add("scan-budget")
    const done = !this.titlePhase && this.index >= this.candidates.length && !this.pendingMatch
    const scanStatus = Atomics.load(this.flag, 0)
      ? "cancelled"
      : this.reasons.has("scan-budget") || (done && this.reasons.has("candidate-limit"))
        ? "limited"
        : done
          ? "complete"
          : "running"
    this.lastCursor = cursor
    this.lastPage = {
      sessionId: this.id,
      results,
      scanStatus,
      nextCursor: scanStatus === "running" ? `${this.id}.${++this.sequence}` : null,
      scannedThreads: this.scannedThreads,
      coverage: {
        basis: "durable-visible",
        completeness: this.reasons.size ? "partial" : done ? "complete" : "unknown",
        reasons: [...this.reasons],
        pendingThreads: this.pendingThreads,
        failedThreads: this.failedThreads,
        skippedRows: this.skippedRows
      }
    }
    if (scanStatus !== "running") {
      this.candidates = []
      this.titleMatches.clear()
    }
    return this.lastPage
  }
}
