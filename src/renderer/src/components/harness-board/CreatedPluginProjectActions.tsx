import { Button } from "@/components/ui/button"

/** A generated plugin uses the ordinary project entry; step editing stays optional. */
export function CreatedPluginProjectActions({
  name,
  busy,
  error,
  onOpenProject,
  onCustomizeSteps,
  onDismiss
}: {
  name: string
  busy: boolean
  error: string | null
  onOpenProject(): void
  onCustomizeSteps(): void
  onDismiss(): void
}) {
  return (
    <section
      role="region"
      aria-label="新项目已创建"
      className="fixed bottom-6 right-6 z-40 max-w-sm space-y-2 rounded-xl border bg-background p-4 shadow-lg"
    >
      <p className="font-medium">{name} · 项目已创建</p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={onOpenProject}>
          打开项目
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCustomizeSteps}>
          调整步骤（可选）
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onDismiss}>
          关闭
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
