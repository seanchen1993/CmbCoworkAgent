import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { AlertTriangle, Minimize2, Power } from "lucide-react"
import { Dialog, DialogContent } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import {
  reduceCloseToTrayPrompt,
  type CloseToTrayPromptAction,
  type CloseToTrayPromptOpenEvent
} from "../../../../shared/close-to-tray"

export function CloseToTrayDialog(): React.JSX.Element | null {
  const [request, setRequest] = useState<CloseToTrayPromptOpenEvent | null>(null)
  const [rememberChoice, setRememberChoice] = useState(false)
  const requestRef = useRef<CloseToTrayPromptOpenEvent | null>(null)

  useEffect(() => {
    return window.electron.onCloseToTrayPrompt((event) => {
      const nextRequest = reduceCloseToTrayPrompt(requestRef.current, event)
      if (nextRequest === requestRef.current) return
      requestRef.current = nextRequest
      setRememberChoice(false)
      setRequest(nextRequest)
    })
  }, [])

  const respond = useCallback(
    (action: CloseToTrayPromptAction) => {
      const activeRequest = requestRef.current
      if (!activeRequest) return
      requestRef.current = null
      flushSync(() => setRequest(null))

      if (action === "cancel") {
        window.electron.respondCloseToTrayPrompt(activeRequest.requestId, action, false)
        return
      }

      const shouldRemember = activeRequest.rememberChoiceAllowed && rememberChoice
      window.electron.respondCloseToTrayPrompt(activeRequest.requestId, action, shouldRemember)
    },
    [rememberChoice]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) respond("cancel")
    },
    [respond]
  )

  const trayAreaName = request?.trayAreaName ?? "系统托盘"

  if (!request) return null

  const hasActiveRuns = request.reason === "active-runs"
  const trayUnavailable = request.reason === "tray-unavailable"

  return (
    <Dialog open={Boolean(request)} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[calc(100vw-32px)] gap-0 rounded-lg border border-border/80 bg-background p-0 shadow-2xl sm:max-w-[460px]">
        <div className="border-b border-border/70 px-5 pb-4 pt-5">
          <div className="flex items-start gap-3">
            <div
              className={`flex size-10 shrink-0 items-center justify-center rounded-md border ${
                hasActiveRuns
                  ? "border-status-critical/35 bg-status-critical/10 text-status-critical"
                  : "border-status-info/35 bg-status-info/10 text-status-info"
              }`}
            >
              {hasActiveRuns ? (
                <AlertTriangle className="size-5" strokeWidth={1.9} />
              ) : (
                <Minimize2 className="size-5" strokeWidth={1.9} />
              )}
            </div>
            <div className="min-w-0 flex-1 pr-7">
              <div className="text-base font-semibold leading-6 text-foreground">
                {hasActiveRuns
                  ? "仍有任务正在运行"
                  : trayUnavailable
                    ? `${trayAreaName}暂不可用`
                    : "关闭窗口？"}
              </div>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                {hasActiveRuns
                  ? "退出应用会中止正在运行的任务，请确认是否继续。"
                  : trayUnavailable
                    ? `当前无法最小化到${trayAreaName}，你可以退出应用或取消关闭。`
                    : "你可以把 CMBDevClaw 留在后台，也可以直接退出应用。"}
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-3 px-5 py-4">
          {request.canMinimizeToTray && (
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
          )}

          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start whitespace-normal rounded-md border-status-critical/35 bg-status-critical/10 px-4 py-3 text-left text-status-critical hover:bg-status-critical/15"
            onClick={() => respond("direct-close")}
          >
            <Power className="size-4 shrink-0" strokeWidth={1.9} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">退出应用</span>
              <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">
                {hasActiveRuns
                  ? "中止正在运行的任务并退出 CMBDevClaw。"
                  : `退出 CMBDevClaw，不再保留在${trayAreaName}后台运行。`}
              </span>
            </span>
          </Button>
        </div>

        <div className="border-t border-border/70 px-5 py-4">
          {request.rememberChoiceAllowed ? (
            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={rememberChoice}
                onChange={(event) => setRememberChoice(event.target.checked)}
                className="mt-0.5 size-4 shrink-0 cursor-pointer rounded border-border accent-primary"
              />
              <span className="min-w-0">
                <span className="block font-medium text-foreground">
                  记住我的选择，下次不再询问
                </span>
                <span className="mt-1 block text-xs leading-5 text-muted-foreground">
                  可在“自定义 &gt; 通用”中修改。
                </span>
              </span>
            </label>
          ) : (
            <p className="text-xs leading-5 text-muted-foreground">
              为防止误操作，任务运行期间每次退出都需要确认。
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
