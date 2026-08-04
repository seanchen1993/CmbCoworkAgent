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
  if (!loginPt) throw new Error("未配置登录环境，无法刷新企业登录凭据")
  return `https://archguardservice.paas.${loginPt}.cn/cowork/login-info`
}

function httpsLoginInfoUrl(endpoint: string): URL {
  const url = new URL(endpoint)
  if (url.protocol !== "https:") throw new Error("登录凭据刷新接口必须使用 HTTPS")
  return url
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

  const url = httpsLoginInfoUrl(loginInfoEndpoint())
  const headers: Record<string, string> = {}
  if (refreshToken) headers.ystRefreshToken = refreshToken
  if (ystCode) headers.ystCode = ystCode

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ENTERPRISE_LOGIN_REFRESH_TIMEOUT_MS)
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      headers,
      signal: controller.signal
    })
    if (!response.ok) {
      console.warn("[EnterpriseLogin] token-refresh:failed", {
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
        returnCode,
        error: readString(payload, "errorMsg")
      })
      return null
    }

    const body = record(payload.body)
    if (!body) throw new Error("登录凭据刷新响应缺少 body")
    const nextUserInfo = mergeUserInfo(userInfo, body)
    upsertUserInfoConfig(nextUserInfo)
    return nextUserInfo
  } catch (error) {
    console.warn("[EnterpriseLogin] token-refresh:error", {
      aborted: error instanceof Error && error.name === "AbortError",
      message: error instanceof Error ? error.message : String(error)
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
