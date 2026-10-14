import { lazy, Suspense } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog"
import {
  closeBuiltinNavigation,
  useBuiltinNavigation,
  type BuiltinNavigationScope
} from "@/lib/builtin-navigation"
import { BuiltinChangeReview } from "./BuiltinChangeReview"
import { BuiltinRunOverview } from "./BuiltinRunOverview"

const Documentation = lazy(() => import("../customize/SparksDocumentation"))
const names = {
  diff: "查看改动",
  instructions: "项目规范",
  runs: "运行过程",
  policy: "使用限制",
  create: "制作插件",
  help: "使用帮助"
}

export function BuiltinNavigationPanel({ threadId, workspace }: BuiltinNavigationScope) {
  const request = useBuiltinNavigation({ threadId, workspace })
  if (!request) return null
  const close = () => closeBuiltinNavigation(request.id)
  if (request.target === "help")
    return (
      <Suspense fallback={<p role="status">正在打开说明…</p>}>
        <Documentation onClose={close} />
      </Suspense>
    )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{names[request.target]}</DialogTitle>
          <DialogDescription>查看当前聊天和项目的信息。</DialogDescription>
        </DialogHeader>
        {!workspace ? (
          <p>请先为当前聊天选择项目目录，再查看项目记录。</p>
        ) : request.target === "diff" ? (
          <BuiltinChangeReview
            key={request.id}
            threadId={threadId}
            workspace={workspace}
            initiallyOpen
          />
        ) : (
          <BuiltinRunOverview
            key={request.id}
            threadId={threadId}
            workspace={workspace}
            visible
            focusTarget={
              request.target === "instructions" || request.target === "policy"
                ? request.target
                : undefined
            }
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
