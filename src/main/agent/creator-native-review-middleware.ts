import { createMiddleware } from "langchain"
import { getModDevelopmentService } from "../mods/devtools/development-service"
import { captureLocalThreadRunLease, getLocalThreadRunLease } from "./thread-run-lease"
import {
  captureCurrentRunMessageQueueOwner,
  peekCurrentRunMessageQueue
} from "./current-run-message-queue"

/** Native creator review yields only after the original ToolNode's whole batch has settled. */
export function createCreatorNativeReviewMiddleware(input: {
  threadId?: string
  workspace: string
  runToken?: string
  signal?: AbortSignal
}) {
  const { threadId, workspace, runToken, signal } = input
  const service = getModDevelopmentService()
  const lease = threadId ? getLocalThreadRunLease(threadId) : undefined
  if (!service || !threadId || !runToken || lease?.owner !== "desktop" || lease.runId !== runToken)
    return undefined
  let assertCreator: () => void
  let assertQueueOwner: () => void
  try {
    assertCreator = service.captureCreatorMode(threadId, workspace)
    assertQueueOwner = captureCurrentRunMessageQueueOwner(threadId, runToken)
  } catch {
    return undefined
  }
  const owns = captureLocalThreadRunLease(threadId)
  const current = () => {
    signal?.throwIfAborted()
    assertCreator()
    assertQueueOwner()
    const actual = getLocalThreadRunLease(threadId)
    return (
      getModDevelopmentService() === service &&
      owns?.() === true &&
      actual?.owner === "desktop" &&
      actual.runId === runToken
    )
  }
  let inFlight = 0,
    completed = 0
  return createMiddleware({
    name: "creatorNativeReviewHandoff",
    beforeModel: {
      canJumpTo: ["end"],
      hook: () => {
        if (!completed || inFlight) return undefined
        try {
          if (
            current() &&
            peekCurrentRunMessageQueue(threadId).length === 0 &&
            service.hasPendingNativeTurnReview(threadId, workspace, runToken) &&
            current()
          )
            return { jumpTo: "end" as const }
        } catch {
          /* Scope changes never manufacture a successful handoff. */
        }
        return undefined
      }
    },
    wrapToolCall: async (request, handler) => {
      inFlight++
      try {
        const result = await handler(request)
        completed++
        return result
      } finally {
        inFlight--
      }
    }
  })
}
