import type { UserInfoConfig } from "../storage"

export function buildMcpUserHeaders(
  userInfo: UserInfoConfig | null | undefined
): Record<string, string> {
  return {
    yst_id_token: userInfo?.ystIdToken || "",
    sap_id: userInfo?.sapId || "",
    name: encodeURIComponent(userInfo?.userName || "")
  }
}

export function resolveMcpHeaders(options: {
  headers?: Record<string, string>
  userInfo?: UserInfoConfig | null
  injectUserHeaders?: boolean
}): Record<string, string> | undefined {
  const configuredHeaders = options.headers ?? {}
  const userHeaders =
    options.injectUserHeaders === false ? {} : buildMcpUserHeaders(options.userInfo)
  const headers = {
    ...configuredHeaders,
    ...userHeaders
  }

  return Object.keys(headers).length > 0 ? headers : undefined
}
