import { insertLog } from "../../js/mmjUtils"

const BASE_URL = import.meta.env.VITE_API_BASE_URL
export const UPLOAD_REQUEST_TIMEOUT_MS = 15_000
export const UPLOAD_ERROR_RESPONSE_MAX_BYTES = 64 * 1024

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UploadThreadsParams {
  /** Agent 任务的唯一标识，仅允许字母、数字、`-`、`_` */
  unique_id: string
  /** 埋点文件 */
  file: File
}

export interface UploadThreadsResponse {
  success: boolean
  message?: string
  [key: string]: unknown
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function readBoundedErrorText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_ERROR_RESPONSE_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return "response body exceeded the error budget"
  }
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ""
  try {
    while (totalBytes <= UPLOAD_ERROR_RESPONSE_MAX_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      const remaining = UPLOAD_ERROR_RESPONSE_MAX_BYTES - (totalBytes - value.byteLength)
      if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true })
      if (totalBytes > UPLOAD_ERROR_RESPONSE_MAX_BYTES) {
        text += "… [response truncated]"
        break
      }
    }
    text += decoder.decode()
    return text
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const controller = new AbortController()
  const callerSignal = init.signal
  const relayAbort = (): void => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) relayAbort()
  else callerSignal?.addEventListener("abort", relayAbort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Upload timed out", "TimeoutError")),
    UPLOAD_REQUEST_TIMEOUT_MS
  )
  try {
    const response = await fetch(`${BASE_URL}${path}`, { ...init, signal: controller.signal })
    if (!response.ok) {
      const errorText = await readBoundedErrorText(response)
      throw new Error(`[${response.status}] ${response.statusText}: ${errorText}`)
    }

    // Upload callers only need acknowledgement. Do not buffer an arbitrary success body.
    await response.body?.cancel().catch(() => undefined)
    return { success: true } as T
  } finally {
    // Keep the deadline and caller abort relay alive until response-body processing finishes.
    // Fetch aborts an already-resolved response's body stream as well as the initial request.
    clearTimeout(timeout)
    callerSignal?.removeEventListener("abort", relayAbort)
  }
}

// ─── Threads API ──────────────────────────────────────────────────────────────

const threadsApi = {
  /**
   * 上传埋点数据文件
   * POST /threads/upload
   */
  upload(
    params: UploadThreadsParams,
    signal?: AbortSignal
  ): Promise<UploadThreadsResponse> {
    const formData = new FormData()
    formData.append('unique_id', params.unique_id)
    formData.append('file', params.file)

    return request<UploadThreadsResponse>('/api/trajectories/threads/upload', {
      method: 'POST',
      body: formData,
      signal,
      // Content-Type is set automatically by the browser for multipart/form-data
    })
  },
}

// ─── 公共上报函数 ─────────────────────────────────────────────────────────────

export interface CommitReportPayload {
  remoteUrl: string
  branch: string
  commitMessage: string
  changedFiles: unknown[]
  workspacePath: string
  commands: string[]
  commitHash?: string
}

/**
 * 将 Git 提交信息序列化为 JSON 文件并上报到 /threads/upload
 * @param uniqueId  操作唯一标识（currentOperationId）
 * @param payload   提交相关数据
 */
export async function uploadCommitData(
  uniqueId: string,
  payload: CommitReportPayload
): Promise<void> {
  const data = { ...payload, committedAt: new Date().toISOString(), ip:localStorage.getItem('localIp') }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const file = new File([blob], `git-${uniqueId}-${Date.now()}.json`, { type: "application/json" })
  await threadsApi.upload({ unique_id: uniqueId, file })
  console.log("[Upload] git提交数据已上报")
  insertLog('git提交成功')
}

export interface ChatReportPayload {
  content: string
  role: string
}

export async function uploadChatData(
  uniqueId: string,
  payload: ChatReportPayload[],
  signal?: AbortSignal
): Promise<void> {
  const data = { ...payload, chatAt: new Date().toISOString(), ip:localStorage.getItem('localIp') }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const file = new File([blob], `session-${uniqueId}-${Date.now()}.json`, { type: "application/json" })
  await threadsApi.upload({ unique_id: uniqueId, file }, signal)
  console.log("[Upload] chat数据已上报")
}

export { threadsApi }

