import { FileCode2 } from "lucide-react"
import { cn } from "@/lib/utils"

const VARIABLE_USAGE_HINT = `如果有变量，需要按照这个格式，否则不生效，案例如下：
const 变量_分支 = "";
await page.getByRole("textbox", { name: "Select branch", exact: true }).fill(变量_分支);`

interface BrowserScriptEditorProps {
  title: React.ReactNode
  value: string
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  disabled?: boolean
  className?: string
  contentClassName?: string
  textareaClassName?: string
  headerRight?: React.ReactNode
}

export function BrowserScriptEditor({
  title,
  value,
  onChange,
  ariaLabel,
  placeholder = "// No script generated yet.",
  disabled = false,
  className,
  contentClassName,
  textareaClassName,
  headerRight
}: BrowserScriptEditorProps): React.JSX.Element {
  const lineCount = value.trim().length > 0 ? value.split(/\r?\n/u).length : 0

  return (
    <div
      className={cn(
        "flex min-h-[360px] flex-col overflow-hidden rounded-xl border border-slate-900/80 bg-[#0b0f14] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]",
        className
      )}
    >
      <div className="flex items-center justify-between gap-3 border-b border-white/10 bg-[#11161d] px-4 py-2 text-[11px] text-slate-400">
        <div className="flex min-w-0 items-center gap-2">
          <FileCode2 className="size-3.5 shrink-0" strokeWidth={1.8} />
          <div className="min-w-0">{title}</div>
        </div>
        {headerRight ?? (
          <span className="shrink-0 font-mono tabular-nums">
            {lineCount > 0 ? `${lineCount} lines` : "waiting"}
          </span>
        )}
      </div>

      <div
        className={cn(
          "flex h-full min-h-0 flex-1 flex-col gap-3 px-4 py-4 font-mono text-[12px] leading-6 text-slate-100",
          contentClassName
        )}
      >
        <div className="rounded-lg border border-amber-400/20 bg-amber-500/10 px-3 py-2 font-sans text-[11px] leading-5 text-amber-100">
          <p className="font-medium text-amber-50">变量格式提示</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-5 text-amber-100">
            {VARIABLE_USAGE_HINT}
          </pre>
        </div>

        <textarea
          aria-label={ariaLabel}
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          className={cn(
            "min-h-0 flex-1 overflow-x-auto overflow-y-scroll resize-none border-0 bg-transparent p-0 font-mono text-[12px] leading-6 text-slate-100 outline-none placeholder:text-slate-500 [scrollbar-gutter:stable]",
            textareaClassName
          )}
          placeholder={placeholder}
        />
      </div>
    </div>
  )
}
