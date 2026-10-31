import {
  readRawTweakDeclaration,
  readTweakDeclaration,
  type TweakSourceDiagnostic
} from "../../../shared/design-tweaks"

export interface DesignBrowserValidationIssue extends Omit<TweakSourceDiagnostic, "message"> {
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
  repairTargetPath?: string
}

function sameSourcePath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    try {
      value = decodeURIComponent(value)
    } catch {
      /* Keep raw source. */
    }
    value = value
      .replace(/^file:\/\//i, "")
      .replace(/\\/g, "/")
      .replace(/^\/(?=[a-z]:\/)/i, "")
    return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value
  }
  return normalize(left) === normalize(right)
}

function rawParameterContext(value: unknown, key: string): string {
  const raw = value as Record<string, Record<string, unknown>> | undefined
  if (!raw || typeof raw !== "object") return ""
  return `原始参数声明：${JSON.stringify({ key, default: raw.defaults?.[key], schema: raw.schema?.[key], bindings: raw.bindings?.[key] }).slice(0, 2200)}`
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

function diagnosticContext(
  issue: DesignBrowserValidationIssue,
  source: ValidationSource,
  raw: unknown,
  declaration: ReturnType<typeof readTweakDeclaration>
): string {
  const target = source.repairTargetPath ?? source.filePath
  const lines = source.html.split("\n")
  const contexts: string[] = []
  const addLine = (line: number, column?: number) => {
    const excerpt = sourceExcerpt(source.html, line, column)
    if (excerpt && !contexts.includes(excerpt)) contexts.push(excerpt)
  }
  if (issue.type === "style" && issue.selector) {
    const line = lines.findIndex((text) => text.includes(issue.selector!))
    if (line >= 0) addLine(line + 1)
    return `定位：${target}${line >= 0 ? `:${line + 1}` : ""}；选择器 ${issue.selector}\n${contexts.join("\n")}`
  }
  if (issue.fieldPath) {
    return `定位：${target}${issue.line ? `:${issue.line}（Tweaks 声明块起始行）` : ""}\n字段：${issue.fieldPath}\n当前值：${issue.actual}\n修复要求：${issue.expected}\n${issue.tweakKey ? rawParameterContext(raw, issue.tweakKey) : ""}\n直接修正上述 JSON 字段；新增 DOM 节点不能修复类型、默认值范围或选择器语法错误。`
  }
  const missingVariable = issue.message.match(/^(\S+) 未引用 CSS 变量 (--[\w-]+)$/)
  if (missingVariable) {
    const [, key, variable] = missingVariable
    const value = declaration?.defaults[key]
    const definition = lines.findIndex((line) => line.includes(variable))
    if (definition >= 0) addLine(definition + 1, lines[definition].indexOf(variable) + 1)
    const jsRead = lines.findIndex((line) =>
      new RegExp(`getPropertyValue\\s*\\(\\s*['"]${variable}['"]\\s*\\)`).test(line)
    )
    if (jsRead >= 0) addLine(jsRead + 1, lines[jsRead].indexOf("getPropertyValue") + 1)
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
    return `定位：${target}\n${contexts.join("\n...\n")}\n${rawParameterContext(raw, key)}\n修复要求：参数 ${key} 绑定 ${variable}，但样式未使用它。若它控制真实视觉样式，把对应的现有样式值改为 var(${variable})。${jsRead >= 0 ? `已定位 JS 对该变量的读取（见上方），仅由 JS 读取不等于受支持的实时视觉绑定。` : ""}若它是数量上限等业务配置，则从 defaults、schema、bindings 三处同时移除该微调参数，保留原 CSS 变量值与业务 JS。不要为过检将它绑定到无关样式，也不要删除业务功能。`
  }

  const tweakKey = issue.message.match(
    /^(\S+) (?:缺少绑定节点|文本目标必须为叶子节点|绑定选择器无效)/
  )?.[1]
  if (tweakKey) {
    const bindings = declaration?.bindings[tweakKey] ?? []
    const selectors = bindings.flatMap((binding) =>
      "selector" in binding ? [binding.selector] : []
    )
    for (const selector of selectors) {
      const line = lines.findIndex(
        (text) => text.includes(selector) || text.includes(`id="${selector.slice(1)}"`)
      )
      if (line >= 0 && contexts.length < 3) addLine(line + 1)
    }
    return `定位：${target}；参数 ${tweakKey}，选择器 ${selectors.join("、")}\n${contexts.join("\n...\n")}\n${rawParameterContext(raw, tweakKey)}\n修复要求：绑定到实际用于页面或弹窗的稳定 DOM 节点；文本目标不能包含子元素，不能只存在于 innerHTML 字符串中，也不能在后续交互中被 innerHTML 销毁。弹窗可预置真实内容节点并切换显示；不要新增永不使用的隐藏节点凑数。保留其他绑定和业务交互。`
  }

  if (issue.line) {
    const localSource = issue.source ?? ""
    if (
      source.validationHtml &&
      source.validationPath &&
      sameSourcePath(localSource, source.validationPath)
    ) {
      const text = source.validationHtml.split("\n")[issue.line - 1]
      const matches = text?.trim()
        ? lines.flatMap((line, index) => (line === text ? [index + 1] : []))
        : []
      if (matches.length === 1) {
        addLine(matches[0], issue.column)
        return `原始源码定位：${target}:${matches[0]}\n${contexts[0]}`
      }
      return `${source.repairTargetPath ? "校验时源码片段" : `校验副本定位：${source.validationPath}`}:${issue.line}\n${sourceExcerpt(source.validationHtml, issue.line, issue.column)}\n修改目标为 ${target}；上面的行号属于宿主注入运行时后的校验副本，不能直接用作修复草稿行号。无需读取校验副本。`
    }
    if (!localSource || sameSourcePath(localSource, source.filePath)) {
      addLine(issue.line, issue.column)
      if (contexts.length) return `定位：${target}:${issue.line}\n${contexts[0]}`
    }
  }
  return ""
}

export function formatDesignBrowserValidation(
  result: DesignBrowserValidationResult,
  source?: ValidationSource
): string {
  if (!result.issues.length) return "浏览器运行校验通过"
  const raw = source ? readRawTweakDeclaration(source.html) : undefined
  const declaration = source ? readTweakDeclaration(source.html) : null
  return result.issues
    .map((issue, index) => {
      const internalSource =
        source &&
        issue.source &&
        [source.filePath, source.validationPath].some((p) => p && sameSourcePath(issue.source!, p))
      const location =
        source?.repairTargetPath && internalSource
          ? "（页面内部错误，见下方片段）"
          : issue.source
            ? ` (${issue.source}${issue.line ? `:${issue.line}${issue.column ? `:${issue.column}` : ""}` : ""})`
            : ""
      const context = source && index < 8 ? diagnosticContext(issue, source, raw, declaration) : ""
      // Internal stack frame line numbers belong to the injected copy. The supplied
      // excerpt is safer than exposing another readable draft path to the model.
      const stackLines = issue.stack
        ?.split("\n")
        .filter(
          (line) =>
            !source?.repairTargetPath ||
            ![source.filePath, source.validationPath].some(
              (p) => p && stackLineContainsPath(line, p)
            )
        )
      const stack = stackLines?.length
        ? `\n${stackLines.slice(0, 4).join("\n").slice(0, 1200)}`
        : ""
      return `${index + 1}. [${issue.type}] ${issue.message}${location}${context ? `\n${context}` : ""}${stack}`
    })
    .join("\n\n")
}

function stackLineContainsPath(line: string, filePath: string): boolean {
  try {
    line = decodeURIComponent(line)
  } catch {
    /* Keep raw frame. */
  }
  line = line.replace(/\\/g, "/")
  filePath = filePath.replace(/\\/g, "/")
  return /^[a-z]:\//i.test(filePath)
    ? line.toLowerCase().includes(filePath.toLowerCase())
    : line.includes(filePath)
}

export const DESIGN_VALIDATION_REPAIR_SYSTEM_PROMPT = `You repair a completed Design HTML artifact using the host's concrete validation report. The host has already located the failures and prepared ONE complete repair draft. Only read/search/edit this target; do not list directories or compare draft copies. Edit only the reported faults and their necessary dependencies with edit_file. Preserve the current layout, content, stable IDs, business interactions, frameworks and valid Tweaks bindings. Do not rebuild a scaffold, re-read requirements, redesign the page, run browser audits or add features. Use the supplied raw JSON fields, code locations and excerpts to edit directly; use bounded read_file only when more local context is necessary. Do not repeatedly search once the fault is located. After actual edits, finish with a brief Chinese summary saying 修复已提交，等待宿主复检; only the host can confirm validation success. Follow tool schemas, hooks, approvals and cancellation.`

export function buildDesignValidationRepairPrompt(report: string, artifactPath: string): string {
  return `[Design validation failed]\n唯一修复目标（文件已存在）：\n${artifactPath}\n宿主已检查并定位以下失败项，请直接按报告修复，无需重新排查整页或重读需求。\n\n${report}\n\n只对上述唯一目标使用 edit_file，保留未涉及的内容和交互。不要列目录、寻找或比较其他 .draft 文件，不需要重写完整 HTML 或再次搭骨架。需要更多上下文时，仅对此目标的相关行使用 read_file({file_path,offset,limit})，或对此文件进行定向搜索。定位后立即编辑，连续只读而无写入将被停止。实际修改后简短说明“修复已提交，等待宿主复检”，宿主会重新执行校验。`
}
