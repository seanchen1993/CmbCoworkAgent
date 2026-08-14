import { ShieldCheck, X } from "lucide-react"
import { ChatTodos } from "./ChatTodos"
import { ContextCompactionCard } from "./ContextCompactionCard"
import { HookLogChip } from "./HookLogViews"
import { ProcessingDuration } from "./ProcessingDuration"
import { WorkflowHistoryButton, WorkflowRunPanel } from "./WorkflowRunPanel"
import { hasChatTimelineTailContent, type ChatTimelineTailProps } from "./ChatTimelineTailState"

export function ChatTimelineTail({
  bottomPadding,
  showDetachedHookLogs,
  hookLoggingEnabled,
  detachedHookLogBuckets,
  onOpenHookLogBucket,
  contextCompaction,
  modelRetry,
  isLoading,
  thinkingMessage,
  streamLoading,
  activeTurnStartTime,
  todos,
  workflowRun,
  isWorkflowMode,
  threadId,
  hookInterruption,
  interruptionNotice,
  onClearHookInterruption,
  errorContent
}: ChatTimelineTailProps): React.JSX.Element | null {
  if (
    !hasChatTimelineTailContent({
      bottomPadding,
      showDetachedHookLogs,
      hookLoggingEnabled,
      detachedHookLogBuckets,
      onOpenHookLogBucket,
      contextCompaction,
      modelRetry,
      isLoading,
      thinkingMessage,
      streamLoading,
      activeTurnStartTime,
      todos,
      workflowRun,
      isWorkflowMode,
      threadId,
      hookInterruption,
      interruptionNotice,
      onClearHookInterruption,
      errorContent
    })
  ) {
    return null
  }

  return (
    <div
      className="space-y-4"
      style={bottomPadding ? { paddingBottom: `${bottomPadding}px` } : undefined}
    >
      {showDetachedHookLogs && hookLoggingEnabled && detachedHookLogBuckets.length > 0 && (
        <div className="flex flex-wrap justify-start gap-2 mt-1">
          {detachedHookLogBuckets.map((bucket) => (
            <HookLogChip
              key={bucket.turnId}
              bucket={bucket}
              onClick={() => onOpenHookLogBucket(bucket.turnId)}
            />
          ))}
        </div>
      )}
      {contextCompaction && <ContextCompactionCard compaction={contextCompaction} />}
      {modelRetry && (
        <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50/60 dark:border-amber-500/40 dark:bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
          <span className="inline-block size-3 mt-0.5 rounded-full border-2 border-amber-500 border-t-transparent animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <span>
              模型暂时不可用（{modelRetry.reason}），正在重试 {modelRetry.attempt}/
              {modelRetry.maxRetries}
              {modelRetry.delayMs > 0 && <>（等待 {Math.round(modelRetry.delayMs / 100) / 10}s）</>}
              …
            </span>
          </div>
        </div>
      )}
      {isLoading && (
        <div className="space-y-3">
          {contextCompaction?.phase !== "started" && (
            <div className="flex items-center gap-2 text-sm">
              <div className="rainbow-spinner" />
              <span className="thinking-shimmer-text" data-text={thinkingMessage}>
                {thinkingMessage}
              </span>
              {streamLoading && (
                <ProcessingDuration key={threadId} startTime={activeTurnStartTime} text="已处理" />
              )}
            </div>
          )}
          {todos.length > 0 && <ChatTodos todos={todos} />}
        </div>
      )}
      {workflowRun ? (
        <WorkflowRunPanel threadId={threadId} run={workflowRun} />
      ) : isWorkflowMode ? (
        <WorkflowHistoryButton threadId={threadId} />
      ) : null}
      {hookInterruption && !isLoading && (
        <div className="flex items-start gap-3 rounded-md border border-amber-400/60 bg-amber-50/50 p-4 dark:border-amber-500/40 dark:bg-amber-500/10">
          <ShieldCheck className="size-5 text-amber-600 shrink-0 mt-0.5 dark:text-amber-300" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-amber-800 text-sm dark:text-amber-200">
              {interruptionNotice?.title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-amber-700/80 dark:text-amber-200/80">
              <span className="rounded border border-amber-400/50 px-1.5 py-0.5 font-mono">
                {hookInterruption.event}
              </span>
              <span>{hookInterruption.timestamp.toLocaleTimeString()}</span>
            </div>
            <div className="text-sm text-amber-900/90 mt-2 break-words dark:text-amber-100/90">
              {hookInterruption.reason}
            </div>
            {hookInterruption.systemMessage && (
              <div className="text-xs text-amber-700/80 mt-2 break-words dark:text-amber-200/80">
                {hookInterruption.systemMessage}
              </div>
            )}
            <div className="text-xs text-muted-foreground mt-2">
              {interruptionNotice?.explanation}
            </div>
          </div>
          <button
            onClick={onClearHookInterruption}
            className="shrink-0 rounded p-1 hover:bg-amber-500/20 transition-colors"
            aria-label="Dismiss hook notice"
          >
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>
      )}
      {errorContent}
    </div>
  )
}
