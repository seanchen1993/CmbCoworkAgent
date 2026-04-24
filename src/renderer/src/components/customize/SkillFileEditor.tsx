import { memo } from "react"
import { PencilLine } from "lucide-react"

export interface SkillFileEditorProps {
  value: string
  disabled?: boolean
  error?: string | null
  onChange: (value: string) => void
  onSave: () => void
}

export const SkillFileEditor = memo(function SkillFileEditor(
  props: SkillFileEditorProps
): React.JSX.Element {
  const { value, disabled = false, error = null, onChange, onSave } = props

  return (
    <div className="space-y-3 rounded-lg border border-amber-200/80 bg-amber-50/55 p-3">
      {/* 将“编辑态”提示固定放在顶部，避免被大文本框挤出可视区域。 */}
      <div className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/70 bg-amber-100/80 px-2 py-1 text-[11px] text-amber-900">
        <PencilLine className="size-3" />
        编辑模式
      </div>
      <p className="text-xs text-muted-foreground">
        当前为编辑态，和预览态样式已区分。可使用 Ctrl/Cmd + S 快速保存。
      </p>
      <textarea
        className="w-full min-h-[58vh] rounded-md border border-amber-300/70 bg-white px-3 py-2 text-xs font-mono leading-relaxed shadow-sm"
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
