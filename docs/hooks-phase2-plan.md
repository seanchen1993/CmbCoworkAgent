# Hook 体系第二期规划 — OMC（Oh My Claude Code）兼容性扩展

> 本文档独立可读。所有兼容性约束、错误分类器设计、全链路改点表均内联，不需要回查一期文档。
> 一期成果分支：`feature/optimize-hook-types`（已合入 PR-01 / PR-02 / PR-05，PR-06 撤回）

---

## Errata — 与 Claude Code 源码核对的修订

本文档历经一次基于 [c:/ai/claude-code/src](../../claude-code/src/) 的逐条复核，纠正以下事实错误。所有下方文字都按修订版本表述。

| 修订项 | 旧说法（错）| CC 源码实情 |
|--------|-------------|-------------|
| `prompt` handler type 归属 | "本项目特有" | CC [src/schemas/hooks.ts:67-95](../../claude-code/src/schemas/hooks.ts) 早就有；本项目与 CC 共有。**项目特有的只是 PreSkillUse/PostSkillUse 两个事件 + prompt hook 的 `fallback` 字段** |
| HTTP hook 默认超时 | 5000ms | CC [execHttpHook.ts:12](../../claude-code/src/utils/hooks/execHttpHook.ts) `DEFAULT_HTTP_HOOK_TIMEOUT_MS = 10 * 60 * 1000`（10 分钟）|
| HTTP hook 安全模型 | "默认禁私网包括 loopback" | CC SSRF guard **明确允许 loopback**（[ssrfGuard.ts:12-13、:67-68](../../claude-code/src/utils/hooks/ssrfGuard.ts)：`"Loopback (127.0.0.0/8, ::1) is intentionally ALLOWED — local dev policy servers are a primary HTTP hook use case."`）。只拦截 `0.0.0.0/8` / `10.0.0.0/8` / `100.64.0.0/10`（CGNAT，含 Alibaba 云元数据）/ `169.254.0.0/16`（cloud metadata）/ `172.16.0.0/12` / `192.168.0.0/16`，IPv6 拦 `fc00::/7` / `fe80::/10`。完整安全栈：URL 白名单 + SSRF guard + 每 hook `allowedEnvVars` + CRLF 注入清洗 + sandbox 代理路由 |
| `async` 协议形态 | "stdout JSON `{async:true, asyncTimeout}`，配置层不存在" | **CC 同时有两层**：（a）**配置层** [schemas/hooks.ts:55-64](../../claude-code/src/schemas/hooks.ts#L55) 的 `async / asyncRewake` 字段，hook 配置时声明；（b）**stdout 协议** [AsyncHookRegistry.ts:30-83](../../claude-code/src/utils/hooks/AsyncHookRegistry.ts#L30)，hook 启动后第一行 stdout 输出 `{"async": true, "asyncTimeout": N}` 即被运行时识别为 async、转入后台（[utils/hooks.ts:1127](../../claude-code/src/utils/hooks/hooks.ts#L1127)）。stdout async 默认 `asyncTimeout = 15000ms`（不是我原说的"没有此字段"）|
| 多维 matcher 设计 | 我提议新增 `eventMatchers` 对象字段 | CC 没这个字段；**CC 是单 `matcher` 字符串 + per-event 不同 matchQuery** + **每 hook 独立 `if` 字段**（permission rule syntax pre-filter） |
| handler types 总数 | "5 个：command/prompt/http/agent/mcp_tool" | CC 持久化 schema 只有 **4 个 discriminated union 成员**：`command`、`prompt`、`http`、`agent`（[schemas/hooks.ts:183](../../claude-code/src/schemas/hooks.ts#L183)）。**没有 `mcp_tool`**，那是第三方文档/博客的错误总结。CC 另有 `callback` / `function` 两个不可持久化的运行时类型 |

新增以下 CC 已有但我之前漏提的字段（全是普惠改进，与 OMC 兼容性正交）：

- **`if` 字段（每 hook 单独的 pre-filter）**：permission rule syntax（如 `"Bash(git *)"`、`"Read(*.ts)"`），matcher 命中后进一步过滤，避免 spawn 不相关 hook。**这是 CC matcher 机制的核心补强，比单 matcher 字符串强大得多**。
- **`shell` 字段**（command hook）：`bash` / `powershell` / `sh` 显式指定 shell。本项目今天靠 `process.platform === "win32"` 隐式判定，但用户可能想在 Windows 上跑 bash（WSL / Git Bash）。
- **`statusMessage` 字段**：自定义 spinner 文案，在 hook 执行时显示给用户。UI 改善项。
- **`once` 字段**：本项目已有，对齐 CC 行为即可。
- **`model` 字段**（prompt / agent hook）：本项目用 `modelId`，CC 用 `model`。**字段名不一致是兼容性问题**。

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [当前能力基线](#2-当前能力基线)
3. [OMC 类框架的硬需求清单](#3-omc-类框架的硬需求清单)
4. [Claude Code 上游全集对照](#4-claude-code-上游全集对照)
5. [二期范围决断](#5-二期范围决断)
6. [公共兼容性约束 CC1–CC11](#6-公共兼容性约束-cc1cc11)
7. [PR 拆分总览](#7-pr-拆分总览)
8. [P0 PR 详细设计](#8-p0-pr-详细设计)
9. [P1 PR 详细设计](#9-p1-pr-详细设计)
10. [跨 PR 共建的基础设施](#10-跨-pr-共建的基础设施)
11. [明确不在本期范围](#11-明确不在本期范围)
12. [验收标准](#12-验收标准)
13. [开放问题](#13-开放问题)

---

## 1. 背景与目标

让本项目能承载 **oh-my-claudecode / claude-forge / claude-code-hooks-mastery** 这类"oh-my-zsh 风"的 Claude Code 扩展框架。这类框架的共性是：

- **多 Agent 编排**：按 `agent_type` 路由 hook 决策
- **Webhook 网关**：把事件 POST 到 Discord / Slack / 内部审计服务
- **多层 hook 栈**：security / quality / tracking 各层 hook 串联
- **生命周期全覆盖**：claude-forge 21 lifecycle events，hooks-mastery 13 events 全覆盖

调研的代表项目：
- [yeachan-heo/oh-my-claudecode](https://github.com/yeachan-heo/oh-my-claudecode) — Teams-first 多 Agent 编排，19 agents + 36 skills
- [disler/claude-code-hooks-mastery](https://github.com/disler/claude-code-hooks-mastery) — 全 13 hook 事件覆盖样板
- [sangrokjung/claude-forge](https://github.com/sangrokjung/claude-forge) — 15 内置 hooks + 9 opt-in，21 lifecycle 事件，inspired by oh-my-zsh

---

## 2. 当前能力基线

### 2.1 已支持的 10 个 hook 事件

| 事件 | 触发点 |
|------|--------|
| `PreToolUse` | [src/main/agent/local-sandbox.ts:1766](../src/main/agent/local-sandbox.ts#L1766) |
| `PostToolUse` | local-sandbox.ts 多处 |
| `PreSkillUse`（项目自有）| local-sandbox.ts |
| `PostSkillUse`（项目自有）| [src/main/agent/skill-lifecycle/completion-hooks.ts](../src/main/agent/skill-lifecycle/completion-hooks.ts) |
| `UserPromptSubmit` | [src/main/ipc/agent.ts:1623](../src/main/ipc/agent.ts#L1623) |
| `SessionStart` | [src/main/hooks/session-lifecycle.ts:48](../src/main/hooks/session-lifecycle.ts#L48) |
| `SessionEnd` | session-lifecycle.ts:70 |
| `Stop` | completion-hooks.ts:313 |
| `SubagentStop` | [src/main/ipc/agent.ts:298](../src/main/ipc/agent.ts#L298)（从 stream 的 task ToolMessage 推断）|
| `Notification` | [src/main/agent/runtime.ts:1748](../src/main/agent/runtime.ts#L1748)（仅审批入口）|

### 2.2 已支持的 2 个 handler types

`command`（shell 子进程）+ `prompt`（LLM 评估自然语言策略，对应 CC 同名 type）。

**与 CC 的实现差异**（不影响通用性，但用户脚本不可直接迁移）：

| 维度 | 本项目 | CC `prompt` hook |
|------|--------|------------------|
| LLM 接收形态 | 自构 `policy + payload` JSON 信封作为 user message | 用户写自然语言 prompt，**`$ARGUMENTS` 占位符**被替换为 hook input JSON |
| 模型字段名 | `modelId` | `model` |
| 失败兜底 | `fallback: "allow" \| "block"`（LLM 超时/错误时的二值策略）| **没有此字段**——错误就报错给用户 |
| `if` 预过滤字段 | 无 | 有（[schemas/hooks.ts:19](../../claude-code/src/schemas/hooks.ts#L19) `IfConditionSchema`，permission rule syntax）|

**严格说本项目独有的能力**：
- `PreSkillUse` / `PostSkillUse` 两个事件（CC 没有 skill 概念）
- prompt hook 的 `fallback` 字段
- 命令 hook 上的 `onBlock` 配置 + `forcedOutcome` 配置层强制覆盖
- prompt + command 之外没有其他 handler type

### 2.3 已声明但运行时未触发（10 个，存储层在所有读取路径过滤丢弃）

`PostToolUseFailure`、`StopFailure`、`SubagentStart`、`PreCompact`、`PostCompact`、`PermissionRequest`、`PermissionDenied`、`Setup`、`CwdChanged`、`FileChanged`。

> 这些事件名在 [src/main/hooks/types.ts](../src/main/hooks/types.ts) 的 `HookEvent` 联合中保留，但不在 `SUPPORTED_HOOK_EVENTS` 里。`isSupportedHookEvent` 守门 → IPC 创建拒绝、5 个读取路径全部过滤、CC `settings.json` 导入也丢弃。

### 2.4 一期已落地的辅助能力

- `HookContext` 已加 `transcriptPath / permissionMode / agentId`（透传协议就绪，仅 Notification 填了 `permissionMode`，其余字段无填充入口）
- `HookResult` 已加 `initialUserMessage / watchPaths`（解析就绪，消费侧待补）
- `parseHookJsonOutput` 已识别 `hookSpecificOutput` 嵌套形态

---

## 3. OMC 类框架的硬需求清单

| 需求 | 出处 | 本项目今天 | 缺口大小 |
|------|------|-----------|---------|
| **HTTP 处理器**（hook 把事件 POST 到 webhook 网关）| oh-my-claudecode `bridge.ts` 完全依赖；OMC 通知 / Discord / Slack 集成走这条 | 无 | **大** |
| **`PostToolUseFailure`** | claude-forge `security-auto-trigger.sh`、hooks-mastery 都用 | 声明未触发 | 中 |
| **`SubagentStart` + `agent_type` 匹配** | 三个项目都用于成本追踪、按 agent 类型路由 | 声明未触发 | 中 |
| **`Setup`** | hooks-mastery 用于 repo init / 维护 | 声明未触发 | 小 |
| ~~**`TaskCreated / TaskCompleted`**~~ | ~~claude-forge `task-completed.sh`；依赖 CC `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`~~ | 未声明 | **本期不做（§13.2 决议 3）** |
| **per-event matchQuery + `if` 字段**（按 `agent_type / source / notification_type` 细分；`if` 做 per-hook pre-filter）| OMC 风格的"按工具 / 按 agent 类型"路由 | matcher 仅按 `toolName / skillName` 匹配；无 `if` 字段 | 中 |
| **`async` hook**（`{"async":true}`）| HTTP / agent / 慢扫描 hook 必须 | 全部同步阻塞 | 中 |
| **`agent` 处理器**（多轮 LLM + 完整 tool 池 + structured output schema）| claude-forge 文档列出；实际用例集中在 ExitPlanMode / 复杂校验 hook | 无 | **大**（需要 deepagents 集成 + structured output 协议）|
| **跨 hook 状态共享**（共享 log dir / session data）| 三家都用 `~/.claude/data/sessions` 或自定 log dir | hook log dir 已有 | 基本满足 |
| **Marketplace 清单** | OMC `.claude-plugin/marketplace.json` | 插件机制已有，可对齐 | 基本满足 |

---

## 4. Claude Code 上游全集对照

### 4.1 事件清单（核自 [c:/ai/claude-code/src/entrypoints/sdk/coreSchemas.ts:355-383](../../claude-code/src/entrypoints/sdk/coreSchemas.ts) `HOOK_EVENTS`）

CC 持久化的 hook 事件共 **27 个**：

| 类别 | 事件（✓ = 本项目已支持）|
|------|-----|
| Session-Level | `SessionStart` ✓、`Setup`、`SessionEnd` ✓ |
| Turn-Level | `UserPromptSubmit` ✓、`Stop` ✓、`StopFailure` |
| Agentic Loop | `PreToolUse` ✓、`PostToolUse` ✓、`PostToolUseFailure`、`PermissionRequest`、`PermissionDenied` |
| Agent / Team | `SubagentStart`、`SubagentStop` ✓、`TeammateIdle`、`TaskCreated`、`TaskCompleted` |
| File / Env | `InstructionsLoaded`、`ConfigChange`、`CwdChanged`、`FileChanged`、`WorktreeCreate`、`WorktreeRemove` |
| Context | `PreCompact`、`PostCompact` |
| Notification / MCP | `Notification` ✓、`Elicitation`、`ElicitationResult` |
| 项目自有（非 CC）| `PreSkillUse` ✓、`PostSkillUse` ✓ |

> 注：早前我写过的 `UserPromptExpansion / PostToolBatch` 在 `HOOK_EVENTS` 数组里**找不到**（搜了 grep `UserPromptExpansion` / `PostToolBatch` on c:/ai/claude-code/src 都 0 match）。第三方博客的 "32+ events" 说法包含了"matcher 子类型"，不是独立事件。本表只列 schema-level 真实存在的。

### 4.2 Handler types（核自 [src/schemas/hooks.ts:183-189](../../claude-code/src/schemas/hooks.ts) 的 discriminatedUnion）

CC 持久化的 handler types **共 4 个**：

| Type | 配置形态 | 执行机制 | 本项目 |
|------|---------|---------|--------|
| `command` | `{ command, shell?, timeout?, async?, asyncRewake?, statusMessage?, once?, if? }` | 起子进程跑 shell；stdin 喂 JSON、stdout 读决策 | ✓（无 `shell` / `async` / `asyncRewake` / `statusMessage` / `if`）|
| `prompt` | `{ prompt, model?, timeout?, statusMessage?, once?, if? }` | Haiku 单轮 LLM；prompt 中的 `$ARGUMENTS` 被替换为 hook input JSON | ✓（字段名 `modelId` ≠ CC 的 `model`；有项目特有 `fallback`；无 `if` / `statusMessage`） |
| `http` | `{ url, method?, headers?, allowedEnvVars?, timeout?, statusMessage?, once?, if? }` | axios POST；CC 默认 10 分钟超时（[execHttpHook.ts:12](../../claude-code/src/utils/hooks/execHttpHook.ts#L12)）；SSRF guard、URL 白名单、env var 显式列表插值 | **无**（PR-14 实现；本项目默认更短 30s 见 PR-13a；**不做 SSRF / URL 白名单**，仅做 env var 列表 + CRLF 清洗，见 §13.2）|
| `agent` | `{ prompt, model?, timeout?, statusMessage?, once?, if? }` | 多轮 LLM `query()` 跑，**带 structured output schema**，默认 60s，默认 Haiku | **无**（暂不实现，见 §11）|

CC 另有 **2 个不可持久化** 的运行时 handler：

- `callback`（[types/hooks.ts:210-226](../../claude-code/src/types/hooks.ts#L210)）：内置 JS 回调，用于 sessionFileAccessHooks / attributionHooks 等内部分析钩子
- `function`（[utils/hooks.ts:1423](../../claude-code/src/utils/hooks.ts#L1423)）：session-scoped 函数式钩子

这两个不会出现在 `settings.json` 里，所以本项目暂不需要对齐。

---

## 5. 二期范围决断

按 "OMC 跑起来的最小集" 划分：

| 优先级 | 项目 | 理由 |
|--------|------|------|
| **P0**（必做，OMC 阻塞）| `http` handler、`PostToolUseFailure`、`SubagentStart`、`Setup`、`async` 协议 | 这五件少了 OMC 跑不起来 |
| **P1**（OMC 体验大幅提升）| per-event matchQuery + `if` 字段（含 agent_type 匹配） | 多 agent 路由 |
| **P2**（兼容补全，非阻塞）| `StopFailure`、`PermissionRequest / PermissionDenied`、`InstructionsLoaded` | 用得到但不致命 |
| **P3**（独立子系统）| `CwdChanged`、`FileChanged`、`ConfigChange`、`WorktreeCreate / Remove` | 需要文件 watcher + env file 机制 |
| **P4**（暂不做）| `agent` handler、`mcp_tool` handler、`Elicitation / ElicitationResult`、`UserPromptExpansion`、`PostToolBatch`、`TeammateIdle` | 实现成本高 / 本项目无对应能力 |

**本期落地 P0 + P1**（PR-11 ~ PR-17 + PR-13a / PR-13b 两个基础 PR，共 9 个）。PR-18（agent teams）按 §13.2 决议 3 移到 §11；P2 / P3 / P4 留到第三期。

---

## 6. 公共兼容性约束 CC1–CC11

**每个 PR 在 PR description 里必须逐条声明"满足 / 不涉及 / 显式妥协"。**

### 一期延续（CC1–CC8）

| 编号 | 约束 | 原因 / 实施要求 |
|------|------|----------------|
| **CC1** | `HookEvent` 联合类型**只新增、不删除** | UI 已渲染所有事件徽章；插件 / 外部代码可能 `import type { HookEvent }` |
| **CC2** | `HookConfig` 现有字段语义、可选性不变 | 持久化在 `~/.cmbcoworkagent/hooks.json` + 插件 / 技能 `hooks.json` |
| **CC3** | 命令 hook 的 stdin payload 现有 key（`hook_event_name / session_id / cwd / tool_name / tool_input / tool_response / prompt / skill_name / ...`）不动 | 用户脚本依赖；只能新增 key |
| **CC4** | 环境变量现有命名（`HOOK_EVENT / TOOL_NAME / WORKSPACE_PATH / CLAUDE_PROJECT_DIR / ...`）不动 | 同上；仅追加 |
| **CC5** | `parseHookJsonOutput` 现有顶层 9 字段优先级不变 | hook stdout 协议；`hookSpecificOutput` 作为叠加层 |
| **CC6** | matcher 现有行为不变（`PreSkillUse / PostSkillUse` 匹配 `skillName`，其余匹配 `toolName`，`*` 永远匹配）| 用户配置 `matcher: "execute"` 等不能失效 |
| **CC7** | CC `settings.json` 导入语义不变 | 跨产品迁移路径 |
| **CC8** | 不引入新的同步阻塞点 | 新事件默认 fire-and-forget；阻断 / halt 能力必须显式标注 |

### 二期新增（CC9–CC11）

| 编号 | 约束 | 原因 |
|------|------|------|
| **CC9** | 新 handler type `http` 的请求 / 响应协议必须可被 IPC 校验拒绝错配；不能让用户在 UI 上配 `type=http` 但漏写 `url` | 防止运行时 NPE |
| **CC10** | `async` 标志一旦写入 hook 配置，必须能在 UI / 日志清晰区分"已 fire 但未完成" vs 同步 hook 的 "已 fire 已完成" | 否则用户看不到 async hook 是否真跑完 |
| **CC11** | 新 handler 与新事件**绝不**改变现有 `command` + `prompt` 行为；HookConfig 的判别仍以 `type` 字段为准，缺省 = `command` | 防止 schema 漂移影响存量 |

---

## 7. PR 拆分总览

| # | PR | Tier | LOC | OMC 价值 | 兼容风险 | 依赖 |
|---|----|------|-----|---------|---------|------|
| **PR-13a** | **Timeout 单位与上限统一化**（按 handler type 设不同上限）| T0 | ~150 | 低（基础设施） | 零 | — |
| **PR-13b** | **CC 字段名对齐**（`modelId` ↔ `model`、加 `statusMessage` / `shell` 字段） | T0 | ~200 | 中（迁移友好） | 低 | — |
| PR-11 | `Setup` 事件接入 | T0 | ~200 | 中 | 零 | — |
| PR-12 | `PostToolUseFailure` + 错误分类器 + 统一 failure helper | T0 | ~400 | 高 | 零 | — |
| PR-13 | `SubagentStart`（含 agent_id 联动 SubagentStop）| T0 | ~250 | 高 | 零 | — |
| PR-14 | **`http` handler type** ⭐（无 SSRF / 无 URL 白名单，§13.2 决议 1） | T1 | ~400 | 高 | 低 | PR-13a / PR-13b / PR-15 |
| PR-15 | **`async` 配置层**（asyncRewake / B 层 stdout async 均延期）⭐ | T1 | ~350 | 高 | 低 | PR-13a |
| **PR-16** | **per-event matchQuery + `if` 字段**（按 CC 真实机制）| T1 | ~700（全链路 + `if` 解析器）| 高 | 中（Notification 双 matcher fallback）| PR-13 |
| PR-17 | `StopFailure` 事件 | T2 | ~250 | 中 | 零 | PR-12（共用错误分类器）|
| ~~PR-18~~ | ~~`TaskCreated / TaskCompleted`~~ | — | — | — | — | **§13.2 决议 3 不做，挪到 §11** |

**推荐合入顺序**：PR-13a → PR-13b → PR-11 → PR-12 → PR-13 → PR-15 → PR-14 → PR-16 → PR-17。共 **9 个 PR**，每个独立可 revert。

> - **PR-13a / PR-13b 必须最先合入**：timeout 上限和字段名对齐是底层 schema 调整，越早做后续 PR 越省事，避免每个新 handler 又写一遍迁移逻辑。
> - 顺序里 PR-15 排在 PR-14 之前的理由：HTTP hook 默认会触发 OMC 用户配 async 的需求。如果 PR-14 先合，没有 async 协议时 HTTP 网关延时会直接卡 turn，体验劣化。

---

## 8. P0 PR 详细设计

### PR-11 — `Setup` 事件接入

**目标**：在 **workspace 首次接触** + 周期性维护时触发 `Setup`，对齐 CC 的 repo init / maintenance 用途。

**去重粒度（关键设计点）**

CC 的 `Setup` 用途是 "repo 初始化"——是**工作区维度**的概念，不是 thread 维度。本项目今天 `SessionStart` 是 **per-thread per main-process** 触发（[session-lifecycle.ts:25 `startedSessions: Map<threadId, ...>`](../src/main/hooks/session-lifecycle.ts#L25)）——如果直接搭在 SessionStart 之后，每个新 thread 都会重新触发 init，**这是错的**。

按 workspace 去重：

| 维度 | 触发条件 | 持久化位置 |
|------|---------|----------|
| `init` | 每个**未初始化的 workspace**首次在本项目里被使用时**仅触发一次** | `<workspacePath>/.cmbcoworkagent/setup-state.json` 记录已 init 标志（含 init 时间、init hook 哈希）|
| `maintenance` | 用户主动点 UI "重新初始化工作区"；或 setup-state 中标记的 init hook 哈希与当前不一致（暗示用户改了 init hook 想重跑）| 不持久化，每次触发 |

**触发点**
- `trigger: "init"`：在 `fireSessionStartOnce`（[session-lifecycle.ts:26](../src/main/hooks/session-lifecycle.ts#L26)）触发**之前**做 workspace setup-state 检查 → 未 init → fire `Setup({trigger:"init", workspace_path})`，等待返回后再写 setup-state 标志（避免 hook 失败但 state 已写）
- `trigger: "maintenance"`：UI "重新初始化工作区" 入口；或在 init 检查阶段发现 hook 哈希变了（diagnostic-only，文档明确）

**改动**

1. `SUPPORTED_HOOK_EVENTS`（[types.ts](../src/main/hooks/types.ts)）+ `AddHookDialog` `HOOK_EVENTS` 加 `Setup`
2. 新增 [src/main/services/setup-state.ts](../src/main/services/setup-state.ts)：读写 `<workspacePath>/.cmbcoworkagent/setup-state.json`
3. `fireSessionStartOnce` 之前插一段 setup 检查；fire `Setup` 后再设 SessionStart context
4. UI 新增"重新初始化工作区"入口（settings 面板或 workspace tab）
5. payload：
   ```json
   { "trigger": "init" | "maintenance", "workspace_path": "<abs path>" }
   ```
6. **空 workspacePath 场景**：thread 未关联 workspace 时（如全局对话），不触发 Setup——文档明确

**兼容性自检**
- CC1 通过；CC8 通过（fire-and-forget）
- 新增持久化文件 `.cmbcoworkagent/setup-state.json`——首次合入时 workspace 都没这文件，相当于"所有 workspace 都未初始化"。如果用户有大量旧 workspace + 配了 Setup hook，**首次升级时所有 workspace 都会触发一次 init**。这是预期行为，但**导入风险**：如果用户的 init hook 有副作用（如 commit 文件），可能在多个 workspace 一次性产生大量副作用。文档建议首次发布前在 changelog 显眼提示

**测试**
- 新 workspace 首次启动 → init 触发；同 workspace 第二个 thread → 不触发；删 `.cmbcoworkagent/setup-state.json` → 重新 init
- maintenance 入口 → 每次都触发
- workspacePath === undefined → 既不触发也不写文件
- 0 个 Setup hook → spawn 计数 0、`.cmbcoworkagent/setup-state.json` **仍然写入**（"已经过这一步"标志，避免 hook 之后才配上导致重复 init）

**回滚**：从 SUPPORTED 集合去除即可。`.cmbcoworkagent/setup-state.json` 文件留在用户 workspace 里无害（旧版本读不到这个文件、新版本回滚后也无人读）。

---

### PR-12 — `PostToolUseFailure` 事件 + 错误分类器

**目标**：工具异常时触发 `PostToolUseFailure`，附带分类的 `error_type`，让 OMC 的 `security-auto-trigger.sh` 类 hook 可按错误类型决策。

**错误分类器（新建于 [src/main/agent/failover.ts](../src/main/agent/failover.ts) 同文件）**

本项目唯一的错误处理是 [failover.ts](../src/main/agent/failover.ts)，但只有二值 `isRetryableApiError(error) → boolean`。新加 `classifyApiError(error): StopFailureErrorCode`，复用其 `getStatusCode` / `RETRYABLE_MESSAGE_PATTERNS` 原语，输出 **6 值最小集**：

| 枚举 | 判定依据（按优先级从高到低）|
|------|-----------------------------|
| `authentication_failed` | `status === 401 \|\| status === 403` |
| `invalid_request` | `status === 400`（含 `billing_error`、`max_output_tokens`，都归这里——本项目无法可靠区分；上游 CC 也允许 `unknown`）|
| `rate_limit` | `status === 429 \|\| message 含 "rate limit"` |
| `server_error` | `status ∈ [500, 599] \|\| message 含 "internal server error" / "bad gateway" / "service unavailable" / "gateway timeout"` |
| `network_error` | `error.code ∈ {ECONNREFUSED, ECONNRESET, ETIMEDOUT, ENOTFOUND, EPIPE, EAI_AGAIN} \|\| message 含 "fetch failed" / "socket hang up" / "network error" / "timeout"` |
| `unknown` | 其他 |

**与 CC 上游不完全一致**——少 `billing_error / max_output_tokens`（本项目无可靠信号源），多 `network_error`（桌面端常见）。文档显式标记"本项目方言"。

**"工具失败"的多种现实形态（先把定义说清）**

本项目工具失败**不是只有 throw**，至少 4 种路径：

| 路径 | 现状 | 示例 |
|------|------|------|
| (a) 抛 JS 异常 | 被 [toolErrorMiddleware (runtime.ts:953)](../src/main/agent/runtime.ts#L953) 捕获，转换为 `ToolMessage({status: "error"})` 喂回模型 | schema 校验失败、运行时 TypeError、abort 异常 |
| (b) 工具 handler 主动返回带 error 状态的结果 | 工具内 `return { success: false, error: "..." }`；对模型来说是有 content 的 ToolMessage | `execute` 工具非零 exitCode、`read_file` 文件不存在 |
| (c) deepagents 内部把抛出转 ToolMessage | langgraph `ToolInvocationError` 等被 deepagents 中间件转换 | wrap 异常时的二次包装 |
| (d) 子进程异常退出但没抛 | `execute` 工具 stderr + 非零 exitCode，hook 视角是工具"成功完成但业务失败" | bash 命令 `grep -q pattern` 返回 1 |

**早前的设计错了**："扫描 try/catch 调用 runHooks" 会**漏掉 (b) 和 (d)**——这两条是 OMC `security-auto-trigger.sh` 类 hook 最关心的（命令失败、文件没读到、API 调用返回 400）。

**正确的统一触发策略：在 `toolErrorMiddleware` 拦截层 + 工具结果检查层各加一处**

**策略 A — `toolErrorMiddleware` 统一拦截 (a)(c)**：在 [runtime.ts:953 toolErrorMiddleware](../src/main/agent/runtime.ts#L953) `unwrapToolFailure` 之后、`return new ToolMessage(...)` 之前 fire-and-forget `runHooks("PostToolUseFailure", ...)`，把 recovered.kind / recovered.message 作为 payload 一部分。

**策略 B — 通用 `detectToolFailure` helper 处理 (b)(d)**：新增 [src/main/hooks/tool-failure.ts](../src/main/hooks/tool-failure.ts)：
```ts
export interface ToolFailureSignal {
  kind: "throw" | "exit-nonzero" | "explicit-error" | "abort" | "timeout"
  message: string
  errorType: StopFailureErrorCode  // 调用 classifyApiError 复用 PR-12 的分类器
  isInterrupt: boolean
  isTimeout: boolean
}

export function detectToolFailure(
  toolName: string,
  toolResult: unknown,
): ToolFailureSignal | null {
  // 检查 ToolMessage.status === "error"
  // 检查 result.success === false
  // 检查 result.is_error === true
  // 检查 result.exitCode 非零（仅 execute / playwright 等 shell-like 工具）
  // 检查 result.error 字段存在且非空
  // 返回失败信号或 null
}
```

这个 helper 在每个 PostToolUse hook 触发点（[local-sandbox.ts:1783、2063、2142、...](../src/main/agent/local-sandbox.ts)）之后**额外调用一次**。已有 PostToolUse 触发的地方一律加 `const failure = detectToolFailure(...); if (failure) runHooks("PostToolUseFailure", ...)`。

**避免双触发**：策略 A 触发后通过 `_firedFailureToolCallIds: Set<string>` 标记 tool_call_id，策略 B 检查同一 set 跳过。统一去重以 `tool_call_id` 为键。

**改动**

1. `SUPPORTED_HOOK_EVENTS` + AddHookDialog 加 `PostToolUseFailure`
2. 新增 `classifyApiError` 于 [failover.ts](../src/main/agent/failover.ts)（共用 PR-17）
3. 新增 [src/main/hooks/tool-failure.ts](../src/main/hooks/tool-failure.ts)：`detectToolFailure` + `_firedFailureToolCallIds` 去重 set
4. `toolErrorMiddleware`（[runtime.ts:953](../src/main/agent/runtime.ts#L953)）在 `return new ToolMessage` 前 fire `PostToolUseFailure`
5. PostToolUse 触发点统一调用 `detectToolFailure`；若返回非 null 且 tool_call_id 未在 fire set 中，fire `PostToolUseFailure`
6. payload：
   ```json
   { "tool_name": "...", "tool_input": {...}, "tool_use_id": "...",
     "error": "<message>", "error_type": "<6 值之一>",
     "failure_kind": "throw" | "exit-nonzero" | "explicit-error" | "abort" | "timeout",
     "is_interrupt": <bool>, "is_timeout": <bool> }
   ```
   注：`failure_kind` 是项目方言（CC 没有这个字段），但对 OMC 框架按失败种类路由 hook 很有用，作为可选字段透传

**runner.ts 分发**：[runner.ts:921](../src/main/hooks/runner.ts#L921) 新增 `PostToolUseFailure` 落到 fire-and-forget 分支（与 Notification 同款），**不读 stdout 决策、不影响 turn**

**兼容性自检**
- CC1 通过；CC3 仅新增 payload key；CC8 通过
- 已有 PostToolUse 行为完全不变：detectToolFailure 是**额外**检查，不修改 PostToolUse 结果

**测试**
- 4 种失败路径 fixture 各至少 1 条：
  - (a) 工具 throw → 统一 catch 处 fire 1 次
  - (b) `execute` 返回 `{ success: false, exitCode: 1 }` → detect helper fire 1 次
  - (c) langgraph 抛 ToolInvocationError → 统一 catch 处 fire 1 次
  - (d) `execute` 返回 `{ exitCode: 1, stderr: "..." }` 但模型视角"成功" → detect helper fire 1 次
- 同一 tool_call_id 在 (a) 和 (b) 路径都触发 → 仅 fire 1 次（去重）
- abort 路径（signal.aborted 为真）→ `failure_kind: "abort"`，`is_interrupt: true`
- 0 hook 场景的零副作用断言：spawn 计数 0、`detectToolFailure` 仍调用但无后续 IO
- 错误分类映射单测：每个枚举值至少一条 fixture

**已知风险**
1. `detectToolFailure` 对工具返回形态的判断**没有正式 schema**——本项目工具结果是 ad-hoc 形状，helper 要 best-effort 多种字段名（success / is_error / exitCode / error）。**这是 PR-12 的复杂度核心，不要低估**：debug 期间应在 hook log 显式打印 helper 的判断输入与输出，便于排查"为什么这次工具失败没触发 PostToolUseFailure"
2. `error_type` 集合是本项目方言（缺 `billing_error / max_output_tokens`、多 `network_error`），文档必须明确说明 "枚举值集合可能随 SDK 升级扩展，hook 脚本应对未知值做默认兜底"
3. `failure_kind` 字段是项目方言，CC 没有；导出到 CC 格式时被丢弃

---

### PR-13 — `SubagentStart` 事件

**目标**：与 `SubagentStop` 对称，OMC 框架按 `agent_type` 路由的入口。

**触发点（关键：不在 SubagentStop 附近！）**

现有 [maybeRunSubagentStopHooksFromStreamPayload (ipc/agent.ts:253)](../src/main/ipc/agent.ts#L253) 是从 stream 里的 **task ToolMessage** 推断出来的——即子 Agent 已经完成、结果回写时才触发。这是"完成"信号，不是"启动"信号。

**SubagentStart 的正确触发位置**：AIMessage 携带的 `tool_calls` 数组里出现 `name === "task"` 时——即父 Agent 刚决定要派发子任务、子 Agent 即将开始的瞬间。代码上对应 [ipc/agent.ts:1980 toolCalls 提取分支](../src/main/ipc/agent.ts#L1980) 与 [:1993 `for (let tcIndex...) { ... if (tcName === "task") ...}`](../src/main/ipc/agent.ts#L1993)（以及 ~2094、~2840、~3189 的三个对称提取点）。

**改动**
1. `SUPPORTED_HOOK_EVENTS` + AddHookDialog 加 `SubagentStart`
2. 抽 `maybeRunSubagentStartHooksFromToolCall(toolCalls, msgId, ...)`，与 `maybeRunSubagentStopHooksFromStreamPayload` 对称
3. **新建去重集合 `_firedSubagentStartIds: Set<string>`**（**不复用** `_countedAiMsgIds`，避免与 metrics 路径耦合）。AIMessage 在 streaming chunk + values snapshot 中可能各出现一次（见 agent.ts:1831 注释），必须独立去重
4. 4 个 tool_call 提取点都加一遍——在抽出的工具函数里集中处理；调用方传 `toolCalls + msgId + firedSubagentStartIds + workspacePath + threadId + turnId + hookScope + onHookResult`
5. payload（fire-and-forget）：
   ```json
   { "agent_id": "<tool_call_id>", "agent_type": "<tc.args.subagent_type>",
     "tool_call_id": "<same as agent_id>",
     "task_description": "<tc.args.description>" }
   ```
6. **agent_id 与 SubagentStop 共用 `tool_call_id`**：让两个事件能串起来追踪同一个子 Agent

**兼容性自检**：与 PR-12 同；额外强调 AIMessage 重复投递的去重不依赖 `_countedAiMsgIds`，避免与 metrics 路径耦合。

**测试**
- 单 task tool_call → SubagentStart spawn +1
- 同一 `tc.id` 在 streaming chunk + values snapshot 中各出现一次 → 只触发 1 次
- 同一对话内 N 个 task 调用 → 触发 N 次
- `agent_id` 与对应 SubagentStop 的 `subagent.id` 字符串相等（用同 `tool_call_id`）

---

### PR-13a — Timeout 单位与上限统一化（**新增基础 PR**）

**目标**：在 PR-14（HTTP，10 分钟默认）和 PR-15（async）落地前，先把 timeout 单位和上限规则定清楚——避免 IPC 校验拒绝合法配置。

**问题现状**

| 维度 | 今天 | PR-14 / -15 需要 | 冲突 |
|------|------|--------------------|------|
| 内部 `HookConfig.timeout` 单位 | ms | ms | ✓ 一致 |
| CC settings.json `timeout` 单位 | s | s | ✓ 一致，导入时已 `× 1000` 转换（[storage.ts:2302 `parseNativeHookTimeout`](../src/main/storage.ts#L2302)）|
| IPC 校验上限 | `TIMEOUT_MIN = 1_000`、`TIMEOUT_MAX = 60_000`（60s）（[ipc/hooks.ts:33-34](../src/main/ipc/hooks.ts#L33)）| HTTP 想要 10 分钟（600,000）、async 想要 5 分钟+ | **当前上限会拒绝 HTTP / async 配置** |

**设计**

按 handler type 设不同上限，保留 sync command/prompt 的现有上限：

| Handler type | min (ms) | max (ms) | 默认 (ms) |
|--------------|----------|----------|---------|
| command（sync） | 1,000 | 60,000 | 10,000（不变）|
| command（`async: true`） | 1,000 | **300,000**（5 分钟，避免资源泄漏） | 60,000 |
| prompt | 1,000 | 60,000 | 10,000（不变）|
| http（sync） | 1,000 | **300,000**（5 分钟，本项目 UI 体验考虑，比 CC 的 10 分钟严格）| **30,000**（30 秒，比 CC 的 10 分钟严格——CC 是 CLI 工具可以等很久，桌面端 UI 卡 5 分钟太久）|
| http（`async: true`） | 1,000 | 300,000 | 60,000 |
| 未来 agent | 1,000 | 600,000（10 分钟）| 60,000 |

**改动**

1. `validateHookConfig`（[ipc/hooks.ts:80-85](../src/main/ipc/hooks.ts#L80)）改为按 handler type + async 标志查上限表
2. CC settings.json 导入：`parseNativeHookTimeout` 转换后**不**强制夹到 60s——按上面的上限表检查（导入 CC 的 HTTP hook 配 5 分钟应该能进）
3. 新增导出常量 `HOOK_TIMEOUT_BOUNDS: Record<HandlerType, Record<"sync"|"async", {min, max, default}>>`
4. UI（AddHookDialog）：timeout 输入框显示当前 type 的范围提示

**兼容性自检**

- 旧 command/prompt hook 上限不变 → 完全兼容
- CC 导入的 HTTP hook 现在能成功落盘（之前会被 60s 上限拒绝）
- 旧 `TIMEOUT_MAX = 60_000` 不再硬编码

**测试**

- 不同 handler type + async 组合的边界值（min - 1 / min / max / max + 1）
- CC 导入 HTTP timeout = 120 秒 → 转 120,000ms → 通过
<!-- 旧版本读新版本的兼容性测试按 §13.1 方向 1 不做 -->

**回滚**：恢复全局 `TIMEOUT_MAX = 60_000` + 单 handler 单上限的旧逻辑。无数据残留。

---

### PR-13b — CC 字段名对齐 + 通用辅助字段

**目标**：把本项目 `HookConfig` 的几个字段对齐到 CC schema，减少跨产品迁移摩擦。这一项**独立 PR**、独立小，应该早做，因为 PR-14 / -15 / -16 都会基于它扩展。

**改动**

| 字段 | 本项目今天 | CC | 行动 |
|------|----------|-----|------|
| 模型引用 | `modelId` | `model` | **读取时双 key 兜底（`model ?? modelId`），写入只写 `model`**。旧文件下次被 upsert 时自然迁移；不主动批量改写旧文件。按 §13.1 方向 1，不为"旧版本读新写出的 `model`"留兼容路径 |
| 状态文案 | 无 | `statusMessage` | 新增 optional `statusMessage?: string`，传给 UI 显示在 spinner 上 |
| Shell 选择 | 隐式（`process.platform === "win32"` ? cmd : sh）| `shell: "bash" \| "powershell" \| "sh"` | 新增 optional `shell?: ShellType`。未设时维持现状判定；设了显式覆盖（用于 Windows + WSL bash 场景）|

**全链路改点**：types.ts / HookUpsert / IPC 校验 / upsertHook / 4 个读取路径 / CC 导入 / UI 编辑——参考 PR-14 表格模式。

**兼容性自检**
- CC2 通过（纯新增 optional）
- **关键：旧 `modelId` 读取保持，不立即废弃**——避免存量数据丢失。新建 hook 写 `model`；UI 编辑器读取时 `model ?? modelId`，写回 `model`。给 modelId 标注 deprecated 注释，半年后再清除（独立 PR）

**测试**
- 旧 hook 文件含 `modelId: "custom:claude"` → 新版本读出 `model === "custom:claude"`，运行正确
- 新建 hook → 落盘 `model` 字段；CC settings.json 导入的 hook → 落盘 `model` 字段
- `statusMessage` 在 hook 运行期间出现在 UI spinner 上
- `shell: "bash"` 在 Windows 下能找到 bash.exe（WSL / Git Bash）

**回滚**：fields 退掉即可。已被新版本写出 `model` 字段的 hook 配置，旧版本读取时**无法识别**（§13.1 方向 1 接受这一点）——回滚前用户需手动改回 `modelId`，或回滚版本在 hook 编辑 UI 重新保存。changelog 注明

---

### PR-14 — `http` handler type ⭐（**按 CC 源码核实**）

**目标**：让 hook 配置 `type: "http"`，把事件 POST 到指定 URL；解析响应 JSON 作为决策。**OMC 整个 webhook 生态的入口**。

**配置形态（与 CC [schemas/hooks.ts:97-126](../../claude-code/src/schemas/hooks.ts#L97) 对齐）**
```jsonc
{
  "id": "...",
  "event": "PreToolUse",
  "type": "http",
  "url": "https://gateway.example.com/hook",   // 必填，仅 http(s)
  "headers": {                                  // 可选；值支持 $VAR / ${VAR} 插值
    "Authorization": "Bearer $MY_TOKEN"
  },
  "allowedEnvVars": ["MY_TOKEN"],               // 可选；显式列出 headers 里允许插值的 env var 名
  "timeout": 5000,                              // 可选，默认 30000ms（30s）；上限由 PR-13a 的 handler-type-aware 表决定（sync HTTP 上限 5 分钟）
  "fallback": "allow",                          // 项目特有：网络/超时失败的兜底（CC 没有此字段）
  "statusMessage": "Posting to gateway...",     // 可选；spinner 文案
  "if": "Bash(git *)",                          // 可选；permission rule pre-filter
  "once": false,
  "enabled": true
}
```

**与 CC 的有意分歧**：
- 加 `fallback`（CC 没有）——与本项目 `prompt` hook 风格一致，网络失败时给个二值默认决策，避免用户配错 URL 导致 turn 永久阻塞
- **不引入 `method` 字段**——CC 也只有 POST；如果将来要支持 GET/PUT 再加
- **不引入 sandbox 网络代理路由**（CC 有，[execHttpHook.ts:21-41](../../claude-code/src/utils/hooks/execHttpHook.ts#L21)）——本项目无网络 sandbox 概念

**协议**
- **请求**：`POST <url>` with `Content-Type: application/json`，body = 与 command stdin payload **完全相同** 的 JSON
- **响应**：
  - 2xx + 合法 JSON → 按 `parseHookJsonOutput` 解析（与 command 共用解析路径，复用所有顶层字段 + `hookSpecificOutput`）
  - 2xx + 非 JSON → 视为"允许"，把 body 作为 stdout 注入上下文
  - 4xx / 5xx → 视为"hook 自身报错"，按 `fallback` 处理
  - 网络超时 / 网络错误 → 同上
- **状态码语义**：CC 上游用 2xx 二值；本项目沿用，不引入 `exit 2` 类等价

**安全模型（按 §13.2 决议 1 简化——不做 SSRF guard）**

桌面单机环境用户自负 → **PR-14 不实现 SSRF guard、不实现全局 URL 白名单、不实现私网开关**。任何 URL（loopback / 私网 / 公网 / 云元数据端点）都直接放行。仅保留以下 4 项**基础卫生**，与 SSRF 无关：

1. **Env var 插值**（这是隐私保护，非 SSRF）：headers 值里的 `$VAR_NAME` / `${VAR_NAME}` 仅当 `VAR_NAME ∈ hook.allowedEnvVars` 时才解析为 `process.env[VAR_NAME]`；其他 `$XXX` 引用替换为空串（防止 settings.json 中的 hook 静默泄漏任意 env 到第三方）
2. **CRLF 注入清洗**：headers 值替换 `\r` / `\n` / `\x00` 为空（防止恶意 env var 注入第二个 header；见 CC `sanitizeHeaderValue` [execHttpHook.ts:76](../../claude-code/src/utils/hooks/execHttpHook.ts#L76)）
3. **响应体上限**：1 MB（与 command stdout 一致，避免无限内存）
4. **headers 默认值**：只设 `Content-Type: application/json`；**不**自动注入任何认证 / cookie / 环境变量

**显式不做**（与 CC 的有意分歧）：

- 不做 SSRF guard——CC [ssrfGuard.ts](../../claude-code/src/utils/hooks/ssrfGuard.ts) 拦截 `10.x` / `169.254.x` / `172.16-31.x` / `192.168.x` 等私网段；本项目桌面环境，用户自负
- 不做全局 `allowedHttpHookUrls` URL 白名单
- 不做 `allowHttpHookPrivateUrls` 私网开关
- 不做跨 origin 重定向限制（fetch 默认 `redirect: "follow"` 即可）
- 不做 retry（§13.2 决议 4）；失败一次即按 `fallback` 处理

**实现**
- 新增 [src/main/hooks/http-runner.ts](../src/main/hooks/http-runner.ts)，导出 `executeHttpHook(hook, context, event): Promise<HookResult>`
- `executeHook`（[runner.ts:749](../src/main/hooks/runner.ts#L749)）分发：
  ```ts
  if (hookType === "http") result = await executeHttpHook(hook, context, event)
  else if (hookType === "prompt") result = await executePromptHook(...)
  else result = await executeCommandHook(...)
  ```
- HTTP 调用用 Node 内置 `fetch`（Electron 已带）；不引入 axios（CC 用 axios 是历史原因，新代码用 fetch 更轻量）
- **无新增 settings 字段**——之前列的 `allowedHttpHookUrls / allowHttpHookPrivateUrls / httpHookAllowedEnvVars` 三个全局开关随 SSRF guard 一并取消

这三项进 settings IPC + UI 设置面板。

**全链路改点（避免遗漏导致静默丢字段）**

| 段 | 文件 | 改动 | 缺则后果 |
|----|------|------|---------|
| 类型 | [src/main/hooks/types.ts](../src/main/hooks/types.ts) | `HookType` 增 `"http"`；`HookConfig` 加 `url? / headers? / allowedEnvVars? / statusMessage?`；`HookUpsert` 同步 | 编译/类型层不通 |
| 类型 | [src/renderer/src/types.ts:255](../src/renderer/src/types.ts#L255) | 自动 re-export，无需手改，但要确认 | 前端取不到类型 |
| 校验 | [src/main/ipc/hooks.ts:56 `validateHookConfig`](../src/main/ipc/hooks.ts#L56) | type=http 时校验：url 为 http(s)、headers 为 string→string map、allowedEnvVars 为 string[]；**无 SSRF / 私网过滤**（§13.2 决议 1）| IPC 创建被默认拒绝 |
| 写入 | [src/main/storage.ts:3194 `upsertHook`](../src/main/storage.ts#L3194) | `next: HookConfig` 增加 url / headers / allowedEnvVars / statusMessage 字段 | **创建/编辑时被静默丢弃** |
| 读取（flat）| [src/main/storage.ts:2542](../src/main/storage.ts#L2542) | return 对象增加这些字段解析 | 重启后读不出来 |
| 读取（workspace flat）| [src/main/storage.ts:2635](../src/main/storage.ts#L2635) | 同上 | workspace hooks 失效 |
| 读取（plugin flat）| [src/main/storage.ts:2834](../src/main/storage.ts#L2834) | 同上 | 插件 hooks 失效 |
| 读取（skill）| [src/main/storage.ts:3142](../src/main/storage.ts#L3142) | 同上 | 技能 hooks 失效 |
| CC settings 导入 | [src/main/storage.ts:2470 `expandCcHooksSettings`](../src/main/storage.ts#L2470) | CC settings.json 已支持 http type；按 [CC schema](../../claude-code/src/schemas/hooks.ts#L97) 透传 url / headers / allowedEnvVars / timeout / statusMessage / once / if 字段 | **跨产品导入字段丢失（OMC 用户从 CC 迁移过来时数据不全）** |
| UI 编辑 | [src/renderer/src/components/customize/AddHookDialog.tsx](../src/renderer/src/components/customize/AddHookDialog.tsx) | type 选择器加 "HTTP Webhook"；选中后展开 url / headers / allowedEnvVars 字段；**不**做私网警告（§13.2 决议 1）| 用户在 UI 上配不出 |
| Hook 日志 | [src/main/hooks/log-record.ts](../src/main/hooks/log-record.ts) | 增加 url / responseStatus / responseBytes 字段，body 截断 4KB；headers 不入日志（含敏感信息）| 日志看不到 |
| 插件 hooks.json 解析 | 插件文件加载器（同 storage.ts plugin 读取路径）| http 字段按 optional 解析 | 插件作者写了被丢弃 |

**测试**
- 用 `node:http` 起 mock server e2e：
  - 2xx JSON → 解析；2xx 非 JSON → 注入
  - 4xx → fallback；超时 → fallback
  - redirect 跨 origin → 拒绝
- 现有 command / prompt 单测全部不变
- 7.2 表里每一行至少一条往返测试：upsert → list → 验证字段完整

**回滚**：单独 PR，把 `HookType` 联合中的 `"http"`、http-runner.ts 文件、IPC 校验 http 分支三块拿掉即可。

---

### PR-15 — `async` 协议（**双层并存，二期只做配置层**）

**核心修订**：早前我两次都没说清。CC 实际有**两层独立的 async 机制**：

#### 15.1 CC 的两层 async（必须分清）

**A 层 — 配置层 `hook.async` / `hook.asyncRewake`**（[schemas/hooks.ts:55-64](../../claude-code/src/schemas/hooks.ts#L55)）：
- 用户在 settings.json 里**预先声明**"此 hook 始终异步"
- 适用于"启动就知道是慢操作"的 hook（远程审计、可选扫描器）
- `asyncRewake: true` 变体：异步 + exit 2 时唤醒模型（implies async）

**B 层 — stdout 协议 `{"async": true, "asyncTimeout": N}`**（[AsyncHookRegistry.ts:30-83](../../claude-code/src/utils/hooks/AsyncHookRegistry.ts#L30)、[hooks.ts:1127](../../claude-code/src/utils/hooks/hooks.ts#L1127)）：
- hook 起来时是 sync 模式，**第一行 stdout 输出 `{"async": true, "asyncTimeout": 30000}`** 后 runtime 立刻把它转入后台
- 适用于"运行时才决定要不要异步"的 hook（看到大文件才 async、其他情况快速 sync 返回）
- `asyncTimeout` 默认 **15000ms**（不是项目 timeout 字段）
- runtime 把 process 转入 [AsyncHookRegistry](../../claude-code/src/utils/hooks/AsyncHookRegistry.ts)，由全局注册表管理

两层独立、可以共存：A 层是声明，B 层是运行时升级。

#### 15.2 二期范围决断：**只做 A 层的 `async`，不做 `asyncRewake`，不做 B 层**

| 维度 | A 层 `async` ✓ | A 层 `asyncRewake` ✗ | B 层 stdout 协议 ✗ |
|------|--------------|---------------------|-------------------|
| 用户感知 | "我配的就是异步 hook" | "失败时会主动通知我" | "hook 自己决定" |
| 实现复杂度 | 中——加 schema 字段 + 后台执行分支 | 高——需要 langgraph 中途注入消息能力（**不确定是否支持**）| 高——stdout 流式解析、PendingHook 全局注册表、跨 turn 状态持久化、UI 进度条 |
| OMC 实际依赖 | 高——OMC 配 webhook gateway 时就该标 async | 低——OMC 用 fire-and-forget 通知足矣 | 低——OMC 没观察到 stdout 协议用法 |
| 风险 | 低 | **高**（反向注入未知）| 中（B 层与 A 层独立，本期暂搁） |

**结论**（按 §13.1 "有风险的优化暂时放下"）：
- A 层 `async` ✓ 实现
- A 层 `asyncRewake` ✗ **本期不实现**，CC 导入时降级为纯 `async` + warning
- B 层 stdout async ✗ **本期不实现**，导入时 warning

文档明确"暂不支持 stdout async 协议；hook 第一行 stdout 输出 `{async: true}` 会被当作普通 JSON 解析（如果不含 decision/continue 字段就当作'空决策'），不会触发后台化"。这样不会破坏存量、不会给用户错误预期。

#### 15.3 A 层设计（**仅配置层 `async`；asyncRewake 按 §13.2 决议放下**）

**配置形态**
```jsonc
{
  "type": "command",
  "command": "node hooks/slow-scan.js",
  "timeout": 60000,               // hook 自身超时（async 也用这个，不另开 asyncTimeout）
  "async": true                   // 配置层：本 hook 始终异步
}
```

适用于 command / prompt / http 三种 type；agent 不在二期范围。

**`asyncRewake` 字段：本期不实现**

CC `asyncRewake: true` 是"async + exit 2 时反向唤醒主模型"的变体（[schemas/hooks.ts:59-64](../../claude-code/src/schemas/hooks.ts#L59)）。反向注入机制对应本项目需要研究 langgraph 是否能中途 push 消息到 agent state——属于 §13.1 "有风险的优化暂时放下"。本期处理：

- `HookConfig` 不加 `asyncRewake` 字段
- CC 导入：遇到 `asyncRewake: true` 在导入日志里记一条 warning "asyncRewake 字段被忽略，本运行时尚未支持反向唤醒"，字段不写入存储（避免半实现给用户错觉）
- 在 `HookConfig` 的 doc comment 里标注"`asyncRewake` 延期到第三期"

#### 15.4 改动

1. `HookConfig` / `HookUpsert` 加 `async?: boolean`（不加 `asyncRewake`、不加 `asyncTimeout`）
2. 4 个读取路径 + CC 导入 + IPC 校验 + UI 编辑 全链路补字段（参考 PR-14 表）
3. CC 导入：遇到 `asyncRewake` 或 `asyncTimeout`（B 层 stdout 字段）→ 导入日志各记一条 warning，字段都不进存储
4. `executeHook`（[runner.ts:749](../src/main/hooks/runner.ts#L749)）检测 `hook.async === true`：
   - 立即 `resolve({...placeholder, asyncPending: true})` 让 runHooks 继续
   - 后台 promise / 子进程 / fetch 继续跑
   - 完成后调用 `onLateHookResult(event, hook, finalResult)` callback 触发日志
5. `HookLogRecord` 加 `async? / lateCompletedAt? / asyncStatus?: "pending"|"completed"|"timeout"` 字段
6. UI（Hook log 面板）：
   - async pending → hourglass 图标
   - completed → 实心
   - timeout → 红色

#### 15.5 兼容性自检

- CC2 通过（新增 optional）
- 旧 hook 不写 `async` ⇒ 完全等同今天

#### 15.6 已知风险

1. **B 层（stdout async）不做的代价**：CC 用户 stdout 输出 `{"async": true}` 的 hook，在本项目里**不会**后台化；hook 仍按 sync 执行（用户可能看到 turn 卡住）。导入流程扫描 hook command 内容里的字面量 `"async":true` 字符串给 warning（不严格但实用）
2. **async hook 的决策语义**：`decision: "block" / continue: false / updatedInput` 一律不生效（属 fire-and-forget 类）；asyncRewake 不在二期范围，无任何反向唤醒能力
3. **`asyncRewake` 用户无法配置**：CC 用户从 `settings.json` 导入含此字段的 hook 会被静默化为 `async: true`（含警告日志）；用户期望的"失败时通知"行为不会发生

#### 15.7 测试

- `async: true` hook 返回 100ms / 5s 后完成 → turn 不阻塞；late result 日志正常
- `async: true` hook 超出 `timeout` → abort + 记 timeout 状态
- `async: true` hook 的 `decision:"block"` 被忽略（mock 验证）
- 导入含 `asyncRewake` 或 `asyncTimeout` 的 CC hook → 显式警告日志，字段不进存储
- 0 async hook 时的零副作用断言：spawn 计数同 sync 路径、`onLateHookResult` 零调用

#### 15.8 回滚

从 `HookConfig` 联合去掉 async 字段；`executeHook` 的 async 分支删除。无数据残留。

---

## 9. P1 PR 详细设计

### PR-16 — Per-event matchQuery + `if` 字段（**按 CC 真实机制对齐**）

**核心修订**：早前我提议引入 `eventMatchers: Record<string,string>` 多维字段——这是**自创设计**。核对 CC 源码后，**CC 没有这个字段**。CC 的机制是更简洁的两件事：

1. **单 `matcher` 字符串**（[utils/hooks.ts:1346 `matchesPattern`](../../claude-code/src/utils/hooks.ts#L1346)），支持：
   - `*` / 空 → 匹配所有
   - 简单字符串 → 大小写敏感精确匹配
   - 管道分隔列表（`"startup|resume|clear"`）→ 多值 OR
   - 包含其他正则元字符 → 当正则
2. **per-event 不同 matchQuery**（[utils/hooks/hooksConfigManager.ts:26 `getHookEventMetadata` matcherMetadata](../../claude-code/src/utils/hooks/hooksConfigManager.ts#L26)）：
   - PreToolUse / PostToolUse → `tool_name`
   - Notification → `notification_type`
   - SessionStart → `source`（`startup|resume|clear|compact`）
   - SessionEnd → `reason`（`clear|logout|prompt_input_exit|other`）
   - **SubagentStart / SubagentStop → `agent_type`**
   - PreCompact / PostCompact → `trigger`（`manual|auto`）
   - StopFailure → `error`（`rate_limit|authentication_failed|...`）
   - ConfigChange → `source`（`user_settings|project_settings|...`）
   - InstructionsLoaded → `load_reason`
3. **每 hook 单独的 `if` 字段**（[schemas/hooks.ts:19 `IfConditionSchema`](../../claude-code/src/schemas/hooks.ts#L19)）：permission rule syntax（如 `"Bash(git *)"`、`"Read(*.ts)"`），matcher 命中后做**第二层 per-hook pre-filter**——比单 matcher 字符串强得多，本来 CC matcher 机制的杀手锏。

**OMC 用例**：
```jsonc
// CC 的写法（PR-16 之后本项目应该一致）
{
  "event": "SubagentStart",
  "matcher": "code-reviewer|security-auditor",  // 匹配 agent_type
  "hooks": [{
    "type": "command",
    "command": "bash hooks/cost-track.sh",
    "if": "Bash(*)"                              // 仅当 task 包含 Bash 调用时跑
  }]
}
```

#### 9.1 兼容性核心难点：现有 `matcher` 语义切换

今天本项目所有事件都用 `getMatcherTarget`（[runner.ts:111](../src/main/hooks/runner.ts#L111)）从 context 取值，**只返回 `toolName` 或 `skillName`**。这意味着：

| 事件 | 今天 `matcher` 实际匹配什么 | 用户是否可能配过有意义的 matcher |
|------|------------------------|-------------------------------|
| `PreToolUse` / `PostToolUse` | `toolName` | **是**（如 `"execute"`、`"write_file"`）|
| `PreSkillUse` / `PostSkillUse` | `skillName` | **是** |
| `Notification` | `toolName`（runtime.ts:1740 填了 `req.tool_call?.name`）| **是**（用户可能配 `"execute"` 仅对工具审批响应）|
| `UserPromptSubmit` | `toolName`（永远 undefined）| 否 |
| `SessionStart` / `SessionEnd` | `toolName`（永远 undefined）| 否 |
| `Stop` | `toolName`（永远 undefined）| 否 |
| `SubagentStop` | `toolName`（永远 undefined）| 否 |

**结论**：除了 PreToolUse / PostToolUse / PreSkillUse / PostSkillUse / **Notification** 这 5 个，其他事件**今天 matcher 实质无效**（永远只能 `"*"` 才生效）——可以安全切换到 per-event matchQuery 语义。

Notification 是唯一需要小心的：用户今天可能配 `matcher: "execute"` 来 "只对 execute 工具的审批触发通知"。如果切换到 CC 语义匹配 `notification_type`，这条配置会突然失效。

**解决方案：Notification 走 "双 matcher fallback"**：
- 先按 `notification_type` 匹配（CC 新语义，目前只有 `permission_prompt` 一种值）
- 若 `notification_type` 不存在（旧上下文）或没匹配到，回落到 `toolName` 匹配（旧语义）
- UI 层面把 `notification_type` 添加到 HookContext，逐步过渡

#### 9.2 改动清单

| 段 | 文件 / 位置 | 改动 |
|----|-------------|------|
| Runner | [src/main/hooks/runner.ts:111 `getMatcherTarget`](../src/main/hooks/runner.ts#L111) | 改为按事件返回不同字段（switch on event）；Notification 走 fallback chain |
| Runner | runner.ts `HookContext` 接口 | 加 `sessionStartSource? / sessionEndReason? / notificationType? / stopFailureError? / compactTrigger? / configChangeSource? / instructionsLoadReason?` 等可选字段 |
| Matcher | runner.ts `matchesName` | **加管道分隔列表支持**（`"a\|b\|c"` 三元 OR）——CC 原有，本项目今天靠正则 `|` 间接支持但语义不完全等价；改成显式优先匹配 |
| 触发点 | 各 fire 调用点 | 把 source / reason / notification_type 等填进 HookContext |
| `HookConfig` | [types.ts:79](../src/main/hooks/types.ts#L79) | 新增 `if?: string`（permission rule syntax）|
| `HookUpsert` | [types.ts:187](../src/main/hooks/types.ts#L187) | 同上 |
| IPC 校验 | [ipc/hooks.ts:56](../src/main/ipc/hooks.ts#L56) | 校验 `if` 形态合法（非空字符串、可被 permission rule parser 解析）|
| `upsertHook` | [storage.ts:3194](../src/main/storage.ts#L3194) | `next: HookConfig` 加 `if: config.if` |
| 4 个读取路径 | storage.ts 2542 / 2635 / 2834 / 3142 | 每处加 `if: typeof h.if === "string" ? h.if : undefined` 解析 |
| CC 导入 | [storage.ts:2470 `expandCcHooksSettings`](../src/main/storage.ts#L2470) | 读 `hook.if`，按 optional 透传 |
| 触发判定 | runner.ts `hookMatchesRunCriteria` | 新增 `matchesIf(hook.if, context)` 调用，缺省返回 true |
| **`if` 实现** | **新建** `src/main/hooks/if-condition.ts` | 实现 permission-rule-style parser：`"Bash(git *)"` 解析为 `{tool: "Bash", argPattern: "git *"}`，对 PreToolUse 的 `tool_name + tool_input.command` 做 glob 匹配 |
| UI 编辑 | [AddHookDialog.tsx](../src/renderer/src/components/customize/AddHookDialog.tsx) | 按事件 metadata 调整 matcher 字段的下拉提示（SubagentStart 显示 agent_type 候选）；额外加 `if` 输入框（高级展开） |
| 插件 hooks.json | 插件加载器 | `if` 字段按 optional 解析 |

#### 9.3 兼容性自检

- **CC2 通过**（`if` 是新增 optional）
- **CC6 退步——但被双 matcher fallback 抵消**：
  - PreToolUse / PostToolUse / PreSkillUse / PostSkillUse → 行为完全不变（matchQuery 还是 toolName/skillName）
  - Notification → fallback chain 保证旧 `matcher: "execute"` 仍能匹配
  - 其他 5 个事件 → 用户今天的 matcher 不可能在工作（toolName 永远 undefined），切换 matchQuery 不破坏任何东西
- **CC7 通过**（CC 导入语义不变，`if` 字段新加但 CC 原本就有）

#### 9.4 测试

- 现有 hook（无 `if`）→ hook-scope / hook-stdin-payload fixture 字节级一致
- `matcher: "code-reviewer"` 的 SubagentStart hook → 仅对 `agent_type === "code-reviewer"` 触发；其他 agent_type 不触发
- `matcher: "startup|resume"` 的 SessionStart hook → 仅在这两种 source 触发
- Notification 双 matcher fallback：
  - `matcher: "execute"` + 来自 execute 审批 → 仍触发（旧语义）
  - `matcher: "permission_prompt"` + 来自任意审批 → 触发（新语义）
- `if: "Bash(git *)"` 的 PreToolUse hook → 仅当 `tool_name === "Bash"` 且 `command` 匹配 `git *` 时触发；其他 Bash 命令不触发
- 校验失败用例：`if: "InvalidSyntax(("` → IPC 拒绝
- 持久化兼容（forward only，§13.1 方向 1）：新版二进制读旧版文件 → `if === undefined`，过滤跳过；行为完全等同今天

---

### PR-17 — `StopFailure` 事件

**目标**：与 `Stop` 互斥，turn 因 API 错误结束时生效。

**触发点**：[src/main/ipc/agent.ts:2558 `if (!isAbortError)` 分支](../src/main/ipc/agent.ts#L2558)（一期 PR-03 已核实）。

**互斥实现**：在 catch 块给 completion-hooks 传 `turnEndedInError: true` 标志，让它跳过 Stop hook fire 路径。

**依赖**：复用 PR-12 的 `classifyApiError`。`error_type` 取值与 PostToolUseFailure 共享枚举。

**payload**：
```json
{ "error": "<message>", "error_type": "<6 值之一>" }
```

**已知风险**：completion-hooks 现在是被 deepagents middleware 触发的，额外信号要走 thread / turn 维度的旁路（不能阻塞中间件）。本 PR 必须覆盖该信号链改动。

---

### ~~PR-18 — `TaskCreated / TaskCompleted`~~ **（§13.2 决议 3：移出二期，整体延期）**

按 §13.2 决议 3 "agent teams 不做"，本 PR 整体延期到第三期或更晚。原设计见 §11 延期清单备注。

---

## 10. 跨 PR 共建的基础设施

PR-14 / PR-15 / PR-16 都会触碰相同的地方，建议先做这些"公共基础"再分头实现，避免 review 冲突：

1. **`HookResult` 新字段集中加到 [types.ts](../src/main/hooks/types.ts)**：`asyncPending? / asyncStatus?`、PR-12 的 failure_kind 透传字段等——一次性加完，避免每个 PR 来回改文件
2. **`parseHookJsonOutput` 改为分层解析器**：底层"读 JSON & 平铺优先级"不变，顶层加一个 dispatcher 按事件分类调用 `hookSpecificOutput.<event>` 解析——为 PR-14 复用、避免 N 次重写
3. **`HookLogRecord` 加 `type / url / responseStatus / async / lateCompletedAt` 字段**：日志一次性扩到位，PR-14 / PR-15 都用
4. **`runHooks` 内 fire-and-forget 分支抽函数**：现有 PostToolUse 等已用，PR-11 / PR-12 / PR-13 都会用，提前抽出避免散落

**建议把这 4 项作为 PR-11 的前置一并合入**（PR-11 体量 +50 LOC 接受范围内）。

---

## 11. 明确不在本期范围

| 项 | 原因 | 何时考虑 |
|----|------|---------|
| `agent` handler type | spawn 子 Agent 做决策；要 deepagents 深度集成 | 第三期或更晚 |
| `mcp_tool` handler type | 需要 MCP 客户端直接调用工具；本项目 MCP 调用走 Agent 路径 | 第三期 |
| `Elicitation / ElicitationResult` | MCP 用户输入弹窗；本项目无对应 UI | 等 MCP 弹窗 UI 落地 |
| `CwdChanged / FileChanged` + `CLAUDE_ENV_FILE` | 需要文件 watcher + 临时 env 文件管理 | 独立 epic |
| `WorktreeCreate / WorktreeRemove` | 需要 git worktree 隔离子系统 | 独立 epic |
| `InstructionsLoaded / ConfigChange` | 观察类，OMC 不依赖 | 第三期 |
| `UserPromptExpansion / PostToolBatch / TeammateIdle` | CC 新事件，使用场景少 | 第三期 |
| `TaskCreated / TaskCompleted`（原 PR-18）| 依赖 CC 实验特性 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`；本项目无 agent teams 概念（§13.2 决议 3）。若将来接入：触发点在 todoList 工具创建/标完成时；payload `{ task_id, task_subject, task_description, teammate_name, team_name }`；阻断语义 `exit 2` 阻止创建/完成、`continue:false` 停止整个 teammate | 第三期，仅在 agent teams 落地后 |
| `asyncRewake`（PR-15 原含）| 反向注入到 langgraph state 的可行性未确认（§13.1 总体方向 2 / §13.2 决议 2 关联）| 第三期，需先做 deepagents 调研 |
| stdout async 协议（B 层）| CC `{"async": true, "asyncTimeout": N}` 第一行 stdout 升级到后台运行；需要流式解析 + 全局注册表 + 跨 turn 状态 | 第三期 |
| HTTP `agent` handler type | 多轮 LLM + 完整 tool 池 + structured output schema；需要 deepagents 集成 | 第三期或更晚 |
| HTTP SSRF guard / URL 白名单（PR-14 原含）| §13.2 决议 1 用户自负；如果未来需要分发给企业用户，再补 | 第三期，企业场景再启 |
| PR-06 PreCompact/PostCompact 重做 | 一期撤回时已记录正确方向：包裹/复用 summarization 的 `wrapModelCall`，观察 `Command.update._summarizationEvent`；不能用 beforeModel bridge | 第三期或更晚 |
| `PermissionRequest / PermissionDenied` 接入审批改写 | 一期 plan 里 PR-08 复杂度极高，OMC 不阻塞 | 第三期 |

---

## 12. 验收标准

二期合入完成后，应能跑通至少一个 OMC 类示例：

1. **PR-14 HTTP hook**：配一个 `type: "http"` hook，POST 到本地 `http://127.0.0.1:8080/hook` mock webhook server（任何 URL 都放行，§13.2 决议 1），验证 PreToolUse 拦截 / 注入
2. **PR-15 async HTTP hook**：mock server 故意 sleep 3s 的同时，hook 配 `"async": true`；turn 不被阻塞，late log 正确出现
3. **PR-13 + PR-16 SubagentStart 路由**：配 `SubagentStart` hook with **`matcher: "code-reviewer"`**（按 CC 真实机制——`matcher` 字符串匹配本事件的 `agent_type` matchQuery，**没有 `eventMatchers` 字段**），过滤只对 `code-reviewer` 触发
4. **PR-12 PostToolUseFailure**：工具人为抛错（验证 throw 路径）+ 工具返回 `exitCode: 1`（验证非零退出路径）两种 fixture 都触发，payload 含正确的 `error_type`
5. **PR-11 Setup**：在新 workspace 第一次启动 → `Setup({trigger:"init"})` 触发 1 次；同 workspace 内开第二个 thread → **不再**触发 init（per-workspace 去重，见 PR-11 设计）；点 UI 维护 → `Setup({trigger:"maintenance"})` 触发

跑通这五条 ⇒ 本项目已能作为 OMC 框架的承载平台。

---

## 13. 开放问题与定稿

5 个问题已经全部拍板，下面是定型答案。同时确定了两条**总体方向**，影响后续所有 PR 的设计取舍。

### 13.1 总体方向（影响所有 PR）

**方向 1：新版本兼容旧配置，不要求旧版本兼容新配置**

- 所有持久化 schema 改动按 **"forward compatibility only"** 处理
- 新增字段：新版本读 / 写都支持；旧版本读到时被丢弃即可（不为旧版本预留向后兼容路径）
- **影响**：测试用例里"持久化双向兼容"全部裁掉一半，只保留"新版本读旧数据""新版本写、新版本再读"两条，不再断言"旧版本读新版本写出的文件"
- **省下的工作**：CC schema 字段名对齐（PR-13b）可以一步到位写 `model`，仍读 `modelId` 兜底——不必再为"旧版本读到新数据"留专门的兼容写出

**方向 2：有风险的优化暂时放下**

- **不做** `asyncRewake`（PR-15）：反向注入到 langgraph state 的可行性未确认，留到第三期
- **不做** `agent` handler type：多轮 LLM + tool 池，工作量与不确定性大，留到第三期
- **不做** SSRF guard：用户自负（见 13.2 第 1 项），降低 PR-14 复杂度
- **不做** stdout async（B 层）：第三期再议
- **不做** PR-18 TaskCreated/TaskCompleted：agent teams 不在路线图

### 13.2 5 个问题定稿

| # | 问题 | 决议 | 影响 |
|---|------|------|------|
| 1 | **HTTP hook SSRF 防护强度** | **A) 完全开放，用户自负** | PR-14 删 SSRF guard、删 `allowHttpHookPrivateUrls`、删 `allowedHttpHookUrls`；仅保留 CRLF 注入清洗 + env var 显式列表（这两条不是 SSRF 而是基础卫生）|
| 2 | **`async` 5 分钟硬上限** | **采用** | PR-13a / PR-15 沿用现有 5 分钟硬上限设计，无需调整 |
| 3 | **agent teams（PR-18）** | **不做** | PR-18 整 PR 移出二期范围，挪到 §11；PR 总数从 10 → 9 |
| 4 | **HTTP hook 0 retry** | **采用** | PR-14 不实现 retry；失败即按 `fallback` 字段处理（与 prompt 一致）|
| 5 | **`Setup({trigger:"maintenance"})` UI 入口** | **A) 加显式按钮**（"重新初始化工作区"） | PR-11 设计已经按此走，无需调整 |

启动顺序按 §7 表执行：**PR-13a → PR-13b → PR-11 → PR-12 → PR-13 → PR-15（仅 async，去掉 asyncRewake）→ PR-14（去掉 SSRF）→ PR-16 → PR-17**。共 9 个 PR。

---

## 附录 A：本期 PR 模板（每个 PR description 复用）

```markdown
## 目标
<一句话>

## 兼容性自检（CC1–CC11，详见 §6）
- [ ] CC1 — HookEvent 联合不删除：满足 / 不涉及
- [ ] CC2 — HookConfig 现有字段不变：满足 / 不涉及
- [ ] CC3 — stdin payload key 不变：满足 / 不涉及
- [ ] CC4 — 环境变量命名不变：满足 / 不涉及
- [ ] CC5 — parseHookJsonOutput 现有字段优先级不变：满足 / 不涉及
- [ ] CC6 — matcher 现有行为不变：满足 / 不涉及
- [ ] CC7 — CC settings.json 导入语义不变：满足 / 不涉及
- [ ] CC8 — 不引入新同步阻塞点：满足 / 显式妥协（说明）
- [ ] CC9 — http 配置错配可被 IPC 校验拒绝（仅 PR-14 / 触碰 http 的 PR）
- [ ] CC10 — async hook 的 UI 状态可视化（仅 PR-15 / 触碰 async 的 PR）
- [ ] CC11 — 新 handler / 新事件不改变现有 command + prompt 行为

## 回归测试
- [ ] tests/hook-scope.spec.ts 0 diff
- [ ] tests/hook-scope-e2e.spec.ts 0 diff
- [ ] tests/git-hook-collection-path.spec.ts 0 diff
- [ ] 持久化前向兼容（新版二进制读旧版文件不丢字段、不报错；按 §13.1 方向 1 不要求旧版二进制读新版文件）

## 回滚步骤
<一句话或一条命令>
```
