import { randomUUID } from "node:crypto"
import { IDLE_MODEL_MODE, isValidSapId, type ModelTransport } from "../../shared/model-catalog"
import { getUserInfo } from "../storage"

interface ModelConnectionConfig {
  baseUrl: string
  apiKey?: string
  transport?: ModelTransport
}

interface ModelConnectionOptions {
  sessionId?: string
  fetch?: typeof fetch
}

export function getModelClientOptions(
  config: ModelConnectionConfig,
  options: ModelConnectionOptions = {}
) {
  return {
    configuration: getModelConnection(config, options),
    ...(config.transport === "idle-gateway" ? { maxRetries: 0 } : {})
  }
}

export function requireIdleModelSapId(): string {
  const sapId = getUserInfo()?.sapId
  if (!isValidSapId(sapId)) {
    throw new Error("闲时模型需要当前登录用户的八位 SAP 员工编号，请完善用户信息后重试。")
  }
  return sapId.trim()
}

/** Shared by agent, compaction, background calls, and the connection test. */
export function getModelConnection(
  config: ModelConnectionConfig,
  options: ModelConnectionOptions = {}
): { baseURL: string; fetch?: typeof fetch } {
  if (config.transport !== "idle-gateway") {
    return { baseURL: config.baseUrl, ...(options.fetch ? { fetch: options.fetch } : {}) }
  }
  requireIdleModelSapId()
  if (!config.apiKey) throw new Error("闲时模型网关密钥未配置")
  const sessionId = options.sessionId || randomUUID()
  const send = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  return {
    baseURL: config.baseUrl,
    fetch: async (input, init) => {
      let sapId: string
      try {
        sapId = requireIdleModelSapId()
      } catch (error) {
        // A local identity failure is a bad request, not a retryable network error.
        return new Response(
          JSON.stringify({
            error: {
              message: error instanceof Error ? error.message : "缺少八位 SAP 员工编号",
              type: "invalid_request_error",
              code: "sap_id_required"
            }
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
      }
      const headers = new Headers(
        init?.headers ?? (input instanceof Request ? input.headers : undefined)
      )
      headers.delete("Authorization")
      headers.set("x-gateway-key", config.apiKey!)
      headers.set("x-spaid", sapId)
      headers.set("x-session-id", sessionId)
      headers.set("x-request-id", randomUUID())
      let body = init?.body
      if (typeof body === "string") {
        const payload = JSON.parse(body)
        payload.model = IDLE_MODEL_MODE
        body = JSON.stringify(payload)
      }
      const response = await send(input, { ...init, headers, body })
      if (response.ok) return response
      // Preserve gateway details for SDK consumers that only understand error.message.
      try {
        const payload = await response.clone().json()
        if (typeof payload.errorMsg !== "string" || payload.error) return response
        const responseHeaders = new Headers(response.headers)
        responseHeaders.delete("content-length")
        responseHeaders.delete("content-encoding")
        return new Response(
          JSON.stringify({
            ...payload,
            error: { message: payload.errorMsg, code: payload.returnCode, type: "gateway_error" }
          }),
          { status: response.status, statusText: response.statusText, headers: responseHeaders }
        )
      } catch {
        return response
      }
    }
  }
}
