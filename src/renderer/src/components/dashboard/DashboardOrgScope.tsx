import { useEffect, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Resolve the local account's default room before mounting any statistics queries. */
export function DashboardOrgScope({
  children
}: {
  children: (rooms: string[]) => ReactNode
}): React.JSX.Element {
  const [rooms, setRooms] = useState<string[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api.dashboard
      .orgFilterDefaults()
      .then((defaults) => {
        if (!cancelled) setRooms(defaults)
      })
      .catch(() => {
        if (!cancelled) setError("获取默认室筛选失败，请重试")
      })
    return () => {
      cancelled = true
    }
  }, [attempt])

  if (rooms !== null) return <>{children(rooms)}</>
  return (
    <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
      {error ? (
        <>
          <span>{error}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null)
              setAttempt((current) => current + 1)
            }}
          >
            重试
          </Button>
        </>
      ) : (
        <>
          <Loader2 className="size-4 animate-spin" />
          正在加载运营面板…
        </>
      )}
    </div>
  )
}
