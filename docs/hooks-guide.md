# Hooks 使用指南

本文档解释 CmbCoworkAgent 的钩子（Hook）系统：什么是钩子、何时触发、能拿到什么数据、能改变什么行为、怎么调试。文档中所有配置和脚本示例都可以直接复制使用。

---

## 0. 一分钟概念

- **钩子 = 在 Agent 工作流的关键节点插入的"拦截器"**。
- 每个钩子绑定一个**事件**（如"工具执行前"），可选一个**匹配器**（如"只拦 execute 工具"）。
- 命中后系统启动你的脚本（或调一次 LLM 评估你写的策略），按它的退出码与 stdout 决定：放行、阻断、改写输入、要求 Agent 修订、或直接终止本轮。
- 钩子有四种作用域：**全局**（`~/.cmbcoworkagent/hooks.json`）、**工作区**（项目内）、**插件**、**技能**——后两种随插件/技能一起分发，只在它们活跃时生效。

---

## 1. 何时触发：事件清单

| 事件 | 触发时机 | 关键作用 |
|---|---|---|
| `PreToolUse` | 工具执行**前** | 拦截危险调用 / 改写参数 |
| `PostToolUse` | 工具执行**后** | 写后校验 / 注入上下文 / 要求 Agent 修订 |
| `PreSkillUse` | 技能加载**前** | 技能准入控制 |
| `PostSkillUse` | 本轮结束阶段，每个使用过的技能各触发一次 | 使用记录 / 收尾审计 |
| `UserPromptSubmit` | 用户消息进入模型**前** | 拦截 / 改写用户输入 |
| `Stop` | 本轮结束 | 最终验收，可要求修订 |
| `SubagentStop` | 子 Agent 结束 | 父轮的事后检查 |
| `Notification` / `SessionStart` / `SessionEnd` | 通知 / 会话开始 / 会话结束 | 纯通知，不能阻断 |

**多钩子串行**：同一事件可以挂多个钩子，按数组顺序依次执行。Pre 系列任一阻断即整体阻断；Post 系列把各钩子的输出合并后回灌给 Agent。

> **关于"暂未实现"事件**：`HookEvent` 联合类型保留了向 Claude Code 看齐的所有事件名（`PostToolUseFailure`、`StopFailure`、`SubagentStart`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`Setup`、`CwdChanged`、`FileChanged`），但只有上表的 10 个进入 `SUPPORTED_HOOK_EVENTS`。其余事件**在加载阶段就被丢弃**——`storage.ts` 在 flat / workspace / plugin / skill / Claude Code `settings.json` 导入这 5 条读取路径上都用 `isSupportedHookEvent` 过滤；IPC 创建接口也会拒绝。HooksPanel 的 `EVENT_BADGE` 仍为这些事件保留了徽章配置项（防御性兜底，避免某次新增运行时支持后忘记加 UI），tooltip 注明 `⚠️ [暂未实现]`；UI 创建对话框（AddHookDialog）不开放这些事件。**实际效果**：插件 `hooks.json` 或 CC `settings.json` 里写了 `PostToolUseFailure` 之类的 hook，加载时被静默丢弃，不会出现在任何面板里、也不会触发。

---

## 2. 配置文件结构

`~/.cmbcoworkagent/hooks.json` 是**一个数组**，每个元素是一条钩子：

```jsonc
{
  "id": "唯一标识，UUID 即可",
  "event": "PreToolUse",            // 必填，见上表
  "matcher": "execute",             // 可选，工具名 / 技能名 / 正则 / "*"
  "type": "command",                // "command"（默认）或 "prompt"
  "command": "node my-hook.js",     // type=command 时必填
  "prompt": "禁止 X",                // type=prompt 时必填（自然语言策略）
  "modelId": "custom:claude",       // type=prompt 时可选，指定哪个模型
  "fallback": "allow",              // type=prompt 时可选：LLM 失败时的兜底，"allow"|"block"
  "forcedOutcome": "always-halt",   // 可选：强制结局，"always-revise"|"always-halt"
  "forcedReason": "原因文本",        // 可选：强制结局时的理由
  "onBlock": {                      // 可选：阻断时附加的整改信息
    "reason": "默认理由",
    "systemMessage": "给用户看的提示",
    "additionalContext": "塞给 Agent 的隐藏上下文",
    "requiredSkill": "remediation-skill"
  },
  "once": false,                    // 是否本会话只触发一次
  "persistAfterInterrupt": false,   // 仅技能/插件钩子：触发后是否常驻整个会话
  "timeout": 10000,                 // 超时毫秒，默认 10000
  "enabled": true,                  // 是否启用
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z"
}
```

> **改了配置不自动生效**：全局 `hooks.json` 是 UI 写入 / 实时监听的，改完即生效。但**插件目录里的 `hooks.json`** 需要在 UI 重新启用一次插件（或重启 App）才会重读——这是踩过的坑。

### 2.1 matcher 匹配规则

- **空 / `"*"`**：匹配所有
- **含 `| * + ? ^ $ ( ) [ ] { } \` 中任一字符**：当**正则**解析（不是 glob），大小写不敏感
- **不含上述字符**：当字面量按大小写不敏感**精确匹配**

| 场景 | 写法 |
|---|---|
| 拦所有工具 | `*` 或留空 |
| 拦单个工具 | `execute` |
| 拦多个工具 | `write_file\|edit_file` |
| 拦所有 MCP 工具 | `mcp__.*` |
| 拦某 provider 的所有 MCP 工具 | `mcp__github__.*` |
| 拦所有读类技能 | `.*-reader` |

> `.` **不算**正则触发字符——`foo.bar` 视为字面量。理由是工具名常含点（特别是 MCP 工具），避免误判。

### 2.2 type=command vs type=prompt

| 维度 | command | prompt |
|---|---|---|
| 执行内容 | 启动子进程跑脚本 | 调用 LLM 评估自然语言策略 |
| 输入 | stdin JSON + 一组环境变量 | 策略 + payload 喂给 LLM |
| 决策 | 看脚本退出码 / stdout JSON | LLM 输出 allow / block |
| 速度 | 本地几十毫秒 | 一次网络往返，秒级 |
| 失败处理 | 非 2 退出码视为"自身报错"，**不阻断** | 看 `fallback` 字段 |
| 适用 | 程序化规则、外部检查 | 难以代码化的策略表达 |

---

## 3. 脚本能读到的数据

### 3.1 stdin JSON（权威，无大小限制）

所有 command 钩子都从 stdin 收到一份完整 JSON。通用字段：

```jsonc
{
  "hook_event_name": "PostToolUse",
  "session_id": "thread-abc123",
  "cwd": "C:\\ai\\demo"
}
```

按事件追加：

| 字段 | 出现于 |
|---|---|
| `tool_name`, `tool_input` | Pre/PostToolUse、Pre/PostSkillUse、UserPromptSubmit（`tool_input.message`） |
| `tool_response` | **仅** PostToolUse（已自动 JSON.parse；解析失败时回退为原始字符串） |
| `prompt` | **仅** UserPromptSubmit |
| `skill_name`, `skill_path`, `skill_root`, `skill_trigger_tool_name` | Pre/PostSkillUse |
| `plugin_id`, `plugin_name`, `plugin_root` | 工具/技能/钩子归属插件时 |
| `hook_source_type`, `hook_source_root`, `hook_source_path` | 钩子来源已知时 |
| `subagent` | **仅** SubagentStop |
| `stop_context` | **仅** Stop / PostSkillUse —— 包含 `userMessage`、`assistantResponse`、`toolCalls[]`、`usedSkills[]` |
| `transcript_path` | **Claude Code 兼容字段 — 解析/透传能力已就绪，当前无填充入口**。Runner 的 stdin JSON 与 env 都已支持透传，但没有任何调用方填值，所以脚本目前永远拿不到。后续 PR 在确认 deepagents filesystem backend 的会话历史文件命名约定后填充。 |
| `permission_mode` | **仅 Notification 事件填充**。值为 `"yolo"`（YOLO 模式）或 `"approve"`（默认审批模式）。其他事件目前不写出该 key。 |
| `agent_id` | **解析/透传能力已就绪，当前无填充入口**。等待 SubagentStart / 子 Agent 内部 hook 路径接通后填充（属于 PR-04 范围）。 |

### 3.2 环境变量（便利，**大字段会被丢弃**）

| 变量 | 含义 |
|---|---|
| `HOOK_EVENT` | 事件名 |
| `SESSION_ID` | thread id |
| `WORKSPACE_PATH` / `CLAUDE_PROJECT_DIR` | 工作区根（两者完全等价） |
| `HOOK_SOURCE_TYPE` / `_ROOT` / `_PATH` | 钩子自身归属 |
| `TOOL_NAME` | 工具名 |
| `TOOL_ARGS` | 工具入参 JSON（**>4096 字符就不下发**） |
| `TOOL_RESULT` | 工具结果 JSON（同 4KB 上限，仅 PostToolUse） |
| `PLUGIN_ID` / `_NAME` / `_ROOT` | 仅工具或钩子归属插件时存在。`PLUGIN_ID` 是 `~/.cmbcoworkagent/plugins.json` 里安装时分配的 **UUID**，不是目录名也不是 plugin.json 里的字段；`PLUGIN_NAME` 来自 plugin.json 的 `name` |
| `SKILL_NAME` / `_PATH` / `_ROOT` | 仅 Pre/PostSkillUse |
| `USER_PROMPT` | 仅 UserPromptSubmit |
| `TRANSCRIPT_PATH` | **当前永远不下发**（透传能力已就绪，无填充入口；详见 §3.1 同名字段说明） |
| `PERMISSION_MODE` | **仅 Notification 事件下发**（值：`yolo` / `approve`）|
| `AGENT_ID` | **当前永远不下发**（透传能力已就绪，等子 Agent hook 路径接通后填充）|

⚠️ **铁律**：要可靠拿到完整工具入参/结果，**必须读 stdin JSON**——超过 4KB 时 env 里直接没有该 key。

### 3.3 cwd 优先级

脚本启动时的工作目录按以下优先级决定：

**`HOOK_SOURCE_ROOT` ▶ `WORKSPACE_PATH` ▶ 进程默认 cwd**

实战含义：**全局钩子的脚本工作目录是 `~/.cmbcoworkagent`，不是项目工作区**。要把日志写到工作区根，必须显式拼接 `WORKSPACE_PATH`，不能用相对路径。

### 3.4 PLUGIN_ROOT 何时有值

两种情况之一会触发：
1. **钩子本身住在插件目录里**——无论拦哪个工具，`PLUGIN_*` 都指向钩子所在的插件
2. **被拦截的工具/技能由插件提供**——全局或工作区钩子拦这种工具时，`PLUGIN_*` 指向被拦截工具所属的插件

**反例**：全局钩子拦 `read_file` / `execute` 这种内置工具时，`PLUGIN_*` 全部为空——这是符合预期的行为，不是 bug。

---

## 4. 脚本能产生什么输出

### 4.1 退出码（command 钩子）

| 退出码 | 含义 |
|---|---|
| `0` | 正常返回；stdout 若是合法 JSON 按结构化字段解析，否则当纯文本注入 |
| `2` | **强制阻断**；等价于 `decision=block`，reason 取自 stderr / stdout |
| 其它非零 | 视为"钩子自身报错"，**不阻断**业务，只打日志 |

> ⚠️ shell 里 `echo 'exit 2'` **不会**让进程退出码为 2，那只是 echo 出字面字符串。sh 里写 `exit 2`，Windows 用 `cmd /c "exit 2"`。

### 4.2 stdout JSON 可识别字段

| 字段 | 类型 | 用途 |
|---|---|---|
| `decision` | `"block"` / `"approve"` | Pre 系列：block=拒绝；Post 系列：block=要求 Agent 修订 |
| `reason` | string | 与 `decision=block` 配套，回灌给 Agent |
| `continue` | boolean | **`false` = 直接终止本轮**（优先级最高，压过 `decision`） |
| `stopReason` | string | 与 `continue=false` 配套，给用户看 |
| `updatedInput` | object | PreToolUse / UserPromptSubmit：改写工具参数 / 用户消息 |
| `additionalContext` | string | 注入 Agent 隐藏上下文 |
| `systemMessage` | string | 在 UI 对用户可见 |
| `requiredSkill` | string | 阻断时要求加载某技能作整改指引 |
| `suppressOutput` | boolean | PostToolUse：抑制工具原始结果进入上下文 |
| `hookSpecificOutput.{additionalContext,updatedInput,permissionDecision,permissionDecisionReason}` | object | 兼容嵌套写法 |
| `hookSpecificOutput.initialUserMessage` / 顶层 `initialUserMessage` | string | **解析已就位，消费侧待补**——SessionStart hook 可返回此字段，未来会自动作为首条用户消息注入（与 Claude Code 一致）|
| `hookSpecificOutput.watchPaths` / 顶层 `watchPaths` | string[] | **解析已就位，消费侧待补**——SessionStart / 未来的 CwdChanged hook 用以注册文件 watcher（与 Claude Code 一致）|

### 4.3 决策优先级（必记）

**`continue=false` ▶ `decision=block` ▶ `exit 2` ▶ 非零退出码**

- `continue=false`：终止本轮（其它字段全失效）
- `decision=block`：要求修订或拒绝（Pre 拒绝、Post 修订）
- `exit 2`：阻断当次操作
- 非零退出：仅记日志，不影响业务

### 4.4 forcedOutcome（配置层强制覆盖脚本）

| 值 | 效果 |
|---|---|
| 不设 | 完全跟脚本走 |
| `"always-revise"` | 无论脚本输出，强制 `decision=block`（Pre=拒绝，Post=要求修订） |
| `"always-halt"` | 无论脚本输出，强制 `continue=false`（直接终止） |

配合 `forcedReason` 提供理由。**适合"宁可错杀"的硬红线**——脚本只用来打日志，结局已经由配置锁死。

---

## 5. 各事件输出语义对照

| 事件 | 普通文本 stdout | `decision=block` | `continue=false` |
|---|---|---|---|
| PreToolUse | 追加到 Agent 上下文 | **拒绝工具执行**，feed reason 让 Agent 重试 | 终止本轮 |
| PostToolUse | 追加到 Agent 上下文 | **要求 Agent 重新审视结果**，feed reason | 终止本轮 |
| PreSkillUse | 追加到 Agent 上下文 | **拒绝技能加载** | 终止本轮 |
| PostSkillUse | **只入 Hook 执行记录**，不进上下文 | 进入修订流程；blocking 的 `additionalContext` 进修订提示 | 终止本轮 |
| UserPromptSubmit | 追加上下文 | 拒绝本轮提问 | 终止本轮 |
| Stop | 追加上下文 | 要求 Agent 修订本轮回复 | 终止本轮 |
| SubagentStop | 日志 | （无效） | 终止父轮 |
| Notification / SessionStart / SessionEnd | 日志 | （无效） | （无效） |

> PostSkillUse 的非阻塞 stdout **不会**回灌——这是和 PostToolUse 最大的区别。要在 PostSkillUse 注入上下文，必须走 `decision=block` 路径。

> **PreCompact / PostCompact 暂未实现**。第一版尝试用一对 `beforeModel` bridge 中间件包夹 `createSummarizationMiddleware`，但 deepagents 的 summarization 实际跑在 `wrapModelCall`，摘要写到 `state._summarizationEvent.summaryMessage` 而不是 `state.messages`——`beforeModel` 阶段根本看不到。同时 PreCompact 的预测也无法复用真实触发条件（effective messages、system prompt、tools、`tokenEstimationMultiplier`、context-overflow fallback）。下一次实现需要包裹/复用 summarization 自身的 `wrapModelCall` 返回值，检查 `Command.update._summarizationEvent` 触发，才能保证可靠。在此之前这两个事件在 UI 上保留徽章但运行时不触发。

---

## 6. 各语言读取输入、产生输出的骨架

每段都覆盖：读 stdin JSON、读 env、读嵌套字段（含缺失防御）、日志→stderr、决策→stdout、安全退出。**复制后替换业务部分即可使用。**

### 6.1 PowerShell（Windows 推荐）

```powershell
# ── 读输入 ─────────────────────────────────────────────
# 注意：[Console]::In.ReadToEnd() 在 Windows PowerShell 5.x + -File 模式下读不到 stdin！
# 在 5.x / 7.x 都稳的是 $input 自动变量。
$raw = ($input | Out-String)
# ConvertFrom-Json 在 5.x 没有 -Depth 参数；7+ 才加的。需跨版本就不写 -Depth。
try { $p = $raw | ConvertFrom-Json } catch { $p = $null }

# stdin 顶层字段
$event   = [string]$p.hook_event_name
$tool    = [string]$p.tool_name
$session = [string]$p.session_id

# 嵌套字段安全读取
$command = ""
if ($p.tool_input -and $p.tool_input.PSObject.Properties["command"]) {
  $command = [string]$p.tool_input.command
}

# tool_response 可能是对象也可能是字符串（PostToolUse）
$ok = $false
if ($p.tool_response -and $p.tool_response.PSObject.Properties["success"]) {
  $ok = [bool]$p.tool_response.success
}

# 环境变量
$ws       = $env:WORKSPACE_PATH          # 等价 $env:CLAUDE_PROJECT_DIR
$srcRoot  = $env:HOOK_SOURCE_ROOT
$pluginRt = $env:PLUGIN_ROOT             # 全局钩子拦内置工具时为空

# ── 日志走 stderr ──────────────────────────────────────
[Console]::Error.WriteLine("[hook] event=$event tool=$tool")

# ── 决策 JSON 走 stdout（一次性，不要混入日志）─────────
[pscustomobject]@{
  decision = "block"
  reason   = "命中策略：$command"
  systemMessage = "Hook 已阻断"
} | ConvertTo-Json -Compress -Depth 10

exit 0
```

### 6.2 Bash / sh（依赖 `jq`）

```bash
#!/usr/bin/env bash
set -u

# ── 读输入 ─────────────────────────────────────────────
raw=$(cat)
event=$(jq -r '.hook_event_name // ""' <<<"$raw")
tool=$(jq -r  '.tool_name // ""'       <<<"$raw")
cmd=$(jq -r   '.tool_input.command // ""' <<<"$raw")
ok=$(jq -r    '.tool_response.success // false' <<<"$raw")

# 环境变量
ws="${WORKSPACE_PATH:-}"
src_root="${HOOK_SOURCE_ROOT:-}"

# ── 日志走 stderr ──────────────────────────────────────
echo "[hook] event=$event tool=$tool" >&2

# ── 决策 JSON 走 stdout ────────────────────────────────
if [[ "$tool" == "execute" && "$cmd" == *"rm -rf /"* ]]; then
  jq -nc '{continue:false, stopReason:"极端高危命令"}'
  exit 0
fi

exit 0
```

无 `jq` 时退而用 `python3 -c`：
```bash
event=$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("hook_event_name",""))' <<<"$raw")
```

### 6.3 Python

```python
#!/usr/bin/env python3
import json, os, sys

# ── 读输入 ─────────────────────────────────────────────
payload = json.load(sys.stdin)
event   = payload.get("hook_event_name", "")
tool    = payload.get("tool_name", "")
cwd     = payload.get("cwd", "")

# 嵌套字段用链式 .get 防 KeyError
tool_input = payload.get("tool_input") or {}
command    = str(tool_input.get("command", ""))

# tool_response 解析失败时上游会回退为字符串
tool_resp = payload.get("tool_response") or {}
ok = bool(tool_resp.get("success")) if isinstance(tool_resp, dict) else False

# stop_context（仅 Stop / PostSkillUse）
stop_ctx = payload.get("stop_context") or {}
last_reply = str(stop_ctx.get("assistantResponse", ""))

# 环境变量
ws        = os.environ.get("WORKSPACE_PATH", "")
plugin_rt = os.environ.get("PLUGIN_ROOT", "")

# ── 日志走 stderr ──────────────────────────────────────
print(f"[hook] event={event} tool={tool} cmd={command[:80]}", file=sys.stderr)

# ── 决策 JSON 走 stdout ────────────────────────────────
if tool == "execute" and "rm -rf /" in command.lower():
    json.dump({"continue": False, "stopReason": "极端高危命令"},
              sys.stdout, ensure_ascii=False)
    sys.exit(0)

sys.exit(0)
```

### 6.4 Node.js（CommonJS）

```js
#!/usr/bin/env node
let raw = ""
process.stdin.on("data", c => (raw += c))
process.stdin.on("end", () => {
  // ── 读输入 ───────────────────────────────────────────
  let p = {}
  try { p = JSON.parse(raw) } catch {}

  const event   = p.hook_event_name ?? ""
  const tool    = p.tool_name        ?? ""
  const session = p.session_id       ?? ""

  // 嵌套字段 + 缺失防御
  const input    = (p.tool_input && typeof p.tool_input === "object") ? p.tool_input : {}
  const command  = String(input.command ?? "")
  const filePath = String(input.filePath ?? input.file_path ?? "")

  // tool_response：可能是对象，也可能是字符串
  const resp = p.tool_response
  const ok   = (resp && typeof resp === "object") ? Boolean(resp.success) : false

  // MCP 工具名拆解
  const [, provider, method] = tool.split("__")     // mcp__github__create_pr

  // 环境变量
  const ws        = process.env.WORKSPACE_PATH || ""
  const pluginRt  = process.env.PLUGIN_ROOT || ""

  // ── 日志走 stderr ────────────────────────────────────
  console.error(`[hook] event=${event} tool=${tool} provider=${provider ?? "-"}`)

  // ── 决策 JSON 走 stdout ──────────────────────────────
  if (provider === "github" && /create|delete|merge|push/i.test(method ?? "")) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `MCP 写操作 ${tool} 需要复述参数后再执行`,
      additionalContext: `参数：${JSON.stringify(input)}`
    }))
  }
  process.exit(0)
})
```

### 6.5 Windows cmd / batch（最朴素的探针）

`.cmd` / `.bat` 没法直接解 JSON，**只适合做"用 env 触发的轻量日志或固定阻断"**。复杂策略借助上面任一语言。

```bat
@echo off
REM ── env 直接可读 ─────────────────────────────────────
echo [hook] event=%HOOK_EVENT% tool=%TOOL_NAME% ws=%WORKSPACE_PATH% 1>&2

REM ── 想阻断时直接 exit /b 2 ───────────────────────────
if /I "%TOOL_NAME%"=="execute" (
  echo 禁止 execute 1>&2
  exit /b 2
)
exit /b 0
```

### 6.6 跨语言对照速查

| 任务 | PowerShell | Bash+jq | Python | Node.js |
|---|---|---|---|---|
| 读整份 stdin | `$input \| Out-String` | `cat` | `sys.stdin.read()` | 累加 `process.stdin.on("data")` |
| 解析 JSON | `\| ConvertFrom-Json`（5.x 不要 `-Depth`） | `jq -r '...'` | `json.load(sys.stdin)` | `JSON.parse(raw)` |
| 取嵌套字段 | `$p.tool_input.command`（先 `.PSObject.Properties[]` 判存在） | `jq -r '.tool_input.command // ""'` | `payload.get("tool_input",{}).get("command","")` | `(p.tool_input ?? {}).command` |
| 读 env | `$env:WORKSPACE_PATH` | `"$WORKSPACE_PATH"` | `os.environ.get("WORKSPACE_PATH","")` | `process.env.WORKSPACE_PATH` |
| 写 stderr | `[Console]::Error.WriteLine(...)` | `echo ... >&2` | `print(..., file=sys.stderr)` | `console.error(...)` |
| 写 stdout JSON | `\| ConvertTo-Json -Compress -Depth 10` | `jq -nc '{...}'` | `json.dump(..., sys.stdout)` | `process.stdout.write(JSON.stringify(...))` |
| 阻断退出 | `exit 2` | `exit 2` | `sys.exit(2)` | `process.exit(2)` |

> ⚠️ 三条铁律（不分语言）：
> 1. **日志只打 stderr**，stdout 是决策通道，混入文本会让 JSON 解析失败 → 退化成纯文本注入。
> 2. **stdin 是权威**，env 里的 `TOOL_ARGS / TOOL_RESULT` 超过 4KB 就没有，别依赖。
> 3. **退出码 2 才会阻断**，其它非零都是"钩子自己报错"。要可控阻断请用 stdout JSON 的 `decision` / `continue`。

---

## 7. 完整可跑示例

### 7.1 最小探针：观察所有 env 与 stdin 字段

文件：`~/.cmbcoworkagent/hooks/env-probe.ps1`

```powershell
$raw = ($input | Out-String)
try { $p = $raw | ConvertFrom-Json } catch { $p = $null }

$root = if ($env:WORKSPACE_PATH) { $env:WORKSPACE_PATH }
        elseif ($p -and $p.cwd) { [string]$p.cwd }
        else { [string](Get-Location) }

$logFile = Join-Path $root ".env-probe.log"

$lines = @(
  "===== $(Get-Date -Format o) ====="
  "HOOK_EVENT     = $env:HOOK_EVENT"
  "WORKSPACE_PATH = $env:WORKSPACE_PATH"
  "PLUGIN_ROOT    = $env:PLUGIN_ROOT"
  "TOOL_NAME      = $env:TOOL_NAME"
  "stdin.tool     = $($p.tool_name)"
  "stdin.cwd      = $($p.cwd)"
)
$lines | ForEach-Object { Add-Content -LiteralPath $logFile -Value $_ -Encoding UTF8 }

[Console]::Error.WriteLine("[env-probe] wrote $logFile")
exit 0
```

`hooks.json` 条目：

```json
{
  "id": "env-probe-001",
  "event": "PostToolUse",
  "matcher": "*",
  "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\\Users\\<你的用户名>\\.cmbcoworkagent\\hooks\\env-probe.ps1\"",
  "timeout": 5000,
  "enabled": true,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z"
}
```

让 Agent 跑任意工具，去工作区根目录看 `.env-probe.log`。

### 7.2 拦截危险命令（Python，PreToolUse）

`matcher: "execute"`：

```python
import json, sys
p = json.load(sys.stdin)
if p.get("tool_name") == "execute":
    cmd = str(p.get("tool_input", {}).get("command", "")).lower()
    if "rm -rf /" in cmd:
        json.dump({"continue": False, "stopReason": "极端高危命令"}, sys.stdout)
        sys.exit(0)
    if "push origin main" in cmd:
        json.dump({"decision": "block",
                   "reason": "请先建分支再 PR",
                   "systemMessage": "已阻断直推 main"}, sys.stdout)
        sys.exit(0)
print("ok"); sys.exit(0)
```

### 7.3 改写用户输入（PowerShell，UserPromptSubmit）

```powershell
$raw = ($input | Out-String)
try { $p = $raw | ConvertFrom-Json } catch { $p = $null }
if ($p -and $p.prompt -match "(?i)drop\s+(database|table)") {
  [pscustomobject]@{
    updatedInput  = @{ message = "请改为只读分析方案，列出影响面，不执行删除" }
    systemMessage = "已按策略改写请求"
    additionalContext = "用户原句涉及 DROP 操作，优先给出只读方案"
  } | ConvertTo-Json -Compress -Depth 10
}
exit 0
```

### 7.4 MCP 工具审计 + 写操作二次确认（Node.js，PostToolUse）

`matcher: "mcp__.*"`：

```js
const fs = require("fs"), path = require("path")
let raw = ""
process.stdin.on("data", c => raw += c)
process.stdin.on("end", () => {
  let p = {}
  try { p = JSON.parse(raw) } catch {}

  const tool = p.tool_name || ""
  const [, provider, method] = tool.split("__")

  // 审计落盘
  const logPath = path.join(process.env.WORKSPACE_PATH || ".", ".mcp-audit.log")
  fs.appendFileSync(logPath,
    `[${new Date().toISOString()}] ${tool} args=${JSON.stringify(p.tool_input).slice(0,400)}\n`)

  // GitHub 写操作要求 Agent 复述参数后再调用
  if (provider === "github" && /create|delete|merge|close|push/i.test(method || "")) {
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `MCP 写操作 ${tool} 已记录，请复述参数并征得用户确认后再调用`,
      additionalContext: `本次调用参数：${JSON.stringify(p.tool_input)}`
    }))
  }
  process.exit(0)
})
```

### 7.5 prompt 类型钩子（无脚本）

`hooks.json` 条目，不用写脚本，自然语言直接定策略：

```json
{
  "id": "no-destructive-sql",
  "event": "PreToolUse",
  "matcher": "execute",
  "type": "prompt",
  "prompt": "禁止执行任何包含 DROP、TRUNCATE、DELETE FROM 的 SQL 命令。",
  "modelId": "custom:claude",
  "fallback": "allow",
  "timeout": 10000,
  "enabled": true,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z"
}
```

`fallback="allow"` 表示**LLM 不可用 / 超时 / 返回非 JSON 时**放行；不是默认动作。严格环境用 `"block"`。

### 7.6 强制阻断（不用脚本逻辑）

`forcedOutcome` 直接由配置层兜底，脚本写什么都被覆盖：

```json
{
  "id": "halt-prod-edit",
  "event": "PreToolUse",
  "matcher": "edit_file|write_file",
  "type": "command",
  "command": "node \"C:\\Users\\<你的用户名>\\.cmbcoworkagent\\hooks\\audit.js\"",
  "forcedOutcome": "always-halt",
  "forcedReason": "本工作区为生产配置仓库，禁止任何写操作",
  "timeout": 5000,
  "enabled": true,
  "createdAt": "2026-05-20T00:00:00.000Z",
  "updatedAt": "2026-05-20T00:00:00.000Z"
}
```

脚本只用来打日志，业务结局已经由 `forcedOutcome` 锁死。

### 7.7 插件作用域钩子（验证 PLUGIN_ROOT）

把同样的钩子放在插件目录 `~/.cmbcoworkagent/plugins/<插件名>/hooks/hooks.json`，**无论拦哪个工具**，`PLUGIN_ID` / `PLUGIN_NAME` / `PLUGIN_ROOT` 都会有值：

```json
[
  {
    "id": "plugin-env-probe",
    "event": "PostToolUse",
    "matcher": "*",
    "type": "command",
    "command": "node hooks/record.cjs",
    "timeout": 10000,
    "enabled": true
  }
]
```

注意：插件目录里的 `hooks.json` 改完后必须在 UI 里**停用 → 再启用**该插件才生效。

---

## 8. 常见配置错误（自检清单）

实际见过的坑：

| 症状 | 原因 | 修复方向 |
|---|---|---|
| 钩子写了但没生效 | `enabled: false` / matcher 写错 / event 写错 | 先把 matcher 设 `"*"` + 最小命令验证能否触发 |
| 插件 hook 改了 hooks.json 不生效 | 插件配置在加载时缓存 | UI 里停用 → 再启用该插件，或重启 App |
| `echo 'exit 2'` 没阻断 | echo 不会改退出码 | 用真正的 `exit 2` 或 `cmd /c "exit 2"` |
| 日志写到了用户目录而不是项目 | 用了相对路径或进程 cwd | 显式拼接 `WORKSPACE_PATH` |
| `TOOL_ARGS` env 是空的 | 入参 > 4KB 被丢弃 | 读 stdin JSON 的 `tool_input` |
| `tool_response` 是字符串不是对象 | 上游 JSON 不合法时回退原文 | 做类型判断再访问字段 |
| 所有工具调用都慢了几秒 | 挂了 `matcher: "*"` 的 prompt 钩子，每次走 LLM | matcher 收紧 / 改 command 类型 / 关掉 |
| stdout 里既输出日志又输出 JSON，JSON 没被识别 | 解析只接受 stdout **整体**是 JSON | 日志一律打 stderr，stdout 只放最终 JSON |
| PowerShell 脚本 stdin 总是空，但 env 正常 | Windows PS 5.x + `-File` 模式 stdin 不可达 | 改用 `$input` 自动变量 |
| `ConvertFrom-Json -Depth N` 报"找不到参数名称 Depth" | `-Depth` 是 PowerShell 7+ 才加的 | 5.x 上去掉 `-Depth` |
| 深层 `tool_response` 序列化截断 | `ConvertTo-Json` 默认 `-Depth 2` | 显式 `-Depth 10` |
| PostSkillUse stdout 没进上下文 | PostSkillUse 非阻塞输出**不回灌**（设计如此） | 改用 `decision=block` + `additionalContext`，或换 PostToolUse |
| 钩子阻断不了反被绕过 | 非零退出码 ≠ 2 被当成"自身报错" | 想阻断必须 `exit 2` 或 JSON `decision=block` |
| `PLUGIN_ROOT` 一直为空 | 钩子在全局且拦的是内置工具 | 把钩子搬到插件目录，或拦插件提供的工具 |

---

## 9. 调试技巧

1. **日志双通道**：stderr 给你看，stdout 给系统看。永远把诊断信息打到 stderr，不影响决策。
2. **最小化验证**：先用 `matcher: "*"` + 一行打印命令验证能触发，再逐步加策略。
3. **看 Hook 执行记录**：UI 的 Hook 面板能看到每次触发的退出码、`decision`、`continue`、stderr 内容——比翻日志快。
4. **dump payload**：把整份 stdin JSON 打到 stderr 一份，立刻看到实际字段，比对着文档猜更准。
5. **超时排查**：`timeout` 默认 10s。LLM 类钩子拉到 20-30s；本地脚本能压到 2-3s 暴露慢路径。
6. **once 一次性钩子**：开发期不要用 `"once": true`，触发一次后就消失，看起来像没生效。
7. **forcedOutcome 是兜底闸**：脚本逻辑还不稳时，挂上 `"always-halt"` 强制阻断先把规则跑通再撤掉。
8. **对照实验定位 PLUGIN_ROOT**：同一份探针脚本，分别挂在全局 hooks.json 和插件 hooks.json 各一次，对比两份日志最快搞清作用域。

---

## 10. 安全建议

- 钩子脚本以**当前用户身份**执行，等同于任意本地命令——不要从不可信来源粘贴。
- 全局 `hooks.json` 由 UI 写入；插件 / 技能 / 工作区 hooks 在首次加载时会经过一次信任确认（记录在 `~/.cmbcoworkagent/trusted-workspace-hooks.json`）。
- prompt 类型钩子会把工具参数（含潜在敏感数据）发给指定 LLM——不要把生产 API key 写到会被钩子捕获的工具入参里。
- 高风险动作建议同时挂 PreToolUse（阻断）+ PostToolUse（审计）两层，前者防止发生、后者留证据。
- `forcedOutcome: "always-halt"` 是最稳的"红线开关"——脚本可能被改、被绕，但 forcedOutcome 在配置层强制生效，适合关键合规场景。
