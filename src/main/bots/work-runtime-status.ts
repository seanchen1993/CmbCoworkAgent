import type { BotWorkSummary } from "../../shared/bots/work"
import type { BotWorkRuntimeState } from "../../shared/bots/work-status"
import type { ThreadIncarnationRow } from "../services/thread-incarnation"
import { verifyWorkConversationThread, verifyWorkThreadMetadata } from "./conversation-link-authority"

interface RuntimeStatusReaders {
  thread(id: string): (ThreadIncarnationRow & { metadata: string | null }) | null | undefined
  running(id: string): boolean
  userInput(id: string): BotWorkRuntimeState["userInput"]
  approval(id: string): boolean
  commands(id: string): boolean
  workflow(id: string): boolean
  workers(id: string): boolean
  pendingResults(id: string): boolean
}

/** One metadata lookup + in-memory registries. Never loads history or captures the browser. */
export function readBotWorkRuntimeStatus(work: BotWorkSummary, read: RuntimeStatusReaders): BotWorkRuntimeState {
  const empty: BotWorkRuntimeState = {
    available: false, threadExists: false, runActive: false,
    userInput: { count: 0, questions: [] }, approval: false,
    commands: false, workflow: false, workers: false, pendingResults: false
  }
  try {
    const row = read.thread(work.threadId)
    if (!row) return { ...empty, available: true }
    const identity = { ...work, audienceKey: work.source?.audienceKey ?? "desktop" }
    const metadata = JSON.parse(row.metadata || "{}") as Record<string, unknown>
    if (work.conversation) {
      if (work.conversation.state !== "bound") return empty
      verifyWorkConversationThread(identity, row, metadata)
    } else verifyWorkThreadMetadata(identity, metadata)
    return {
      available: true, threadExists: true, runActive: read.running(work.threadId),
      userInput: read.userInput(work.threadId), approval: read.approval(work.threadId),
      commands: read.commands(work.threadId), workflow: read.workflow(work.threadId),
      workers: read.workers(work.threadId), pendingResults: read.pendingResults(work.threadId)
    }
  } catch {
    // Missing/corrupt identity or a failed probe is not evidence that a thread is idle.
    return empty
  }
}
