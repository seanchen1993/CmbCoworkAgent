import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Minimize2, Power } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  reduceCloseToTrayPrompt,
  type CloseToTrayPromptAction,
  type CloseToTrayPromptOpenEvent
} from "../../../../shared/close-to-tray"

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resolve()
    }
    const timeout = window.setTimeout(finish, 250)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(finish)
    })
  })
}

export function CloseToTrayDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<CloseToTrayPromptOpenEvent | null>(null)
  const requestRef = useRef<CloseToTrayPromptOpenEvent | null>(null)

  useEffect(() => {
    return window.electron.onCloseToTrayPrompt((event) => {
      const nextRequest = reduceCloseToTrayPrompt(requestRef.current, event)
      if (nextRequest === requestRef.current) return
      requestRef.current = nextRequest
      setRequest(nextRequest)
    })
  }, [])

  const respond = useCallback((action: CloseToTrayPromptAction) => {
    const activeRequest = requestRef.current
    if (!activeRequest) return
    requestRef.current = null
    flushSync(() => setRequest(null))

    if (action === "cancel") {
      window.electron.respondCloseToTrayPrompt(activeRequest.requestId, action)
      return
    }

    void waitForNextPaint().then(() => {
      window.electron.respondCloseToTrayPrompt(activeRequest.requestId, action)
    })
  }, [])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) respond("cancel")
    },
    [respond]
  )

  const trayAreaName = request?.trayAreaName ?? "系统托盘"

  if (!request) return null

  return (
    <Dialog open={Boolean(request)} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[calc(100vw-32px)] gap-0 rounded-lg border border-border/80 bg-background p-0 shadow-2xl sm:max-w-[460px]">
        <div className="border-b border-border/70 px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-md border border-status-info/35 bg-status-info/10 text-status-info">
              <Minimize2 className="size-5" strokeWidth={1.9} />
            </div>
            <div className="min-w-0 flex-1 pr-7">
              <div className="text-base font-semibold leading-6 text-foreground">
                关闭窗口？
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                你可以把 CMBDevClaw 留在后台，也可以直接退出应用。
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal rounded-md border-status-info/35 bg-status-info/10 px-4 py-3 text-left text-foreground hover:bg-status-info/15"
            onClick={() => respond("minimize-to-tray")}
          >
            <Minimize2 className="size-4 shrink-0 text-status-info" strokeWidth={1.9} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">最小化到{trayAreaName}</span>
              <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                后台继续运行，可从{trayAreaName}图标重新打开。
              </span>
            </span>
          </Button>

          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal rounded-md border-status-critical/35 bg-status-critical/10 px-4 py-3 text-left text-status-critical hover:bg-status-critical/15"
            onClick={() => respond("direct-close")}
          >
            <Power className="size-4 shrink-0" strokeWidth={1.9} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">直接关闭</span>
              <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                退出 CMBDevClaw，不再保留在{trayAreaName}后台运行。
              </span>
            </span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
