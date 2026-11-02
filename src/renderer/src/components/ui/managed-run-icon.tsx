import { RefreshCw, Workflow } from "lucide-react"

export function ManagedRunIcon(): React.JSX.Element {
  return (
    <span className="relative inline-flex size-4 shrink-0" aria-hidden="true">
      <RefreshCw className="size-4" strokeWidth={1.5} />
      <Workflow className="absolute left-1/2 top-1/2 size-[9px] -translate-x-1/2 -translate-y-1/2" />
    </span>
  )
}
