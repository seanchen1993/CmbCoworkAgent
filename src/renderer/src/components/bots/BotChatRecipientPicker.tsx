import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Plus, Users } from "lucide-react"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import type { BotDefinition, BotGroup } from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"

interface RecipientOption {
  value: string
  label: string
  bot?: BotDefinition
  name?: string
}

export function BotChatRecipientPicker({
  bots,
  groups,
  selectedIds,
  pendingNames,
  selectedCount,
  disabled,
  onSelect,
  onCommit,
  onRemoveLast
}: {
  bots: BotDefinition[]
  groups: BotGroup[]
  selectedIds: readonly string[]
  pendingNames: readonly string[]
  selectedCount: number
  disabled: boolean
  onSelect(value: string, name?: string): void
  onCommit(): void
  onRemoveLast(): void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState(0)
  const [previousCount, setPreviousCount] = useState(selectedCount)
  if (previousCount !== selectedCount) {
    setPreviousCount(selectedCount)
    if (selectedCount > previousCount) {
      setQuery("")
      setActive(0)
    }
  }
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options = useMemo<RecipientOption[]>(() => {
    const name = query.trim(),
      needle = name.toLocaleLowerCase()
    const matches: RecipientOption[] = [
      ...bots
        .filter(
          (bot) =>
            !bot.archived &&
            !bot.deleting &&
            !selectedIds.includes(bot.id) &&
            bot.name.toLocaleLowerCase().includes(needle)
        )
        .map((bot) => ({ value: `bot:${bot.id}`, label: bot.name, bot })),
      ...(selectedCount ? [] : groups)
        .filter((group) => !group.deleting && group.name.toLocaleLowerCase().includes(needle))
        .map((group) => ({ value: `group:${group.id}`, label: group.name }))
    ]
    const create = {
      value: "new-bot",
      label: selectedCount ? `将“${name}”添加为新 Bot` : `创建名为“${name}”的 Bot`,
      name: name || undefined
    }
    return name && !pendingNames.some((pending) => pending.toLocaleLowerCase() === needle)
      ? [...matches, create]
      : matches
  }, [bots, groups, query, selectedIds, pendingNames, selectedCount])
  const selected = Math.min(active, Math.max(0, options.length - 1))
  const expanded = open && !disabled && options.length > 0
  const choose = (index: number) => {
    if (disabled) return
    const option = options[index]
    if (!option) return
    // A dialog opened by this option must return to the persistent combobox, not a removed option.
    input.current?.focus({ preventScroll: true })
    onSelect(option.value, option.name)
    if (option.value.startsWith("bot:") || (option.value === "new-bot" && selectedCount)) {
      setQuery("")
      setActive(0)
      setOpen(true)
    } else setOpen(false)
  }
  useEffect(() => {
    if (open)
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [open, selected, query])
  return (
    <Popover open={expanded} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <input
          ref={input}
          className="min-w-0 flex-1 bg-transparent py-2 outline-none"
          autoFocus
          role="combobox"
          aria-label="选择聊天收件人"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          aria-activedescendant={expanded ? `${listId}-${selected}` : undefined}
          autoComplete="off"
          placeholder="搜索 Bot，或输入新名字…"
          maxLength={80}
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setOpen(true)
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              if (!options.length) return
              setOpen(true)
              setActive(
                open
                  ? (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                      options.length
                  : 0
              )
            } else if (event.key === "Enter") {
              event.preventDefault()
              if (!query.trim() && selectedCount) onCommit()
              else if (open) choose(selected)
              else setOpen(true)
            } else if (event.key === "Backspace" && !query && selectedCount) {
              event.preventDefault()
              onRemoveLast()
            } else if ((event.key === "Tab" || event.key === ",") && query.trim() && open) {
              event.preventDefault()
              choose(selected)
            } else if (event.key === "Escape") {
              event.preventDefault()
              if (query) setQuery("")
              else setOpen(false)
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        role="presentation"
        data-bot-popup
        className="bot-workspace-menu bot-recipient-options max-h-80 overflow-y-auto rounded-2xl p-1.5"
        align="start"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={(event) => {
          if (event.target === input.current) event.preventDefault()
        }}
      >
        <div ref={list} id={listId} role="listbox" aria-label="收件人">
          {options.map((option, index) => (
            <button
              id={`${listId}-${index}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm aria-selected:bg-accent"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(index)}
            >
              {option.bot ? (
                <BotAvatar color={option.bot.color} shape={option.bot.shape} size={25} />
              ) : option.value === "new-bot" ? (
                <Plus size={22} />
              ) : (
                <Users size={22} />
              )}
              <span className="min-w-0 truncate">{option.label}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
