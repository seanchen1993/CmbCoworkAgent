import type { DashboardTraceDetail } from "./use-dashboard"

/**
 * 把 `dashboard:threadTraces` 的响应转成 trace 列表，**失败一律抛出**。
 *
 * 每个加载器原来都写 `res.success ? res.data : []`，于是「请求失败」和「这个会话
 * 确实没有 trace」在调用方眼里长得一模一样。TraceExplorer 会把返回值写进
 * threadTraceCache，而它的守卫是 `if (threadTraceCache[id]) return` —— 空数组也是
 * truthy，所以一次失败就把该会话永久锁在「只有摘要」的状态，本次会话内不再重试。
 *
 * 会话列表改成摘要预览（不含 `_raw`）之后，这条通路是完整对话的唯一来源，吞掉
 * 失败的代价从「降级」变成了「归零」。抛出让调用方能区分二者：成功（含真正为空）
 * 才进缓存，失败只提示并保留重试机会。
 *
 * 独立成模块（而非留在 TraceHistoryDialog.tsx）是为了能脱离 React 直接单测。
 */
export function unwrapThreadTracesResponse(
  res: { success?: boolean; data?: unknown; error?: string } | null | undefined
): DashboardTraceDetail[] {
  if (!res?.success) throw new Error(res?.error || "加载完整会话失败")
  return Array.isArray(res.data) ? (res.data as DashboardTraceDetail[]) : []
}
