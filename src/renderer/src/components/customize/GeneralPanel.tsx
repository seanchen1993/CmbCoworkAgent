import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, Settings2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { isWindowCloseBehavior, type WindowCloseBehavior } from "../../../../shared/close-to-tray"

export function GeneralPanel(): React.JSX.Element {
  const [closeBehavior, setCloseBehavior] = useState<WindowCloseBehavior | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const closeBehaviorRevisionRef = useRef(0)
  const trayAreaName = window.electron.process.platform === "darwin" ? "菜单栏" : "系统托盘"

  const loadCloseBehavior = useCallback(async (): Promise<void> => {
    const revision = ++closeBehaviorRevisionRef.current
    setLoading(true)
    setError(null)
    setCloseBehavior(null)
    try {
      const behavior = await window.electron.getWindowCloseBehavior()
      if (closeBehaviorRevisionRef.current === revision) {
        setCloseBehavior(behavior)
      }
    } catch (loadError) {
      console.error("[GeneralPanel] Failed to load window close behavior:", loadError)
      if (closeBehaviorRevisionRef.current === revision) {
        setError("无法读取关闭窗口设置，请稍后重试。")
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCloseBehavior()
  }, [loadCloseBehavior])

  useEffect(() => {
    return window.electron.onWindowCloseBehaviorChanged((behavior) => {
      closeBehaviorRevisionRef.current += 1
      setCloseBehavior(behavior)
      setLoading(false)
      setError(null)
    })
  }, [])

  const handleCloseBehaviorChange = useCallback(
    async (value: string): Promise<void> => {
      if (!isWindowCloseBehavior(value) || closeBehavior === null || value === closeBehavior) return
      const previousBehavior = closeBehavior
      const revision = ++closeBehaviorRevisionRef.current
      setCloseBehavior(value)
      setSaving(true)
      setError(null)
      try {
        const savedBehavior = await window.electron.setWindowCloseBehavior(value)
        if (closeBehaviorRevisionRef.current === revision) {
          setCloseBehavior(savedBehavior)
        }
        toast.success("关闭窗口设置已保存")
      } catch (saveError) {
        console.error("[GeneralPanel] Failed to save window close behavior:", saveError)
        if (closeBehaviorRevisionRef.current === revision) {
          setCloseBehavior(previousBehavior)
          setError("保存失败，设置未更改。")
        }
      } finally {
        setSaving(false)
      }
    },
    [closeBehavior]
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6 sm:p-8">
      <div className="mx-auto w-full max-w-3xl space-y-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
              <Settings2 className="size-5 text-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-foreground">通用</h1>
              <p className="mt-1 text-sm text-muted-foreground">管理应用窗口和基础行为。</p>
            </div>
          </div>
        </div>

        <section className="rounded-lg border border-border/80 bg-background">
          <div className="border-b border-border/70 px-5 py-4">
            <h2 className="text-sm font-semibold text-foreground">窗口</h2>
          </div>
          <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 sm:pr-8">
              <div className="text-sm font-medium text-foreground">关闭主窗口时</div>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                设置点击窗口右上角 × 时的行为；从{trayAreaName}菜单选择“退出”始终会退出应用。
              </p>
            </div>
            <div className="flex w-full shrink-0 items-center gap-2 sm:w-[250px]">
              <Select
                value={closeBehavior ?? undefined}
                onValueChange={(value) => void handleCloseBehaviorChange(value)}
                disabled={loading || saving || closeBehavior === null}
              >
                <SelectTrigger aria-label="关闭主窗口时" className="w-full">
                  <SelectValue placeholder={loading ? "正在加载…" : "无法读取设置"} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ask">每次询问</SelectItem>
                  <SelectItem value="minimize-to-tray">最小化到{trayAreaName}</SelectItem>
                  <SelectItem value="quit">退出应用</SelectItem>
                </SelectContent>
              </Select>
              {(loading || saving) && (
                <Loader2
                  className="size-4 shrink-0 animate-spin text-muted-foreground"
                  aria-label={loading ? "正在加载" : "正在保存"}
                />
              )}
            </div>
          </div>
          {error && (
            <div className="flex items-center justify-between gap-3 border-t border-status-critical/25 bg-status-critical/5 px-5 py-3 text-xs text-status-critical">
              <span>{error}</span>
              {!loading && (
                <Button variant="outline" size="sm" className="h-7" onClick={loadCloseBehavior}>
                  重试
                </Button>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
