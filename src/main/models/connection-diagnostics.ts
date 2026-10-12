import { isNativeError } from "node:util/types"

const hints: Readonly<Record<string, string>> = {
  ENOTFOUND: "无法解析模型服务域名，请检查接口地址及当前网络的 DNS 配置。",
  EAI_AGAIN: "模型服务域名暂时无法解析，请检查网络后重试。",
  ECONNREFUSED: "模型服务拒绝连接，请检查服务是否启动，以及接口地址和端口。",
  ETIMEDOUT: "连接模型服务超时，请检查网络及服务状态。",
  UND_ERR_CONNECT_TIMEOUT: "连接模型服务超时，请检查网络及服务状态。",
  UND_ERR_HEADERS_TIMEOUT: "模型服务未及时响应，请检查服务状态后重试。",
  UND_ERR_BODY_TIMEOUT: "等待模型响应内容超时，请检查网络及服务状态。",
  ECONNRESET: "模型连接意外断开，请检查网络及服务状态后重试。",
  EPIPE: "模型连接意外断开，请检查网络及服务状态后重试。",
  UND_ERR_SOCKET: "模型连接意外断开，请检查网络及服务状态后重试。",
  CERT_HAS_EXPIRED: "模型服务证书已过期，请检查系统时间，并联系服务管理员更新证书。",
  CERT_NOT_YET_VALID: "模型服务证书尚未生效，请检查系统时间及服务证书。",
  ERR_TLS_CERT_ALTNAME_INVALID: "模型服务证书与接口域名不匹配，请检查接口地址及服务证书。",
  DEPTH_ZERO_SELF_SIGNED_CERT: "无法验证模型服务证书，请联系管理员配置可信证书。",
  SELF_SIGNED_CERT_IN_CHAIN: "无法验证模型服务证书，请联系管理员配置可信证书。",
  UNABLE_TO_GET_ISSUER_CERT: "无法验证模型服务证书，请联系管理员配置可信证书。",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "无法验证模型服务证书，请联系管理员配置可信证书。",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证模型服务证书，请联系管理员配置可信证书。",
  CERT_UNTRUSTED: "无法验证模型服务证书，请联系管理员配置可信证书。"
}

/** Only for errors caught at the native transport boundary. Never interpret a
 * provider response body as a network error or return its message/URL/headers. */
export function modelConnectionHint(error: unknown): string | undefined {
  const pending: unknown[] = [error]
  const visited = new Set<Error>()
  for (let index = 0; index < pending.length && index < 32; index++) {
    const current = pending[index]
    if (!isNativeError(current) || visited.has(current)) continue
    visited.add(current)
    const { code, cause, errors } = current as Error & { code?: unknown; errors?: unknown }
    if (typeof code === "string" && Object.hasOwn(hints, code)) return hints[code]
    if (pending.length < 32) pending.push(cause)
    // Node may report all attempted network addresses in an AggregateError.
    if (Array.isArray(errors)) {
      for (let child = 0; child < errors.length && pending.length < 32; child++)
        pending.push(errors[child])
    }
  }
  return undefined
}
