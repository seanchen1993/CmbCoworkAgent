import { readTweakDeclaration } from "../../../shared/design-tweaks"

export interface DesignBrowserValidationIssue {
  type: "console" | "load" | "crash" | "timeout" | "structure" | "style" | "interaction"
  message: string
  source?: string
  line?: number
  column?: number
  stack?: string
  selector?: string
}

export interface DesignBrowserValidationResult {
  ok: boolean
  issues: DesignBrowserValidationIssue[]
}

interface ValidationSource {
  html: string
  filePath: string
  validationHtml?: string
  validationPath?: string
}

/** Capture the error's location, rather than the console.log location in our probe. */
export function parseDesignBrowserRuntimeIssue(
  message: string,
  fallback: { source?: string; line?: number } = {}
): DesignBrowserValidationIssue | undefined {
  const match = message.match(/^\[DesignValidation(?:Error|UnhandledRejection)\]\s*(.*)$/i)
  if (!match) return undefined
  try {
    const detail: unknown = JSON.parse(match[1])
    if (
      detail &&
      typeof detail === "object" &&
      "message" in detail &&
      typeof detail.message === "string"
    ) {
      const value = detail as Record<string, unknown>
      const stack = typeof value.stack === "string" ? value.stack : undefined
      const frame = stack?.match(/((?:file|https?):\/\/[^\n)]+?):(\d+):(\d+)/)
      return {
        type: "console",
        message: detail.message,
        source: typeof value.source === "string" && value.source ? value.source : frame?.[1],
        line:
          typeof value.line === "number" && value.line > 0
            ? value.line
            : frame
              ? Number(frame[2])
              : undefined,
        column:
          typeof value.column === "number" && value.column > 0
            ? value.column
            : frame
              ? Number(frame[3])
              : undefined,
        stack
      }
    }
  } catch {
    /* Older validation probes logged plain text. */
  }
  return { type: "console", message: match[1]?.trim() || message, ...fallback }
}

export function injectDesignBrowserValidationProbe(html: string): string {
  const probe = `<script>window.addEventListener('error',function(e){console.error('[DesignValidationError] '+JSON.stringify({message:e.message||'Unknown runtime error',source:e.filename||'',line:e.lineno,column:e.colno,stack:e.error&&e.error.stack||''}));});window.addEventListener('unhandledrejection',function(e){var r=e.reason;console.error('[DesignValidationUnhandledRejection] '+JSON.stringify({message:r&&r.message||String(r||'Unhandled promise rejection'),stack:r&&r.stack||''}));});</script>`
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>\n${probe}`)
  if (/<html[^>]*>/i.test(html))
    return html.replace(/<html([^>]*)>/i, `<html$1>\n<head>\n${probe}\n</head>`)
  return `${probe}\n${html}`
}

function sourceExcerpt(html: string, line: number, column?: number): string {
  const lines = html.split("\n")
  if (line < 1 || line > lines.length) return ""
  return lines
    .slice(Math.max(0, line - 2), line + 1)
    .map((text, i) => {
      const number = Math.max(1, line - 1) + i
      const start = number === line && column ? Math.max(0, column - 180) : 0
      return `${number}: ${start ? "…" : ""}${text.slice(start, start + 650)}`
    })
    .join("\n")
}

function diagnosticContext(issue: DesignBrowserValidationIssue, source: ValidationSource): string {
  const lines = source.html.split("\n")
  const contexts: string[] = []
  const addLine = (line: number, column?: number) => {
    const excerpt = sourceExcerpt(source.html, line, column)
    if (excerpt && !contexts.includes(excerpt)) contexts.push(excerpt)
  }
  if (issue.type === "style" && issue.selector) {
    const line = lines.findIndex((text) => text.includes(issue.selector!))
    if (line >= 0) addLine(line + 1)
    return `定位：${source.filePath}${line >= 0 ? `:${line + 1}` : ""}；选择器 ${issue.selector}\n${contexts.join("\n")}`
  }
  const missingVariable = issue.message.match(/^(\S+) 未引用 CSS 变量 (--[\w-]+)$/)
  if (missingVariable) {
    const [, key, variable] = missingVariable
    const value = readTweakDeclaration(source.html)?.defaults[key]
    const definition = lines.findIndex((line) => line.includes(variable))
    if (definition >= 0) addLine(definition + 1)
    if (typeof value === "string" && value.length) {
      for (const style of source.html.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)) {
        let index = style[0].indexOf(value)
        while (index >= 0 && contexts.length < 3) {
          const line = source.html.slice(0, style.index! + index).split("\n").length
          if (line !== definition + 1) addLine(line)
          index = style[0].indexOf(value, index + value.length)
        }
      }
    }
    return `定位：${source.filePath}\n${contexts.join("\n...\n")}\n修复要求：参数 ${key} 绑定 ${variable}，但样式未使用它。把对应的现有样式值改为 var(${variable})，使该参数实际控制页面；保留其他参数与布局。`
  }

  const tweakKey = issue.message.match(
    /^(\S+) (?:缺少绑定节点|文本目标必须为叶子节点|绑定选择器无效)/
  )?.[1]
  if (tweakKey) {
    const bindings = readTweakDeclaration(source.html)?.bindings[tweakKey] ?? []
    const selectors = bindings.flatMap((binding) =>
      "selector" in binding ? [binding.selector] : []
    )
    for (const selector of selectors) {
      const line = lines.findIndex(
        (text) => text.includes(selector) || text.includes(`id="${selector.slice(1)}"`)
      )
      if (line >= 0 && contexts.length < 3) addLine(line + 1)
    }
    return `定位：${source.filePath}；参数 ${tweakKey}，选择器 ${selectors.join("、")}\n${contexts.join("\n...\n")}\n修复要求：修正这些绑定与目标节点；文本绑定必须指向不包含子元素的文字节点。保留其他绑定和业务交互。`
  }

  if (issue.line) {
    let localSource = issue.source ?? ""
    try {
      localSource = decodeURIComponent(localSource.replace(/^file:\/\//, ""))
    } catch {
      /* Keep raw source. */
    }
    if (source.validationHtml && source.validationPath && localSource === source.validationPath) {
      const text = source.validationHtml.split("\n")[issue.line - 1]
      const matches = text?.trim()
        ? lines.flatMap((line, index) => (line === text ? [index + 1] : []))
        : []
      if (matches.length === 1) {
        addLine(matches[0], issue.column)
        return `原始源码定位：${source.filePath}:${matches[0]}\n${contexts[0]}`
      }
      return `校验副本定位：${source.validationPath}:${issue.line}\n${sourceExcerpt(source.validationHtml, issue.line, issue.column)}\n修改目标仍为修复草稿；上面的行号属于宿主注入运行时后的校验副本。`
    }
    if (!localSource || localSource === source.filePath) {
      addLine(issue.line, issue.column)
      if (contexts.length) return `定位：${source.filePath}:${issue.line}\n${contexts[0]}`
    }
  }
  return ""
}

export function formatDesignBrowserValidation(
  result: DesignBrowserValidationResult,
  source?: ValidationSource
): string {
  if (!result.issues.length) return "浏览器运行校验通过"
  return result.issues
    .map((issue, index) => {
      const location = issue.source
        ? ` (${issue.source}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""})`
        : ""
      const context = source && index < 8 ? diagnosticContext(issue, source) : ""
      const stack = issue.stack
        ? `\n${issue.stack.split("\n").slice(0, 4).join("\n").slice(0, 1200)}`
        : ""
      return `${index + 1}. [${issue.type}] ${issue.message}${location}${context ? `\n${context}` : ""}${stack}`
    })
    .join("\n\n")
}

export const DESIGN_VALIDATION_REPAIR_SYSTEM_PROMPT = `You repair a completed Design HTML artifact using the host's concrete validation report. The host has already located the failures and prepared a complete repair draft. Edit only the reported faults and their necessary dependencies with edit_file. Preserve the current layout, content, stable IDs, business interactions, frameworks and valid Tweaks bindings. Do not rebuild a scaffold, re-read requirements, redesign the page, run browser audits or add features. Use the supplied code locations and excerpts; use bounded read_file only when more local context is necessary. After the edits, finish with a brief Chinese summary; the host reruns validation. Follow tool schemas, hooks, approvals and cancellation.`

export function buildDesignValidationRepairPrompt(report: string, artifactPath: string): string {
  return `[Design validation failed]\n宿主已检查并定位以下失败项，请直接按报告修复，无需重新排查整页或重读需求。\n\n${report}\n\nDESIGN ARTIFACT FILE\n${artifactPath}\n宿主已将完整失败页面复制到此修复草稿，文件已存在。只用 edit_file 修改这个路径，保留未涉及的内容和交互。报告中的原始源码/校验副本仅用于定位，不要修改这些参考文件。不需要重写完整 HTML 或再次搭骨架。需要更多上下文时，仅对相关行使用 read_file({file_path,offset,limit})。完成后简短说明，宿主会重新执行校验。`
}
