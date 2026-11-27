import { useState } from "react"
import { Check, ChevronDown, GitBranch } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { GitPanelRepository } from "../../../../shared/git-panel-repository"

export function GitPanelRepositoryPicker({
  repositories,
  selected,
  onSelect,
  onOpen
}: {
  repositories: GitPanelRepository[]
  selected: GitPanelRepository | null
  onSelect: (repository: GitPanelRepository | null) => void
  onOpen: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const select = (repository: GitPanelRepository | null) => {
    setOpen(false)
    onSelect(repository)
  }
  const label = selected?.path ?? "全部仓库"
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) onOpen()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`操作仓库 ${label}`}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted/50"
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="shrink-0">操作仓库</span>
          <span className="min-w-0 truncate font-mono">{label}</span>
          <ChevronDown className="size-3 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(440px,calc(100vw_-_2rem))] p-1">
        <div className="max-h-72 overflow-y-auto">
          {repositories.filter((repository) => repository.source === "workspace").length > 1 && (
            <button
              type="button"
              aria-pressed={!selected}
              onClick={() => select(null)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/50"
            >
              <span className="w-4">{!selected && <Check className="size-4" />}</span>
              全部仓库（工作区）
            </button>
          )}
          {repositories.map((repository) => (
            <button
              key={repository.path}
              title={repository.path}
              type="button"
              aria-pressed={selected?.path === repository.path}
              onClick={() => select(repository)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted/50"
            >
              <span className="w-4 shrink-0">
                {selected?.path === repository.path && <Check className="size-4" />}
              </span>
              <span className="min-w-0">
                <span className="block break-all font-mono">{repository.path}</span>
                <span className="flex items-center gap-1 text-muted-foreground">
                  {repository.source === "authorized" ? "本任务授权" : "工作区"}
                  <GitBranch className="size-3" />
                  <span className="break-all">{repository.branch || "未知分支"}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
