import { useRef, useState } from "react"
import { Check, ChevronDown } from "lucide-react"
import type { KnowledgeBaseListItem } from "../../../../shared/knowledge-base-types"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

function formatKnowledgeBaseLabel(item: KnowledgeBaseListItem): string {
  return `${item.name}（${item.gitRef}）`
}

export function KnowledgeBaseSelector({
  items,
  selectedIds,
  supportsKnowledgeBaseContext,
  disabled,
  portalContainer,
  onChange
}: {
  items: KnowledgeBaseListItem[]
  selectedIds: string[]
  supportsKnowledgeBaseContext: boolean
  disabled?: boolean
  portalContainer?: HTMLElement | null
  onChange: (ids: string[]) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const optionsRef = useRef<HTMLDivElement>(null)
  const selectedId = selectedIds[0] ?? ""
  const selectable = items.filter(
    (item) =>
      item.visibility === "visible" &&
      item.workspaces.some(
        (entry) => entry.role === "read" && entry.status === "success" && entry.localValid
      )
  )
  const selected = selectable.find((item) => item.idKey === selectedId)

  return (
    <div className="mt-3 grid gap-1.5 text-xs font-medium text-muted-foreground">
      <span>系统约束</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            aria-label={
              selected
                ? `选择系统约束，当前：${formatKnowledgeBaseLabel(selected)}`
                : "选择系统约束"
            }
            className="h-9 w-full min-w-0 justify-between gap-2 bg-background px-3 font-normal text-foreground"
          >
            <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground/45")}>
              {selected ? formatKnowledgeBaseLabel(selected) : "请选择要使用的公共系统约束"}
            </span>
            <ChevronDown className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          portalContainer={portalContainer}
          aria-label="选择系统约束"
          align="start"
          side="bottom"
          sideOffset={4}
          avoidCollisions={false}
          collisionPadding={16}
          className={cn(
            "z-[70] w-[var(--radix-popover-trigger-width)] p-0",
            "flex max-h-[min(24rem,var(--radix-popover-content-available-height))] max-w-[calc(100vw-2rem)] flex-col overflow-hidden"
          )}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            optionsRef.current?.focus()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || !["ArrowDown", "ArrowUp"].includes(event.key))
              return
            const buttons = Array.from(
              optionsRef.current?.querySelectorAll<HTMLButtonElement>("[role=option]") ?? []
            )
            const index = buttons.indexOf(event.target as HTMLButtonElement)
            if (buttons.length === 0) return
            event.preventDefault()
            const nextIndex =
              index === -1
                ? event.key === "ArrowDown"
                  ? 0
                  : buttons.length - 1
                : event.key === "ArrowDown"
                  ? index + 1
                  : index - 1
            buttons[Math.max(0, Math.min(nextIndex, buttons.length - 1))]?.focus()
          }}
        >
          <div
            ref={optionsRef}
            role="listbox"
            tabIndex={-1}
            aria-label="系统约束"
            className="min-h-0 overflow-y-auto overscroll-y-contain p-1 outline-none"
          >
            {selectable.map((item) => (
              <button
                key={item.idKey}
                type="button"
                role="option"
                aria-selected={selectedId === item.idKey}
                onClick={() => {
                  onChange([item.idKey])
                  setOpen(false)
                }}
                onPointerMove={(event) => {
                  if (event.pointerType !== "touch") event.currentTarget.focus()
                }}
                className="relative flex w-full min-w-0 rounded-sm py-2 pl-4 pr-10 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {selectedId === item.idKey && <Check className="absolute right-3 top-3 size-4" />}
                <span className="min-w-0 truncate">{formatKnowledgeBaseLabel(item)}</span>
              </button>
            ))}
            {selectable.length === 0 && (
              <div role="status" className="px-3 py-6 text-center text-sm text-muted-foreground">
                暂无可用知识库
              </div>
            )}
          </div>
        </PopoverContent>
      </Popover>
      {selectedId && !supportsKnowledgeBaseContext && (
        <span className="text-status-warning">
          插件尚未兼容系统约束读取，所选系统约束不会传给这个插件。
        </span>
      )}
    </div>
  )
}
