function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
}

export function isImGatewayUrlAllowed(value: string): boolean {
  try {
    const url = new URL(value)
    const allowedTransport =
      url.protocol === "wss:" || (url.protocol === "ws:" && isLocalHostname(url.hostname))
    return allowedTransport && !url.username && !url.password && !url.hash
  } catch {
    return false
  }
}

export function normalizeImGatewayUrlOverride(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (!trimmed) throw new Error("统一机器人网关地址不能为空；如需恢复默认地址，请点击恢复默认。")

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error("统一机器人网关地址格式无效。")
  }

  const localWs = url.protocol === "ws:" && isLocalHostname(url.hostname)
  if (url.protocol !== "wss:" && !localWs) {
    throw new Error("统一机器人网关必须使用 WSS（仅本机联调允许 WS）。")
  }
  if (url.username || url.password || url.hash) {
    throw new Error("统一机器人网关地址不能包含用户名、密码或片段。")
  }
  return trimmed
}
