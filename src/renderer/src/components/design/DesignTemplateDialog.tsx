import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { DesignTemplateSelector } from "./DesignTemplateSelector"
import type { DesignSystemInfo } from "../../../../shared/design-system"
import {
  useDesignTemplateSelection,
  type DesignPageTemplate
} from "./use-design-template-selection"

/** Mounted for one editor session so cancelled or late imports cannot change its selection. */
export function DesignTemplateDialog({
  initial,
  currentSystem,
  systems,
  onConfirm,
  onClose,
  onRestoreFocus
}: {
  initial?: DesignPageTemplate | null
  currentSystem?: DesignSystemInfo | null
  systems: DesignSystemInfo[]
  onConfirm: (template: DesignPageTemplate) => void
  onClose: () => void
  onRestoreFocus: () => void
}) {
  const picker = useDesignTemplateSelection(initial, currentSystem, systems)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flex max-h-[min(90vh,900px)] w-[calc(100vw_-_2rem)] max-w-5xl flex-col gap-0 p-0"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onRestoreFocus()
        }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <DialogTitle>关联页面模板</DialogTitle>
          <DialogDescription>
            模板用于首次生成页面。生成后，后续修改会继续基于当前页面。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto p-6">
          <DesignTemplateSelector
            picker={picker}
            headingId="editor-template-heading"
            browserPreview={false}
          />
        </div>
        <DialogFooter className="shrink-0 gap-2 border-t border-border px-6 py-4">
          <Button type="button" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!picker.canConfirm}
            onClick={() => onConfirm(picker.selection)}
          >
            {picker.templateMode === "none" ? "移除页面模板" : "关联此模板"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
