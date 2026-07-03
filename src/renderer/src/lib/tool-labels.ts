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
  start_worker: "启动子代理",
  continue_worker: "继续子代理",
  read_worker_state: "等待子代理结果",
  cancel_worker: "取消子代理",
  git_push: "Git 推送",
  code_exec: "编程式工具调用",
  request_user_input: "请求用户输入",
  invoke_deferred_tool: "调用延迟加载的工具",
  inspect_tool: "查看工具定义",
  search_tool: "搜索工具"
}

interface ToolLabelOptions {
  showToolName?: boolean
}

function formatMappedLabel(
  toolName: string,
  chineseLabel: string,
  options?: ToolLabelOptions
): string {
  if (options?.showToolName === false) return chineseLabel
  return `${chineseLabel}（${toolName}）`
}

export function getToolLabel(toolName: string, options?: ToolLabelOptions): string {
  const exact = TOOL_LABELS[toolName]
  if (exact) return formatMappedLabel(toolName, exact, options)

  // For compact/collapsed display, if no explicit Chinese mapping exists,
  // keep the original tool name instead of synthesizing a Chinese label.
  if (options?.showToolName === false) {
    return toolName
  }

  return toolName
}
