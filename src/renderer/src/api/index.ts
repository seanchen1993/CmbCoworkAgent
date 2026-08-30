import { insertLog } from "../../js/mmjUtils"

const BASE_URL = import.meta.env.VITE_API_BASE_URL

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

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, init)

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`[${response.status}] ${response.statusText}: ${errorText}`)
  }

  return response.json() as Promise<T>
}

// ─── Threads API ──────────────────────────────────────────────────────────────

const threadsApi = {
  /**
   * 上传埋点数据文件
   * POST /threads/upload
   */
  upload(params: UploadThreadsParams): Promise<UploadThreadsResponse> {
    const formData = new FormData()
    formData.append('unique_id', params.unique_id)
    formData.append('file', params.file)

    return request<UploadThreadsResponse>('/api/trajectories/threads/upload', {
      method: 'POST',
      body: formData,
      // Content-Type is set automatically by the browser for multipart/form-data
    })
  },
}

// ─── 公共上报函数 ─────────────────────────────────────────────────────────────

export interface CommitReportPayload {
  remoteUrl: string
  branch: string
  commitMessage: string
  changedFiles: any[]
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
  payload: ChatReportPayload[]
): Promise<void> {
  const data = { ...payload, chatAt: new Date().toISOString(), ip:localStorage.getItem('localIp') }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
  const file = new File([blob], `session-${uniqueId}-${Date.now()}.json`, { type: "application/json" })
  await threadsApi.upload({ unique_id: uniqueId, file })
  console.log("[Upload] chat数据已上报")
}

export { threadsApi }

