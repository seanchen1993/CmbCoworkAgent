import { useEffect, useState } from "react"
import { ArrowRight, Check, ChevronsUpDown, Loader2, Search } from "lucide-react"
import { toast } from "sonner"
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { useRequirementStore } from "./requirement-store"

export function SystemSelectionDialog({
  initialSystemId,
  onCancel,
  onConfirm,
  title = "选择需求系统",
  description = "本次需求将关联所选系统，并使用对应的系统规范。",
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
  const [systemSelectOpen, setSystemSelectOpen] = useState(false)
  const [dialogContent, setDialogContent] = useState<HTMLDivElement | null>(null)
  const [selectedSystemId, setSelectedSystemId] = useState(initialSystemId)
  const [customSystemName, setCustomSystemName] = useState("")
  const [loading, setLoading] = useState(false)
  const systemList = useRequirementStore((state) => state.systemList)
  const setSystemList = useRequirementStore((state) => state.setSystemList)
  const addCustomSystem = useRequirementStore((state) => state.addCustomSystem)

  // 弹窗打开时加载系统列表，若 store 已有缓存则跳过请求
  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const systems = await window.api.design.listSystems()
        if (!cancelled) setSystemList(systems)
      } catch (error) {
        if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "加载系统列表失败")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [setSystemList])

  const selectedSystem = systemList.find((system) => system.id === selectedSystemId) ?? null
  const visibleSystems = systemList.filter((system) =>
    [system.name, system.category, system.description, system.id]
      .join(" ")
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent ref={setDialogContent} className="gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader>
          <div className="px-6 pt-5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="mt-1.5">{description}</DialogDescription>
          </div>
        </DialogHeader>
        <div className="px-6 pb-2 pt-5">
          <label className="mb-2 block text-sm font-semibold text-foreground">业务系统</label>
          <Popover
            open={systemSelectOpen}
            onOpenChange={(open) => {
              setSystemSelectOpen(open)
              if (!open) setQuery("")
            }}
          >
            <PopoverTrigger asChild>
              <button
                type="button"
                role="combobox"
                aria-expanded={systemSelectOpen}
                aria-label="选择业务系统"
                className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-white px-3 text-left text-sm shadow-sm outline-none transition-colors hover:bg-muted/30 focus-visible:ring-1 focus-visible:ring-ring"
              >
                {loading ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
                <span className={cn("min-w-0 flex-1 truncate", !selectedSystem && "text-muted-foreground")}>
                  {selectedSystem ? selectedSystem.name : loading ? "正在加载系统..." : "请选择业务系统"}
                </span>
                <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              portalContainer={dialogContent}
              align="start"
              sideOffset={6}
              className="w-[var(--radix-popover-trigger-width)] overflow-hidden p-0"
            >
              <div className="relative border-b border-border p-2">
                <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索系统名称、分类或编号"
                  aria-label="搜索系统"
                  className="h-9 bg-white pl-8"
                  autoFocus
                />
              </div>
              <div
                role="listbox"
                className="max-h-64 overscroll-contain overflow-y-auto p-1.5"
              >
                {loading ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    正在加载系统...
                  </div>
                ) : visibleSystems.length === 0 ? (
                  <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                    没有找到匹配的系统
                  </div>
                ) : (
                  visibleSystems.map((system) => {
                    const selected = selectedSystem?.id === system.id
                    return (
                      <button
                        key={system.id}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          setSelectedSystemId(system.id)
                          setSystemSelectOpen(false)
                          setQuery("")
                        }}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none",
                          selected && "bg-muted/70"
                        )}
                      >
                        <span
                          className="flex size-8 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white"
                          style={{ backgroundColor: system.tokens?.accent ?? "#c4956a" }}
                        >
                          {system.name.slice(0, 1)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {system.name}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {system.category || system.id}
                          </span>
                        </span>
                        <Check className={cn("size-4 shrink-0 text-primary", !selected && "invisible")} />
                      </button>
                    )
                  })
                )}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <div className="mx-6 mt-4 rounded-xl border border-dashed border-[#d7b899] bg-[#fffaf5] p-4">
          <div className="text-sm font-semibold text-foreground">列表里没有？新增一个系统</div>
          <p className="mt-1 text-xs text-muted-foreground">
            无需先选择上方系统。输入新系统名称后直接选择；系统会保存在本地，主题默认为空，下次可继续选择。
          </p>
          <div className="mt-3 flex gap-2">
            <Input
              value={customSystemName}
              onChange={(event) => setCustomSystemName(event.target.value)}
              placeholder="输入新的系统名称"
              aria-label="新的系统名称"
              className="h-9 bg-white"
            />
            <Button
              type="button"
              variant="outline"
              disabled={!customSystemName.trim()}
              onClick={() => {
                const system = addCustomSystem(customSystemName)
                setSelectedSystemId(system.id)
                setCustomSystemName("")
                onConfirm(system.id)
              }}
            >
              新增并选择
            </Button>
          </div>
        </div>
        <DialogFooter className="mt-5 items-center gap-3 border-t border-border bg-[#fbf8f4] px-6 py-3">
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
