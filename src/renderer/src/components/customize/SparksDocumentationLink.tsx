import { lazy, Suspense, useState } from "react"
import { BookOpen } from "lucide-react"
import type { SparksDocumentFile } from "./sparks-document-links"

const Reader = lazy(() => import("./SparksDocumentation"))

export function SparksDocumentationLink({ initialFile, label = "官方说明" }: {
  initialFile?: SparksDocumentFile; label?: string
} = {}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <a
        href="#sparks-documentation"
        className="inline-flex items-center gap-2 rounded text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => {
          event.preventDefault()
          setOpen(true)
        }}
      >
        <BookOpen className="size-4" aria-hidden="true" />
        {label}
        <span className="text-xs font-normal text-muted-foreground">离线可读</span>
      </a>
      {open && (
        <Suspense fallback={<p role="status" className="text-sm">正在打开官方说明…</p>}>
          <Reader initialFile={initialFile} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  )
}
