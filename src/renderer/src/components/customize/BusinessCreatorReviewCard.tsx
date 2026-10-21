import type { DevelopmentBusinessStatus } from "../../../../shared/mods/development"
import { InstalledPluginStartUse } from "./InstalledPluginStartUse"
import { projectDeliveryReconciliationText } from "./project-delivery-view"

type Review = NonNullable<DevelopmentBusinessStatus["review"]>
const button = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"
const descriptions: Record<Review["phase"], string> = {
  "needs-approval": "已准备独立插件，等待确认。检查通过不代表真实业务流程已经执行。",
  "needs-review": "此方案需要重新核对来源与版本。重启不会恢复安装授权。",
  installing: "正在通过原插件服务安装，请等待并核对结果。",
  exporting: "正在导出插件，请等待并核对结果。",
  installed: "独立插件已安装。插件权限、用户配置及实际项目运行仍由原入口管理。",
  exported: "插件包已导出。安装到其他电脑后，需要重新绑定自己的知识目录、参数和权限。",
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
  onTrial,
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
        <h4 className="font-semibold">{sourceOnly ? "组装来源与候选版本" : review.exportOnly ? "保存插件更新包" : "保存为新的独立插件"}</h4>
        <p className="mt-1 break-words text-sm">{review.name} · v{review.version}</p>
      </div>
      <p role="status" className="text-xs leading-5">
        {sourceOnly && review.phase === "needs-approval"
          ? "原组装候选已准备；使用项目候选入口试用、验收并保存为新插件。"
          : descriptions[review.phase]}
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        {sourceOnly ? "保留原生组装预审、业务步骤、检查提示与来源标识。此处不再重复安装或导出；上方项目候选入口使用相同的组装来源。"
          : review.exportOnly
          ? "此候选用于更新已安装同名插件。先导出ZIP，再在原‘安装插件’入口确认更新；保留原UUID和配置，权限变化需重新确认。"
          : "安装会新增一份独立插件，保留原插件。安装不会授予运行权限，也不会开始任务。导出使用原生保存窗口选择位置，与安装分别确认。"}
      </p>
      <details className="rounded-lg border bg-background/60 p-3 text-xs">
      <summary className="cursor-pointer font-medium">核对插件内容（{review.steps.length} 个步骤{review.extensions?.length ? `、${review.extensions.length} 个扩展` : ""}）</summary>
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
      <div className="flex flex-wrap gap-2">
        {!sourceOnly && onTrial && (
          <button type="button" className={button} disabled={busy} onClick={onTrial}>
            隔离试用此版本
          </button>
        )}
        {!sourceOnly && !review.exportOnly && (
          <button
            type="button"
            className={`${button} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || !installable}
            onClick={onApprove}
          >
            保存为新插件并安装
          </button>
        )}
        {!sourceOnly && <button type="button" className={button} disabled={busy || !exportable} onClick={onExport}>
          {review.exportOnly ? "导出更新包…" : "导出插件包…"}
        </button>}
        <button type="button" className={button} disabled={busy} onClick={onRead}>
          {review.canReconcile ? "核对实际交付结果" : "核对状态"}
        </button>
      </div>
      {!sourceOnly && ["installed", "exported"].includes(review.phase) && <div className="space-y-1 rounded-lg border bg-background/60 p-3 text-xs">
        <p className="font-medium">{review.phase === "installed" ? "插件已安装，可在下方核对配置并直接进入对应使用入口。" : "将 ZIP 交给其他用户，从“安装插件”导入。"}</p>
        <p className="text-muted-foreground">每个使用环境单独填写用户参数、知识库目录并确认源码及运行权限。保存插件不包含本轮试用数据和本机授权。</p>
      </div>}
      {!sourceOnly && review.pluginId && startUseScope && review.contentDigest && (
        <InstalledPluginStartUse
          {...startUseScope}
          pluginId={review.pluginId}
          expected={{ name: review.name, version: review.version, digest: review.contentDigest }}
        />
      )}
      {!sourceOnly && review.pluginId && !review.contentDigest && (
        <p className="text-xs text-muted-foreground">
          这是较早的交付记录，请先核对实际交付结果，补齐精确安装内容身份后再开始使用。
        </p>
      )}
      {!sourceOnly && onTrial && (
        <p className="text-xs leading-5 text-muted-foreground">
          试用使用独立目录，不会安装正式插件。参数、源码权限和实际操作仍需分别确认；运行结果以原流程检查为准。
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
