
export const BROWSER_TOOL_LABELS: Record<string, string> = {
  mcp__node_repl__js: "内置浏览器：脚本执行"
}

type BrowserActionLabelRule = {
  label: string
  pattern: RegExp
}

const BROWSER_ACTION_LABEL_RULES: BrowserActionLabelRule[] = [
  { label: "脚本执行", pattern: /\.(?:evaluate|evaluateOnPlaywright)\s*\(/g },
  { label: "启动", pattern: /\bsetupBrowserRuntime|setup\s*\(/g },
  { label: "能力列表", pattern: /\.capabilities\.list\s*\(/g },
  { label: "能力详情", pattern: /\.capabilities\.get\s*\(/g },
  { label: "打开链接", pattern: /\.(?:goto|goTo)\s*\(/g },
  { label: "点击", pattern: /\.(?:click|setChecked|check|uncheck|downloadMedia)\s*\(/g },
  { label: "双击", pattern: /\.dblclick\s*\(/g },
  { label: "输入", pattern: /\.(?:fill|type)\s*\(/g },
  { label: "按键", pattern: /\.press\s*\(/g },
  { label: "选择", pattern: /\.selectOption\s*\(/g },
  { label: "截图", pattern: /\.(?:screenshot|elementScreenshot)\s*\(/g },
  { label: "下载", pattern: /\.(?:downloadMedia|path)\s*\(/g },
  { label: "页面快照", pattern: /\.domSnapshot\s*\(/g },
  {
    label: "等待",
    pattern: /\.(?:waitFor|waitForURL|waitForLoadState|waitForTimeout|waitForEvent)\s*\(/g
  },
  {
    label: "读取",
    pattern: /\.(?:textContent|innerText|allTextContents|getAttribute|readAll|title|url)\s*\(/g
  },
  { label: "检查", pattern: /\.(?:isVisible|isEnabled|count|elementInfo)\s*\(/g }
]

function collectBrowserAction(code: string): string | null {
  for (const { label, pattern } of BROWSER_ACTION_LABEL_RULES) {
    const regex = new RegExp(pattern.source, pattern.flags)
    if (regex.test(code)) return label
  }

  return null
}

export function getNodeReplChineseLabel(args: Record<string, unknown> | undefined): string {
  const code = typeof args?.code === "string" ? args.code : ""
  if (!code) return BROWSER_TOOL_LABELS.mcp__node_repl__js

  const action = collectBrowserAction(code)
  if (!action) return BROWSER_TOOL_LABELS.mcp__node_repl__js
  return `内置浏览器：${action}`
}
