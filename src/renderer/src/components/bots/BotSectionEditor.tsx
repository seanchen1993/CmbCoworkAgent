import { useRef, useState } from "react"

/** Inline naming keeps the moved Bot visible, matching the sidebar grouping flow. */
export function BotSectionEditor({
  name,
  onClose,
  onSave
}: {
  name: string
  onClose(): void
  onSave(name: string): void
}) {
  const [value, setValue] = useState(name)
  const finished = useRef(false)
  const save = () => {
    if (finished.current) return
    finished.current = true
    onSave(value.trim() || name)
  }
  return (
    <input
      className="bot-section-name-input"
      autoFocus
      aria-label="重命名分组"
      maxLength={40}
      value={value}
      onFocus={(event) => event.target.select()}
      onChange={(event) => setValue(event.target.value)}
      onBlur={save}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return
        if (event.key === "Enter") {
          event.preventDefault()
          save()
        }
        if (event.key === "Escape") {
          finished.current = true
          onClose()
        }
      }}
    />
  )
}
