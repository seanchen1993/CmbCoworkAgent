import { useMemo } from "react"
import { useAppStore } from "@/lib/store"
import { isHarnessFeatureThread } from "@/lib/thread-classification"
import { useAllThreadStates, useAllStreamLoadingStates } from "@/lib/thread-context"
import { KanbanColumn } from "./KanbanColumn"
import { KanbanHeader } from "./KanbanHeader"
import { ThreadKanbanCard, SubagentKanbanCard } from "./KanbanCard"
import type { Thread, Subagent } from "@/types"

type KanbanStatus = "pending" | "in_progress" | "interrupted" | "done"

interface ThreadWithStatus {
  thread: Thread
  status: KanbanStatus
}

interface SubagentWithParent {
  subagent: Subagent
  parentThread: Thread
  status: KanbanStatus
}

function getThreadKanbanStatus(
  thread: Thread,
  isLoading: boolean,
  hasDraft: boolean,
  hasPendingApproval: boolean
): KanbanStatus {
  if (hasPendingApproval || thread.status === "interrupted") return "interrupted"
  if (thread.status === "busy" || isLoading) return "in_progress"
  if (hasDraft) return "pending"
  return "done"
}

export function KanbanView(): React.JSX.Element {
  const { threads, selectThread, showSubagentsInKanban } = useAppStore()
  const allThreadStates = useAllThreadStates()
  const loadingStates = useAllStreamLoadingStates()

  const handleCardClick = (threadId: string): void => {
    selectThread(threadId)
  }

  const chatThreads = useMemo(
    () => threads.filter((thread) => !isHarnessFeatureThread(thread)),
    [threads]
  )

  const categorizedThreads = useMemo(() => {
    const result: Record<KanbanStatus, ThreadWithStatus[]> = {
      pending: [],
      in_progress: [],
      interrupted: [],
      done: []
    }

    for (const thread of chatThreads) {
      const threadState = allThreadStates[thread.thread_id]
      const isLoading = (loadingStates[thread.thread_id] ?? false) || Boolean(threadState?.scheduledTaskLoading)
      const hasDraft = Boolean(threadState?.draftInput?.trim())
      const hasPendingApproval = Boolean(threadState?.pendingApproval)
      const status = getThreadKanbanStatus(thread, isLoading, hasDraft, hasPendingApproval)
      result[status].push({ thread, status })
    }

    return result
  }, [chatThreads, loadingStates, allThreadStates])

  const categorizedSubagents = useMemo(() => {
    if (!showSubagentsInKanban) {
      return { pending: [], in_progress: [], interrupted: [], done: [] }
    }

    const result: Record<KanbanStatus, SubagentWithParent[]> = {
      pending: [],
      in_progress: [],
      interrupted: [],
      done: []
    }

    const threadMap = new Map(chatThreads.map((t) => [t.thread_id, t]))

    for (const [threadId, state] of Object.entries(allThreadStates)) {
      const parentThread = threadMap.get(threadId)
      if (!parentThread || !state.subagents) continue

      for (const subagent of state.subagents) {
        let status: KanbanStatus
        switch (subagent.status) {
          case "pending":
            status = "pending"
            break
          case "running":
            status = "in_progress"
            break
          case "completed":
            status = "done"
            break
          case "failed":
            status = "done"
            break
          default:
            status = "pending"
        }

        result[status].push({ subagent, parentThread, status })
      }
    }

    return result
  }, [chatThreads, allThreadStates, showSubagentsInKanban])

  const columnData: { status: KanbanStatus; title: string }[] = [
    { status: "pending", title: "待处理" },
    { status: "in_progress", title: "进行中" },
    { status: "interrupted", title: "待审批" },
    { status: "done", title: "已完成" }
  ]

  return (
    <div className="flex flex-col h-full bg-background">
      <KanbanHeader className="h-10 shrink-0 border-b border-border" />
      <div className="flex-1 overflow-x-auto p-2">
        <div className="flex h-full min-w-max gap-2">
          {columnData.map(({ status, title }) => {
            const threadItems = categorizedThreads[status]
            const subagentItems = categorizedSubagents[status]
            const totalCount = threadItems.length + subagentItems.length

            return (
              <KanbanColumn key={status} title={title} status={status} count={totalCount}>
                {threadItems.map(({ thread, status: threadStatus }) => (
                  <ThreadKanbanCard
                    key={thread.thread_id}
                    thread={thread}
                    status={threadStatus}
                    onClick={() => handleCardClick(thread.thread_id)}
                  />
                ))}
                {subagentItems.map(({ subagent, parentThread }) => (
                  <SubagentKanbanCard
                    key={subagent.id}
                    subagent={subagent}
                    parentThread={parentThread}
                    onClick={() => handleCardClick(parentThread.thread_id)}
                  />
                ))}
                {totalCount === 0 && (
                  <div className="text-center text-sm text-muted-foreground py-8">暂无任务</div>
                )}
              </KanbanColumn>
            )
          })}
        </div>
      </div>
    </div>
  )
}
