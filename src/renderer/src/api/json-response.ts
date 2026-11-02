type JsonResponseFailure = "html" | "empty" | "invalid-json" | "invalid-shape"

function responseMime(response: Response): string {
  const value = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase()
  return value && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(value) ? value : "unknown"
}

/** Safe protocol facts only: never retain a response body, URL or parser cause. */
export class RemoteJsonResponseError extends Error {
  readonly code = "REMOTE_JSON_RESPONSE_INVALID"
  readonly status: number
  readonly redirected: boolean
  readonly mime: string

  constructor(response: Response, service: string, failure: JsonResponseFailure) {
    const reason =
      failure === "html"
        ? "返回了网页，暂时无法读取数据"
        : failure === "empty"
          ? "未返回数据"
          : "返回的数据格式异常"
    super(
      `${service}${reason}，请稍后重试或检查服务配置。${
        response.redirected ? "请求发生了跳转，可能进入了登录页。" : ""
      }`
    )
    this.name = "RemoteJsonResponseError"
    this.status = response.status
    this.redirected = response.redirected
    this.mime = responseMime(response)
  }
}

/** Parse already-read text without retaining remote bodies or parser causes. */
export function parseJsonResponse<T>(response: Response, body: string, service: string): T {
  const text = body.trim()
  if (!text) throw new RemoteJsonResponseError(response, service, "empty")
  if (responseMime(response) === "text/html" || /^<(?:!doctype\b|html\b)/i.test(text)) {
    throw new RemoteJsonResponseError(response, service, "html")
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new RemoteJsonResponseError(response, service, "invalid-json")
  }
}

/** The caller owns HTTP/authorization handling; body-read failures retain their identity. */
export async function readJsonResponse<T>(response: Response, service: string): Promise<T> {
  return parseJsonResponse<T>(response, await response.text(), service)
}
