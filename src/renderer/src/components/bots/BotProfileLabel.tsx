import { botErrorMessage } from "@/lib/bot-error-message"
import { useRef, useState } from "react"
import type { BotClient, BotDefinition } from "../../../../shared/bots/contracts"

export function BotProfileLabel({
  bot,
  client,
  disabled
}: {
  bot: BotDefinition
  client: BotClient
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState("")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lock = useRef(false)
  const cancelled = useRef(false)
  const version = useRef(bot.version)
  const save = async () => {
    if (lock.current || cancelled.current) return
    if (draft.trim() === (bot.label ?? "")) {
      setEditing(false)
      return
    }
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      await client.update({ ...bot, label: draft.trim(), expectedVersion: version.current })
      setEditing(false)
    } catch (cause) {
      setError(botErrorMessage(cause, "标签保存失败，请重试"))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <div className="bot-profile-label">
      {editing ? (
        <input
          autoFocus
          aria-label="Bot 标签"
          aria-invalid={Boolean(error)}
          maxLength={80}
          value={draft}
          readOnly={saving}
          placeholder="添加标签"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (!error) void save()
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return
            if (event.key === "Enter") {
              event.preventDefault()
              void save()
            }
            if (event.key === "Escape" && !lock.current) {
              cancelled.current = true
              setEditing(false)
              setError(null)
            }
          }}
        />
      ) : (
        <button
          aria-label="Bot 标签"
          disabled={disabled}
          onClick={() => {
            cancelled.current = false
            version.current = bot.version
            setDraft(bot.label ?? "")
            setError(null)
            setEditing(true)
          }}
        >
          {bot.label || "添加标签"}
        </button>
      )}
      {error && (
        <div className="mt-1 text-xs">
          <p role="alert" className="text-destructive">
            {error}
          </p>
          <button
            disabled={saving || disabled}
            onClick={() => {
              // Explicit retry applies only the label to the latest profile, preserving other edits.
              version.current = bot.version
              void save()
            }}
          >
            重试保存
          </button>
          <button
            disabled={saving}
            onClick={() => {
              cancelled.current = true
              setEditing(false)
              setError(null)
            }}
          >
            取消
          </button>
        </div>
      )}
    </div>
  )
}
