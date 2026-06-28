# 详细设计：CmbCoworkAgent harnessboard 系统提示词模板化改造

## 1. 背景与目标

### 1.1 当前问题

- harnessboard 模式下的系统提示词仅通过 `workingDirPromptAppendix` 注入片段，没有完整独立的提示词。
- AGENTS.md 在两种模式下都被直接拼接到提示词末尾，章节顺序不符合 Kimi Code 的最佳实践。
- harnessboard 模式不支持按项目/插件配置系统提示词模板。

### 1.2 目标

- **普通模式保持现有系统提示词不变**。
- harnessboard 模式引入类 Kimi Code 的声明式模板系统：YAML agent spec + Markdown system prompt 模板。
- harnessboard 模板通过 `board_config.json` 的 `systemPrompt` 字段按项目配置。
- harnessboard 模式下 AGENTS.md 作为模板变量 `${AGENTS_MD}` 注入到 `# Project Information` 章节。
- harnessboard 模式下工具说明保留 CmbCoworkAgent 自有内容，通过 `${TOOL_USAGE}` 动态注入。
- harness 项目信息通过 `${HARNESS_PROJECT_INFO}` 注入到 `# Working Environment` 章节。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     createAgentRuntime                       │
│                       (src/main/agent/runtime.ts)            │
└───────────────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
   普通模式                          harnessboard 模式
        │                               │
        ▼                               ▼
  保持现有 getSystemPrompt()      使用模板系统
  + 直接拼接 AGENTS.md            agent.yaml + system.md
                                  + ${VAR} 渲染
```

---

## 3. 关键数据结构

### 3.1 Agent Spec（仅用于 harnessboard 模式）

```ts
// src/main/agent/agent-spec.ts

export interface AgentSpec {
  version: number
  name: string
  systemPromptPath: string
  systemPromptArgs: Record<string, string>
  tools: string[]
  allowedTools?: string[] | null
  excludeTools?: string[]
  subagents: Record<string, SubagentSpec>
}

export interface SubagentSpec {
  path: string
  description: string
}

export interface ResolvedAgentSpec {
  name: string
  systemPromptPath: string
  systemPromptArgs: Record<string, string>
  tools: string[]
  allowedTools: string[] | null
  excludeTools: string[]
  subagents: Record<string, SubagentSpec>
}
```

### 3.2 Harness System Prompt Config

```ts
// src/main/harness-board/types.ts 或 service.ts

export interface HarnessSystemPromptConfig {
  template?: string
  args?: Record<string, string>
}
```

### 3.3 Template Variables（仅用于 harnessboard 模式）

```ts
interface HarnessSystemPromptVars {
  ROLE_ADDITIONAL: string
  CMB_NOW: string
  WORKSPACE_PATH: string
  WORKSPACE_LS: string
  OS: string
  SHELL: string
  HARNESS_PROJECT_INFO: string
  AGENTS_MD: string
  SKILLS: string
  TOOL_USAGE: string
}
```

---

## 4. 模块设计

### 4.1 `src/main/agent/agent-spec.ts`（新增）

职责：
- 加载并解析 harness agent.yaml
- 提供模板渲染函数

接口：

```ts
export function loadAgentSpec(agentFilePath: string): Promise<ResolvedAgentSpec>
export function renderTemplate(template: string, vars: Record<string, string>): string
export function resolveSystemPromptPath(baseDir: string, specPath: string): string
```

模板渲染规则：
- 正则 `/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`
- 未定义变量替换为空字符串并 `console.warn`

### 4.2 `src/main/agent/templates/harness/agent.yaml`（新增）

```yaml
version: 1
agent:
  name: "cmb-cowork-harness"
  system_prompt_path: ./system.md
  system_prompt_args:
    ROLE_ADDITIONAL: |
      You are running in harnessboard project mode. The current conversation is bound to a Harness Board feature. You must follow the project-specific conventions defined in the board configuration and AGENTS.md.
  tools:
    - "cmb-agent:Agent"
    - "cmb-agent:AskUserQuestion"
    - "cmb-agent:SetTodoList"
    - "cmb-agent:Shell"
    - "cmb-agent:TaskList"
    - "cmb-agent:TaskOutput"
    - "cmb-agent:TaskStop"
    - "cmb-agent:ReadFile"
    - "cmb-agent:ReadMediaFile"
    - "cmb-agent:Glob"
    - "cmb-agent:Grep"
    - "cmb-agent:WriteFile"
    - "cmb-agent:StrReplaceFile"
    - "cmb-agent:SearchWeb"
    - "cmb-agent:FetchURL"
    - "cmb-agent:ExitPlanMode"
    - "cmb-agent:EnterPlanMode"
  subagents: {}
```

> 注：`tools` 列表需与当前 `runtime.ts` 实际加载的工具对齐，此处为示意。

### 4.3 `src/main/agent/templates/harness/system.md`（新增）

```markdown
You are CmbCowork Agent, an interactive general AI agent running on a user's computer.

${ROLE_ADDITIONAL}

# Prompt and Tool Use

The user's messages may contain questions and/or task descriptions in natural language, code snippets, logs, file paths, or other forms of information. Read them, understand them and do what the user requested. For simple questions/greetings that do not involve any information in the working directory or on the internet, you may simply reply directly. For anything else, default to taking action with tools. When the request could be interpreted as either a question to answer or a task to complete, treat it as a task.

When handling the user's request, if it involves creating, modifying, or running code or files, you MUST use the appropriate tools to make actual changes — do not just describe the solution in text. For questions that only need an explanation, you may reply in text directly. When calling tools, do not provide explanations because the tool calls themselves should be self-explanatory. You MUST follow the description of each tool and its parameters when calling tools.

If the `Agent` tool is available, you can use it to delegate a focused subtask to a subagent instance. The tool can either create a new subagent instance or resume an existing one by `agent_id`. Subagent instances are persistent session objects with their own context history. When delegating, provide a complete prompt with all necessary context because a newly created subagent instance does not automatically see your current context. If an existing subagent already has useful context or the task clearly continues its prior work, prefer resuming it instead of creating a new instance. Default to foreground subagents. Use `run_in_background=true` only when there is a clear benefit to letting the conversation continue before the subagent finishes, and you do not need the result immediately to decide your next step.

You have the capability to output any number of tool calls in a single response. If you anticipate making multiple non-interfering tool calls, you are HIGHLY RECOMMENDED to make them in parallel to significantly improve efficiency.

# General Guidelines for Coding

When building something from scratch, you should:

- Understand the user's requirements.
- Ask the user for clarification if there is anything unclear.
- Design the architecture and make a plan for the implementation.
- Write the code in a modular and maintainable way.

Always use tools to implement your code changes:

- Use `write_file` to create or overwrite source files. Code that only appears in your text response is NOT saved to the file system and will not take effect.
- Use `execute` to run and test your code after writing it.
- Iterate: if tests fail, read the error, fix the code with `write_file` or `edit_file`, and re-test with `execute`.

When working on an existing codebase, you should:

- Understand the codebase by reading it with tools (`read_file`, `glob`, `grep`) before making changes. Identify the ultimate goal and the most important criteria to achieve the goal.
- For a bug fix, you typically need to check error logs or failed tests, scan over the codebase to find the root cause, and figure out a fix. If user mentioned any failed tests, you should make sure they pass after the changes.
- For a feature, you typically need to design the architecture, and write the code in a modular and maintainable way, with minimal intrusions to existing code. Add new tests if the project already has tests.
- Make MINIMAL changes to achieve the goal.
- Follow the coding style of existing code in the project.

# General Guidelines for Research and Data Processing

The user may ask you to research on certain topics, process or generate certain multimedia files. When doing such tasks, you must:

- Understand the user's requirements thoroughly, ask for clarification before you start if needed.
- Make plans before doing deep or wide research, to ensure you are always on track.
- Search on the Internet if possible, with carefully-designed search queries to improve efficiency and accuracy.
- Use proper tools or shell commands or Python packages to process or generate images, videos, PDFs, docs, spreadsheets, presentations, or other multimedia files.

# Working Environment

## Operating System

You are on **${OS}**. The Shell tool executes commands using **${SHELL}**.

## Date and Time

The current date and time in ISO format is `${CMB_NOW}`.

## Working Directory

The current working directory is `${WORKSPACE_PATH}`.

The directory listing of current working directory is:

```
${WORKSPACE_LS}
```

## Harness Project Context

${HARNESS_PROJECT_INFO}

# Project Information

Markdown files named `AGENTS.md` usually contain the background, structure, coding styles, user preferences and other relevant information about the project. You should use this information to understand the project and the user's preferences.

The `AGENTS.md` instructions (merged from all applicable directories):

`````````
${AGENTS_MD}
`````````

# Skills

${SKILLS}

# Tool Usage

${TOOL_USAGE}

# Ultimate Reminders

At any time, you should be HELPFUL, CONCISE, and ACCURATE. Be thorough in your actions — test what you build, verify what you change — not in your explanations.

- Never diverge from the requirements and the goals of the task you work on. Stay on track.
- Never give the user more than what they want.
- Try your best to avoid any hallucination.
- Think about the best approach, then take action decisively.
- Do not give up too early.
- ALWAYS, keep it stupidly simple. Do not overcomplicate things.
- When the task requires creating or modifying files, always use tools to do so.
```

### 4.4 `src/main/agent/system-prompt.ts`（改造）

保持现有 `BASE_SYSTEM_PROMPT`、`MEMORY_SYSTEM_PROMPT` 和普通模式使用逻辑**不变**。

新增导出：

```ts
export function renderToolUsageSection(options: {
  hasSearchTool: boolean
  hasInspectTool: boolean
  hasInvokeDeferredTool: boolean
  hasCodeExecTool: boolean
  deferredToolIds: string[]
}): string {
  return [
    "## General Tool Principles",
    "",
    "- Prefer built-in file tools (`read_file`, `write_file`, `edit_file`, `glob`, `grep`) over shell commands for file operations.",
    "- Use `execute` for running scripts, tests, builds, and system commands.",
    "- Output multiple independent tool calls in parallel when possible.",
    "- Always follow the parameter descriptions of each tool exactly.",
    "",
    renderInjectedToolUsagePrompt({ ...options }),
    "",
    renderAvailableDeferredToolsPrompt(options.deferredToolIds)
  ].join("\n")
}
```

### 4.5 `src/main/agent/agents-md.ts`（改造）

保持现有 `loadAgentsPromptForWorkspace` 和普通模式使用逻辑**不变**。

新增包装函数（仅用于 harnessboard 模板）：

```ts
export async function loadAgentsMdForTemplate(
  workspacePath: string,
  options?: AgentsPromptBudgetOptions
): Promise<{ prompt: string | null; loadedPaths: string[]; truncated: boolean }> {
  const result = await loadAgentsPromptForWorkspace(workspacePath, options)
  return {
    prompt: result.prompt,
    loadedPaths: result.loadedPaths,
    truncated: result.truncated
  }
}
```

### 4.6 `src/main/harness-board/service.ts`（改造）

在 `HarnessFeatureAgentContext` 中新增字段：

```ts
export interface HarnessFeatureAgentContext {
  // ... existing fields
  systemPromptConfig?: HarnessSystemPromptConfig
}
```

在 `buildHarnessFeatureAgentContext` 中读取：

```ts
const systemPromptInject = readBoardConfigPlatformText(cwd, "system_prompt_inject")
const systemPromptConfig = readBoardConfigSystemPrompt(cwd) // 新增

// ...

return {
  // ...
  workingDirPromptAppendix: systemPromptInject,
  systemPromptConfig
}
```

新增辅助函数：

```ts
function readBoardConfigSystemPrompt(pluginDir: string): HarnessSystemPromptConfig | undefined {
  const config = readBoardConfig(pluginDir)
  if (!config || typeof config !== "object") return undefined
  const systemPrompt = (config as Record<string, unknown>).systemPrompt
  if (!systemPrompt || typeof systemPrompt !== "object") return undefined
  const { template, args } = systemPrompt as Record<string, unknown>
  return {
    template: typeof template === "string" ? template : undefined,
    args: typeof args === "object" && args !== null ? (args as Record<string, string>) : undefined
  }
}
```

### 4.7 `src/main/agent/runtime.ts`（改造）

核心变化：harnessboard 模式下用模板渲染替换原 `getSystemPrompt() + workingDirPromptAppendix` 的硬编码逻辑；普通模式保持不变。

伪代码：

```ts
let systemPrompt: string
let agentsPrompt: AgentsPromptResult = {
  prompt: null,
  projectRoot: workspacePath,
  loadedPaths: [],
  truncated: false
}

if (featureId) {
  // harnessboard 模式：使用模板系统
  const harnessContext = buildHarnessFeatureAgentContext(thread.metadata)
  const agentsMd = enableAgentsPrompt
    ? await loadAgentsMdForTemplate(workspacePath, {
        globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
        projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES
      })
    : { prompt: null, loadedPaths: [], truncated: false }

  systemPrompt = await buildHarnessSystemPrompt(workspacePath, {
    harnessContext,
    agentsMd,
    windowsSandbox,
    deferredToolIds,
    // ... 其他上下文
  })
} else {
  // 普通模式：保持现有逻辑不变
  systemPrompt = getSystemPrompt(workspacePath, windowsSandbox, workingDirPromptAppendix, {
    includeSubagents: true
  })

  if (enableAgentsPrompt) {
    agentsPrompt = await loadAgentsPromptForWorkspace(workspacePath, {
      globalMaxBytes: DEFAULT_GLOBAL_AGENTS_MAX_BYTES,
      projectMaxBytes: DEFAULT_AGENTS_MAX_BYTES
    })
    if (agentsPrompt.prompt) {
      systemPrompt += "\n\n" + agentsPrompt.prompt
    }
  }
}

if (extraSystemPrompt) {
  systemPrompt += "\n\n" + extraSystemPrompt
}

// 后续 Tool Orchestrator、backend 初始化等逻辑保持不变
```

新增 `buildHarnessSystemPrompt` 辅助函数：

```ts
async function buildHarnessSystemPrompt(
  workspacePath: string,
  options: {
    harnessContext: HarnessFeatureAgentContext
    agentsMd: { prompt: string | null; loadedPaths: string[]; truncated: boolean }
    windowsSandbox?: "none" | "unelevated" | "readonly" | "elevated"
    deferredToolIds: string[]
    // ...
  }
): Promise<string> {
  const specPath = path.join(__dirname, "templates/harness/agent.yaml")
  let spec = await loadAgentSpec(specPath)

  // 合并 board_config.json 中的 systemPrompt 配置
  const config = options.harnessContext.systemPromptConfig
  if (config?.template) {
    const customTemplatePath = path.isAbsolute(config.template)
      ? config.template
      : path.resolve(options.harnessContext.pluginDir, config.template)
    spec.systemPromptPath = customTemplatePath
  }
  if (config?.args) {
    spec.systemPromptArgs = { ...spec.systemPromptArgs, ...config.args }
  }

  const vars: HarnessSystemPromptVars = {
    ROLE_ADDITIONAL: spec.systemPromptArgs.ROLE_ADDITIONAL ?? "",
    CMB_NOW: getRuntimeTimeContext().currentTime,
    WORKSPACE_PATH: workspacePath,
    WORKSPACE_LS: await listWorkspace(workspacePath),
    OS: platform,
    SHELL: shell,
    HARNESS_PROJECT_INFO: buildHarnessProjectInfo(options.harnessContext),
    AGENTS_MD: options.agentsMd.prompt ?? "",
    SKILLS: skillsFormatted,
    TOOL_USAGE: renderToolUsageSection({ ... })
  }

  const template = await fs.readFile(spec.systemPromptPath, "utf-8")
  return renderTemplate(template, vars)
}
```

---

## 5. 配置规范

### 5.1 `board_config.json` 新增字段

```json
{
  "inspectCommands": { ... },
  "system_prompt_inject": "...",
  "systemPrompt": {
    "template": "./custom-system.md",
    "args": {
      "ROLE_ADDITIONAL": "Custom role guidance for this plugin."
    }
  }
}
```

字段说明：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `systemPrompt` | object | 否 | 系统提示词配置 |
| `systemPrompt.template` | string | 否 | 自定义模板路径，相对路径基于插件目录解析 |
| `systemPrompt.args` | object | 否 | 覆盖或追加模板变量 |

### 5.2 模板路径解析规则

1. 若 `template` 以 `/` 或盘符开头（绝对路径），直接使用。
2. 若 `template` 为相对路径，基于 `adapterPluginDir(project)` 解析。
3. 若未指定 `template`，使用默认 harness 模板 `src/main/agent/templates/harness/system.md`。

### 5.3 变量优先级

1. 运行时内置变量（如 `${WORKSPACE_PATH}`）
2. `agent.yaml` 中的 `system_prompt_args`
3. `board_config.json` 中的 `systemPrompt.args`（最高优先级，覆盖前者）

---

## 6. harnessboard 渲染流程

```
createAgentRuntime()
  ├── 判断 featureId 是否存在
  ├── 普通模式
  │     └── 保持现有 getSystemPrompt() + AGENTS.md 直接拼接逻辑
  └── harnessboard 模式
        ├── 读取 harness context（含 board_config.systemPrompt）
        ├── loadAgentSpec('templates/harness/agent.yaml')
        ├── 合并 board_config systemPrompt 配置
        ├── 收集内置变量
        │     ├── CMB_NOW, WORKSPACE_PATH, WORKSPACE_LS
        │     ├── OS, SHELL
        │     ├── HARNESS_PROJECT_INFO
        │     ├── AGENTS_MD
        │     ├── SKILLS
        │     └── TOOL_USAGE
        ├── 合并 agent.yaml system_prompt_args
        ├── 合并 board_config systemPrompt.args
        ├── 读取 system.md 模板文件
        ├── renderTemplate() 替换 ${VAR}
        └── 追加 extraSystemPrompt（兼容）
```

---

## 7. 测试策略

### 7.1 单元测试

新增 `tests/agent-spec.spec.ts`：

- `loadAgentSpec` 解析 harness agent.yaml
- `renderTemplate` 正常替换变量
- `renderTemplate` 对未定义变量发出 warn 并置空
- 模板路径解析（相对/绝对）

新增 `tests/system-prompt-template.spec.ts`：

- harness 模板渲染后章节顺序正确
- `${AGENTS_MD}` 出现在 `# Project Information` 章节内
- `${HARNESS_PROJECT_INFO}` 出现在 `# Working Environment` 章节内
- `${TOOL_USAGE}` 包含 Tool Routing Gate 和 Deferred Tools
- board_config 自定义 template 和 args 生效
- 普通模式系统提示词与改动前保持一致（回归）

### 7.2 更新现有测试

- `tests/agents-md.spec.ts`：
  - 保留现有发现/合并/预算测试
  - 新增 `loadAgentsMdForTemplate` 输出格式测试

### 7.3 集成验证

- 普通模式新 thread：系统提示词与改动前完全一致。
- harnessboard 模式新 thread：使用 harness 模板，章节顺序符合 Kimi Code 结构。
- 配置自定义 template：验证 `board_config.json` 生效。

---

## 8. 风险与回滚

| 风险 | 缓解措施 |
|---|---|
| 普通模式提示词被意外改动 | 代码分支隔离；回归测试对比普通模式输出 |
| 模板变量遗漏替换 | 单元测试覆盖所有变量；未定义变量时 warn |
| 自定义 template 路径解析错误 | 绝对路径与相对路径分别测试；失败时回退默认模板 |
| 性能下降（文件 I/O） | 模板文件很小；后续可考虑缓存 |
| 老版本 board_config.json 不兼容 | `systemPrompt` 为可选字段 |

---

## 9. 交付物清单

- [ ] `src/main/agent/agent-spec.ts`（新增）
- [ ] `src/main/agent/templates/harness/agent.yaml`（新增）
- [ ] `src/main/agent/templates/harness/system.md`（新增）
- [ ] `src/main/agent/system-prompt.ts`（新增 `renderToolUsageSection`）
- [ ] `src/main/agent/agents-md.ts`（新增 `loadAgentsMdForTemplate`）
- [ ] `src/main/agent/runtime.ts`（新增 harness 模板渲染分支）
- [ ] `src/main/harness-board/service.ts`（新增 systemPrompt 配置读取）
- [ ] `tests/agent-spec.spec.ts`（新增）
- [ ] `tests/system-prompt-template.spec.ts`（新增）
- [ ] `tests/agents-md.spec.ts`（更新）
- [ ] `sys_exc_plan.md`（本设计文档）
