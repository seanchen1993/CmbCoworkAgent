import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
import { Loader2, Plus, X } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import type { BotClient, BotDefinition, BotGroup } from "../../../../shared/bots/contracts"
import { BotAvatar } from "./BotAvatar"

/** Inline membership management uses the same versioned Host operation as the group editor. */
export function BotGroupMembers({
  group,
  bots,
  client,
  onOpen
}: {
  group: BotGroup
  bots: BotDefinition[]
  client: BotClient
  onOpen(bot: BotDefinition): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)
  const available = bots.filter(
    (bot) => !bot.archived && !bot.deleting && !group.memberIds.includes(bot.id)
  )
  const change = async (memberIds: string[]) => {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError(null)
    try {
      await client.saveGroup(
        { name: group.name, memberIds },
        { id: group.id, version: group.version }
      )
    } catch (cause) {
      setError(botErrorMessage(cause, "更新成员失败，请重试"))
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <section className="bot-group-members" aria-label="群成员" aria-busy={busy}>
      <ul>
        {group.memberIds.map((id) => {
          const bot = bots.find((item) => item.id === id)
          return (
            <li key={id}>
              <button
                className="bot-member-open"
                disabled={!bot || bot.deleting}
                onClick={() => bot && onOpen(bot)}
                aria-label={`打开 ${bot?.name ?? "已不可用的 Bot"} 的聊天`}
              >
                <BotAvatar color={bot?.color ?? "#888888"} shape={bot?.shape} size={36} />
                <span>{bot?.name ?? "已不可用的 Bot"}</span>
              </button>
              <button
                className="bot-icon-button"
                disabled={busy || group.deleting || group.memberIds.length < 2}
                aria-label={`移除 ${bot?.name ?? "已不可用的 Bot"}`}
                title={group.memberIds.length < 2 ? "群聊至少保留一个成员" : "移除成员"}
                onClick={() => void change(group.memberIds.filter((member) => member !== id))}
              >
                <X size={16} />
              </button>
            </li>
          )
        })}
      </ul>
      <Select
        value=""
        onValueChange={(id) => void change([...group.memberIds, id])}
        disabled={busy || group.deleting || group.memberIds.length >= 8 || !available.length}
      >
        <SelectTrigger
          className="bot-member-add h-auto w-full border-0 shadow-none"
          aria-label="添加成员"
        >
          <span className="flex items-center gap-3">
            {busy ? <Loader2 size={18} className="animate-spin" /> : <Plus size={18} />}
            {group.memberIds.length >= 8 ? "已达 8 位成员上限" : "添加成员"}
          </span>
        </SelectTrigger>
        <SelectContent className="bot-group-member-menu max-h-72 min-w-52">
          {available.map((bot) => (
            <SelectItem key={bot.id} value={bot.id} textValue={bot.name}>
              <span className="flex items-center gap-2">
                <BotAvatar color={bot.color} shape={bot.shape} size={24} />
                <span className="max-w-56 truncate">{bot.name}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
