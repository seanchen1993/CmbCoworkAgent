export const DASHBOARD_ES_INPUT_BYTE_LIMIT = 8 * 1024 * 1024
export const DASHBOARD_ES_OUTPUT_BYTE_LIMIT = 6 * 1024 * 1024
export const DASHBOARD_ES_FALLBACK_BYTE_LIMIT = 256 * 1024
export const DASHBOARD_ES_REQUEST_CANCELLED = "DASHBOARD_ES_REQUEST_CANCELLED"
export const DASHBOARD_ES_RESPONSE_TOO_LARGE = "DASHBOARD_ES_RESPONSE_TOO_LARGE"
export const DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT = 384 * 1024
export const DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT = 1024 * 1024
export const DASHBOARD_HOME_ENDPOINT_OUTPUT_BYTE_LIMITS = {
  overview: DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT * 2,
  modelStats: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT,
  userStats: DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT,
  productivity: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT * 2,
  advancedFeatures: DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT * 2
} as const
export const DASHBOARD_HOME_PAGE_OUTPUT_BYTE_LIMIT =
  DASHBOARD_HOME_RANKING_QUERY_OUTPUT_BYTE_LIMIT * 3 + DASHBOARD_HOME_QUERY_OUTPUT_BYTE_LIMIT * 5
export const DASHBOARD_USER_DIRECTORY_PAGE_SIZE = 1000
export const DASHBOARD_USER_DIRECTORY_MAX_PAGES = 5
export const DASHBOARD_USER_DIRECTORY_MAX_ITEMS = 5000
export const DASHBOARD_USER_DIRECTORY_OUTPUT_BYTE_LIMIT = 2 * 1024 * 1024

export type DashboardEsProjection =
  | { kind: "overview-trace"; granularity: "day" | "week" | "month" | "custom" }
  | { kind: "overview-code" }
  | { kind: "model-stats" }
  | { kind: "user-stats"; selectedUpperOrgLv1: string | null }
  | {
      kind: "productivity-commit"
      granularity: "day" | "week" | "month" | "custom"
      range: { from: string; to: string }
    }
  | { kind: "productivity-code" }
  | { kind: "advanced-event" }
  | { kind: "advanced-trace" }
  | { kind: "user-directory" }

export interface DashboardEsWorkerQueryRequest {
  type: "query"
  requestId: number
  nodes: string[]
  method: "GET" | "POST"
  path: string
  headers: Record<string, string>
  bodyText?: string
  projection?: DashboardEsProjection
  timeoutMs: number
  inputByteLimit: number
  outputByteLimit: number
  cancellationBuffer: SharedArrayBuffer
}

export interface DashboardEsWorkerShutdownRequest {
  type: "shutdown"
}

export type DashboardEsWorkerRequest =
  | DashboardEsWorkerQueryRequest
  | DashboardEsWorkerShutdownRequest

export interface DashboardEsWorkerQuerySuccess {
  type: "query-result"
  requestId: number
  ok: true
  value: unknown
  stats: {
    sourceBytes: number
    outputBytes: number
    durationMs: number
    node: string
  }
}

/**
 * 序列化后的 cause 链节点。
 *
 * worker 只能回传可结构化克隆的值，Error 的 `cause` 不在其中：`postMessage` 一个
 * Error 只剩 message / stack / name，cause 会被整条丢掉。而每节点的真实失败原因
 * （`ES 400: <ES 自己的报错>`、`fetch failed`、`ETIMEDOUT`）恰恰只存在 cause 里，
 * runDashboardEsQuery 把它们收拢成一句面向用户的「请检查网络连接后重试」时，也
 * 只是挂在 cause 上。所以必须显式摊平成普通对象，否则主进程侧的
 * getErrorDetail 沿 cause 找不到东西，日志就会打成
 * 「All 2 ES nodes failed. Last error: 请检查网络连接后重试」——把真正的原因用
 * 提示语盖掉，排查无从下手。
 */
export interface DashboardEsWorkerErrorCause {
  code?: string
  message: string
  cause?: DashboardEsWorkerErrorCause
}

export interface DashboardEsWorkerQueryFailure {
  type: "query-result"
  requestId: number
  ok: false
  error: {
    code: string
    message: string
    stack?: string
    cause?: DashboardEsWorkerErrorCause
  }
}

export interface DashboardEsWorkerShutdownComplete {
  type: "shutdown-complete"
}

export type DashboardEsWorkerResponse =
  | DashboardEsWorkerQuerySuccess
  | DashboardEsWorkerQueryFailure
  | DashboardEsWorkerShutdownComplete
