import type { DevelopmentStatus } from "../../../../shared/mods/development"
import { developmentCapabilitySummary } from "./development-trial-view"

type Plan = NonNullable<DevelopmentStatus["reuse"]>

const button = "rounded-lg border px-3 py-2 text-xs font-medium hover:bg-accent disabled:opacity-50"

export function DevelopmentReusePlanCard({
  plan,
  current,
  busy,
  onApprove,
  onPrepare,
  onRead
}: {
  plan: Plan
  current: boolean
  busy: boolean
  onApprove: () => void
  onPrepare?: () => void
  onRead: () => void
}) {
  const canApprove = current && !!plan.planId && !!plan.compiledDigest && !!plan.targetProfileDigest
  return (
    <article aria-label="保存并在其他聊天复用" className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-3 text-sm">
      <p className="break-words font-medium">保存并在其他聊天复用 · {plan.name}</p>
      {plan.phase === "needs-approval" ? (
        <>
          <p className="text-xs">
            确认后将安装这个正式版本、授予当前项目下方列出的权限、保存可复用组合，并加入当前聊天。保留原有其他功能和设置。
          </p>
          <ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">
            {developmentCapabilitySummary(plan.capabilities).map((capability) =>
              <li key={capability}>{capability}</li>)}
          </ul>
          {!plan.capabilities.length && <p className="text-xs">此版本未申请额外能力。</p>}
          <p className="text-xs text-muted-foreground">可在其他聊天选择这份组合；使用默认继承设置的聊天也会包含本项目已授权的功能。保存不会发送消息或执行任务。</p>
          {!current && <p role="status" className="text-xs text-amber-700 dark:text-amber-400">
            当前草稿已更新，请先重新准备最新版本。
          </p>}
          <button type="button" className={`${button} w-full border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={busy || !canApprove} onClick={onApprove}>
            确认保存并复用
          </button>
          {!canApprove && onPrepare && <button type="button" className={button} disabled={busy} onClick={onPrepare}>
            重新准备最新版本
          </button>}
        </>
      ) : (
        <p role="status" className="text-xs">
          {plan.phase === "active" ? "正式版本和可复用组合已保存，当前聊天已使用。可在其他聊天选择这份组合。"
            : plan.phase === "unknown" ? "保存或切换结果待核对。请先核对当前状态，不要重复安装或授权。"
              : plan.phase === "failed" ? "保存与复用尚未完成。已完成的步骤会保留，请先核对当前状态。"
                : plan.phase === "applying" ? "正在安装、授权并保存组合，请等待当前操作完成。"
                  : "正在核对版本、权限和当前聊天的选择…"}
        </p>
      )}
      {["failed", "unknown"].includes(plan.phase) && <button type="button" className={button} disabled={busy} onClick={onRead}>
        核对复用状态
      </button>}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">版本与权限详情</summary>
        <p className="mt-2 break-all">版本：v{plan.revision}<br />源码摘要：{plan.sourceDigest}<br />编译摘要：{plan.compiledDigest ?? "核对中"}</p>
        <p className="mt-2 break-all">能力标识：{plan.capabilities.join("、") || "无"}</p>
      </details>
    </article>
  )
}
