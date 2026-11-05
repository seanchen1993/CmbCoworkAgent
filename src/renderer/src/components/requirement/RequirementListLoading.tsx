import { ClipboardList } from "lucide-react"

export function RequirementListLoading({
  label = "正在加载需求列表"
}: {
  label?: string
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-8 bg-gradient-to-b from-background to-muted/30 px-6 py-10">
      <div className="flex flex-col items-center gap-4">
        <div className="relative flex size-16 items-center justify-center">
          <div className="absolute inset-0 animate-ping rounded-2xl bg-primary/15" />
          <div className="absolute inset-1 rounded-2xl bg-primary/8" />
          <div className="relative flex size-16 items-center justify-center rounded-2xl bg-primary/8 ring-1 ring-primary/15">
            <ClipboardList className="size-7 text-primary/70" strokeWidth={1.8} />
          </div>
        </div>
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm font-medium text-foreground/80">{label}</p>
          <div className="flex items-center gap-1.5">
            <span className="size-1.5 animate-bounce rounded-full bg-primary/50 [animation-delay:-0.3s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-primary/50 [animation-delay:-0.15s]" />
            <span className="size-1.5 animate-bounce rounded-full bg-primary/50" />
          </div>
        </div>
      </div>
      <div className="flex w-full max-w-md flex-col gap-2">
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className="flex items-center gap-3 rounded-lg border border-border/60 bg-card/50 px-3 py-3"
          >
            <div className="size-2 shrink-0 animate-pulse rounded-full bg-muted" />
            <div className="h-2.5 w-20 shrink-0 animate-pulse rounded bg-muted" />
            <div className="h-2.5 flex-1 animate-pulse rounded bg-muted" />
            <div className="h-2.5 w-12 shrink-0 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  )
}
