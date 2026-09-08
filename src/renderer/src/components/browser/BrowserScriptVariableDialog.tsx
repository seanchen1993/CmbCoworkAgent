import { Loader2, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { ScriptRecordingVariable } from "../../../../shared/browser-script-recording"

interface BrowserScriptVariableDialogProps {
  open: boolean
  variables: ScriptRecordingVariable[]
  values: Record<string, string>
  isSubmitting: boolean
  onOpenChange: (open: boolean) => void
  onValueChange: (identifier: string, value: string) => void
  onSubmit: () => void
}

export function BrowserScriptVariableDialog({
  open,
  variables,
  values,
  isSubmitting,
  onOpenChange,
  onValueChange,
  onSubmit
}: BrowserScriptVariableDialogProps): React.JSX.Element {
  const hasMissingValue = variables.some((variable) => {
    const value = values[variable.identifier] ?? ""
    return variable.isArray
      ? value.split(/\r?\n/u).every((item) => !item.trim())
      : value.trim().length === 0
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] max-w-lg overflow-hidden">
        <DialogHeader>
          <DialogTitle>填写脚本变量</DialogTitle>
          <DialogDescription>
            执行前需要先填写下面的变量值。填写完成后，脚本才会在内置浏览器中执行。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[52vh] space-y-4 overflow-auto p-2">
          {variables.map((variable, index) => {
            const value = values[variable.identifier] ?? ""
            const missing = variable.isArray
              ? value.split(/\r?\n/u).every((item) => !item.trim())
              : value.trim().length === 0

            return (
              <div key={variable.identifier} className="space-y-2">
                <label
                  htmlFor={`browser-script-variable-${variable.identifier}`}
                  className="block text-sm font-medium text-foreground"
                >
                  {index + 1}. {variable.displayName}
                </label>
                {variable.isArray ? (
                  <textarea
                    id={`browser-script-variable-${variable.identifier}`}
                    value={value}
                    disabled={isSubmitting}
                    onChange={(event) => onValueChange(variable.identifier, event.target.value)}
                    placeholder="每行填写一个值，例如一个文件路径"
                    className="min-h-24 w-full resize-y rounded-lg border border-border/80 bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-wait"
                  />
                ) : (
                  <Input
                    id={`browser-script-variable-${variable.identifier}`}
                    autoFocus={index === 0}
                    value={value}
                    disabled={isSubmitting}
                    onChange={(event) => onValueChange(variable.identifier, event.target.value)}
                    placeholder={`请输入${variable.displayName}`}
                    className="h-9 rounded-lg border-border/80 bg-background text-sm shadow-none"
                  />
                )}
                {missing ? (
                  <p className="text-[11px] text-status-warning">请填写此变量值。</p>
                ) : null}
              </div>
            )
          })}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={isSubmitting || hasMissingValue}
            onClick={() => {
              onSubmit()
            }}
          >
            {isSubmitting ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
            ) : (
              <Play className="size-3.5" strokeWidth={1.8} />
            )}
            执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
