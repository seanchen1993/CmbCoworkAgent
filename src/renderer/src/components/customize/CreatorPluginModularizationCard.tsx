import type { PluginModularizationStatus } from "../../../../shared/plugin-modularization"

const button = "rounded-lg border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50"

export function CreatorPluginModularizationCard({
  status,
  busy,
  onConfirm,
  onContinue
}: {
  status: PluginModularizationStatus
  busy: boolean
  onConfirm?: () => void
  onContinue?: () => void
}) {
  return (
    <article
      aria-label="原始插件首次模块化确认"
      className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4"
    >
      <h3 className="font-semibold">把原始插件整理成可组合的 Mods</h3>
      <p className="text-sm font-medium">{status.sourceName}</p>
      <p className="text-sm">{status.summary}</p>
      <p role="status" className="text-sm">
        {status.phase === "ready"
          ? "模块化来源已准备，可回原聊天继续选择、组合和试用。"
          : status.phase === "needs-confirmation"
            ? "请核对模块边界和原资源保留方案，再确认准备。"
            : status.phase === "preparing"
              ? "正在准备模块化来源。"
              : status.phase === "cancelled"
                ? "本次准备已取消。"
                : "模块化准备未完成，请回原聊天查看诊断并调整方案。"}
      </p>
      <details className="rounded-lg border bg-background/60 p-3 text-xs">
        <summary className="cursor-pointer font-medium">
          模块边界与保留资源（{status.mods.length} 个 Mod、{status.resources} 项资源）
        </summary>
        <ol className="mt-2 list-inside list-decimal space-y-1">
          {status.mods.map((mod) => (
            <li key={mod.id}>
              {mod.title} · {mod.id}
            </li>
          ))}
        </ol>
        <p className="mt-2 break-all text-muted-foreground">原始源码摘要：{status.sourceDigest}</p>
      </details>
      {!!status.diagnostics.length && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">检查说明（{status.diagnostics.length}）</summary>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {status.diagnostics.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs leading-5 text-muted-foreground">
        确认只准备当前来源的模块化副本，不修改原插件，不安装、不授予执行权限，也不代表 Hooks
        或业务效果已通过运行验证。
      </p>
      <div className="flex flex-wrap gap-2">
        {status.phase === "needs-confirmation" && (
          <button
            type="button"
            className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || !status.canConfirm || !onConfirm}
            onClick={onConfirm}
          >
            确认并准备这些 Mods
          </button>
        )}
        {status.phase === "ready" && onContinue && (
          <button type="button" className={button} disabled={busy} onClick={onContinue}>
            回原聊天继续组合
          </button>
        )}
      </div>
    </article>
  )
}
