import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AlertTriangle, Check, ChevronDown, ClipboardList, Loader2, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { preferredTextMatchesTaskKey, type TaskCardItem } from "../../../../shared/task-card-types"

interface TaskCardPickerProps {
  value: string
  onValueChange: (value: string, card?: TaskCardItem | null) => void
  disabled?: boolean
  autoSelect?: boolean
  preferredText?: string
  placeholder?: string
  compact?: boolean
  popoverAlign?: ComponentProps<typeof PopoverContent>["align"]
  popoverSide?: ComponentProps<typeof PopoverContent>["side"]
  popoverWidth?: "trigger" | "panel"
  className?: string
}

function normalizeText(value: string | undefined): string {
  return (value || "").trim().toLowerCase()
}

function getPriorityLabel(priority?: string): string | null {
  const value = normalizeText(priority).toUpperCase()
  if (!value) return null
  if (value === "HIGH") return "高"
  if (value === "MEDIUM") return "中"
  if (value === "LOW") return "低"
  return priority || null
}

/** Linear-style status dot: priority drives the color, archived cards read as muted. */
function getPriorityDotClass(card: TaskCardItem): string {
  if (card.archived) return "bg-muted-foreground/30"
  switch (normalizeText(card.priority).toUpperCase()) {
    case "HIGH":
      return "bg-rose-500"
    case "MEDIUM":
      return "bg-amber-500"
    case "LOW":
      return "bg-slate-400"
    default:
      return "bg-muted-foreground/40"
  }
}

function getColumnLabel(card: TaskCardItem): string | null {
  return card.columnFullName || card.columnName || null
}

function getSecondaryLabel(card: TaskCardItem): string {
  return [card.boardName, card.taskGroupName, getColumnLabel(card)].filter(Boolean).join(" / ")
}

/** First-line meta after the task key, e.g. "需求 · 高". */
function getRowMeta(card: TaskCardItem): string {
  const priority = getPriorityLabel(card.priority)
  return [card.taskTypeName, priority].filter(Boolean).join(" · ")
}

export function TaskCardPicker({
  value,
  onValueChange,
  disabled = false,
  autoSelect = true,
  preferredText,
  placeholder = "选择任务卡片",
  compact = false,
  popoverAlign = "start",
  popoverSide,
  popoverWidth = "trigger",
  className
}: TaskCardPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [includeArchived, setIncludeArchived] = useState(false)
  const [cards, setCards] = useState<TaskCardItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const autoSelectSuppressedRef = useRef(false)
  const selectedValue = value.trim()

  const loadCards = useCallback(
    async (options?: { forceRefresh?: boolean }) => {
      if (disabled) return
      const requestId = ++requestIdRef.current
      setLoading(true)
      setError(null)
      try {
        const result = await window.api.taskCards.list({
          includeArchived,
          pageSize: 1000,
          pageNum: 1,
          forceRefresh: options?.forceRefresh
        })
        if (requestId !== requestIdRef.current) return
        if (!result.success) {
          setCards([])
          setError(result.error || "任务卡加载失败")
          return
        }
        setCards(result.cards)
      } catch (e) {
        if (requestId !== requestIdRef.current) return
        setCards([])
        setError(e instanceof Error ? e.message : "任务卡加载失败")
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false)
        }
      }
    },
    [disabled, includeArchived]
  )

  useEffect(() => {
    if (disabled) return
    void loadCards()
  }, [disabled, loadCards])

  const selectedCard = useMemo(
    () =>
      cards.find((card) => normalizeText(card.taskKey) === normalizeText(selectedValue)) ?? null,
    [cards, selectedValue]
  )

  useEffect(() => {
    if (selectedValue) {
      autoSelectSuppressedRef.current = false
    }
  }, [selectedValue])

  useEffect(() => {
    if (
      !autoSelect ||
      autoSelectSuppressedRef.current ||
      disabled ||
      loading ||
      selectedValue ||
      cards.length === 0
    ) {
      return
    }
    const preferredCard = cards.find((card) =>
      preferredTextMatchesTaskKey(preferredText, card.taskKey)
    )
    const nextCard = preferredCard || (cards.length === 1 ? cards[0] : null)
    if (nextCard) {
      onValueChange(nextCard.taskKey, nextCard)
    }
  }, [autoSelect, cards, disabled, loading, onValueChange, preferredText, selectedValue])

  const handleSelectCard = useCallback(
    (card: TaskCardItem) => {
      autoSelectSuppressedRef.current = false
      onValueChange(card.taskKey, card)
      setOpen(false)
    },
    [onValueChange]
  )

  const handleManualValueChange = useCallback(
    (nextValue: string) => {
      autoSelectSuppressedRef.current = !nextValue.trim()
      onValueChange(nextValue, null)
    },
    [onValueChange]
  )

  const manualValue = selectedValue
  const triggerTitle = selectedCard
    ? `${selectedCard.taskKey} ${selectedCard.taskName}`
    : selectedValue || placeholder
  const secondaryLabel = selectedCard ? getSecondaryLabel(selectedCard) : ""
  const triggerMainLabel = compact
    ? selectedCard
      ? `任务卡 ${selectedCard.taskKey}`
      : selectedValue
        ? `任务卡 ${selectedValue}`
        : placeholder
    : selectedCard
      ? `${selectedCard.taskKey} · ${selectedCard.taskName}`
      : selectedValue || placeholder

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={triggerTitle}
          className={cn(
            compact
              ? "flex h-7 max-w-[190px] items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs shadow-none transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              : "flex min-h-10 w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-sm transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
            className
          )}
        >
          {loading ? (
            <Loader2
              className={cn(
                "shrink-0 animate-spin text-muted-foreground",
                compact ? "size-3.5" : "size-4"
              )}
            />
          ) : (
            <ClipboardList
              className={cn("shrink-0 text-muted-foreground", compact ? "size-3.5" : "size-4")}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className={cn("block truncate", !selectedValue && "text-muted-foreground")}>
              {triggerMainLabel}
            </span>
            {!compact && selectedCard && secondaryLabel && (
              <span className="mt-0.5 block truncate text-[11px] leading-4 text-muted-foreground">
                {secondaryLabel}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn("shrink-0 text-muted-foreground", compact ? "size-3" : "size-4")}
          />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={popoverAlign}
        side={popoverSide}
        sideOffset={6}
        collisionPadding={12}
        className={cn(
          popoverWidth === "panel"
            ? "w-80 max-w-[calc(100vw-32px)]"
            : "w-[var(--radix-popover-trigger-width)] min-w-72 max-w-[calc(100vw-32px)]",
          "overflow-hidden rounded-lg p-0"
        )}
      >
        {/* Header: title + count + refresh + archived toggle */}
        <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-2.5">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">任务卡片</div>
            <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
              {loading ? "正在加载" : `${cards.length} 张可选`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground"
              disabled={loading}
              onClick={() => loadCards({ forceRefresh: true })}
              title="刷新任务卡"
            >
              {loading ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </Button>
            <button
              type="button"
              onClick={() => setIncludeArchived((current) => !current)}
              className={cn(
                "h-7 shrink-0 rounded-md border px-2.5 text-xs transition-colors",
                includeArchived
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted/50"
              )}
              title="是否包含已归档任务卡"
            >
              含归档
            </button>
          </div>
        </div>

        {/* Card list */}
        <div
          className="overflow-y-auto p-1.5"
          style={{
            maxHeight: "min(320px, calc(var(--radix-popover-content-available-height) - 116px))"
          }}
        >
          {error ? (
            <div className="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <div className="font-medium">任务卡加载失败</div>
                <div className="mt-0.5 text-xs leading-5">{error}</div>
              </div>
            </div>
          ) : loading && cards.length === 0 ? (
            <div className="space-y-1.5 px-1 py-1">
              {[0, 1, 2].map((item) => (
                <div key={item} className="flex items-center gap-2.5 px-1.5 py-2">
                  <div className="size-2 shrink-0 rounded-full bg-muted/70" />
                  <div className="min-w-0 flex-1">
                    <div className="h-3.5 w-32 rounded bg-muted/70 animate-pulse" />
                    <div className="mt-1.5 h-3 w-full max-w-[260px] rounded bg-muted/50 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          ) : cards.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">暂无任务卡片</div>
          ) : (
            <div className="space-y-0.5">
              {cards.map((card) => {
                const selected = normalizeText(card.taskKey) === normalizeText(selectedValue)
                const meta = getRowMeta(card)
                return (
                  <button
                    key={card.taskKey}
                    type="button"
                    onClick={() => handleSelectCard(card)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
                      selected ? "bg-primary/10" : "hover:bg-muted/60"
                    )}
                  >
                    <span
                      className={cn(
                        "mt-[5px] size-2 shrink-0 rounded-full",
                        getPriorityDotClass(card)
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span
                          className={cn(
                            "truncate font-mono text-xs font-medium",
                            selected ? "text-primary" : "text-foreground"
                          )}
                        >
                          {card.taskKey}
                        </span>
                        {meta && (
                          <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>
                        )}
                        <span className="flex-1" />
                        {card.archived && !selected && (
                          <span className="shrink-0 text-[10px] text-muted-foreground">归档</span>
                        )}
                        {selected && <Check className="size-3.5 shrink-0 text-primary" />}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {card.taskName}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Footer: manual entry */}
        <div className="border-t border-border/70 p-2">
          <Input
            value={manualValue}
            onChange={(event) => handleManualValueChange(event.target.value)}
            placeholder="手动输入卡号"
            disabled={disabled}
            className="h-8 w-full"
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
