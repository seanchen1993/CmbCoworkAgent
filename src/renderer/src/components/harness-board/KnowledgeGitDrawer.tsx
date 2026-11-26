import { lazy, Suspense, useState } from "react"
import * as DialogPrimitive from "@radix-ui/react-dialog"
import { Loader2, X } from "lucide-react"
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogTitle
} from "@/components/ui/dialog"

const GitPanelView = lazy(() =>
  import("@/components/panels/GitPanelView").then((module) => ({ default: module.GitPanelView }))
)

interface KnowledgeGitDrawerProps {
  target: { id: string; name: string; workspacePath: string } | null
  onClose: () => void
}

export function KnowledgeGitDrawer({
  target,
  onClose
}: KnowledgeGitDrawerProps): React.JSX.Element {
  const [drawerContent, setDrawerContent] = useState<HTMLDivElement | null>(null)
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={setDrawerContent}
          aria-describedby={undefined}
          data-cmb-modal-dialog="true"
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-[60rem] flex-col border-l border-border bg-background shadow-xl duration-200 [-webkit-app-region:no-drag] data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right"
        >
          <header className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
            <div className="min-w-0">
              <DialogTitle className="truncate">{target?.name} · 沉淀工作区</DialogTitle>
              <p
                className="mt-1 truncate text-xs text-muted-foreground"
                title={target?.workspacePath}
              >
                {target?.workspacePath}
              </p>
            </div>
            <DialogClose className="rounded p-2 hover:bg-muted" aria-label="关闭 Git 面板">
              <X className="size-4" />
            </DialogClose>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden">
            {target && (
              <Suspense
                fallback={
                  <div role="status" className="grid h-full place-items-center">
                    <Loader2 className="size-5 animate-spin" aria-label="正在加载 Git 面板" />
                  </div>
                }
              >
                <GitPanelView
                  knowledgeBaseId={target.id}
                  workspacePath={target.workspacePath}
                  pushDialogContainer={drawerContent}
                />
              </Suspense>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  )
}
