import type { WebContents } from "electron"
import { waitForAbort } from "../../utils/wait-for-abort"

export interface WpsDocumentReadOptions {
  textOffset?: number
  maxTextChars?: number
  signal?: AbortSignal
}

export interface WpsDocumentText {
  text: string
  totalChars: number
  textOffset: number
  nextTextOffset?: number
}

/** Shared by the workbench and the Bot's exact owned WebContents, including cross-origin frames. */
export async function readWpsDocumentText(
  contents: WebContents,
  options: WpsDocumentReadOptions = {}
): Promise<WpsDocumentText> {
  const { signal } = options
  signal?.throwIfAborted()
  const offset = options.textOffset ?? 0
  const limit = options.maxTextChars
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50_000))
  )
    throw new Error("文档读取范围无效")
  const mainFrame = contents.mainFrame
  const frames = mainFrame.framesInSubtree.filter((frame) => frame !== mainFrame)
  const prioritized = [
    ...frames.filter((frame) => frame.name === "office-iframe"),
    ...frames.filter((frame) => frame.name !== "office-iframe")
  ]
  if (!prioritized.length) throw new Error("当前页面未找到 WPS office-iframe")
  // Only fixed read-only code crosses into the page. Bound IPC/tool output for Bot reads.
  const script = `(async () => {
    const api = window.WPSOpenApi;
    if (!api?.Application?.ActiveDocument) throw new Error("WPS OpenAPI 不可用");
    const doc = await api.Application.ActiveDocument;
    const range = await doc.GetDocumentRange();
    const text = await range.Text;
    if (typeof text !== "string") throw new Error("WPS 文档正文不是文本");
    return { text: text.slice(${offset}, ${limit === undefined ? "undefined" : offset + limit}), totalChars: text.length };
  })()`
  const timeout = new AbortController()
  const readSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
  const timer = setTimeout(() => {
    timeout.abort(new Error("读取 WPS 文档超时，请等待文档加载后重试"))
  }, 10_000)
  try {
    let firstError: string | undefined
    for (const frame of prioritized) {
      readSignal.throwIfAborted()
      const url = frame.url
      try {
        const result = (await waitForAbort(frame.executeJavaScript(script), readSignal)) as {
          text: string
          totalChars: number
        }
        if (
          contents.isDestroyed() ||
          contents.mainFrame !== mainFrame ||
          frame.detached ||
          frame.url !== url
        )
          throw new Error("文档页面已改变，请重新读取")
        if (
          typeof result?.text !== "string" ||
          !Number.isSafeInteger(result.totalChars) ||
          result.totalChars < 0
        )
          throw new Error("WPS 文档正文格式无效")
        const next = offset + result.text.length
        return {
          ...result,
          textOffset: offset,
          ...(next < result.totalChars ? { nextTextOffset: next } : {})
        }
      } catch (error) {
        readSignal.throwIfAborted()
        if (
          contents.isDestroyed() ||
          contents.mainFrame !== mainFrame ||
          frame.detached ||
          frame.url !== url
        )
          throw error
        firstError ??= error instanceof Error ? error.message : "WPS OpenAPI 不可用"
      }
    }
    throw new Error(`读取 WPS 文档全文失败：${firstError ?? "WPS OpenAPI 不可用"}`)
  } finally {
    clearTimeout(timer)
  }
}
