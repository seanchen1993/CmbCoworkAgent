import { useMemo, useState } from "react"
import { Code2, Loader2, RotateCcw, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { useAppStore } from "@/lib/store"
import { findRequirementDevelopmentThreads } from "@/lib/requirement-development"
import type { RequirementRecord } from "./requirement-data"
import { shouldHideRequirementDevelopment } from "./requirement-persona"
import {
  REQUIREMENT_ACTION_HINTS,
  RequirementActionButton
} from "./RequirementActionButton"

export function RequirementDevelopmentActions({
  requirement,
  onStartDevelopment,
  onContinueDevelopment,
  onResetDevelopment
}: {
  requirement: RequirementRecord
  onStartDevelopment: () => void | Promise<void>
  onContinueDevelopment: (threadId: string) => void | Promise<void>
  onResetDevelopment: () => void | Promise<void>
}): React.JSX.Element {
  const threads = useAppStore((state) => state.threads)
  const developmentThreads = useMemo(
    () => findRequirementDevelopmentThreads(requirement.id, threads),
    [requirement.id, threads]
  )
  const existingThreadId = developmentThreads[0]?.thread_id ?? requirement.developmentThreadIds[0]
  const inProgress = Boolean(existingThreadId)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  if (shouldHideRequirementDevelopment()) return <></>

  return (
    <>
      <div className="flex items-center gap-1.5">
        {inProgress && (
          <RequirementActionButton
            type="button"
            size="sm"
            variant="outline"
            className="h-7 gap-1 px-2 text-[11px] text-destructive hover:text-destructive"
            hint={REQUIREMENT_ACTION_HINTS.resetDevelopment}
            onClick={() => setResetOpen(true)}
          >
            <RotateCcw className="size-3" />
            重置
          </RequirementActionButton>
        )}
        <RequirementActionButton
          type="button"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px]"
          hint={
            inProgress
              ? REQUIREMENT_ACTION_HINTS.continueDevelopment
              : REQUIREMENT_ACTION_HINTS.startDevelopment
          }
          onClick={() => {
            if (existingThreadId) void onContinueDevelopment(existingThreadId)
            else void onStartDevelopment()
          }}
        >
          <Code2 className="size-3" />
          {inProgress ? "继续开发" : "去开发"}
        </RequirementActionButton>
      </div>

      <Dialog
        open={resetOpen}
        onOpenChange={(open) => {
          if (!resetting) setResetOpen(open)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>确认重置需求开发？</DialogTitle>
            <DialogDescription>
              重置后仅解除需求与开发会话的关联。开发会话及其历史记录仍会保留。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              disabled={resetting}
              onClick={() => setResetOpen(false)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={resetting}
              onClick={() => {
                setResetting(true)
                void Promise.resolve(onResetDevelopment())
                  .then(() => {
                    setResetOpen(false)
                    toast.success("需求开发已重置")
                  })
                  .catch((error) => {
                    toast.error(error instanceof Error ? error.message : "重置需求开发失败")
                  })
                  .finally(() => setResetting(false))
              }}
            >
              {resetting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              确认重置
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
