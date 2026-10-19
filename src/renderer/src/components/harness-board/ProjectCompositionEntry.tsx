import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { ProjectCompositionScope } from "../../../../shared/project-runtime/composition-api"
import { ProjectCompositionPanel } from "./ProjectCompositionPanel"

export function ProjectCompositionEntry({ scope }: { scope: ProjectCompositionScope }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        项目能力
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto p-0">
          <DialogTitle className="sr-only">项目能力</DialogTitle>
          {open && <ProjectCompositionPanel scope={scope} onClose={() => setOpen(false)} />}
        </DialogContent>
      </Dialog>
    </>
  )
}
