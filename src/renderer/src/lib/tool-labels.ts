export const IN_APP_BROWSER_TOOL_LABELS: Record<string, string> = {
  mcp__inAppBrowser__browser_close: "内置浏览器-关闭",
  mcp__inAppBrowser__browser_resize: "内置浏览器-调整窗口大小",
  mcp__inAppBrowser__browser_console_messages: "内置浏览器-获取控制台消息",
  mcp__inAppBrowser__browser_handle_dialog: "内置浏览器-处理对话框",
  mcp__inAppBrowser__browser_evaluate: "内置浏览器-执行 JavaScript",
  mcp__inAppBrowser__browser_file_upload: "内置浏览器-上传文件",
  mcp__inAppBrowser__browser_fill_form: "内置浏览器-填写表单",
  mcp__inAppBrowser__browser_install: "内置浏览器-安装浏览器",
  mcp__inAppBrowser__browser_press_key: "内置浏览器-按键",
  mcp__inAppBrowser__browser_press_sequentially: "内置浏览器-逐字输入",
  mcp__inAppBrowser__browser_type: "内置浏览器-输入文本",
  mcp__inAppBrowser__browser_mouse_move_xy: "内置浏览器-移动鼠标",
  mcp__inAppBrowser__browser_mouse_click_xy: "内置浏览器-坐标点击",
  mcp__inAppBrowser__browser_mouse_drag_xy: "内置浏览器-坐标拖拽",
  mcp__inAppBrowser__browser_navigate: "内置浏览器-导航",
  mcp__inAppBrowser__browser_navigate_back: "内置浏览器-返回上一页",
  mcp__inAppBrowser__browser_network_requests: "内置浏览器-获取网络请求",
  mcp__inAppBrowser__browser_open: "内置浏览器-打开网址",
  mcp__inAppBrowser__browser_pdf_save: "内置浏览器-保存为 PDF",
  mcp__inAppBrowser__browser_run_code: "内置浏览器-运行 Playwright 代码",
  mcp__inAppBrowser__browser_take_screenshot: "内置浏览器-截图",
  mcp__inAppBrowser__browser_snapshot: "内置浏览器-获取页面快照",
  mcp__inAppBrowser__browser_click: "内置浏览器-点击",
  mcp__inAppBrowser__browser_drag: "内置浏览器-拖拽",
  mcp__inAppBrowser__browser_hover: "内置浏览器-悬停",
  mcp__inAppBrowser__browser_select_option: "内置浏览器-选择选项",
  mcp__inAppBrowser__browser_generate_locator: "内置浏览器-生成元素定位器",
  mcp__inAppBrowser__browser_tabs: "内置浏览器-管理标签页",
  mcp__inAppBrowser__browser_start_tracing: "内置浏览器-开始追踪",
  mcp__inAppBrowser__browser_stop_tracing: "内置浏览器-停止追踪",
  mcp__inAppBrowser__browser_verify_element_visible: "内置浏览器-验证元素可见",
  mcp__inAppBrowser__browser_verify_text_visible: "内置浏览器-验证文本可见",
  mcp__inAppBrowser__browser_verify_list_visible: "内置浏览器-验证列表可见",
  mcp__inAppBrowser__browser_verify_value: "内置浏览器-验证元素值",
  mcp__inAppBrowser__browser_wait_for: "内置浏览器-等待页面状态"
}

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
  search_tool: "搜索工具",
  ...IN_APP_BROWSER_TOOL_LABELS
}

interface ToolLabelOptions {
  args?: Record<string, unknown>
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

export function getChineseLabel(toolName: string, options?: ToolLabelOptions): string | null {
  void options
  return TOOL_LABELS[toolName] ?? null
}

export function getToolLabel(toolName: string, options?: ToolLabelOptions): string {
  const chineseLabel = getChineseLabel(toolName, options)
  if (chineseLabel) return formatMappedLabel(toolName, chineseLabel, options)

  // For compact/collapsed display, if no explicit Chinese mapping exists,
  // keep the original tool name instead of synthesizing a Chinese label.
  if (options?.showToolName === false) {
    return toolName
  }

  return toolName
}
