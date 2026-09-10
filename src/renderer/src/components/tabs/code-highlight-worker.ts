import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core"
import { createJavaScriptRegexEngine } from "shiki/engine/javascript"
import langTypescript from "shiki/langs/typescript.mjs"
import langTsx from "shiki/langs/tsx.mjs"
import langJavascript from "shiki/langs/javascript.mjs"
import langJsx from "shiki/langs/jsx.mjs"
import langPython from "shiki/langs/python.mjs"
import langJson from "shiki/langs/json.mjs"
import langCss from "shiki/langs/css.mjs"
import langHtml from "shiki/langs/html.mjs"
import langMarkdown from "shiki/langs/markdown.mjs"
import langYaml from "shiki/langs/yaml.mjs"
import langBash from "shiki/langs/bash.mjs"
import langSql from "shiki/langs/sql.mjs"

interface HighlightRequest {
  type: "highlight"
  requestId: number
  content: string
  language: string
}

interface CancelRequest {
  type: "cancel"
  requestId: number
}

let highlighterPromise: Promise<HighlighterCore> | null = null
const cancelled = new Set<number>()
const MAX_HIGHLIGHT_HTML_CHARS = 512 * 1024
const appSyntaxTheme = createCssVariablesTheme({
  name: "cmbdevclaw",
  variablePrefix: "--shiki-"
})

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [appSyntaxTheme],
      langs: [
        langTypescript,
        langTsx,
        langJavascript,
        langJsx,
        langPython,
        langJson,
        langCss,
        langHtml,
        langMarkdown,
        langYaml,
        langBash,
        langSql
      ],
      engine: createJavaScriptRegexEngine()
    })
  }
  return highlighterPromise
}

self.onmessage = (event: MessageEvent<HighlightRequest | CancelRequest>): void => {
  const request = event.data
  if (request.type === "cancel") {
    cancelled.add(request.requestId)
    setTimeout(() => cancelled.delete(request.requestId), 60_000)
    return
  }
  void (async () => {
    try {
      const highlighter = await getHighlighter()
      if (cancelled.delete(request.requestId)) return
      const html = highlighter.codeToHtml(request.content, {
        lang: request.language,
        theme: "cmbdevclaw"
      })
      if (cancelled.delete(request.requestId)) return
      if (html.length > MAX_HIGHLIGHT_HTML_CHARS) {
        throw new Error("Highlighted preview exceeded its response budget")
      }
      self.postMessage({ type: "result", requestId: request.requestId, ok: true, html })
    } catch (error) {
      self.postMessage({
        type: "result",
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })()
}
