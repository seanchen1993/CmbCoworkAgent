import type { DevelopmentBusinessStatus } from "../../../../shared/mods/development"
import { InstalledPluginStartUse } from "./InstalledPluginStartUse"
import { projectDeliveryReconciliationText } from "./project-delivery-view"

type Review = NonNullable<DevelopmentBusinessStatus["review"]>
const button = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
const descriptions: Record<Review["phase"], string> = {
  "needs-approval": "插件已准备好。",
  "needs-review": "请重新核对当前版本。",
  installing: "正在安装…",
  exporting: "正在导出…",
  installed: "插件已保存。",
  exported: "插件包已导出。",
  failed: "操作未完成。已保存的草稿与现有插件保留，请核对后重新准备方案。",
  unknown: "操作结果未确认。请先核对已安装插件和导出文件，不要重复安装或导出。",
  cancelled: "已取消本次操作。已安装的插件和已保存草稿保留。"
}

export function BusinessCreatorReviewCard({
  review,
  busy,
  onApprove,
  onExport,
  onRead,
  startUseScope,
  presentation = "delivery"
}: {
  review: Review
  busy: boolean
  onApprove(): void
  onExport(): void
  onRead(): void
  onTrial?(): void
  startUseScope?: { threadId: string; workspace: string }
  presentation?: "delivery" | "source"
}) {
  const sourceOnly = presentation === "source"
  const installable =
    !review.exportOnly && review.canConfirm && ["needs-approval", "exported"].includes(review.phase)
  const exportable =
    review.canConfirm && ["needs-approval", "installed", "exported"].includes(review.phase)
  return (
    <article
      aria-label="业务插件组装确认"
      className="space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm"
    >
      <div>
        <h4 className="font-semibold">
          {sourceOnly
            ? "组装来源与候选版本"
            : review.pluginId
              ? "插件已保存"
              : review.exportOnly
                ? "导出更新包"
                : "保存插件"}
        </h4>
        <p className="mt-1 break-words text-sm">
          {review.name} · v{review.version}
        </p>
      </div>
      <p role="status" className="text-xs leading-5">
        {sourceOnly && review.phase === "needs-approval"
          ? "原组装候选已准备；使用项目候选入口试用、验收并保存为新插件。"
          : descriptions[review.phase]}
      </p>
      {!sourceOnly && !review.pluginId && (
        <p className="text-xs text-muted-foreground">
          {review.exportOnly ? "导出后，在安装插件入口更新。" : "保存为新插件，保留原插件。"}
        </p>
      )}
      <details className="rounded-lg border bg-background/60 p-3 text-xs">
        <summary className="cursor-pointer font-medium">
          核对插件内容（{review.steps.length} 个步骤
          {review.extensions?.length ? `、${review.extensions.length} 个扩展` : ""}）
        </summary>
        <ol className="mt-3 list-inside list-decimal space-y-1 text-xs" aria-label="组合的业务步骤">
          {review.steps.map((step) => (
            <li key={step.id}>
              {step.title} · {step.sourceName}
            </li>
          ))}
        </ol>
        {!!review.extensions?.length && (
          <ul className="list-inside list-disc space-y-1 text-xs" aria-label="附加的扩展模块">
            {review.extensions.map((extension) => (
              <li key={extension.id}>
                {extension.title} · {extension.sourceName}
              </li>
            ))}
          </ul>
        )}
      </details>
      {!!review.diagnostics.length && (
        <div role="status" className="space-y-1 rounded border p-2 text-xs">
          <p>检查提示：</p>
          {review.diagnostics.map((diagnostic, index) => (
            <p key={index} className="break-words">
              {diagnostic}
            </p>
          ))}
        </div>
      )}
      {!sourceOnly && review.pluginId && startUseScope && review.contentDigest && (
        <InstalledPluginStartUse
          {...startUseScope}
          pluginId={review.pluginId}
          expected={{ name: review.name, version: review.version, digest: review.contentDigest }}
        />
      )}
      <div className="flex flex-wrap gap-2">
        {!sourceOnly && !review.exportOnly && !review.pluginId && (
          <button
            type="button"
            className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || !installable}
            onClick={onApprove}
          >
            保存插件
          </button>
        )}
        {!sourceOnly && (
          <button
            type="button"
            className={button}
            disabled={busy || !exportable}
            onClick={onExport}
          >
            {review.exportOnly ? "导出更新包…" : "导出插件包…"}
          </button>
        )}
        {(review.canReconcile || ["needs-review", "failed"].includes(review.phase)) && (
          <button type="button" className={button} disabled={busy} onClick={onRead}>
            {review.canReconcile ? "核对实际交付结果" : "核对状态"}
          </button>
        )}
      </div>
      {!sourceOnly && review.pluginId && !review.contentDigest && (
        <p className="text-xs text-muted-foreground">
          这是较早的交付记录，请先核对实际交付结果，补齐精确安装内容身份后再开始使用。
        </p>
      )}
      {review.reconciliation && (
        <p role="status" className="text-xs text-muted-foreground">
          {projectDeliveryReconciliationText(review.reconciliation.outcome)}
        </p>
      )}
      {review.output && (
        <p className="break-all text-xs text-muted-foreground">导出位置：{review.output}</p>
      )}
      {review.pendingOutput && (
        <div className="space-y-1 text-xs text-muted-foreground">
          <p className="break-all">待核对导出目标：{review.pendingOutput}</p>
          <p>
            若存在不完整或冲突文件，请先保留并移到其他位置，再核对实际交付结果。
            确认未执行后，让创造者重新准备当前候选，在新方案中确认导出；不会自动覆盖或删除原文件。
          </p>
        </div>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">来源与版本</summary>
        <p className="mt-2 break-all">插件标识：{review.copyId}</p>
        <p className="mt-2 break-all">内容摘要：{review.digest}</p>
        {review.pluginId && <p className="mt-2 break-all">安装标识：{review.pluginId}</p>}
      </details>
    </article>
  )
}
