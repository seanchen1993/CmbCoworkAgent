import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { useAppStore } from "@/lib/store"
import type {
  HookConfig,
  HookEvent,
  HookType,
  PromptHookFallback,
  HookUpsert,
  SkillMetadata
} from "@/types"

// ── 常用工具选项 ──────────────────────────────────────────────────────────────
export const COMMON_TOOLS: { value: string; label: string; description: string }[] = [
  { value: "*", label: "所有工具（*）", description: "匹配任意工具调用" },
  { value: "execute", label: "执行命令（execute）", description: "Shell / PowerShell 命令执行" },
  { value: "write_file", label: "写入文件（write_file）", description: "创建或覆盖文件内容" },
  { value: "edit_file", label: "编辑文件（edit_file）", description: "局部替换文件内容" },
  { value: "read_file", label: "读取文件（read_file）", description: "读取文件内容" },
  { value: "memory_search", label: "搜索记忆（memory_search）", description: "检索长期记忆" },
  { value: "memory_get", label: "读取记忆（memory_get）", description: "读取记忆文件" },
  {
    value: "manage_scheduler",
    label: "调度任务（manage_scheduler）",
    description: "创建/修改定时任务"
  },
  { value: "manage_skill", label: "技能管理（manage_skill）", description: "加载/卸载技能" },
  { value: "custom", label: "自定义…", description: "手动输入工具名称或正则表达式" }
]
const CUSTOM_SENTINEL = "custom"

const HOOK_EVENTS: { value: HookEvent; label: string; description: string }[] = [
  {
    value: "PreToolUse",
    label: "工具调用前（PreToolUse）",
    description: "在工具执行前触发，拦截后可阻止执行，阻断原因会反馈给 Agent 使其自适应调整"
  },
  {
    value: "PostToolUse",
    label: "工具调用后（PostToolUse）",
    description: "在工具执行后触发，stdout 会追加到 Agent 下一轮上下文，外部系统状态可参与 AI 推理"
  },
  {
    value: "UserPromptSubmit",
    label: "用户提交提示（UserPromptSubmit）",
    description: "用户消息进入模型前触发，可阻断、重写提示或注入 additionalContext"
  },
  {
    value: "SessionStart",
    label: "会话开始（SessionStart）",
    description: "线程首次运行 Agent 时触发一次，适合初始化会话资源"
  },
  {
    value: "SessionEnd",
    label: "会话结束（SessionEnd）",
    description: "线程删除或应用退出时触发，适合清理会话资源"
  },
  {
    value: "Stop",
    label: "Agent 停止时（Stop）",
    description: "Agent 完成任务停止时触发，可请求 Agent 返工或发送通知"
  },
  {
    value: "Notification",
    label: "通知事件（Notification）",
    description: "Agent 等待用户审批时触发，可用于自定义提醒或消息推送"
  },
  {
    value: "SubagentStop",
    label: "子 Agent 停止（SubagentStop）",
    description: "子 Agent 任务结束时触发，可用于记录或同步子任务结果"
  }
]

const FALLBACK_OPTIONS: { value: PromptHookFallback; label: string; description: string }[] = [
  {
    value: "allow",
    label: "宽松（默认放行）",
    description: "模型超时或返回异常时默认放行，适合非关键场景"
  },
  {
    value: "block",
    label: "严格（默认阻断）",
    description: "模型超时或返回异常时默认阻断，适合高安全要求场景"
  }
]
const MANUAL_SKILL_VALUE = "__manual_skill__"
export type CommandExampleKind = "python" | "shell"

export interface CommandHookEventDoc {
  inputDescription: string
  inputFields: string[]
  envFields: string[]
  stdinExample: string
  outputDescription: string
  outputNotes: string[]
  outputExample: string
  pythonExample: string
  shellExample: string
}

export interface ToolInputDoc {
  key: string
  label: string
  fields: string[]
  description: string
  fileHint?: string
}

export interface HookReadableFieldDoc {
  key: string
  description: string
  note?: string
}

export interface HookReadableObjectDoc {
  key: string
  description: string
  fields?: string[]
  note?: string
}

export interface CommandHookReadableContextDoc {
  stdinFields: HookReadableFieldDoc[]
  envFields: HookReadableFieldDoc[]
  extraObjects: HookReadableObjectDoc[]
}

export const COMMAND_HOOK_EVENT_DOCS: Record<HookEvent, CommandHookEventDoc> = {
  PreToolUse: {
    inputDescription: "当前事件发生在工具真正执行前，最常见的输入是工具名和工具参数。",
    inputFields: ["hook_event_name", "session_id", "cwd", "tool_name", "tool_input"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH", "TOOL_NAME", "TOOL_ARGS"],
    stdinExample: `{
  "hook_event_name": "PreToolUse",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "tool_name": "execute",
  "tool_input": {
    "command": "git push origin main"
  }
}`,
    outputDescription: "当前事件最常见的是阻断高风险调用，或改写工具入参后再继续执行。",
    outputNotes: [
      "`exit = 2` 可直接阻断工具执行。",
      "`stdout` 输出 JSON 时，可使用 `decision=block`、`reason`、`updatedInput`、`systemMessage` 等字段。"
    ],
    outputExample: `{
  "decision": "block",
  "reason": "检测到直接推送主分支，请先创建分支并提交 PR",
  "systemMessage": "Hook 已阻断直接推送主分支",
  "requiredSkill": "workspace-hook-remediation"
}`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
tool_name = payload.get("tool_name")
tool_input = payload.get("tool_input", {})
command = str(tool_input.get("command", ""))

print(
    f"[hook] event={payload.get('hook_event_name')} tool={tool_name} command={command}",
    file=sys.stderr,
)

if tool_name == "execute" and "push origin main" in command.lower():
    json.dump(
        {
            "decision": "block",
            "reason": "检测到直接推送主分支，请先创建分支并提交 PR",
            "systemMessage": "Hook 已阻断直接推送主分支",
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.exit(0)

print("检查通过", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$toolName = [string]$payload.tool_name
$toolInput = $payload.tool_input
$command = ""

if ($toolInput -and $toolInput.PSObject.Properties["command"]) {
    $command = [string]$toolInput.command
}

[Console]::Error.WriteLine(
    "[hook] event=$($payload.hook_event_name) tool=$toolName command=$command"
)

if ($toolName -eq "execute" -and $command.ToLower().Contains("push origin main")) {
    [pscustomobject]@{
        decision = "block"
        reason = "检测到直接推送主分支，请先创建分支并提交 PR"
        systemMessage = "Hook 已阻断直接推送主分支"
    } | ConvertTo-Json -Compress -Depth 5
    exit 0
}

Write-Output "检查通过"
exit 0
`
  },
  PostToolUse: {
    inputDescription: "当前事件发生在工具执行完成后，除了工具名和参数，还能拿到工具返回结果。",
    inputFields: [
      "hook_event_name",
      "session_id",
      "cwd",
      "tool_name",
      "tool_input",
      "tool_response"
    ],
    envFields: [
      "HOOK_EVENT",
      "SESSION_ID",
      "WORKSPACE_PATH",
      "TOOL_NAME",
      "TOOL_ARGS",
      "TOOL_RESULT"
    ],
    stdinExample: `{
  "hook_event_name": "PostToolUse",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "tool_name": "write_file",
  "tool_input": {
    "filePath": "README.md",
    "content": "Hello"
  },
  "tool_response": {
    "success": true,
    "message": "文件已写入"
  }
}`,
    outputDescription: "当前事件通常用于做写后校验、状态同步，或把外部检查结果回灌给 Agent。",
    outputNotes: [
      "普通文本 `stdout` 会追加到 Agent 下一轮上下文。",
      "若要要求 Agent 重新审视本次结果，可返回 JSON，并设置 `decision=block` 与 `reason`。"
    ],
    outputExample: `已完成写后校验：README.md 已更新，建议继续执行后续步骤。`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
tool_name = payload.get("tool_name")
tool_input = payload.get("tool_input", {})
tool_response = payload.get("tool_response", {})
file_path = str(tool_input.get("filePath", ""))
success = bool(tool_response.get("success"))

print(
    f"[hook] event={payload.get('hook_event_name')} tool={tool_name} file={file_path}",
    file=sys.stderr,
)

if tool_name == "write_file" and not success:
    json.dump(
        {
            "decision": "block",
            "reason": f"写入 {file_path} 后校验失败，请先修复再继续",
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.exit(0)

print(f"已完成写后校验：{file_path} 写入成功", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$toolName = [string]$payload.tool_name
$toolInput = $payload.tool_input
$toolResponse = $payload.tool_response
$filePath = ""
$success = [bool]($toolResponse.success)

if ($toolInput -and $toolInput.PSObject.Properties["filePath"]) {
    $filePath = [string]$toolInput.filePath
}

[Console]::Error.WriteLine(
    "[hook] event=$($payload.hook_event_name) tool=$toolName file=$filePath"
)

if ($toolName -eq "write_file" -and -not $success) {
    [pscustomobject]@{
        decision = "block"
        reason = "写入 $filePath 后校验失败，请先修复再继续"
    } | ConvertTo-Json -Compress -Depth 5
    exit 0
}

Write-Output "已完成写后校验：$filePath 写入成功"
exit 0
`
  },
  UserPromptSubmit: {
    inputDescription: "当前事件发生在用户消息进入模型前，重点字段是原始 prompt 和消息体。",
    inputFields: ["hook_event_name", "session_id", "cwd", "prompt", "tool_input.message"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH", "USER_PROMPT", "TOOL_ARGS"],
    stdinExample: `{
  "hook_event_name": "UserPromptSubmit",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "prompt": "直接帮我删除生产库订单表",
  "tool_input": {
    "message": "直接帮我删除生产库订单表"
  }
}`,
    outputDescription: "当前事件可在消息进入模型前拦截、重写用户输入，或注入隐藏整改上下文。",
    outputNotes: [
      "`updatedInput.message` / `updatedInput.prompt` 可重写送入模型的内容。",
      "`decision=block` 或 `exit=2` 可直接阻止本轮提问继续执行。"
    ],
    outputExample: `{
  "updatedInput": {
    "message": "请先评估风险，再给出只读排查方案，不要直接执行删除操作。"
  },
  "systemMessage": "已按策略重写用户请求",
  "additionalContext": "用户原始请求涉及高风险生产操作，优先给出只读方案。"
}`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
prompt = str(payload.get("prompt", ""))

print(f"[hook] event={payload.get('hook_event_name')} prompt={prompt}", file=sys.stderr)

if "生产" in prompt and "删除" in prompt:
    json.dump(
        {
            "updatedInput": {
                "message": "请先评估风险，再给出只读排查方案，不要直接执行删除操作。"
            },
            "systemMessage": "已按策略重写用户请求",
            "additionalContext": "用户原始请求涉及高风险生产操作，优先给出只读方案。"
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.exit(0)

print("用户输入通过校验", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$prompt = ""

if ($payload.PSObject.Properties["prompt"]) {
    $prompt = [string]$payload.prompt
}

[Console]::Error.WriteLine("[hook] event=$($payload.hook_event_name) prompt=$prompt")

if ($prompt.Contains("生产") -and $prompt.Contains("删除")) {
    [pscustomobject]@{
        updatedInput = @{
            message = "请先评估风险，再给出只读排查方案，不要直接执行删除操作。"
        }
        systemMessage = "已按策略重写用户请求"
        additionalContext = "用户原始请求涉及高风险生产操作，优先给出只读方案。"
    } | ConvertTo-Json -Compress -Depth 10
    exit 0
}

Write-Output "用户输入通过校验"
exit 0
`
  },
  SessionStart: {
    inputDescription: "当前事件发生在会话启动时，只带基础会话信息，适合做初始化。",
    inputFields: ["hook_event_name", "session_id", "cwd"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH"],
    stdinExample: `{
  "hook_event_name": "SessionStart",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo"
}`,
    outputDescription:
      "当前事件属于 fire-and-forget，更适合做副作用或初始化日志，不建议依赖它改变主流程。",
    outputNotes: [
      "常见用途包括创建会话级缓存、记录审计日志、准备外部资源。",
      "`stdout` / `stderr` 主要用于日志展示。"
    ],
    outputExample: `session initialized for C:\\ai\\demo`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
cwd = str(payload.get("cwd", ""))
session_id = str(payload.get("session_id", ""))

print(f"[hook] session start session_id={session_id} cwd={cwd}", file=sys.stderr)
print(f"session initialized for {cwd}", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$cwd = ""
$sessionId = ""

if ($payload.PSObject.Properties["cwd"]) {
    $cwd = [string]$payload.cwd
}
if ($payload.PSObject.Properties["session_id"]) {
    $sessionId = [string]$payload.session_id
}

[Console]::Error.WriteLine("[hook] session start session_id=$sessionId cwd=$cwd")
Write-Output "session initialized for $cwd"
exit 0
`
  },
  SessionEnd: {
    inputDescription: "当前事件发生在会话结束时，只带基础会话信息，适合做清理与归档。",
    inputFields: ["hook_event_name", "session_id", "cwd"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH"],
    stdinExample: `{
  "hook_event_name": "SessionEnd",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo"
}`,
    outputDescription: "当前事件属于 fire-and-forget，适合做资源清理、会话收尾和审计上报。",
    outputNotes: [
      "常见用途包括释放会话资源、同步结束状态、写入归档日志。",
      "`stdout` / `stderr` 主要用于日志展示。"
    ],
    outputExample: `session cleaned up for C:\\ai\\demo`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
cwd = str(payload.get("cwd", ""))
session_id = str(payload.get("session_id", ""))

print(f"[hook] session end session_id={session_id} cwd={cwd}", file=sys.stderr)
print(f"session cleaned up for {cwd}", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$cwd = ""
$sessionId = ""

if ($payload.PSObject.Properties["cwd"]) {
    $cwd = [string]$payload.cwd
}
if ($payload.PSObject.Properties["session_id"]) {
    $sessionId = [string]$payload.session_id
}

[Console]::Error.WriteLine("[hook] session end session_id=$sessionId cwd=$cwd")
Write-Output "session cleaned up for $cwd"
exit 0
`
  },
  Stop: {
    inputDescription:
      "当前事件发生在 Agent 准备结束本轮任务时，会带上 stop_context 供你做收尾复查。",
    inputFields: ["hook_event_name", "session_id", "cwd", "stop_context"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH"],
    stdinExample: `{
  "hook_event_name": "Stop",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "stop_context": {
    "userMessage": "帮我修复登录 bug",
    "assistantResponse": "我已经修改完成。",
    "toolCalls": ["read_file", "edit_file", "execute pytest"],
    "usedSkills": ["bugfix-playbook"]
  }
}`,
    outputDescription: "当前事件适合做任务验收和结果复查，发现质量问题时可以要求 Agent 返工。",
    outputNotes: [
      "返回 `decision=block`、`continue=false` 或 `exit=2` 都可以阻止本轮结束。",
      "`additionalContext` 可把整改建议带回下一轮。"
    ],
    outputExample: `{
  "decision": "block",
  "reason": "本轮缺少测试结果与验收结论，请补充后再结束",
  "additionalContext": "请先运行相关测试，并在回复中明确说明验证结果。"
}`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
stop_context = payload.get("stop_context", {})
tool_calls = stop_context.get("toolCalls", []) or []
assistant_response = str(stop_context.get("assistantResponse", ""))

print(f"[hook] stop tool_calls={tool_calls}", file=sys.stderr)

if "pytest" not in " ".join(map(str, tool_calls)).lower():
    json.dump(
        {
            "decision": "block",
            "reason": "本轮缺少测试结果与验收结论，请补充后再结束",
            "additionalContext": "请先运行相关测试，并在回复中明确说明验证结果。"
        },
        sys.stdout,
        ensure_ascii=False,
    )
    sys.exit(0)

print(f"Stop 检查通过：{assistant_response}", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$stopContext = $payload.stop_context
$toolCalls = @($stopContext.toolCalls)
$assistantResponse = ""

if ($stopContext -and $stopContext.PSObject.Properties["assistantResponse"]) {
    $assistantResponse = [string]$stopContext.assistantResponse
}

[Console]::Error.WriteLine("[hook] stop tool_calls=$($toolCalls -join ', ')")

if (-not (($toolCalls -join ' ').ToLower().Contains('pytest'))) {
    [pscustomobject]@{
        decision = "block"
        reason = "本轮缺少测试结果与验收结论，请补充后再结束"
        additionalContext = "请先运行相关测试，并在回复中明确说明验证结果。"
    } | ConvertTo-Json -Compress -Depth 10
    exit 0
}

Write-Output "Stop 检查通过：$assistantResponse"
exit 0
`
  },
  Notification: {
    inputDescription: "当前事件发生在系统等待用户审批时，通常会带上审批相关的工具信息。",
    inputFields: ["hook_event_name", "session_id", "cwd", "tool_name", "tool_input"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH", "TOOL_NAME", "TOOL_ARGS"],
    stdinExample: `{
  "hook_event_name": "Notification",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "tool_name": "execute",
  "tool_input": {
    "command": "git push origin feature/login-fix",
    "reason": "需要用户审批",
    "filePath": "C:\\\\ai\\\\demo\\\\README.md"
  }
}`,
    outputDescription:
      "当前事件通常用于发企业微信、飞书、邮件或审计告警，重点是副作用而不是主流程控制。",
    outputNotes: [
      "这是 fire-and-forget 事件，最适合做通知，不建议依赖它改变主流程。",
      "通知结果和调试日志建议输出到 `stderr` 或 `stdout` 供面板查看。"
    ],
    outputExample: `已发送审批提醒：git push origin feature/login-fix`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
tool_name = payload.get("tool_name")
tool_input = payload.get("tool_input", {})
command = str(tool_input.get("command", ""))
reason = str(tool_input.get("reason", ""))

print(
    f"[hook] notification tool={tool_name} command={command} reason={reason}",
    file=sys.stderr,
)

print(f"已发送审批提醒：{command}", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$toolName = [string]$payload.tool_name
$toolInput = $payload.tool_input
$command = ""
$reason = ""

if ($toolInput -and $toolInput.PSObject.Properties["command"]) {
    $command = [string]$toolInput.command
}
if ($toolInput -and $toolInput.PSObject.Properties["reason"]) {
    $reason = [string]$toolInput.reason
}

[Console]::Error.WriteLine(
    "[hook] notification tool=$toolName command=$command reason=$reason"
)

Write-Output "已发送审批提醒：$command"
exit 0
`
  },
  SubagentStop: {
    inputDescription: "当前事件发生在子 Agent 结束时，输入重点是 `subagent` 对象。",
    inputFields: ["hook_event_name", "session_id", "cwd", "subagent"],
    envFields: ["HOOK_EVENT", "SESSION_ID", "WORKSPACE_PATH"],
    stdinExample: `{
  "hook_event_name": "SubagentStop",
  "session_id": "thread-123",
  "cwd": "C:\\\\ai\\\\demo",
  "subagent": {
    "id": "call_abc123",
    "status": "completed"
  }
}`,
    outputDescription: "当前事件适合做子任务审计、同步状态或发通知，不建议依赖它控制主流程。",
    outputNotes: [
      "常见用途包括记录子任务完成情况、归档结果、发送子任务结束通知。",
      "`subagent` 目前只在 stdin JSON 中提供，没有对应的专用环境变量。"
    ],
    outputExample: `subagent call_abc123 completed`,
    pythonExample: `import json
import sys

payload = json.load(sys.stdin)
subagent = payload.get("subagent", {})
subagent_id = str(subagent.get("id", ""))
status = str(subagent.get("status", ""))

print(f"[hook] subagent stop id={subagent_id} status={status}", file=sys.stderr)
print(f"subagent {subagent_id} {status}", end="")
sys.exit(0)
`,
    shellExample: `$raw = [Console]::In.ReadToEnd()
$payload = $raw | ConvertFrom-Json -Depth 20
$subagent = $payload.subagent
$subagentId = ""
$status = ""

if ($subagent -and $subagent.PSObject.Properties["id"]) {
    $subagentId = [string]$subagent.id
}
if ($subagent -and $subagent.PSObject.Properties["status"]) {
    $status = [string]$subagent.status
}

[Console]::Error.WriteLine("[hook] subagent stop id=$subagentId status=$status")
Write-Output "subagent $subagentId $status"
exit 0
`
  }
}

export const TOOL_INPUT_DOCS: Record<string, ToolInputDoc> = {
  execute: {
    key: "execute",
    label: "execute",
    fields: ["command"],
    description: "可以直接拿到本次要执行的命令全文。"
  },
  write_file: {
    key: "write_file",
    label: "write_file",
    fields: ["filePath", "content"],
    description: "可以直接拿到目标文件路径和要写入的内容。",
    fileHint: "文件路径 / 文件名直接来自 tool_input.filePath。"
  },
  edit_file: {
    key: "edit_file",
    label: "edit_file",
    fields: ["filePath", "oldString", "newString", "replaceAll"],
    description: "可以拿到被编辑的文件、查找文本、替换文本，以及是否全量替换。",
    fileHint: "文件路径 / 文件名直接来自 tool_input.filePath。"
  }
}

export const USER_PROMPT_TOOL_INPUT_DOC: ToolInputDoc = {
  key: "user-prompt-submit",
  label: "UserPromptSubmit",
  fields: ["message"],
  description: "当前 tool_input 里主要是用户原始消息，完整文本同时也会出现在顶层 prompt。"
}

export const NOTIFICATION_TOOL_INPUT_DOC: ToolInputDoc = {
  key: "notification",
  label: "Notification",
  fields: ["command", "reason", "filePath"],
  description: "审批等待场景下，通常能拿到待审批命令、触发原因，以及相关文件路径。",
  fileHint: "如果这是文件相关审批，tool_input.filePath 可以直接拿到对应路径。"
}

export function getCommandHookToolInputDocs(event: HookEvent, matcher?: string): ToolInputDoc[] {
  if (event === "UserPromptSubmit") return [USER_PROMPT_TOOL_INPUT_DOC]
  if (event === "Notification") return [NOTIFICATION_TOOL_INPUT_DOC]
  if (event === "PreToolUse" || event === "PostToolUse") {
    const commonDocs = [
      TOOL_INPUT_DOCS.execute,
      TOOL_INPUT_DOCS.write_file,
      TOOL_INPUT_DOCS.edit_file
    ]
    if (!matcher || matcher === "*") return commonDocs
    const exactDoc = TOOL_INPUT_DOCS[matcher]
    return exactDoc ? [exactDoc] : commonDocs
  }
  return []
}

export function getCommandHookToolInputSummary(event: HookEvent, matcher?: string): string {
  if (event === "UserPromptSubmit") {
    return "当前事件主要读取用户原始输入，重点看 tool_input.message 和顶层 prompt。"
  }
  if (event === "Notification") {
    return "当前事件的 tool_input 来自审批请求，常见字段是 command、reason、filePath。"
  }
  if (event === "PreToolUse" || event === "PostToolUse") {
    if (!matcher || matcher === "*") {
      return "当前 matcher 会命中多个工具，tool_input 会随实际工具变化。下面是目前已接入的常见字段。"
    }
    if (TOOL_INPUT_DOCS[matcher]) {
      return `当前 matcher 命中 ${matcher}，tool_input 可以直接按下面字段读取。`
    }
    return "当前 matcher 是自定义名称或正则，tool_input 要以实际命中的工具为准；如果命中 write_file / edit_file，可直接拿到 filePath。"
  }
  return ""
}

export function getCommandHookReadableContextDocs(event: HookEvent): CommandHookReadableContextDoc {
  const stdinFields: HookReadableFieldDoc[] = [
    {
      key: "hook_event_name",
      description: "当前 Hook 事件名，可用来区分 PreToolUse、Stop 等不同生命周期节点。"
    },
    { key: "session_id", description: "当前线程 / 会话 ID，适合关联日志、缓存或外部系统记录。" },
    { key: "cwd", description: "当前工作目录；有工作区时通常就是当前工作区路径。" }
  ]

  const envFields: HookReadableFieldDoc[] = [
    { key: "HOOK_EVENT", description: "当前 Hook 事件名，对应 stdin 里的 hook_event_name。" },
    { key: "SESSION_ID", description: "当前线程 / 会话 ID，对应 stdin 里的 session_id。" },
    { key: "WORKSPACE_PATH", description: "当前工作区路径，方便脚本拼接相对路径。" },
    {
      key: "CLAUDE_PROJECT_DIR",
      description: "WORKSPACE_PATH 的兼容别名，方便直接复用 Claude Code 社区脚本。"
    }
  ]

  const extraObjects: HookReadableObjectDoc[] = []

  if (event === "PreToolUse" || event === "PostToolUse" || event === "Notification") {
    stdinFields.push(
      {
        key: "tool_name",
        description: "当前触发 Hook 的工具名，例如 execute、write_file、edit_file。"
      },
      {
        key: "tool_input",
        description:
          "当前工具的结构化入参对象；字段会随实际工具变化，下面的 tool_input 说明会继续展开。"
      }
    )
    envFields.push(
      { key: "TOOL_NAME", description: "当前工具名，对应 stdin 里的 tool_name。" },
      {
        key: "TOOL_ARGS",
        description:
          "当前工具入参的 JSON 字符串版本；如果脚本更喜欢从环境变量读取，可以直接解析它。"
      }
    )
  }

  if (event === "PostToolUse") {
    stdinFields.push({
      key: "tool_response",
      description: "工具执行后的结构化返回；stdin 里会尽量还原成对象，便于脚本直接读取。"
    })
    envFields.push({
      key: "TOOL_RESULT",
      description: "工具返回结果的 JSON 字符串版本；适合不想从 stdin 解析完整 payload 的脚本。"
    })
    extraObjects.push({
      key: "tool_response",
      description:
        "结构随实际工具返回而变。比如写文件可能会有 success、message 等字段，其他工具则会带自己的返回结构。",
      note: "如果上游结果不是合法 JSON，stdin 里的 tool_response 会保留原始字符串。"
    })
  }

  if (event === "UserPromptSubmit") {
    stdinFields.push(
      {
        key: "prompt",
        description: "用户原始输入文本；脚本通常会直接基于它做拦截、改写或补充上下文。"
      },
      {
        key: "tool_input",
        description: "当前主要是消息对象，常见字段是 message；下面的 tool_input 说明会继续展开。"
      }
    )
    envFields.push(
      { key: "USER_PROMPT", description: "用户原始输入文本，对应 stdin 里的 prompt。" },
      {
        key: "TOOL_ARGS",
        description: "用户消息对象的 JSON 字符串版本，当前通常就是 { message }。"
      }
    )
  }

  if (event === "Stop") {
    stdinFields.push({
      key: "stop_context",
      description: "Agent 本轮结束前的摘要信息，用于做任务验收、补充要求或阻断结束。"
    })
    extraObjects.push({
      key: "stop_context",
      fields: ["userMessage", "assistantResponse", "toolCalls", "usedSkills"],
      description: "包含本轮用户目标、Agent 最终回复、调用过的工具，以及已使用的技能。",
      note: "stop_context 目前只在 stdin JSON 中提供，没有对应的专用环境变量。"
    })
  }

  if (event === "SubagentStop") {
    stdinFields.push({
      key: "subagent",
      description: "当前结束的子 Agent 信息，可用于审计、通知或外部同步。"
    })
    extraObjects.push({
      key: "subagent",
      fields: ["id", "name", "status"],
      description: "描述当前结束的子 Agent；常见字段包括 ID、名称和完成状态。",
      note: "subagent 目前只在 stdin JSON 中提供，没有对应的专用环境变量。"
    })
  }

  return { stdinFields, envFields, extraObjects }
}

export function AddHookDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  editHook?: HookConfig | null
}): React.JSX.Element {
  const { open, onOpenChange, onSuccess, editHook } = props
  const { models, loadModels } = useAppStore()
  const [skills, setSkills] = useState<SkillMetadata[]>([])
  const [disabledSkillNames, setDisabledSkillNames] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (open && models.length === 0) loadModels()
  }, [open, models.length, loadModels])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    void Promise.all([window.api.skills.list(), window.api.skills.getDisabled()])
      .then(([availableSkills, disabled]) => {
        if (cancelled) return
        setSkills([...availableSkills].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")))
        setDisabledSkillNames(new Set(disabled.map((name) => name.trim().toLowerCase())))
      })
      .catch((error) => {
        console.error("[AddHookDialog] Failed to load skills:", error)
        if (cancelled) return
        setSkills([])
        setDisabledSkillNames(new Set())
      })

    return () => {
      cancelled = true
    }
  }, [open])

  const [hookType, setHookType] = useState<HookType>(editHook?.type ?? "command")
  const [event, setEvent] = useState<HookEvent>(editHook?.event ?? "PreToolUse")
  const [matcher, setMatcher] = useState(editHook?.matcher ?? "")
  // matcher mode: preset value or "custom" for manual input
  const initMatcherMode = (h: HookConfig | null | undefined): string => {
    const m = h?.matcher ?? ""
    if (!m) return "*"
    return COMMON_TOOLS.some((t) => t.value !== CUSTOM_SENTINEL && t.value === m)
      ? m
      : CUSTOM_SENTINEL
  }
  const [matcherMode, setMatcherMode] = useState<string>(initMatcherMode(editHook))
  // command fields
  const [command, setCommand] = useState(editHook?.command ?? "")
  // prompt fields
  const [prompt, setPrompt] = useState(editHook?.prompt ?? "")
  const [modelId, setModelId] = useState(editHook?.modelId ?? "")
  const [fallback, setFallback] = useState<PromptHookFallback>(editHook?.fallback ?? "allow")
  const [onBlockReason, setOnBlockReason] = useState(editHook?.onBlock?.reason ?? "")
  const [onBlockSystemMessage, setOnBlockSystemMessage] = useState(
    editHook?.onBlock?.systemMessage ?? ""
  )
  const [onBlockRequiredSkill, setOnBlockRequiredSkill] = useState(
    editHook?.onBlock?.requiredSkill ?? ""
  )
  const [onBlockAdditionalContext, setOnBlockAdditionalContext] = useState(
    editHook?.onBlock?.additionalContext ?? ""
  )
  const [commandExampleKind, setCommandExampleKind] = useState<CommandExampleKind>("python")
  // shared
  const [timeout, setTimeout_] = useState(String(editHook?.timeout ?? 10000))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const configuredSkills = useMemo(() => {
    const enabled: SkillMetadata[] = []
    const disabled: SkillMetadata[] = []

    for (const skill of skills) {
      if (disabledSkillNames.has(skill.name.trim().toLowerCase())) {
        disabled.push(skill)
      } else {
        enabled.push(skill)
      }
    }

    return [...enabled, ...disabled]
  }, [skills, disabledSkillNames])
  const matchedSkill = useMemo(() => {
    const normalized = onBlockRequiredSkill.trim().toLowerCase()
    if (!normalized) return null
    return skills.find((skill) => skill.name.trim().toLowerCase() === normalized) ?? null
  }, [skills, onBlockRequiredSkill])
  const matchedSkillDisabled = matchedSkill
    ? disabledSkillNames.has(matchedSkill.name.trim().toLowerCase())
    : false
  const requiredSkillPickerValue = matchedSkill ? matchedSkill.name : MANUAL_SKILL_VALUE
  const currentEventMeta = useMemo(
    () => HOOK_EVENTS.find((item) => item.value === event) ?? HOOK_EVENTS[0],
    [event]
  )
  const currentCommandHookDoc = useMemo(() => COMMAND_HOOK_EVENT_DOCS[event], [event])
  const resolvedMatcherValue = useMemo(() => {
    if (event !== "PreToolUse" && event !== "PostToolUse") return ""
    return matcherMode === CUSTOM_SENTINEL ? matcher.trim() : matcherMode
  }, [event, matcherMode, matcher])
  const currentToolInputDocs = useMemo<ToolInputDoc[]>(
    () => getCommandHookToolInputDocs(event, resolvedMatcherValue),
    [event, resolvedMatcherValue]
  )
  const currentToolInputSummary = useMemo(
    () => getCommandHookToolInputSummary(event, resolvedMatcherValue),
    [event, resolvedMatcherValue]
  )
  const currentReadableContext = useMemo(() => getCommandHookReadableContextDocs(event), [event])

  const populateFromHook = useCallback((h: HookConfig | null | undefined) => {
    if (h) {
      setHookType(h.type ?? "command")
      setEvent(h.event)
      const mm = initMatcherMode(h)
      setMatcherMode(mm)
      setMatcher(mm === CUSTOM_SENTINEL ? (h.matcher ?? "") : "")
      setCommand(h.command ?? "")
      setPrompt(h.prompt ?? "")
      setModelId(h.modelId ?? "")
      setFallback(h.fallback ?? "allow")
      setOnBlockReason(h.onBlock?.reason ?? "")
      setOnBlockSystemMessage(h.onBlock?.systemMessage ?? "")
      setOnBlockRequiredSkill(h.onBlock?.requiredSkill ?? "")
      setOnBlockAdditionalContext(h.onBlock?.additionalContext ?? "")
      setTimeout_(String(h.timeout ?? 10000))
    } else {
      setHookType("command")
      setEvent("PreToolUse")
      setMatcherMode("*")
      setMatcher("")
      setCommand("")
      setPrompt("")
      setModelId("")
      setFallback("allow")
      setOnBlockReason("")
      setOnBlockSystemMessage("")
      setOnBlockRequiredSkill("")
      setOnBlockAdditionalContext("")
      setTimeout_("10000")
    }
    setError(null)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open) populateFromHook(editHook)
  }, [open, editHook, populateFromHook])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) populateFromHook(editHook)
      onOpenChange(next)
    },
    [onOpenChange, editHook, populateFromHook]
  )

  const showMatcher = event === "PreToolUse" || event === "PostToolUse"

  const handleSubmit = useCallback(async () => {
    setError(null)

    if (hookType === "command") {
      if (!command.trim()) {
        setError("请输入命令")
        return
      }
    } else {
      if (!prompt.trim()) {
        setError("请输入合规策略描述")
        return
      }
    }

    setSubmitting(true)
    try {
      const config: HookUpsert = {
        event,
        type: hookType,
        timeout: Math.min(60000, Math.max(1000, parseInt(timeout, 10) || 10000)),
        enabled: editHook ? editHook.enabled : true
      }
      if (showMatcher) {
        const resolvedMatcher = matcherMode === CUSTOM_SENTINEL ? matcher.trim() : matcherMode
        if (resolvedMatcher && resolvedMatcher !== "*") config.matcher = resolvedMatcher
      }

      if (hookType === "command") {
        config.command = command.trim()
      } else {
        config.prompt = prompt.trim()
        if (modelId.trim()) config.modelId = modelId.trim()
        config.fallback = fallback
      }

      const onBlock = {
        reason: onBlockReason.trim(),
        systemMessage: onBlockSystemMessage.trim(),
        requiredSkill: onBlockRequiredSkill.trim(),
        additionalContext: onBlockAdditionalContext.trim()
      }
      if (
        onBlock.reason ||
        onBlock.systemMessage ||
        onBlock.requiredSkill ||
        onBlock.additionalContext
      ) {
        config.onBlock = onBlock
      }

      if (editHook) {
        await window.api.hooks.update({ ...config, id: editHook.id })
      } else {
        await window.api.hooks.create(config)
      }
      onSuccess()
      handleOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败")
    } finally {
      setSubmitting(false)
    }
  }, [
    hookType,
    event,
    matcherMode,
    matcher,
    command,
    prompt,
    modelId,
    fallback,
    timeout,
    onBlockReason,
    onBlockSystemMessage,
    onBlockRequiredSkill,
    onBlockAdditionalContext,
    editHook,
    onSuccess,
    handleOpenChange,
    showMatcher
  ])

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 px-6 pt-6 pb-4 border-b border-border/60">
          <DialogTitle>{editHook ? "编辑 Hook" : "添加 Hook"}</DialogTitle>
          <DialogDescription>
            配置在特定事件发生时自动执行的 Shell 命令，或用自然语言描述合规策略由模型判决。
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-6 py-4">
          <div className="space-y-4 pr-1">
            {/* Hook type toggle */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Hook 类型</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setHookType("command")}
                  className={cn(
                    "flex-1 py-2 px-3 rounded-md border text-sm font-medium transition-colors",
                    hookType === "command"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50"
                  )}
                >
                  Shell 命令
                </button>
                <button
                  type="button"
                  onClick={() => setHookType("prompt")}
                  className={cn(
                    "flex-1 py-2 px-3 rounded-md border text-sm font-medium transition-colors",
                    hookType === "prompt"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-primary/50"
                  )}
                >
                  自然语言策略
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                {hookType === "command"
                  ? "执行 Shell 命令，exit=2 时阻断；exit=0 可返回 Claude Code JSON 输出"
                  : "用自然语言描述合规规则，由行内 LLM 实时判决是否允许执行"}
              </p>
            </div>

            {/* Event */}
            <div className="space-y-2">
              <label className="text-sm font-medium">事件类型</label>
              <Select value={event} onValueChange={(v) => setEvent(v as HookEvent)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HOOK_EVENTS.map((ev) => (
                    <SelectItem key={ev.value} value={ev.value} className="py-2">
                      <div>
                        <span className="text-sm">{ev.label}</span>
                        <p className="text-xs text-muted-foreground mt-0.5">{ev.description}</p>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Matcher */}
            {showMatcher && (
              <div className="space-y-2">
                <label className="text-sm font-medium">工具匹配</label>
                <Select
                  value={matcherMode}
                  onValueChange={(v) => {
                    setMatcherMode(v)
                    if (v !== CUSTOM_SENTINEL) setMatcher("")
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COMMON_TOOLS.map((t) => (
                      <SelectItem key={t.value} value={t.value} className="py-2">
                        <div>
                          <span className="text-sm">{t.label}</span>
                          <p className="text-xs text-muted-foreground mt-0.5">{t.description}</p>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {matcherMode === CUSTOM_SENTINEL && (
                  <>
                    <Input
                      placeholder="输入工具名称，如 execute 或 write_file|edit_file"
                      value={matcher}
                      onChange={(e) => setMatcher(e.target.value)}
                      className="h-9 font-mono"
                      autoFocus
                    />
                    <p className="text-xs text-muted-foreground">
                      精确匹配工具名（不区分大小写）。包含{" "}
                      <code className="font-mono">
                        | * + ? ^ $ ( ) [ ] {"{"} {"}"} \
                      </code>{" "}
                      时按
                      <strong>正则表达式</strong>解析（不是 glob）。例如{" "}
                      <code className="font-mono">write_file|edit_file</code> 命中两个工具，
                      <code className="font-mono">mcp__.*</code> 命中所有 mcp 工具。
                    </p>
                  </>
                )}
              </div>
            )}

            {/* Command-specific */}
            {hookType === "command" && (
              <div className="space-y-2">
                <label htmlFor="hook-command" className="text-sm font-medium">
                  命令
                </label>
                <Input
                  id="hook-command"
                  placeholder='echo "hello" 或 python C:\scripts\check.py'
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  className="h-9 font-mono"
                />
                <p className="text-xs text-muted-foreground">
                  脚本会收到一份 stdin JSON 和若干环境变量。想返回结构化结果时，`stdout`
                  必须只输出最终文本或 JSON；调试日志请写到 `stderr`。
                </p>
                <details className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                  <summary className="cursor-pointer text-xs font-medium text-foreground">
                    查看可读取信息、输入 / 输出协议、日志查看方式和脚本示例
                  </summary>
                  <div className="mt-3 space-y-3 text-xs">
                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">脚本输入</p>
                      <p className="text-muted-foreground">
                        当前按{" "}
                        <span className="font-mono text-foreground/80">
                          {currentEventMeta.value}
                        </span>{" "}
                        联动展示。
                        {currentCommandHookDoc.inputDescription}
                      </p>
                      <div className="space-y-1">
                        <div className="flex flex-wrap gap-1.5">
                          {currentCommandHookDoc.inputFields.map((field) => (
                            <span
                              key={field}
                              className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80"
                            >
                              {field}
                            </span>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {currentCommandHookDoc.envFields.map((field) => (
                            <span
                              key={field}
                              className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                            >
                              {field}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="rounded-md border border-border/50 bg-background/70 px-3 py-2 space-y-3">
                        <div className="space-y-1">
                          <p className="font-medium text-foreground">可读取信息总览</p>
                          <p className="text-muted-foreground">
                            下面这份清单展示当前事件下脚本能直接读取的主要上下文。需要确认实际原始
                            payload 时，也可以先把整份 payload 打到 `stderr`。
                          </p>
                        </div>
                        <div className="space-y-2">
                          <p className="font-medium text-foreground/90">stdin 顶层字段</p>
                          <div className="space-y-2">
                            {currentReadableContext.stdinFields.map((field) => (
                              <div
                                key={field.key}
                                className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 space-y-1"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                                    {field.key}
                                  </span>
                                </div>
                                <p className="text-muted-foreground">{field.description}</p>
                                {field.note && <p className="text-foreground/80">{field.note}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <p className="font-medium text-foreground/90">环境变量</p>
                          <div className="space-y-2">
                            {currentReadableContext.envFields.map((field) => (
                              <div
                                key={field.key}
                                className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 space-y-1"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                                    {field.key}
                                  </span>
                                </div>
                                <p className="text-muted-foreground">{field.description}</p>
                                {field.note && <p className="text-foreground/80">{field.note}</p>}
                              </div>
                            ))}
                          </div>
                        </div>
                        {currentReadableContext.extraObjects.length > 0 && (
                          <div className="space-y-2">
                            <p className="font-medium text-foreground/90">事件专属对象</p>
                            <div className="space-y-2">
                              {currentReadableContext.extraObjects.map((doc) => (
                                <div
                                  key={doc.key}
                                  className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 space-y-1.5"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <span className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                                      {doc.key}
                                    </span>
                                  </div>
                                  {doc.fields && doc.fields.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5">
                                      {doc.fields.map((field) => (
                                        <span
                                          key={`${doc.key}-${field}`}
                                          className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                                        >
                                          {field}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  <p className="text-muted-foreground">{doc.description}</p>
                                  {doc.note && <p className="text-foreground/80">{doc.note}</p>}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      {currentToolInputDocs.length > 0 && (
                        <div className="rounded-md border border-border/50 bg-background/70 px-3 py-2 space-y-2">
                          <p className="font-medium text-foreground">tool_input 里通常有什么</p>
                          <p className="text-muted-foreground">{currentToolInputSummary}</p>
                          <div className="space-y-2">
                            {currentToolInputDocs.map((doc) => (
                              <div
                                key={doc.key}
                                className="rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 space-y-1.5"
                              >
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-foreground/80">
                                    {doc.label}
                                  </span>
                                  {doc.fileHint && (
                                    <span className="rounded-full border border-emerald-300/50 bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300">
                                      可直接拿文件路径：`filePath`
                                    </span>
                                  )}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                  {doc.fields.map((field) => (
                                    <span
                                      key={field}
                                      className="rounded-full border border-dashed border-border/50 bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
                                    >
                                      {field}
                                    </span>
                                  ))}
                                </div>
                                <p className="text-muted-foreground">{doc.description}</p>
                                {doc.fileHint && (
                                  <p className="text-emerald-700 dark:text-emerald-300">
                                    {doc.fileHint}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <pre className="max-h-40 overflow-auto rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {currentCommandHookDoc.stdinExample}
                      </pre>
                    </div>

                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">脚本输出</p>
                      <p className="text-muted-foreground">
                        {currentCommandHookDoc.outputDescription}
                      </p>
                      <div className="space-y-1 text-muted-foreground">
                        {currentCommandHookDoc.outputNotes.map((note) => (
                          <p key={note}>{note}</p>
                        ))}
                      </div>
                      <pre className="max-h-40 overflow-auto rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {currentCommandHookDoc.outputExample}
                      </pre>
                    </div>

                    <div className="space-y-1.5">
                      <p className="font-medium text-foreground">怎么看脚本日志</p>
                      <div className="space-y-1 text-muted-foreground">
                        <p>
                          调试日志建议写到 `stderr`，例如 Python 用 `print(..., file=sys.stderr)`。
                        </p>
                        <p>
                          运行后回到聊天区，展开顶部的“Hook 执行记录”，就能看到 `stdout` 和 `stderr
                          / 日志`。
                        </p>
                        <p>
                          如果你要让 `stdout` 输出 JSON，请不要同时往 `stdout`
                          打日志，否则结构化解析会失败。
                        </p>
                        <p>
                          如果你想确认某个事件实际传进来了哪些字段，可以临时把 `payload` 整体打印到
                          `stderr`，再去 Hook 执行记录里查看原始内容。
                        </p>
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3">
                        <p className="font-medium text-foreground">脚本示例</p>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setCommandExampleKind("python")}
                            className={cn(
                              "rounded-md border px-2 py-1 text-[11px] transition-colors",
                              commandExampleKind === "python"
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border bg-background text-muted-foreground hover:border-primary/50"
                            )}
                          >
                            Python
                          </button>
                          <button
                            type="button"
                            onClick={() => setCommandExampleKind("shell")}
                            className={cn(
                              "rounded-md border px-2 py-1 text-[11px] transition-colors",
                              commandExampleKind === "shell"
                                ? "border-primary bg-primary/10 text-primary"
                                : "border-border bg-background text-muted-foreground hover:border-primary/50"
                            )}
                          >
                            Shell（PowerShell）
                          </button>
                        </div>
                      </div>
                      <p className="text-muted-foreground">
                        当前展示的是
                        <span className="font-mono text-foreground/80">
                          {" "}
                          {currentEventMeta.value}{" "}
                        </span>
                        下的
                        {commandExampleKind === "python"
                          ? " Python 版本，适合 `python hook.py` 这类命令。"
                          : " Shell / PowerShell 版本，适合 `powershell -File hook.ps1` 这类命令。"}
                      </p>
                      <pre className="max-h-64 overflow-auto rounded-md border border-border/50 bg-background px-3 py-2 font-mono text-[11px] whitespace-pre-wrap break-all">
                        {commandExampleKind === "python"
                          ? currentCommandHookDoc.pythonExample
                          : currentCommandHookDoc.shellExample}
                      </pre>
                    </div>
                  </div>
                </details>
              </div>
            )}

            {/* Prompt-specific */}
            {hookType === "prompt" && (
              <>
                <div className="space-y-2">
                  <label htmlFor="hook-prompt" className="text-sm font-medium">
                    合规策略描述
                  </label>
                  <textarea
                    id="hook-prompt"
                    placeholder={
                      "例：如果 AI 执行的命令包含生产数据库关键词（prod/prd/production）且不是只读的 SELECT 操作，则阻止并说明原因"
                    }
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={4}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                  <p className="text-xs text-muted-foreground">
                    用自然语言描述业务合规规则，行内 LLM 将据此对每次工具调用进行实时判决
                  </p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="hook-model" className="text-sm font-medium">
                    判决模型（可选）
                  </label>
                  <select
                    id="hook-model"
                    value={modelId}
                    onChange={(e) => setModelId(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    <option value="">使用默认模型</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id} disabled={!m.available}>
                        {m.name}
                        {m.tier === "economy" ? " (轻量)" : ""}
                        {!m.available ? " (不可用)" : ""}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    建议选轻量模型专用于 Hook 判决，与主对话模型解耦，降低延迟和成本
                  </p>
                </div>

                <div className="space-y-2">
                  <label htmlFor="hook-fallback" className="text-sm font-medium">
                    超时/异常回退策略
                  </label>
                  <select
                    id="hook-fallback"
                    value={fallback}
                    onChange={(e) => setFallback(e.target.value as PromptHookFallback)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {FALLBACK_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {FALLBACK_OPTIONS.find((o) => o.value === fallback)?.description}
                  </p>
                </div>
              </>
            )}

            {/* Timeout (shared) */}
            <div className="space-y-2">
              <label htmlFor="hook-timeout" className="text-sm font-medium">
                超时（ms）
              </label>
              <Input
                id="hook-timeout"
                type="number"
                placeholder="10000"
                value={timeout}
                onChange={(e) => setTimeout_(e.target.value)}
                className="h-9"
              />
              <p className="text-xs text-muted-foreground">
                {hookType === "prompt"
                  ? "LLM 判决超时时间（含网络往返），范围 1000–60000ms，建议 ≥15000ms"
                  : "命令执行超时时间，范围 1000–60000ms，默认 10000ms"}
              </p>
            </div>

            <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-3">
              <div className="space-y-1">
                <label className="text-sm font-medium">阻断后补充配置（onBlock）</label>
                <p className="text-xs text-muted-foreground">
                  当 Hook 发生阻断或停止时，静态补齐整改信息。不会覆盖 Hook 自己已经返回的
                  reason，只补充缺失字段并附加提示。
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-onblock-reason" className="text-sm font-medium">
                  阻断原因回退（可选）
                </label>
                <Input
                  id="hook-onblock-reason"
                  placeholder="例如：请先按整改技能处理后再重试"
                  value={onBlockReason}
                  onChange={(e) => setOnBlockReason(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-onblock-system-message" className="text-sm font-medium">
                  用户提示（可选）
                </label>
                <Input
                  id="hook-onblock-system-message"
                  placeholder="例如：Hook 已阻断本次操作，并附带整改技能"
                  value={onBlockSystemMessage}
                  onChange={(e) => setOnBlockSystemMessage(e.target.value)}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">联动已配置技能（可选）</label>
                <Select
                  value={requiredSkillPickerValue}
                  onValueChange={(value) => {
                    if (value === MANUAL_SKILL_VALUE) return
                    setOnBlockRequiredSkill(value)
                  }}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue
                      placeholder={
                        configuredSkills.length > 0 ? "从当前已配置技能中选择" : "暂无已配置技能"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={MANUAL_SKILL_VALUE}>手动输入或保留当前值</SelectItem>
                    {configuredSkills.map((skill) => {
                      const skillDisabled = disabledSkillNames.has(skill.name.trim().toLowerCase())

                      return (
                        <SelectItem key={skill.path} value={skill.name} className="py-2">
                          <div>
                            <span className="text-sm">
                              {skill.name}
                              {skillDisabled ? "（已禁用）" : ""}
                            </span>
                            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                              {skill.description || (skillDisabled ? "该技能当前已禁用" : "无描述")}
                            </p>
                          </div>
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {configuredSkills.length > 0
                    ? "这里联动的是当前已配置技能。选中后会自动写入下方 `requiredSkill` 字段；若技能已禁用，需要先启用后运行时才会注入整改指引。"
                    : "当前还没有可联动的技能，仍可手动填写 `requiredSkill`。"}
                </p>
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-onblock-required-skill" className="text-sm font-medium">
                  整改技能（requiredSkill，可选）
                </label>
                <Input
                  id="hook-onblock-required-skill"
                  placeholder="可手动输入，或从上方已配置技能列表带入"
                  value={onBlockRequiredSkill}
                  onChange={(e) => setOnBlockRequiredSkill(e.target.value)}
                  className="h-9 font-mono"
                />
                {onBlockRequiredSkill.trim() && matchedSkill && !matchedSkillDisabled && (
                  <p className="text-xs text-muted-foreground">
                    已匹配技能：`{matchedSkill.name}`{" "}
                    {matchedSkill.source === "user" ? "（自定义）" : "（内置）"}
                  </p>
                )}
                {onBlockRequiredSkill.trim() && matchedSkillDisabled && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    当前填写的技能存在，但已被禁用。运行时只会对已启用技能注入整改指引。
                  </p>
                )}
                {onBlockRequiredSkill.trim() && !matchedSkill && (
                  <p className="text-xs text-muted-foreground">
                    当前值未匹配到技能列表，将按原样保存。只有运行时能解析到已启用技能时才会生效。
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <label htmlFor="hook-onblock-context" className="text-sm font-medium">
                  额外上下文（additionalContext，可选）
                </label>
                <textarea
                  id="hook-onblock-context"
                  placeholder="补充给 Agent 的隐藏整改说明"
                  value={onBlockAdditionalContext}
                  onChange={(e) => setOnBlockAdditionalContext(e.target.value)}
                  rows={3}
                  className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>
        </div>

        <div className="shrink-0 border-t border-border/60 px-6 py-4 bg-background">
          {error && <p className="text-sm text-destructive mb-3">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submitting}>
              {submitting ? "处理中…" : editHook ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
