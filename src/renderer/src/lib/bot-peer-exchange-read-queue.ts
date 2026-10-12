import { createContext } from "react"
import {
  createBoundedLatestTaskQueue,
  type BoundedTaskContext
} from "../components/harness-board/bounded-latest-task-queue"

/** A Workspace owns this one read slot across its keyed Content/Dialog lifetimes.
 * The latest callback carries its exact scope; the queue stores no transcript. */
export function createBotPeerExchangeReadQueue() {
  return createBoundedLatestTaskQueue<"read", (context: BoundedTaskContext) => Promise<void>>(
    1,
    (read, context) => read(context)
  )
}
export const BotPeerExchangeReadQueueContext = createContext<ReturnType<
  typeof createBotPeerExchangeReadQueue
> | null>(null)
