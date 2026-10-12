import { BotDomainError } from "../../shared/bot-types"

export interface BotNetwork {
  close(): Promise<void>
}

/** Install only in the independent Host. Node fetch, model SDKs and HTTP MCP
 * then share Undici's proxy implementation without replacing fetch/Response or
 * adding retries. Chromium keeps its separate browser network configuration. */
export async function installBotNetwork(
  environment: NodeJS.ProcessEnv = process.env
): Promise<BotNetwork | undefined> {
  const httpProxy = environment.http_proxy ?? environment.HTTP_PROXY ?? ""
  const httpsProxy = environment.https_proxy ?? environment.HTTPS_PROXY ?? ""
  if (!httpProxy && !httpsProxy) return undefined
  for (const value of [httpProxy, httpsProxy]) {
    if (!value) continue
    const url = URL.parse(value)
    let credentialsValid = true
    try {
      decodeURIComponent(url?.username ?? "")
      decodeURIComponent(url?.password ?? "")
    } catch {
      credentialsValid = false
    }
    if (
      !url ||
      !credentialsValid ||
      !["http:", "https:"].includes(url.protocol) ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new BotDomainError(
        "proxy_configuration",
        "Bot 后台代理地址无效，请检查 HTTP_PROXY / HTTPS_PROXY；支持 HTTP 或 HTTPS 代理"
      )
  }
  const { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } = await import("undici")
  const previous = getGlobalDispatcher()
  const bypass = environment.no_proxy ?? environment.NO_PROXY ?? ""
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy,
    httpsProxy,
    // Browser control and local callback traffic must never leave the machine.
    // Keep the library's whole-list wildcard semantics intact.
    noProxy: bypass.trim() === "*" ? "*" : [bypass, "localhost", "127.0.0.1", "[::1]"].join(",")
  })
  setGlobalDispatcher(dispatcher)
  let closing: Promise<void> | undefined
  return {
    close() {
      closing ??= (async () => {
        if (getGlobalDispatcher() === dispatcher) setGlobalDispatcher(previous)
        await dispatcher.destroy()
      })()
      return closing
    }
  }
}
