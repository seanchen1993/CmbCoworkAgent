import { useId, useLayoutEffect, useRef, useState } from "react"
import { Check, ChevronDown, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { BotNativeSelect } from "../../../../shared/bot-computer"

/** The native browser popup is outside Page.screenshot. This bounded chooser is
 * only a human projection; the Host owns the exact element and selection receipt. */
export function BotNativeSelectPicker({
  select,
  ready,
  onSelect,
  onDismiss
}: {
  select: BotNativeSelect
  ready: boolean
  onSelect(indices: number[]): boolean
  onDismiss(): boolean
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  const [selected, setSelected] = useState(() =>
    select.options.filter((option) => option.selected).map((option) => option.index)
  )
  const [sent, setSent] = useState(false)
  const focused = useRef(false)
  useLayoutEffect(() => {
    if (ready && !focused.current) {
      const target =
        panel.current?.querySelector<HTMLButtonElement>(
          '[data-native-option][aria-selected="true"]'
        ) ?? panel.current?.querySelector<HTMLButtonElement>("[data-native-option]")
      if (target) {
        target.focus()
        focused.current = true
      }
    }
  }, [ready])
  const enabled = ready && !sent
  const submit = (indices: number[]) => {
    if (enabled && onSelect(indices)) setSent(true)
  }
  return (
    <div
      ref={panel}
      role="dialog"
      aria-labelledby={titleId}
      aria-busy={!enabled}
      className="absolute bottom-3 left-1/2 z-20 flex max-h-[min(22rem,85%)] w-[min(22rem,calc(100%-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover text-popover-foreground shadow-xl"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // These keys belong to this chooser, never the remote browser screenshot.
        event.stopPropagation()
        if (event.key === "Escape") {
          event.preventDefault()
          if (enabled && onDismiss()) setSent(true)
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault()
          const options = [
            ...(panel.current?.querySelectorAll<HTMLButtonElement>("[data-native-option]") ?? [])
          ]
          if (!options.length) return
          const index = options.indexOf(document.activeElement as HTMLButtonElement)
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : event.key === "ArrowDown"
                  ? (index + 1) % options.length
                  : (index - 1 + options.length) % options.length
          options[next].focus()
        }
      }}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border/50 px-3 py-2">
        <ChevronDown size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
        <span
          id={titleId}
          className="min-w-0 flex-1 truncate text-xs font-medium"
          title={select.label}
        >
          {select.label}
        </span>
        {select.multiple && <span className="text-[10px] text-muted-foreground">多选</span>}
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="size-6 rounded-full"
          disabled={!enabled}
          aria-label="关闭选项"
          onClick={() => {
            if (onDismiss()) setSent(true)
          }}
        >
          <X size={12} />
        </Button>
      </div>
      <div
        role="listbox"
        aria-labelledby={titleId}
        aria-multiselectable={select.multiple || undefined}
        className="min-h-0 overflow-y-auto overscroll-contain p-1.5"
      >
        {select.options.map((option, index) => (
          <div key={option.index}>
            {option.group !== undefined &&
              (index === 0 || select.options[index - 1].group !== option.group) && (
                <div
                  className="truncate px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground"
                  title={option.group}
                >
                  {option.group || "未命名分组"}
                </div>
              )}
            <button
              type="button"
              data-native-option
              role="option"
              aria-selected={selected.includes(option.index)}
              disabled={!enabled}
              title={option.label || "（空选项）"}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                if (select.multiple)
                  setSelected((current) =>
                    current.includes(option.index)
                      ? current.filter((item) => item !== option.index)
                      : [...current, option.index]
                  )
                else submit([option.index])
              }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {selected.includes(option.index) && <Check size={13} aria-hidden="true" />}
              </span>
              <span className="min-w-0 truncate">{option.label || "（空选项）"}</span>
            </button>
          </div>
        ))}
      </div>
      {select.multiple && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/50 px-3 py-2">
          <span className="text-[10px] text-muted-foreground">已选 {selected.length} 项</span>
          <Button
            type="button"
            size="sm"
            className="h-7 rounded-lg"
            disabled={!enabled}
            onClick={() => submit(selected)}
          >
            应用选择
          </Button>
        </div>
      )}
    </div>
  )
}
