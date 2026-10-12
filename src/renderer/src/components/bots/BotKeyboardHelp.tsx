import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { BotDialogContent as DialogContent } from "./BotDialog"
import type { GlobalShortcutAction } from "./upstream/grok-keyboard-shortcuts"
import { botShortcutLabel } from "@/lib/bot-keyboard"

export function BotKeyboardHelp({
  actions,
  close
}: {
  actions: GlobalShortcutAction[]
  close(): void
}) {
  const mac = window.electron?.process.platform === "darwin"
  const rows = actions
    .filter((action) => !/^focus[1-9]$/.test(action.id))
    .map((action) => ({ label: action.label, key: botShortcutLabel(action.hotkey, mac) }))
  rows.push(
    { label: "按侧栏顺序切换会话", key: botShortcutLabel("mod+1", mac) + " … 9" },
    { label: "浏览器画面：回到电脑控件", key: mac ? "⌃ + ⌥ + Esc" : "Ctrl + Alt + Esc" },
    { label: "发送消息", key: "Enter" },
    { label: "输入换行", key: "Shift + Enter" }
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Bot 快捷键</DialogTitle>
          <DialogDescription>
            在 Bot 工作区内使用。接管浏览器时，按键交给浏览器处理。
          </DialogDescription>
        </DialogHeader>
        <dl className="space-y-3 py-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-5">
              <dt>{row.label}</dt>
              <dd>
                <kbd className="rounded border bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
                  {row.key}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      </DialogContent>
    </Dialog>
  )
}
