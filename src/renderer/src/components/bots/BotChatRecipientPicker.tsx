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
  disabled,
  onSelect
}: {
  bots: BotDefinition[]
  groups: BotGroup[]
  disabled: boolean
  onSelect(value: string, name?: string): void
}) {
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(true)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const options = useMemo<RecipientOption[]>(() => {
    const name = query.trim(),
      needle = name.toLocaleLowerCase()
    const matches: RecipientOption[] = [
      ...bots
        .filter(
          (bot) => !bot.archived && !bot.deleting && bot.name.toLocaleLowerCase().includes(needle)
        )
        .map((bot) => ({ value: `bot:${bot.id}`, label: bot.name, bot })),
      ...groups
        .filter((group) => !group.deleting && group.name.toLocaleLowerCase().includes(needle))
        .map((group) => ({ value: `group:${group.id}`, label: group.name }))
    ]
    const create = {
      value: "new-bot",
      label: name ? `创建名为“${name}”的 Bot` : "创建新 Bot",
      name: name || undefined
    }
    return name
      ? [...matches, create]
      : [create, { value: "new-group", label: "创建群聊" }, ...matches]
  }, [bots, groups, query])
  const selected = Math.min(active, options.length - 1)
  const choose = (index: number) => {
    if (disabled) return
    const option = options[index]
    if (!option) return
    // A dialog opened by this option must return to the persistent combobox, not a removed option.
    input.current?.focus({ preventScroll: true })
    setOpen(false)
    onSelect(option.value, option.name)
  }
  useEffect(() => {
    if (open)
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" })
  }, [open, selected, query])
  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <input
          ref={input}
          className="min-w-0 flex-1 bg-transparent py-2 outline-none"
          autoFocus
          role="combobox"
          aria-label="选择聊天收件人"
          aria-autocomplete="list"
          aria-expanded={open && !disabled}
          aria-controls={open && !disabled ? listId : undefined}
          aria-activedescendant={open && !disabled ? `${listId}-${selected}` : undefined}
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
              setOpen(true)
              setActive(
                open
                  ? (selected + (event.key === "ArrowDown" ? 1 : -1) + options.length) %
                      options.length
                  : 0
              )
            } else if (event.key === "Enter") {
              event.preventDefault()
              if (open) choose(selected)
              else setOpen(true)
            } else if (event.key === "Escape") {
              event.preventDefault()
              setOpen(false)
            }
          }}
        />
      </PopoverAnchor>
      <PopoverContent
        data-bot-popup
        className="bot-recipient-options max-h-80 overflow-y-auto rounded-2xl p-1.5"
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
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm aria-selected:bg-muted"
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
