import {
  requirementFailure,
  type LeanstarQuery,
  type RequirementResult
} from "../../../shared/requirement-credentials"
import {
  containsRequirementCredential,
  RequirementCredentialStore,
  RequirementSecurityError
} from "./credential-store"

function fields(value: unknown, names: string[]): value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return (
    keys.length === names.length &&
    keys.every((key) => names.includes(key)) &&
    names.every((key) => typeof (value as Record<string, unknown>)[key] === "string")
  )
}
const identifier = (value: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(value)
export function parseLeanstarQuery(value: unknown): LeanstarQuery {
  const operation = (value as { operation?: unknown } | null)?.operation
  if (operation === "listDigitalProducts" || operation === "getNamespaceTree") {
    if (fields(value, ["operation"])) return value as LeanstarQuery
  } else if (operation === "listProductRequirements") {
    if (
      fields(value, ["operation", "domainId", "domainType"]) &&
      identifier(value.domainId) &&
      identifier(value.domainType)
    )
      return value as LeanstarQuery
  } else if (
    ["getImplementationDetail", "getRequirementDetail", "getRequirementDocumentContent"].includes(
      operation as string
    )
  ) {
    if (fields(value, ["operation", "code"]) && identifier(value.code))
      return value as LeanstarQuery
  }
  throw new RequirementSecurityError("INVALID_INPUT")
}
export function resolveLeanstarGateway(value: string | undefined): string {
  try {
    const configured = value?.trim() ?? ""
    const url = new URL(configured)
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      configured.includes("?") ||
      configured.includes("#")
    )
      throw new Error()
    return url.href.replace(/\/+$/, "")
  } catch {
    throw new RequirementSecurityError("GATEWAY_UNAVAILABLE")
  }
}
function buildQuery(query: LeanstarQuery): {
  endpoint: string
  method: "GET" | "POST"
  body?: string
} {
  switch (query.operation) {
    case "listDigitalProducts":
      return {
        endpoint: "/api/requirement/digital-products/person/page",
        method: "POST",
        body: JSON.stringify({ pageIndex: 1, pageSize: 50 })
      }
    case "listProductRequirements":
      return {
        endpoint: "/api/requirement/product-requirements/page",
        method: "POST",
        body: JSON.stringify({
          pageIndex: 1,
          pageSize: 15,
          domain: { id: query.domainId, type: query.domainType }
        })
      }
    case "getImplementationDetail":
      return {
        endpoint: `/api/requirement/product-requirements/${encodeURIComponent(query.code)}/impl-detail`,
        method: "GET"
      }
    case "getRequirementDetail":
      return {
        endpoint: `/api/requirement/product-requirements/${encodeURIComponent(query.code)}/detail`,
        method: "GET"
      }
    case "getRequirementDocumentContent":
      return {
        endpoint: `/api/requirement/document-content/${encodeURIComponent(query.code)}`,
        method: "GET"
      }
    case "getNamespaceTree":
      return { endpoint: "/api/leanstar/namespaces/tree", method: "GET" }
  }
}
export class LeanstarRequirementGateway {
  constructor(
    private readonly options: {
      credentials: RequirementCredentialStore
      gatewayUrl: () => string | undefined
      fetch?: typeof fetch
      timeoutMs?: number
      maxResponseBytes?: number
    }
  ) {}
  async query(payload: unknown): Promise<RequirementResult<{ data: unknown }>> {
    try {
      const query = parseLeanstarQuery(payload)
      const base = resolveLeanstarGateway(this.options.gatewayUrl())
      const status = await this.options.credentials.status()
      if (!status.success) return status
      if (!status.credentialRef) return requirementFailure("CREDENTIAL_MISSING")
      return await this.options.credentials.consume(status.credentialRef, async (token) => {
        const controller = new AbortController()
        let timeout: ReturnType<typeof setTimeout> | undefined
        try {
          const request = buildQuery(query)
          const result = (async () => {
            const response = await (this.options.fetch ?? fetch)(`${base}${request.endpoint}`, {
              method: request.method,
              ...(request.body ? { body: request.body } : {}),
              headers: { "Content-Type": "application/json", "Ls-Access-Token": token },
              redirect: "error",
              signal: controller.signal
            })
            if (response.redirected || (response.status >= 300 && response.status < 400))
              throw new RequirementSecurityError("UPSTREAM_FAILURE")
            if (response.status === 401 || response.status === 403)
              throw new RequirementSecurityError("CREDENTIAL_INVALID")
            if (!response.ok) throw new RequirementSecurityError("UPSTREAM_FAILURE")
            const limit = this.options.maxResponseBytes ?? 5 * 1024 * 1024
            if (Number(response.headers.get("content-length")) > limit)
              throw new RequirementSecurityError("RESPONSE_TOO_LARGE")
            const reader = response.body?.getReader()
            if (!reader) throw new RequirementSecurityError("INVALID_RESPONSE")
            const chunks: Uint8Array[] = []
            let size = 0
            try {
              for (;;) {
                const chunk = await reader.read()
                if (chunk.done) break
                size += chunk.value.byteLength
                if (size > limit) throw new RequirementSecurityError("RESPONSE_TOO_LARGE")
                chunks.push(chunk.value)
              }
            } finally {
              await reader.cancel().catch(() => undefined)
            }
            let data: unknown
            try {
              data = JSON.parse(Buffer.concat(chunks).toString("utf8"))
            } catch {
              throw new RequirementSecurityError("INVALID_RESPONSE")
            }
            if (containsRequirementCredential(data, token))
              throw new RequirementSecurityError("SECRET_ECHO")
            return { success: true as const, data }
          })()
          const deadline = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort()
              reject(new RequirementSecurityError("TIMEOUT"))
            }, this.options.timeoutMs ?? 15_000)
          })
          return await Promise.race([result, deadline])
        } finally {
          if (timeout) clearTimeout(timeout)
          controller.abort()
        }
      })
    } catch (error) {
      return requirementFailure(
        error instanceof RequirementSecurityError ? error.code : "NETWORK_FAILURE"
      )
    }
  }
}
