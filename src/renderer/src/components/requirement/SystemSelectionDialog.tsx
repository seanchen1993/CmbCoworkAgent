import { useState } from "react"
import { ArrowRight, Check, Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useRequirementStore } from "./requirement-store"

export function SystemSelectionDialog({
  initialSystemId,
  onCancel,
  onConfirm,
  title = "选择需求业务系统",
  description = "本次需求将关联所选业务系统，并使用对应的系统规范。",
  confirmLabel = "确认并开始需求沟通"
}: {
  initialSystemId: string | null
  onCancel: () => void
  onConfirm: (systemId: string) => void
  title?: string
  description?: string
  confirmLabel?: string
}): React.JSX.Element {
  const [query, setQuery] = useState("")
  const [selectedSystemId, setSelectedSystemId] = useState(initialSystemId)
  const systemList = useRequirementStore((state) => state.systemList)
  const selectedSystem = systemList.find((system) => system.id === selectedSystemId) ?? null
  const visibleSystems = systemList.filter((system) =>
    [system.name, system.category, system.description, system.id]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader>
          <div className="px-6 pt-5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1.5">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="px-6 pb-3 pt-4">
          <div className="flex items-center gap-2 text-sm font-bold text-muted-foreground">
            <span>全部业务系统</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold">
              {systemList.length}
            </span>
            <label className="relative ml-auto block">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索系统名称 / 分类"
                aria-label="搜索业务系统"
                className="h-8 w-56 bg-white pl-8 text-sm"
              />
            </label>
          </div>
        </div>
        <div className="mx-6 max-h-[330px] overflow-y-auto rounded-xl border border-border bg-[#fbf9f6] p-2.5">
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {visibleSystems.map((system) => {
              const selected = selectedSystem?.id === system.id
              return (
                <button
                  key={system.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedSystemId(system.id)}
                  className={cn(
                    "relative flex h-[142px] flex-col overflow-hidden rounded-lg border bg-white p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected
                      ? "border-primary shadow-[0_0_0_3px_rgba(196,107,79,0.14)]"
                      : "border-border hover:border-border-emphasis"
                  )}
                >
                  {selected && (
                    <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  )}
                  <span className="flex items-center gap-2">
                    <span
                      className="flex size-8 items-center justify-center rounded-lg text-sm font-bold text-white"
                      style={{ backgroundColor: system.tokens?.accent ?? "#c4956a" }}
                    >
                      {system.name.slice(0, 1)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-bold text-foreground">
                        {system.name}
                      </span>
                      <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                        {system.category || system.id}
                      </span>
                    </span>
                  </span>
                  <span className="mt-2 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
                    {system.description}
                  </span>
                  <span className="mt-auto rounded-md border border-[#d3e6da] bg-[#e9f2ec] px-2 py-1 text-[10px] font-semibold text-[#44715a]">
                    系统规范
                  </span>
                </button>
              )
            })}
          </div>
          {visibleSystems.length === 0 && (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              没有找到匹配的业务系统
            </div>
          )}
        </div>
        <DialogFooter className="mt-5 items-center gap-3 border-t border-border bg-[#fbf8f4] px-6 py-3 sm:justify-between">
          <p className="mr-auto text-sm text-muted-foreground">
            {selectedSystem ? `已选：${selectedSystem.name} · 系统规范` : "请选择一个业务系统"}
          </p>
          <Button type="button" variant="outline" onClick={onCancel}>
            取消
          </Button>
          <Button
            type="button"
            disabled={!selectedSystem}
            onClick={() => selectedSystemId && onConfirm(selectedSystemId)}
          >
            {confirmLabel}
            <ArrowRight className="size-4" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
