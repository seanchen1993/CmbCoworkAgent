import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"

export function ModsSettingsGate({ children }: { children: ReactNode }): React.JSX.Element {
  const [unlocked, setUnlocked] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  useEffect(() => {
    let live = true
    void window.api.mods.functionUnlocked().then(
      (value) => {
        if (live) setUnlocked(value)
      },
      () => {
        if (live) setError("无法读取设置锁定状态，请重试。")
      }
    )
    void window.api.mods.globalEnabled().then(
      (value) => {
        if (live) setEnabled(value)
      },
      () => {
        if (live) setError("无法读取运行开关状态。")
      }
    )
    return () => {
      live = false
    }
  }, [])

  if (unlocked) return <>{children}</>
  return (
    <section className="w-full space-y-4 p-4 text-sm" data-mods-settings data-mods-locked>
      <fieldset disabled className="space-y-3 rounded border bg-muted/30 p-4 opacity-50">
        <legend className="px-1 font-medium">Function Mods · 已锁定</legend>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} readOnly />
          启用 Mods 功能（应用级）
        </label>
        <Button variant="outline" size="sm" disabled>
          安装示范 Mods
        </Button>
        <p className="text-muted-foreground">项目授权与已安装 Mods 管理在解锁后可用。</p>
      </fieldset>
      <form
        className="max-w-md space-y-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy || !password) return
          setBusy(true)
          setError("")
          void window.api.mods
            .unlockFunction(password)
            .then(
              (value) => {
                if (value) setUnlocked(true)
                else setError("Function Mods 设置暂不可用。")
              },
              (reason: unknown) =>
                setError(
                  String(reason).includes("MODS_FUNCTION_PASSWORD_INVALID")
                    ? "管理口令错误，请重试。"
                    : "解锁失败，请重试。"
                )
            )
            .finally(() => {
              setPassword("")
              setBusy(false)
            })
        }}
      >
        <label htmlFor="mods-settings-password">输入管理口令解锁 Function Mods 设置</label>
        <div className="flex gap-2">
          <input
            id="mods-settings-password"
            type="password"
            autoComplete="off"
            className="h-9 min-w-0 flex-1 rounded border bg-background px-3"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <Button type="submit" size="sm" disabled={busy || !password}>
            解锁设置
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          解锁仅对本次应用会话有效，重启后需重新输入。解锁不会自动开启
          Mods，也不会改变已有运行开关。
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </form>
    </section>
  )
}
