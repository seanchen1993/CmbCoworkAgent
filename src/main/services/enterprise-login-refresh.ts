import { net } from "electron"
import { getUserInfo, upsertUserInfoConfig, type UserInfoConfig } from "../storage"

const ENTERPRISE_LOGIN_REFRESH_TIMEOUT_MS = 15_000

// A desktop process has a single signed-in enterprise user. Share one refresh
// across every main-process consumer so simultaneous 401s cannot stampede the
// login-info endpoint or race while rotating the refresh token.
let enterpriseLoginRefreshPromise: Promise<UserInfoConfig | null> | null = null

function loginInfoEndpoint(): string {
  const viteEnv = (import.meta.env ?? {}) as Record<string, string | undefined>
  const configured = viteEnv.VITE_LOGIN_INFO_ENDPOINT?.trim() || process.env.CMB_LOGIN_INFO_ENDPOINT
  if (configured?.trim()) return configured.trim()

  const loginPt = viteEnv.VITE_LOGIN_PT?.trim() || process.env.VITE_LOGIN_PT?.trim()
  if (!loginPt) throw new Error("未配置登录环境，无法刷新登录凭据")
  return `https://archguardservice.paas.${loginPt}.cn/cowork/login-info`
}

function httpsLoginInfoUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== "https:") throw new Error("登录凭据刷新接口必须使用 HTTPS")
  return url
}

function loginInfoFetch(
  input: string,
  init: RequestInit
): Promise<Response> {
  // Electron's net.fetch uses Chromium's network stack, matching the Personal
  // Info page. That matters on the intranet where system proxy/PAC, DNS and
  // enterprise certificate handling can differ from Node's built-in fetch.
  if (process.versions.electron) {
    return net.fetch(input, init)
  }
  // Keep the module testable in a plain Node process.
  return globalThis.fetch(input, init)
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key]
  if (typeof candidate === "string") return candidate.trim() || undefined
  if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate)
  return undefined
}

function mergeUserInfo(current: UserInfoConfig, body: Record<string, unknown>): UserInfoConfig {
  const nextIdToken = readString(body, "ystIdToken")
  const nextAccessToken = readString(body, "ystAccessToken")
  if (!nextIdToken && !nextAccessToken) {
    throw new Error("登录凭据刷新响应缺少有效 Token")
  }

  return {
    ...current,
    sapId: readString(body, "sapId") || current.sapId,
    ystId: readString(body, "ystId") || current.ystId,
    userName: readString(body, "userName") || current.userName,
    originOrgId: readString(body, "originOrgId") || current.originOrgId,
    orgName: readString(body, "orgName") || current.orgName,
    pathName: readString(body, "pathName") || current.pathName,
    upperOrgLv1: readString(body, "upperOrgLv1") || current.upperOrgLv1,
    originPathId: readString(body, "originPathId") || current.originPathId,
    ystRefreshToken: readString(body, "ystRefreshToken") || current.ystRefreshToken,
    ystIdToken: nextIdToken || current.ystIdToken,
    ystCode: readString(body, "ystCode") || current.ystCode,
    ystAccessToken: nextAccessToken || current.ystAccessToken
  }
}

async function requestEnterpriseLoginRefresh(
  userInfo: UserInfoConfig
): Promise<UserInfoConfig | null> {
  const refreshToken = userInfo.ystRefreshToken?.trim()
  const ystCode = userInfo.ystCode?.trim()
  if (!refreshToken && !ystCode) {
    console.warn("[EnterpriseLogin] token-refresh:missing-refresh-token")
    return null
  }

  const headers: Record<string, string> = {}
  if (refreshToken) headers.ystRefreshToken = refreshToken
  if (ystCode) headers.ystCode = ystCode

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_LOGIN_REFRESH_TIMEOUT_MS)
  try {
    const url = httpsLoginInfoUrl(loginInfoEndpoint())
    const transport = process.versions.electron ? "electron-net" : "node-fetch"
    console.info("[EnterpriseLogin] token-refresh:request", {
      transport,
      endpoint: `${url.origin}${url.pathname}`
    })
    const response = await loginInfoFetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    })
    if (!response.ok) {
      console.warn("[EnterpriseLogin] token-refresh:failed", {
        transport,
        status: response.status,
        statusText: response.statusText
      })
      return null
    }

    const payload = record(await response.json())
    if (!payload) throw new Error("登录凭据刷新响应格式异常")
    const returnCode = readString(payload, "returnCode")
    if (returnCode !== "SUC0000") {
      console.warn("[EnterpriseLogin] token-refresh:business-failed", {
        transport,
        returnCode,
        error: readString(payload, "errorMsg")
      })
      return null
    }

    const body = record(payload.body)
    if (!body) throw new Error("登录凭据刷新响应缺少 body")
    const nextUserInfo = mergeUserInfo(userInfo, body)
    upsertUserInfoConfig(nextUserInfo)
    console.info("[EnterpriseLogin] token-refresh:succeeded", { transport })
    return nextUserInfo
  } catch (error) {
    console.warn("[EnterpriseLogin] token-refresh:error", {
      transport: process.versions.electron ? "electron-net" : "node-fetch",
      aborted: error instanceof Error && error.name === "AbortError",
      reasonType: error instanceof Error ? error.name : typeof error,
      message: error instanceof Error ? error.message : String(error),
      causeType:
        error instanceof Error && error.cause instanceof Error ? error.cause.name : undefined,
      causeMessage:
        error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined
    })
    return null
  } finally {
    clearTimeout(timeout)
  }
}

export async function refreshEnterpriseLogin(
  userInfo: UserInfoConfig | null = getUserInfo()
): Promise<UserInfoConfig | null> {
  if (!userInfo) return null
  if (!enterpriseLoginRefreshPromise) {
    enterpriseLoginRefreshPromise = requestEnterpriseLoginRefresh(userInfo).finally(() => {
      enterpriseLoginRefreshPromise = null
    })
  }
  return enterpriseLoginRefreshPromise
}
