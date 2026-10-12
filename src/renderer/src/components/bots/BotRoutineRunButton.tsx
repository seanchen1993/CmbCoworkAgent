import { useBotWorkItemVisibility } from "@/lib/use-bot-work-item-visibility"
import { BotPendingSaveRecovery } from "./BotPendingSaveRecovery"
import {
  useBotRoutineRun,
  type BotRoutineRunOptions,
  type BotRoutineRunController
} from "@/lib/use-bot-routine-run"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Standalone callers retain the same durable controller; menus reuse one owner. */
export function BotRoutineRunButton(props: BotRoutineRunOptions) {
  const visibility = useBotWorkItemVisibility()
  const control = useBotRoutineRun({ ...props, visible: visibility.visible })
  return <BotRoutineRunControl control={control} observeElement={visibility.ref} />
}

export function BotRoutineRunControl({
  control,
  observeElement,
  feedbackOnly = false
}: {
  control: BotRoutineRunController
  observeElement?: (node: HTMLElement | null) => void
  feedbackOnly?: boolean
}) {
  const {
    active,
    supported,
    trackedError,
    record,
    pending,
    blocked,
    failure,
    busy,
    buttonDisabled,
    label,
    editingEpoch
  } = control
  if (control.hidden || (feedbackOnly && !control.showFeedback)) return null
  return (
    <div
      ref={observeElement}
      className={feedbackOnly ? "max-w-64 space-y-1 px-3 pb-2 pt-1" : "max-w-64 space-y-1"}
    >
      <Button
        size="sm"
        variant="ghost"
        disabled={buttonDisabled}
        title={!supported ? "请更新 Bot 后台后运行例程" : undefined}
        onClick={() => void control.submit()}
      >
        {(busy || (active?.status === "running" && !pending)) && (
          <Loader2 className="mr-1 size-3.5 animate-spin motion-reduce:animate-none" />
        )}
        {label}
      </Button>
      {trackedError && (
        <p role="alert" className="text-xs text-destructive">
          {trackedError}
        </p>
      )}
      {!supported && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          请更新 Bot 后台后运行例程。
        </p>
      )}
      {blocked && (
        <BotPendingSaveRecovery
          record={record}
          dataEpoch={editingEpoch}
          operationLabel="例程运行"
          discard={control.discard}
          onRepaired={control.repaired}
        />
      )}
      {(failure || pending) && (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">
          {failure ?? "上次运行尚未确认，可核对同一次请求。"}
        </p>
      )}
    </div>
  )
}
