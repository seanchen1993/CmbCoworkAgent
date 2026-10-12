import { Bot, CalendarClock, Plug, Users, X } from "lucide-react"
import {
  botEntityLabels,
  type BotEntityReference,
  type BotEntitySelection
} from "../../../../shared/bot-entity-references"

export function BotEntityIcon({ kind }: { kind: BotEntitySelection["kind"] }) {
  const Icon = { bot: Bot, group: Users, routine: CalendarClock, connector: Plug }[kind]
  return <Icon size={13} className="shrink-0 text-muted-foreground" />
}

export function BotEntityReferences({
  references,
  remove,
  disabled,
  open
}: {
  references?: BotEntityReference[]
  remove?: (reference: BotEntityReference) => void
  disabled?: boolean
  open?: (reference: BotEntityReference) => void
}) {
  if (!references?.length) return null
  return (
    <div
      className={remove ? "bot-selected-skills" : "mb-2 flex flex-wrap gap-1.5"}
      aria-label="引用的对象"
    >
      {references.map((reference) => (
        <span
          key={`${reference.kind}:${reference.id}`}
          className="bot-skill-chip"
          title={`${botEntityLabels[reference.kind]} · ${reference.name}`}
        >
          <BotEntityIcon kind={reference.kind} />
          {open && reference.conversationId ? (
            <button
              type="button"
              className="max-w-48 truncate hover:underline"
              onClick={() => open(reference)}
            >
              @{reference.name}
            </button>
          ) : (
            <span className="max-w-48 truncate">@{reference.name}</span>
          )}
          {remove && (
            <button
              type="button"
              disabled={disabled}
              aria-label={`移除引用 ${reference.name}`}
              onClick={() => remove(reference)}
            >
              <X size={13} />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}
