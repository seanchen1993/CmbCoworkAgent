import { useId, useRef, useState } from "react"
import { botErrorMessage } from "@/lib/bot-error-message"

/** Retain the edit's version; only an explicit retry may use the latest version. */
export function BotNameInput({
  name,
  version,
  label,
  maxLength,
  disabled,
  onSave
}: {
  name: string
  version: number
  label: string
  maxLength: number
  disabled: boolean
  onSave: (name: string, expectedVersion: number) => Promise<unknown>
}) {
  const errorId = useId()
  const [draft, setDraft] = useState<{ name: string; baseName: string; version: number } | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const lock = useRef(false)
  const cancelled = useRef(false)
  const save = async (expectedVersion = draft?.version) => {
    if (!draft || expectedVersion === undefined || lock.current || cancelled.current || disabled)
      return
    const nextName = draft.name.trim()
    if (!nextName || nextName === draft.baseName) {
      setDraft(null)
      setError(null)
      return
    }
    lock.current = true
    setSaving(true)
    setError(null)
    try {
      await onSave(nextName, expectedVersion)
      setDraft(null)
    } catch (cause) {
      setError(botErrorMessage(cause, "名称保存失败，请重试"))
    } finally {
      lock.current = false
      setSaving(false)
    }
  }
  return (
    <div className="bot-name-input">
      <input
        aria-label={label}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        placeholder="名称"
        maxLength={maxLength}
        disabled={disabled}
        readOnly={saving}
        value={draft?.name ?? name}
        onFocus={() => {
          cancelled.current = false
          setDraft((value) => value ?? { name, baseName: name, version })
        }}
        onChange={(event) => {
          const nextName = event.target.value
          setDraft((value) => ({
            name: nextName,
            baseName: value?.baseName ?? name,
            version: value?.version ?? version
          }))
          setError(null)
        }}
        onBlur={() => {
          if (!error) void save()
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return
          if (event.key === "Enter") {
            event.preventDefault()
            event.currentTarget.blur()
          }
          if (event.key === "Escape" && !lock.current) {
            event.preventDefault()
            cancelled.current = true
            setDraft(null)
            setError(null)
            event.currentTarget.blur()
          }
        }}
      />
      {error && (
        <div className="bot-name-input-error">
          <p id={errorId} role="alert">
            {error}
          </p>
          <button disabled={saving || disabled} onClick={() => void save(version)}>
            重试保存
          </button>
          <button
            disabled={saving}
            onClick={() => {
              setDraft(null)
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
