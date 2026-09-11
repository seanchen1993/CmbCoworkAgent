import React, { useState, useSyncExternalStore } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  isBuiltinBrowserScreenshotEnabled,
  setBuiltinBrowserScreenshotEnabled,
  subscribeBuiltinBrowserScreenshot
} from "./builtin-browser"

export function BuiltinBrowserScreenshotToggle(): React.ReactElement {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const enabled = useSyncExternalStore(
    subscribeBuiltinBrowserScreenshot,
    isBuiltinBrowserScreenshotEnabled,
    () => false
  )

  const handleChange = (nextEnabled: boolean): void => {
    if (!nextEnabled) {
      setBuiltinBrowserScreenshotEnabled(false)
      return
    }
    setConfirmOpen(true)
  }

  return (
    <>
      <label
        className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => handleChange(event.currentTarget.checked)}
          className="size-3.5 accent-primary"
        />
        <span>允许使用截图功能</span>
      </label>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>是否允许内置浏览器使用截图功能？</DialogTitle>
            <DialogDescription>
              如果当前大模型不支持图片识别，内置浏览器使用截图功能时将会失败并且报错。请确认当前大模型已支持图片识别。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button
              type="button"
              onClick={() => {
                setBuiltinBrowserScreenshotEnabled(true)
                setConfirmOpen(false)
              }}
            >
              允许
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
