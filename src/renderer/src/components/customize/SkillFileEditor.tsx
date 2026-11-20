import { memo } from "react"
import { PencilLine } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SkillFileEditorProps {
  value: string
  disabled?: boolean
  error?: string | null
  className?: string
  note?: string | null
  onChange: (value: string) => void
  onSave: () => void
}

export const SkillFileEditor = memo(function SkillFileEditor(
  props: SkillFileEditorProps
): React.JSX.Element {
  const { value, disabled = false, error = null, className, note = null, onChange, onSave } = props

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col gap-3 rounded-lg border border-status-warning/25 bg-status-warning/10 p-3",
        className
      )}
    >
      {/* 将“编辑态”提示固定放在顶部，避免被大文本框挤出可视区域。 */}
      <div className="inline-flex items-center gap-1.5 rounded-md border border-status-warning/30 bg-status-warning/15 px-2 py-1 text-[11px] text-status-warning">
        <PencilLine className="size-3" />
        编辑模式
      </div>
      <p className="text-xs text-muted-foreground">
        当前为编辑态，和预览态样式已区分。可使用 Ctrl/Cmd + S 快速保存。
      </p>
      {note && <p className="text-xs text-status-warning-foreground">{note}</p>}
      <textarea
        className="min-h-0 w-full flex-1 resize-none rounded-md border border-border bg-background-elevated px-3 py-2 font-mono text-xs leading-relaxed shadow-sm"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault()
            onSave()
          }
        }}
        spellCheck={false}
        disabled={disabled}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
})
