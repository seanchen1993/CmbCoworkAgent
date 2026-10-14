import { useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "../ui/dialog"
import { BuiltinRunOverview } from "./BuiltinRunOverview"
import { useAppStore } from "../../lib/store"

/** Read-only project evidence is available without granting ordinary chat/DIY execution. */
export function ProjectRunDetails({
  threadId,
  workspace
}: {
  threadId: string
  workspace?: string | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mx-auto mb-2 flex max-w-3xl flex-wrap justify-end gap-3 text-xs">
      <button type="button" className="rounded border px-3 py-1.5" onClick={() => setOpen(true)}>
        运行过程
      </button>
      <button
        type="button"
        className="underline"
        onClick={() => useAppStore.getState().setShowHarnessBoardView(true)}
      >
        返回项目任务
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>本阶段运行过程</DialogTitle>
            <DialogDescription>
              查看规范、文件改动与已有运行记录。执行和重试请返回项目任务。
            </DialogDescription>
          </DialogHeader>
          <BuiltinRunOverview threadId={threadId} workspace={workspace} visible={open} />
        </DialogContent>
      </Dialog>
    </div>
  )
}
