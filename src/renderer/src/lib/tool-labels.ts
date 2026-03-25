const TOOL_LABELS: Record<string, string> = {
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  execute: "执行命令",
  ls: "列出目录",
  glob: "查找文件",
  grep: "搜索内容",
  write_todos: "更新任务",
  task: "子任务执行",
  git_workflow: "Git 代码批量提交（点击展开）",
  git_push: "Git 推送",
  agent_browser: "Agent Browser 浏览器操作",
  browser_playwright: "Playwright 浏览器操作",
  mcp_call: "调用 MCP 工具",
  search_tool: "搜索 MCP 工具",
  load_tool: "加载 MCP 工具",
  computer: "Chrome 计算机操作",
  computer_use: "Chrome 计算机操作",
  chrome_computer: "Chrome 计算机操作",
  chrome_computer_use: "Chrome 计算机操作",
  chrome_read_page: "Chrome 读取页面",
  chrome_get_web_content: "Chrome 获取网页内容",
  chrome_get_interactive_elements: "Chrome 获取可交互元素",
  chrome_navigate: "Chrome 页面跳转",
  chrome_go_back_or_forward: "Chrome 前进后退",
  chrome_click_element: "Chrome 点击元素",
  chrome_hover_element: "Chrome 悬停元素",
  chrome_type_text: "Chrome 输入文本",
  chrome_fill_or_select: "Chrome 填写或选择",
  chrome_press_key: "Chrome 按键操作",
  chrome_take_screenshot: "Chrome 页面截图",
  chrome_snapshot: "Chrome 页面快照",
  chrome_scroll_to: "Chrome 页面滚动",
  chrome_scroll_to_text: "Chrome 文本定位滚动",
  chrome_wait_for: "Chrome 等待条件",
  chrome_new_tab: "Chrome 新建标签页",
  chrome_switch_tab: "Chrome 切换标签页",
  chrome_close_tab: "Chrome 关闭标签页",
  chrome_upload_file: "Chrome 上传文件",
  chrome_download_file: "Chrome 下载文件"
}

function titleCaseWords(text: string): string {
  return text
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function formatMappedLabel(toolName: string, chineseLabel: string): string {
  return `${chineseLabel}（${toolName}）`
}

export function getToolLabel(toolName: string): string {
  const exact = TOOL_LABELS[toolName]
  if (exact) return formatMappedLabel(toolName, exact)

  if (toolName.startsWith("chrome_")) {
    const suffix = toolName.slice("chrome_".length)
    return formatMappedLabel(toolName, `Chrome 工具：${titleCaseWords(suffix)}`)
  }

  if (toolName.includes("computer")) {
    return formatMappedLabel(toolName, "Chrome 计算机操作")
  }

  return toolName
}
