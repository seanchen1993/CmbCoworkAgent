# oh-my-opencode 及主流 Agent 插件生态调研

> 调研日期：2026-06-05
> 调研对象：oh-my-opencode、OpenCode 插件体系、oh-my-openagent、**oh-my-claudecode**、**OpenClaw**、Claude Code 插件/技能/子代理生态及相关周边项目
> 目的：评估上述生态的设计思路，识别可被本项目（CMBDevClaw）谨慎借鉴的能力与机制
> 性质：**调研与可行性参考**，非实施承诺。所有"建议"均需结合本项目安全模型与合规要求二次评审后再决定是否落地
>
> 更新（2026-06-05 二轮）：新增 **oh-my-claudecode**（Claude Code 多代理编排插件）与 **OpenClaw**（个人 AI 助理网关，本机已检出于 `c:\ai\openclaw`，含一手源码）两个深度调研，见 §4.4、§4.5、§4.6。其中 OpenClaw 与本项目同构度最高（桌面/网关形态 + 多聊天渠道 + 记忆 + 安全审计），是本轮最有价值的对照对象。
>
> 更新（2026-06-08 三轮）：**oh-my-claudecode 与 oh-my-opencode 的完整源码已检出于 `C:\ai\oh-my-claudecode` 与 `C:\ai\oh-my-opencode`**。新增 §9「源码核实：可直接移植的实现细节」，把前文基于 README 的二手判断升级为**带文件路径、带具体逻辑的一手核实**，并给出可落地的移植要点。前文若与 §9 有出入，**以 §9（源码）为准**。

---

## 0. TL;DR（结论先行）

- oh-my-opencode 的核心价值不是"某个功能"，而是一套 **"开箱即用的多代理编排 + 行为约束 + 确定性代码工具"** 的组合拳。其大部分理念（技能、Hook、MCP、子代理、多模型分工）本项目已具备同类能力，差距主要在 **预置质量、子代理并行编排、LSP/AST 级确定性工具、行为强制（防偷懒/防注水注释）** 这几处。
- **最值得借鉴**（低风险、高价值）：
  1. **按"角色"预置子代理 + 按任务类别路由**（visual/business-logic/debug → 不同模型/agent）。
  2. **行为强制 Hook**：Todo 续跑强制（防止 Agent 中途停手）、注释质量检查。本项目已有 Hook 体系，属增量。
  3. **LSP/AST 级代码工具**（重命名、诊断、结构化搜索/改写）替代纯文本编辑，提升确定性与安全性。
  4. **后台子代理并发上限**（按 provider/model 限流）作为编排稳定性保障。
- **需谨慎或暂缓**：
  - "默认全开、agent 自助安装"的激进哲学与本项目"沙箱默认开启、高风险命令需审批"的安全基线**直接冲突**，不可照搬。
  - 第三方插件市场/npm 自动安装链路存在**供应链与命令执行风险**，若引入须有签名、来源白名单与审批。
  - 多模型分工依赖大量外部模型（GPT/Gemini/Grok），与本项目（招行内网/合规环境，DeepAgents+自有模型配置）的可用模型集合不一定匹配。

- **二轮新增结论（oh-my-claudecode / OpenClaw）**：
  - **oh-my-claudecode** 把"多代理团队"做成了**确定性流水线**（plan→prd→exec→verify→fix 循环）+ **模型分层路由**（Haiku/Sonnet/Opus 按复杂度，省 30–50% token）+ **tmux 真进程协同**（拉起真实 `claude`/`codex`/`gemini` CLI）。最值得借鉴的是 **"分层路由省 token" 与 "可观测 HUD/会话产物（sessions/replay 日志）"**。
  - **OpenClaw**（本机已检出）是本轮**最高价值参照**：它的 **安全审计套件**（`src/security/` 下数十个 audit：沙箱、exec 面、插件信任、技能扫描、workspace 技能逃逸、危险配置标志）、**严格的插件 SDK 边界契约**（core 必须与扩展无关，扩展只能经 `openclaw/plugin-sdk/*` 入核）、**向量记忆**（memory-lancedb + memory-wiki）、**20+ 聊天渠道**（含微信/QQ/飞书，直接对标本项目 ChatX）都极具借鉴价值。其中**安全审计套件**是本项目作为金融场景应用最该优先吸收的工程实践。

---

## 1. 调研背景与本项目定位

本项目 **CMBDevClaw**（仓库 `CmbCoworkAgent`）是基于 `Electron + React + TypeScript + DeepAgents/LangChain` 的**本地 AI Agent 桌面应用**，已具备：

- 多线程对话、工作区读写、命令执行
- 技能系统（内置/自定义/上传/在线提案）
- MCP 扩展、插件系统（ZIP/目录安装，内置 skills 与 `.mcp.json` 自动注册）
- Hook 系统（全局/工作区/插件/技能，兼容 Claude Code hooks settings、`SKILL.md` frontmatter、`once`/`onBlock`/强制修订）
- 安全执行（safe/needs_approval/forbidden 分级、审批缓存、沙箱模式）
- 自优化（Trace 回放、候选技能生成）、定时任务、Heartbeat、Memory、ChatX 机器人、Kanban 视图

因此本项目与 OpenCode/Claude Code 生态**高度同构**——它本质上是一个"自带 GUI 的 Agent 运行时（harness）"。oh-my-opencode 这类项目是在 OpenCode 之上的"增强层"，其许多能力恰好对应本项目可继续打磨的方向。

> 关键差异：本项目是**桌面 GUI + 自有运行时**，而 OpenCode 是**终端 CLI + 插件生态**。借鉴时要区分"理念/机制"（可借鉴）与"实现形态"（不一定适用）。

---

## 2. oh-my-opencode 深度解析

### 2.1 定位

OpenCode 之上的"batteries-included"编排层，把 OpenCode 从单代理 CLI 升级为**生产级多代理 harness**。口号："Claude Code is great. But if you're a hacker, you'll fall head over heels for OpenCode." 明确以 AmpCode、Claude Code 为参照，移植并"往往改进"其能力。

> 注意：官方多次警告 `ohmyopencode.com` 与项目**无官方关联**，请勿在第三方站点下载安装包或输入支付信息——这一点本身也提示了该生态的**供应链/钓鱼风险**。

### 2.2 子代理团队（按角色 + 模型分工）

| 子代理 | 职责 | 绑定模型（示例） |
| --- | --- | --- |
| Sisyphus | 旗舰主控/核心开发 | Opus 4.5 High |
| Oracle | 架构与调试 | GPT 5.2 Medium |
| Frontend UI/UX | 前端/视觉 | Gemini 3 Pro |
| Librarian | 官方文档/开源探索 | Claude Sonnet 4.5 |
| Explore | 快速代码库映射（contextual grep） | Grok Code |
| Prometheus | 规划与任务拆解 | — |
| Metis | 方案咨询 | — |

设计要点：**子代理异步并行**，把"重活/噪声大的探索"从主控上下文剥离，主控只接收摘要 → 降低主上下文负载。

### 2.3 确定性代码工具（LSP/AST）

- 完整 LSP 支持：重命名、诊断、AST 感知搜索
- AstGrep 集成做精确重构
- 内置技能：Playwright（浏览器自动化）、Git Master（原子化提交）、Tmux 交互式终端、会话工具（列出/读取/搜索/分析历史）

核心理念：**用 AST/LSP 替代纯文本改写，更确定、更安全**。

### 2.4 多模型组合策略

按任务专长路由：架构 → GPT、前端视觉 → Gemini、文档研究 → Sonnet、核心开发 → Opus。即"不同模型干不同活"。

### 2.5 Claude Code 兼容层

完整兼容 Claude Code 扩展机制：**Commands、Agents、Skills、MCPs、Hooks（25+ 扩展点：PreToolUse/PostToolUse/UserPromptSubmit/Stop 等，可通过 `disabled_hooks` 关闭）**。

### 2.6 预置 MCP

Exa（Web 搜索）、Context7（官方文档）、Grep.app（公共仓库代码搜索）——减少自建集成。

### 2.7 配置架构

- 多级配置：项目级 `.opencode/oh-my-opencode.json` + 用户级 `~/.config/opencode/oh-my-opencode.json`
- 支持 JSONC（注释 + 尾逗号）
- 可配置项：agent 的模型/温度/系统提示/权限矩阵、后台任务并发上限（按 provider/model）、任务类别路由、Hook 开关、LSP 参数、实验特性开关

### 2.8 行为强制机制（差异化亮点）

- **Todo Continuation Enforcer**：Agent 中途想停就强制其继续（"keeps Sisyphus rolling the boulder"）。
- **Comment Checker**：抑制 AI 生成的注水注释，让产出"与人写的无差别"。
- **Ralph Loop**：强制任务完成模式。
- **Think Mode**：扩展推理/规划。

### 2.9 后台编排与类别路由

多 agent 并发执行，按 provider/model 设并发上限；按 `visual / business-logic / debugging / 自定义` 类别路由到对应 agent。自动注入 `AGENTS.md` / `README.md`、按文件类型应用条件规则、跨多代理管理上下文预算。

### 2.10 实验特性

激进截断（aggressive truncation）、自动恢复（auto-resume）、高级续跑。

### 2.11 设计哲学（需批判看待）

- "Battery included, works out of the box"，**所有功能默认开启**。
- 安装建议"让 agent 来装，人会出错"——体现"agent 自助配置"理念，但**与高安全环境天然冲突**。

---

## 3. OpenCode 插件 / 代理底层机制（被借鉴的"土壤"）

### 3.1 插件系统

- 插件 = 导出 plugin 函数的 JS/TS 模块；函数收 context 返回 hooks 对象。
- 加载顺序：全局 config → 项目 config → 全局插件目录 → 项目插件目录。
- 两种装载：本地文件 / npm 包（启动时用 Bun 自动安装到 `~/.cache/opencode/node_modules/`）。
- context 提供：`project / directory / worktree / client(SDK) / $(Bun shell)`。
- **30+ 事件**：session.*（created/compacted/idle/error/updated）、tool.execute.before/after、file.edited/file.watcher.updated、message.*、command/LSP/permission/server/todo/shell/TUI 等。
- 支持 **Zod schema 定义自定义工具**、注入环境变量、保护敏感文件、发送通知、改写工具执行。
- `experimental.session.compacting` 钩子可在压缩时注入上下文或替换压缩提示词。

### 3.2 代理系统

- **Primary**（Build/Plan，Tab 切换）vs **Subagent**（General/Explore/Scout，主控自动调用或 `@mention`）。
- 定义方式：`opencode.json` JSON 配置 **或** markdown 文件（`agents/` 下，文件名即 agent 名，如 `review.md` → `review`）。
- 细粒度权限：`ask / allow / deny`，键含 `read/edit/bash/glob/grep/list/task/webfetch`，支持 glob（如 `"git *": "ask"`）。
- 每 agent 可覆盖模型；mode 为 `primary/subagent/all`。
- 子会话导航：child-first / child-cycle / parent。

---

## 4. 横向对比：其他主流生态

### 4.1 OpenCode 周边（awesome-opencode 精选）

| 项目 | 能力 | 对本项目的启发 |
| --- | --- | --- |
| Background Agents | 异步代理委派 + 上下文持久化 | 子代理并行编排 |
| Agent Memory | 可自编辑的持久记忆块 | 对照本项目 Memory |
| Dynamic Context Pruning / opencode-snip | 裁剪过时输出，节省 60–90% token | 上下文压缩/裁剪 |
| Handoff | 为新会话生成聚焦交接提示词 | 长任务/跨线程交接 |
| Micode | Brainstorm-Plan-Implement 工作流 + 子代理编排 | 规划-实现工作流 |
| Opencode Worktree | 零摩擦 git worktree | 对照本项目 Worktree |
| Tokenscope / Context Analysis / Quota | token 用量/成本分析与配额提示 | 成本可观测性 |
| Vibe Kanban | 并行 AI agent 的看板 | 对照本项目 Kanban |
| Agent Identity / Model Announcer | 多代理自我身份/当前模型自知 | 多代理协同辨识 |
| OpenChamber / OpenWork | OpenCode 的 Web/桌面 GUI（OpenWork 自称"Claude Cowork 的桌面替代"） | **直接同类竞品形态** |

> 值得注意：awesome 列表中已出现"Claude Cowork 桌面替代"类项目，说明本项目所处赛道（Cowork 形态桌面 Agent）已有公开竞品，可持续跟踪。

### 4.2 oh-my-openagent（omo）

同源理念（同样有 Sisyphus 命名），定位"复杂代码库的唯一 agent harness——复杂软件工程的镐子"，面向 Codex / OpenCode。强调：后台代理、预置 LSP/AST/MCP 工具、精选 agent 包、Claude Code 兼容。可视为 oh-my-opencode 的"跨宿主"版本。

> （注：调研时 `code-yeongyu/oh-my-openagent` 仓库页抓取遇到证书错误，以上为来自检索摘要的二手信息，**需以仓库一手内容复核**。）

### 4.3 Claude Code 官方生态（2026）

七大组件：**CLAUDE.md、Skills（已合并旧 Commands）、Subagents、Agent Teams、Plugins、Hooks（约 24 个）、MCP Servers**。关键心智模型：

- **Skill = 知识**，与当前对话**同一上下文**运行，无隔离；`/skill-name` 或自动判定触发。
- **Subagent = 工人**，**独立上下文**、无历史干扰、只回传摘要，适合大规模/噪声任务。
- **Hook = 隐形规则执行**，你不盯着时也会跑。
- **Plugin = 一键打包分发**（skills+hooks+subagents+tools），从 marketplace 安装缓存到 `~/.claude/plugins/cache/`，跨项目可用。
- **Marketplace = GitHub 仓库做注册表**，可订阅。已有第三方市场号称 425 插件 / 2810 技能 / 200 agent + `ccpi` 包管理器。

本项目的 Hook 兼容层、技能/插件/MCP 已对齐这一心智，**方向正确**。

### 4.4 oh-my-claudecode（OMC）— Claude Code 多代理编排插件

仓库 `Yeachan-Heo/oh-my-claudecode`（MIT，~13k+ stars，作者 Yeachan Heo；npm 包名 `oh-my-claude-sisyphus`，命令 `omc`）。定位"teams-first 多代理编排"，主打"不用学 Claude Code，说要做什么即可"。

**核心：确定性团队流水线（Team mode 为主入口）**

```
team-plan → team-prd → team-exec → team-verify → team-fix（循环）
```

各 agent 在共享任务清单上接力，而非孤立工作。

**19 个专职 agent**（架构/研究/设计/测试/数据科学/执行等），每个有**分层模型变体**：简单任务 Haiku、均衡 Sonnet、深推理 Opus。官方称按复杂度路由可省 **30–50% token**，并提供 premium/balanced/budget 成本档位预设。

**多执行模式**：

| 模式 | 说明 |
| --- | --- |
| Team（推荐） | 分阶段流水线，Claude agents 共享任务清单 |
| Autopilot | 单自治 agent，端到端、轻仪式 |
| Ultrawork / Ralph | 最大并行 + 持久续跑（带 verify/fix 循环） |
| UltraQA | 质量门循环：反复 诊断/修复 直到测试通过 |
| omc team (CLI) | **tmux 拉起真实 `claude`/`codex`/`gemini`/`grok` CLI 进程**，分屏、按需启动、自动清理 |
| Pipeline | 严格有序的顺序处理 |

**多供应商协同**：通过 tmux worker 调度外部 CLI——Codex 做架构校验/代码评审交叉验证、Gemini 做 UI/UX 与大上下文（1M）、Grok 做评审交叉验证；`/ccg`、`omc ask codex/gemini` 各自独立产出，再由 Claude 综合，结果落 `.omc/artifacts/ask/`。

**技能与学习**：`/skillify` 把可复用模式提取为带 `triggers` 元数据的 `.md`（项目级 `.omc/skills/` 优先于用户级 `~/.omc/skills/`），匹配时自动注入。

**可观测性**：
- **HUD 状态行**：实时展示活动任务/token/协同状态（`/hud setup`）。
- **会话产物**：`.omc/sessions/*.json`（摘要+指标）、`.omc/state/agent-replay-*.jsonl`（回放日志）。

**其他工程化亮点**：多仓工作区（`.omc-workspace` 标记共享状态）、**限流自动恢复**（`omc wait --start` 检测 rate-limit 重置后自动续跑会话）、Stop 回调把会话摘要推送到 Telegram/Discord/Slack、可经 webhook 把会话事件转发到 **OpenClaw** 网关（两生态打通）。

**对本项目的启发**：①"确定性流水线 + verify/fix 循环"比纯自由编排更可控；②**模型分层路由省 token** 是企业落地刚需；③**HUD + 会话回放日志**是本项目自优化/Trace 能力的可视化与可观测增强方向；④tmux 真进程协同是 CLI 思路，本项目桌面形态可用"子进程 + 面板"等价实现，但要纳入审批与沙箱。

### 4.5 OpenClaw — 个人 AI 助理网关（本机已检出一手源码）

仓库 `openclaw/openclaw`（MIT，发布一周即破 10 万 stars；TypeScript/ESM，Node 22+，pnpm/bun，Vitest）。本机检出于 `c:\ai\openclaw`，以下基于**一手源码目录结构**。

定位：你自托管的**个人 AI 助理**，在你已用的聊天渠道上回应你；能浏览网页、读写文件、跑 shell、在沙箱执行代码。"Gateway 只是控制面，产品是助理本身。"

**与本项目高度同构的子系统（重点）**：

1. **多聊天渠道（直接对标 ChatX 机器人，且远更全）**
   `extensions/` 与 `src/channels/` 含 20+ 渠道：Telegram、Discord、Slack、Signal、iMessage、WhatsApp、Matrix、**Feishu（飞书）**、**qqbot（QQ）**、**WeChat（微信）**、LINE、Zalo、MS Teams、IRC、Nextcloud Talk、Synology Chat 等。本项目 ChatX 当前是单一 WebSocket 收/HTTP 回的形态，可参考其**渠道抽象**（`src/channels/plugins/types.*`：plugin/core/adapters 三类型，路由、allowlist、配对 pairing、命令门控、onboarding 统一处理）。

2. **安全审计套件（`src/security/`，本轮最值得吸收）**
   一整套静态/运行时审计，覆盖：
   - `audit-exec-surface` / `audit-exec-safe-bins` / `audit-exec-sandbox-host`：命令执行面与安全二进制白名单审计
   - `audit-plugins-trust` / `audit-plugin-code-safety` / `audit-trust-model`：**插件信任模型与插件代码安全扫描**
   - `skill-scanner` / `audit-workspace-skill-escape`：**技能扫描与"技能逃逸工作区"检测**
   - `audit-sandbox-docker-config` / `audit-sandbox-browser`：沙箱配置审计
   - `dangerous-config-flags` / `dangerous-tools` / `external-content`：危险配置标志、危险工具、外部内容（注入面）治理
   - `audit-gateway-exposure` / `audit-gateway-http-auth` / `audit-config-symlink` / `windows-acl` / `temp-path-guard`：网关暴露、HTTP 鉴权、符号链接/临时路径/Windows ACL 防护
   - 统一由 `openclaw doctor` / audit runtime 驱动，`fix.ts` 提供修复路径。
   这套"**把安全做成可执行的审计 + doctor 自检+修复**"的工程范式，正是本项目（金融场景、可执行命令+读写工作区）最该优先借鉴的。

3. **向量记忆（对标本项目 Memory）**
   `extensions/memory-core`、`extensions/memory-lancedb`（**LanceDB 向量库**）、`extensions/memory-wiki`，外加 `src/memory-host-sdk` 与 `packages/memory-host-sdk`。本项目 Memory 目前是文件 + 索引检索，可借鉴**向量检索 + wiki 式结构化记忆**。

4. **严格的插件 SDK 边界契约（架构治理范本）**
   见 `AGENTS.md`「Architecture Boundaries」：**core 必须与扩展无关**，扩展只能经 `openclaw/plugin-sdk/*` + manifest + 文档化运行时 helper 入核，禁止深引 `src/**` 或别的扩展内部；新增扩展不得逼 core 改无关代码；插件 seam 必须是**文档化、向后兼容、带版本的契约**（"我们有第三方插件在野，不轻易破坏"）。`src/plugins/*` 负责发现/清单校验/加载/注册表/契约强制。对本项目插件系统的**长期可维护性**很有参考价值。

5. **上下文引擎 / Hooks / Cron**
   - `src/context-engine`（delegate/registry/types）：上下文委派与裁剪。
   - `src/hooks`：bundled/plugin-hooks/workspace/policy/frontmatter/internal-hooks 多源 Hook（与本项目 Hook 多作用域设计同构，可对照其 `policy.ts` 与 frontmatter 处理）。
   - `src/cron`：定时任务（对标本项目 scheduler）。

6. **沙箱**：`Dockerfile.sandbox` / `Dockerfile.sandbox-browser` / `Dockerfile.sandbox-common`——**Docker 化沙箱**（含浏览器沙箱），与本项目 Windows 本地沙箱思路不同，可作为"更强隔离"的演进选项参考。

7. **coding-agent 技能（委派式）**：`skills/coding-agent/SKILL.md` 把编码任务**委派给 Codex/Claude Code/OpenCode/Pi**（后台进程/PTY），并在 frontmatter 用 `metadata.openclaw.requires.anyBins` 与 `install` 声明依赖与安装方式——是"技能即可声明依赖与安装器"的良好范式。

**OpenClaw 的提示词缓存稳定性纪律**（`AGENTS.md`「Prompt Cache Stability」）也值得一提：从 map/set/registry/插件列表/MCP 目录组装请求前必须**确定性排序**；不要每轮重写历史字节以免使缓存前缀失效；截断/压缩应优先动尾部。**这对本项目控制模型成本同样适用**。

### 4.6 oh-my-claudecode × OpenClaw × 本项目 形态对照

| 维度 | oh-my-claudecode | OpenClaw | 本项目 CMBDevClaw |
| --- | --- | --- | --- |
| 形态 | Claude Code 之上的插件 | 自托管网关 + 多端 App | Electron 桌面 App + 自有运行时 |
| 核心卖点 | 多代理团队流水线 + 模型分层 | 多渠道个人助理 + 安全/记忆 | 工程研发协作 + 安全执行 |
| 多代理 | ✅ 19 agent + tmux 真进程 | ⚠️（以技能委派外部 CLI 为主） | ⚠️ DeepAgents 子代理 |
| 聊天渠道 | 仅 Stop 回调通知 | ✅✅ 20+ 渠道（含微信/QQ/飞书） | ⚠️ ChatX 单通道 |
| 安全治理 | 基本（继承 CC） | ✅✅ 审计套件 + doctor | ✅ 命令分级 + 沙箱 + 审批 |
| 记忆 | 技能元数据 | ✅ 向量(LanceDB)+wiki | ✅ 文件 + 索引 |
| 可观测 | ✅ HUD + replay 日志 | doctor/status/logs | ⚠️ 待加强 |
| 插件治理 | marketplace | ✅✅ 严格 SDK 边界契约 | ⚠️ ZIP/目录安装 |

---

## 5. 能力差距矩阵（本项目 vs 该生态）

| 能力维度 | 本项目现状 | oh-my-opencode / 生态 | 差距判断 |
| --- | --- | --- | --- |
| 技能系统 | ✅ 内置/自定义/上传/在线提案 | ✅ 预置高质量技能包 | 机制对等，**预置质量与数量**有差距 |
| Hook 系统 | ✅ 多作用域、兼容 CC、强制修订/停止 | ✅ 25+ 点 + 行为强制 | 机制对等，**缺"防偷懒/注释质量"等行为强制策略** |
| MCP | ✅ 连接器管理/连通测试/懒加载 | ✅ 预置 Exa/Context7/Grep.app | 机制对等，**缺精选预置 MCP** |
| 插件系统 | ✅ ZIP/目录安装 | ✅ 本地+npm 自动安装 + 市场 | 本项目**更克制更安全**；生态有市场分发但带供应链风险 |
| 子代理 | ⚠️ DeepAgents 子代理（需确认并行/路由成熟度） | ✅ 角色化 + 类别路由 + 并发限流 | **核心差距：并行编排 + 路由 + 限流** |
| 代码工具 | ⚠️ 文件/命令为主 | ✅ LSP/AST/AstGrep 确定性工具 | **核心差距：确定性结构化改写** |
| 多模型分工 | ✅ 自定义模型配置 | ✅ 按类别绑定模型 / **OMC 按复杂度分层路由** | 机制可达，**缺"类别/复杂度→模型"路由策略层（省 token）** |
| 上下文管理 | ✅ checkpointer + 压缩（见 docs） | ✅ 压缩钩子 + 裁剪 + 自动恢复 / **OpenClaw 缓存稳定性纪律** | 大致对等，可补**动态裁剪/交接/确定性请求组装** |
| 安全/审批 | ✅✅ 沙箱默认开 + 命令分级 + 审批 | OMC/oh-my-opencode 较弱；**OpenClaw 有审计套件 + doctor** | 本项目执行审批强；**审计自检/插件信任扫描可向 OpenClaw 看齐** |
| 成本可观测 | ⚠️ 待确认 | ✅ token/配额看板 / **OMC HUD + replay 日志** | 可补**用量成本面板 + 会话回放可视化** |
| 聊天渠道 | ⚠️ ChatX 单通道 | **OpenClaw 20+ 渠道（微信/QQ/飞书）** | **核心差距：渠道抽象与覆盖面** |
| 记忆 | ✅ 文件 + 索引检索 | **OpenClaw 向量(LanceDB)+wiki** | 可补**向量检索 + 结构化记忆** |
| 多代理执行 | ⚠️ DeepAgents 子代理 | **OMC 确定性流水线 + tmux 真进程 + verify/fix 循环** | **核心差距：可控的团队流水线与质量门循环** |

---

## 6. 可借鉴清单（按"价值/风险"分级）

### A. 推荐借鉴（高价值 / 低风险，与现有安全模型不冲突）

1. **行为强制 Hook 策略集**（基于现有 Hook 体系增量）：
   - *Todo 续跑强制*：检测到 Agent 在未完成 Todo 时停手 → 注入"继续"。需配上限/熔断，避免死循环烧 token。
   - *注释质量检查*：PostToolUse 上对写入内容做注水注释检测并提示修订。
   - 价值：直接提升长任务完成率与产出质量；风险低，可灰度开关。

2. **LSP/AST 确定性代码工具**（重命名、诊断、结构化搜索/改写，参考 AstGrep）：
   - 价值：减少纯文本改写引入的破坏；与本项目沙箱+审批天然互补。
   - 风险：实现成本中等；建议先做"诊断/结构化搜索"只读能力，再做改写。

3. **子代理"角色化 + 任务类别路由 + 并发限流"**：
   - 预置 Explore（代码库映射）、Oracle（架构/调试）、Librarian（文档）等角色；按 visual/business-logic/debug 路由模型；按 provider/model 设并发上限。
   - 价值：降低主控上下文负载、提升复杂任务表现。
   - 风险：需与本项目 DeepAgents 子代理能力对齐，控制并发避免资源/成本失控。

4. **成本/用量可观测面板 + 会话回放**（token、配额、按线程/任务成本；参考 OMC 的 HUD 状态行与 `agent-replay-*.jsonl`）：
   - 价值：企业环境刚需；可复用现有 Customize 中心与现有 Trace 能力。

5. **安全审计自检（参考 OpenClaw `src/security/` + `doctor`）**：把"插件信任扫描、技能扫描/技能逃逸工作区检测、命令执行面审计、危险配置标志、网关/HTTP 暴露检查"做成**可一键运行的自检 + 修复建议**。
   - 价值：金融场景刚需；与本项目现有 `exec-policy`/沙箱/审批天然互补，是把"安全策略"升级为"安全可验证"的关键一步。
   - 风险：低（只读自检为主）；建议先做静态扫描与报告，再做 `--fix`。

6. **模型分层路由（参考 OMC：简单→Haiku、均衡→Sonnet、深推理→Opus）**：在现有自定义模型配置上加一层"任务复杂度/类别 → 模型"映射，**默认回退本项目可用模型**。
   - 价值：省 30–50% token；企业成本可控。

### B. 可选借鉴（中价值，需设计权衡）

7. **确定性团队流水线 + 质量门循环（参考 OMC：plan→exec→verify→fix / UltraQA）**：把"自由子代理编排"升级为"分阶段 + verify/fix 直到测试通过"，比纯放养更可控。需配最大迭代/成本上限。
8. **向量记忆 + 结构化（wiki）记忆（参考 OpenClaw memory-lancedb / memory-wiki）**：在现有文件 + 索引基础上引入向量检索。需评估内网可用的本地向量库。
9. **聊天渠道抽象（参考 OpenClaw `src/channels/plugins/types.*`）**：把 ChatX 从单通道演进为"渠道适配器 + 统一路由/allowlist/配对/命令门控"，便于未来接入飞书/企业微信等。
10. **插件 SDK 边界契约治理（参考 OpenClaw AGENTS.md 架构边界）**：当本项目插件生态变大时，确立"core 与扩展无关、扩展只经公共 SDK 入核、契约带版本向后兼容"的规则，避免长期腐化。
11. **提示词缓存稳定性纪律（参考 OpenClaw）**：请求组装前对 map/registry/插件/MCP 列表确定性排序；压缩优先动尾部，保住缓存前缀。低成本、直接省钱。
12. **预置精选 MCP/技能包**（受控来源，如内网文档检索、代码搜索）：替代 Exa/Context7/Grep.app 的内网等价物。
13. **动态上下文裁剪 + 会话交接（Handoff）提示词生成**：对照现有压缩方案增量。
14. **多级 + JSONC 配置**：若配置项增多，引入分级与注释友好格式。
15. **会话历史工具**（列出/读取/搜索/分析历史）作为内置技能。
16. **技能声明依赖与安装器（参考 OpenClaw coding-agent frontmatter `requires.anyBins` / `install`）**：让技能能声明所需二进制及安装方式，提升可移植性（安装动作仍须走审批）。

### C. 暂缓 / 谨慎（高风险或与本项目基线冲突）

9. **"默认全开 + agent 自助安装"哲学**：与"沙箱默认开、高风险审批"冲突，**不采纳**；保持默认安全、显式开启。
10. **npm/第三方市场自动安装链路**：供应链与任意命令执行风险。若做，须：来源白名单、签名校验、安装即审批、离线/内网镜像。
11. **强依赖多家外部商业模型（GPT/Gemini/Grok）**：在合规/内网环境多不可用；路由层应做成"可插拔模型映射"，默认回退到本项目可用模型。
12. **OMC 的 tmux 拉起真实外部 CLI（claude/codex/gemini）协同**：本质是"代理调用代理 + 任意进程"，在桌面/合规环境风险高。如借鉴其编排理念，应改为受控子进程并纳入沙箱+审批，**不直接拉起任意外部 Agent CLI**。
13. **OpenClaw 的"网关多渠道全开 + 公网暴露"形态**：其安全文档本身承认网关暴露/鉴权是重点审计面。本项目若扩渠道，须默认最小暴露、强鉴权、渠道级 allowlist。
14. **Ultrawork/Ralph 等"最大并行 + 强制续跑"**：与第 9 项行为强制同源风险（空转烧 token / 绕过意图），务必带成本与迭代上限、可中断。

---

## 7. 风险与合规提示

- **供应链风险**：插件/MCP/技能的第三方分发是主要攻击面。本项目的 ZIP/目录安装本已较克制，引入任何"自动拉取/自动安装"前必须接入审批与来源校验。
- **行为强制的副作用**：Todo 续跑/Ralph Loop 可能导致 Agent **空转烧 token**或绕过用户意图。必须有最大迭代数、用户可中断、成本上限。
- **AST/LSP 改写**仍是写操作，须纳入现有 `safe/needs_approval/forbidden` 与沙箱体系，不能因"确定性"而豁免审批。
- **品牌钓鱼**：oh-my-opencode 官方都需声明域名仿冒风险；本项目引用任何外部资源应固定到一手仓库/release。
- **二手信息复核**：本调研含来自搜索摘要与第三方文章的内容（尤其 oh-my-openagent 仓库未能直接抓取）。**落地前务必回到一手源码/官方文档核对**版本、行为与许可证。
- **许可证**：借鉴"理念/机制"通常安全；若**复制代码**须核对各项目 LICENSE 与本项目 MIT 的兼容性。

---

## 8. 建议的后续动作（非承诺）

1. 评审本文档第 6 节 A 类清单，挑选 1–2 项做 PoC。**修订后建议优先级**：① 安全审计自检（A5，金融场景最高优先，且 OpenClaw 一手源码就在本机可直接研读）；② 行为强制 Hook（A1）；③ 模型分层路由省 token（A6）。
2. 由于 **OpenClaw 已检出于 `c:\ai\openclaw`**，可直接精读 `src/security/audit*.ts`、`src/plugins/*`、`src/channels/plugins/types.*`、`extensions/memory-lancedb` 作为实现范本（注意其 MIT 许可证与本项目兼容，但**借鉴理念优先于复制代码**）。
3. 补一份"子代理并行编排现状"评估（确认 DeepAgents 在本项目中的并行/路由/限流能力边界），对照 OMC 的确定性流水线设计目标态。
4. 回到一手源核对 oh-my-openagent、oh-my-opencode、oh-my-claudecode 的实际实现与许可证。
5. 评估内网可用的 MCP 等价物（文档检索、代码搜索）与本地向量库（对标 LanceDB）作为预置候选。
6. 若计划扩展聊天渠道（飞书/企业微信等），先以 OpenClaw 的渠道适配器抽象做一版设计评审，避免在 ChatX 单通道上打补丁。

---

## 9. 源码核实：可直接移植的实现细节（基于本机一手源码）

> 源码位置：`C:\ai\oh-my-claudecode`（记为 **OMC**）、`C:\ai\oh-my-opencode`（记为 **OMO**）。
> 两者**许可证均为 MIT**（`OMC/LICENSE`、`OMO/LICENSE.md`）。注意 OMO 另有 `CLA.md`（贡献者协议，仅影响向其提交代码，不影响借鉴）。
> 关键事实核实：OMC 的多个行为型 Hook 源码注释明确写着 *"Ported from oh-my-opencode"* ——**OMO 是这些机制的源头，OMC 是面向 Claude Code 的移植**。本项目两边都可参考，但要追溯到 OMO 看原始实现。

### 9.1 模型分层路由（最高性价比，OMC `src/config/models.ts`）

核实到的真实设计（比 README 更精确）：

- 三档 `ModelTier = LOW | MEDIUM | HIGH`，映射到 `HAIKU/SONNET/OPUS`，**内置默认是"无日期"的家族别名**（`claude-haiku-4-5 / claude-sonnet-4-6 / claude-opus-4-8`），注释明确："Keep these date-less so version bumps are a one-line edit per family"——版本升级只改一行。
- 解析优先级（高→低）：`OMC_MODEL_HIGH/MEDIUM/LOW` 环境变量 → Claude Code provider 环境变量（如 Bedrock app-profile）→ Anthropic 家族默认环境变量 → 内置兜底；**用户/项目配置（`routing.tierModels` 或 per-agent `agents.<name>.model`）经 deepMerge 再覆盖**。
- 还有 `CLAUDE_FAMILY_HIGH_VARIANTS`（`*-high` 高推理变体）与外部模型默认（`codexModel/geminiModel`）。

**移植要点（→ 本项目）**：本项目已有自定义模型配置，可在其上加一层**"任务复杂度/类别 → tier → 具体模型"的映射 + 多级覆盖（env < 内置 < 用户配置）**。直接采纳"无日期家族别名 + 一处兜底"的写法，便于内网模型版本切换。**默认 tier 兜底必须回退到本项目内网可用模型**，不可硬编码 Anthropic 模型。

### 9.2 风险分级的验证升级（强烈推荐，OMC `src/verification/tier-selector.ts`）

这是一段**可几乎原样移植**的纯函数逻辑，与本项目 `exec-policy` / 审批分级天然契合：

```
selectVerificationTier(changes):
  if 有安全影响 or 有架构改动        → THOROUGH (opus，要求 full review + 全测试 + 无回归)
  if filesChanged > 20             → THOROUGH
  if filesChanged<5 且 linesChanged<100 且 测试覆盖=full → LIGHT (haiku，仅要求 lsp 诊断 clean)
  else                             → STANDARD (sonnet，lsp 诊断 + 构建通过)
```

- `detectArchitecturalChanges(files)`：命中 `config.*` / `schema.*` / `types.ts` / `package.json` / `tsconfig.json` 等正则 → 视为架构改动。
- `detectSecurityImplications(files)`：命中 `/auth/`、`/security/` 等路径 → 视为安全相关。
- 每档绑定 `evidenceRequired`（需要的证据：lsp 诊断 clean / build pass / 全测试通过）。

**移植要点**：本项目可引入一个"变更风险评估器"，按**改动文件类型/规模/测试覆盖**自动决定 ①用哪一档模型做复核、②强制收集哪些"证据"（诊断/构建/测试）才允许收尾。这把"自优化/验证"从经验式升级为**可量化、可审计**，对金融场景尤其合适。

### 9.3 Hook 事件链（OMC `hooks/hooks.json` 是现成模板）

OMC 的 `hooks.json` 是一份**完整可读的 Claude Code Hook 编排**，本项目 Hook 系统已兼容 CC hooks，可直接对照：

| 事件 | 挂载的处理器（节选） | 借鉴点 |
| --- | --- | --- |
| `UserPromptSubmit` | keyword-detector、skill-injector | 关键词触发 + 技能自动注入 |
| `SessionStart`（含 `init`/`maintenance` matcher） | session-start、project-memory、wiki | 会话级记忆/知识注入；matcher 分流 |
| `PreToolUse` | pre-tool-enforcer | 工具执行前强制策略 |
| `PermissionRequest`（matcher=`Bash`） | permission-handler | **命令审批挂钩**（与本项目审批契合） |
| `PostToolUse` | post-tool-verifier、project-memory、rules-injector | 工具后校验 + 规则注入 |
| `PostToolUseFailure` | 失败专用处理 | 失败恢复 |
| `SubagentStart/Stop` | subagent-tracker、verify-deliverables | **子代理交付物校验** |
| `PreCompact` | 记忆/wiki 注入 | 压缩前保上下文 |
| `Stop` | context-guard-stop、persistent-mode、code-simplifier | **续跑强制 + 收尾自动简化** |
| `SessionEnd` | session-end、wiki-session-end | 会话落档 |

每个 hook 都带 `timeout`（3–60s）。**移植要点**：本项目可把"PermissionRequest:Bash→审批"、"SubagentStop→交付物校验"、"Stop→续跑+简化"这三组直接对应到现有 Hook 作用域；timeout 设防御值避免卡死。

### 9.4 行为强制 Hook 的真实实现（OMC `src/hooks/`，源自 OMO）

- **todo-continuation**（`src/hooks/todo-continuation/index.ts`）：检测 `~/.claude/tasks|todos` 中未完成项，阻止过早 Stop。**值得注意的安全细节**：内置 `isValidSessionId()` 用正则 `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,255}$` 防止 sessionId 路径穿越——本项目凡是"用外部 ID 拼文件路径"的地方都应照此加固。
- **comment-checker**（`src/hooks/comment-checker/`）：检测新增注释/docstring 并要求删改，但**有成熟的豁免名单**：BDD 关键词（given/when/then…）、类型检查/Lint 指令（`eslint-disable`、`ts-expect-error`、`noqa`、`clippy::`、`go:build`、`biome-ignore`、`#region`…）。OMO 把它独立成 npm 包 `@code-yeongyu/comment-checker`。

**移植要点**：续跑强制与注释检查都可在本项目 Hook 体系内实现；**务必带豁免名单 + 最大迭代/成本上限 + 可中断**，否则会空转烧 token 或误伤合理注释。

### 9.5 确定性代码工具：LSP + AST-grep（OMO `src/tools/lsp`、`src/tools/ast-grep`）

这是本项目目前**最缺的一类工具**，OMO 的实现是清晰范本：

- **LSP 工具（6 个）**：`lsp_goto_definition`、`lsp_find_references`、`lsp_symbols`(document/workspace)、`lsp_diagnostics`、`lsp_prepare_rename`、`lsp_rename`。用 `tool({description, args(zod), execute})` 定义，结果带**截断上限**（`DEFAULT_MAX_REFERENCES/SYMBOLS/DIAGNOSTICS`）。重命名走 **`prepare_rename` 先校验 → `rename` 再 `applyWorkspaceEdit`** 的安全两步。
- **AST-grep 工具（2 个）**：`ast_grep_search`、`ast_grep_replace`，支持 25 语言、元变量 `$VAR`（单节点）/`$$$`（多节点），并对空结果给出**纠错 Hint**（如 Python 模式误带尾冒号）。二进制按平台**懒下载缓存**（`downloader.ts`，OMO 还预置了 `packages/<platform>` 各平台二进制）。

**移植要点（→ DeepAgents/LangChain 工具层）**：可新增一个"结构化代码工具家族"。建议**分两期**：① 先做**只读**（diagnostics、find_references、symbols、ast_grep_search）——零破坏、纯增益；② 再做**写操作**（rename、ast_grep_replace），且**必须纳入本项目沙箱 + `safe/needs_approval/forbidden` 审批**，不能因"确定性"豁免。注意 LSP 需要每语言的 language server，落地成本主要在环境准备。

### 9.6 强类型配置契约（OMO `src/config/schema.ts`）

全 Zod。**per-agent 权限**模型：`edit/bash/webfetch/doom_loop/external_directory` 取 `ask|allow|deny`，其中 `bash` 还可按命令名给 `Record<string, ask|allow|deny>`（精确到 `git push` 级）。内置 agent/skill/hook 名都是 `z.enum` 枚举（如 `HookNameSchema` 列出 ~30 个 hook 名做开关）。

**移植要点**：本项目若要让用户细粒度开关"哪个 agent 能用 bash/edit/外部目录、哪个 hook 启停"，这份 schema 是直接可参考的契约样板——尤其 **per-command bash 权限**与本项目命令分级互补。

### 9.7 顺手可采纳的安全/工程小件

- **SSRF 防护**（OMC `src/utils/ssrf-guard.ts`）：`validateUrlForSSRF()` 屏蔽 loopback/私网/链路本地/多播/IPv6 唯一本地/IPv6-mapped-IPv4，并限定 `http(s)` 方案；被模型 baseURL 校验复用。**本项目任何"按用户/配置发起外呼"（MCP、webfetch、ChatX 回调、市场）都应过这道校验**，防止 Agent 被诱导打内网。
- **提示词缓存稳定性**：OMO/OpenClaw 都强调请求组装前对 map/registry/插件/MCP 列表**确定性排序**、压缩优先动尾部——本项目控成本可直接采纳。
- **agent 即 TS 提示词构造器**（OMO `src/agents/*.ts` + `dynamic-agent-prompt-builder.ts`）：角色 agent 不只是 md，而是可按上下文动态拼装系统提示。本项目子代理可借此做"角色化动态提示"。

### 9.8 三轮调研后的"落地优先级"（修订版）

| 优先级 | 项目 | 来源/文件 | 风险 | 价值 |
| --- | --- | --- | --- | --- |
| P0 | 风险分级验证升级 | OMC `verification/tier-selector.ts` | 低（纯函数） | 高（可审计、省钱） |
| P0 | SSRF 校验 + sessionId 防穿越 | OMC `ssrf-guard.ts`/`todo-continuation` | 低 | 高（金融安全刚需） |
| P1 | 模型分层路由 + 多级覆盖 | OMC `config/models.ts` | 低 | 高（省 30–50% token） |
| P1 | LSP/AST 只读工具 | OMO `tools/lsp`、`tools/ast-grep` | 中（环境准备） | 高 |
| P1 | 行为强制 Hook（续跑/注释，带上限+豁免） | OMC `hooks/todo-continuation`、`comment-checker` | 中 | 中高 |
| P2 | LSP/AST 写操作（纳入审批） | OMO 同上 | 中高 | 高 |
| P2 | per-agent/ per-command 权限 schema | OMO `config/schema.ts` | 中 | 中 |
| P2 | 安全审计自检套件 | OpenClaw `src/security/*`（见 §4.5） | 中 | 高 |

---

## 10. 参考来源

- [oh-my-opencode (GitHub, opensoft)](https://github.com/opensoft/oh-my-opencode)
- [Oh My OpenCode 官网（注意：官方声明与项目无官方关联）](https://ohmyopencode.com/)
- [oh-my-openagent / omo (GitHub, code-yeongyu)](https://github.com/code-yeongyu/oh-my-openagent)
- [oh-my-claudecode (GitHub, Yeachan-Heo)](https://github.com/Yeachan-Heo/oh-my-claudecode)
- [oh-my-claudecode 官网](https://oh-my-claudecode.dev/)
- [oh-my-claudecode: Turn Claude Code Into a Full 32-Agent Development Team (emelia.io)](https://emelia.io/hub/oh-my-claudecode-multi-agent)
- [OpenClaw (GitHub)](https://github.com/openclaw/openclaw) — 本机检出于 `c:\ai\openclaw`
- [OpenClaw 文档](https://docs.openclaw.ai/)
- [OpenClaw 官网](https://openclaw.ai/)
- [How to Build and Secure a Personal AI Agent with OpenClaw (freeCodeCamp)](https://www.freecodecamp.org/news/how-to-build-and-secure-a-personal-ai-agent-with-openclaw/)
- [Build a Secure, Always-On Local AI Agent with OpenClaw (NVIDIA Blog)](https://developer.nvidia.com/blog/build-a-secure-always-on-local-ai-agent-with-nvidia-nemoclaw-and-openclaw/)
- [awesome-opencode 精选列表](https://github.com/awesome-opencode/awesome-opencode)
- [OpenCode 插件文档](https://opencode.ai/docs/plugins/)
- [OpenCode 代理文档](https://opencode.ai/docs/agents/)
- [OpenCode 官网](https://opencode.ai/)
- [7 OpenCode Plugins That Make AI Coding More Powerful (KDnuggets)](https://www.kdnuggets.com/7-opencode-plugins-that-make-ai-coding-more-powerful)
- [How I Use OpenCode, Oh-My-OpenCode-Slim, and OpenSpec (dataleadsfuture)](https://www.dataleadsfuture.com/how-i-use-opencode-oh-my-opencode-slim-and-openspec-to-build-my-own-ai-coding-environment/)
- [Plugins reference - Claude Code Docs](https://code.claude.com/docs/en/plugins-reference)
- [A Mental Model for Claude Code: Skills, Subagents, and Plugins](https://levelup.gitconnected.com/a-mental-model-for-claude-code-skills-subagents-and-plugins-3dea9924bf05)
- [Claude Code Skills, Subagents, Hooks and Plugins — A Practical Overview](https://medium.com/@mishra.shashank35/claude-code-skills-subagents-hooks-and-plugins-a-practical-overview-572de7cedb20)
- [claude-code-plugins-plus-skills (GitHub)](https://github.com/jeremylongshore/claude-code-plugins-plus-skills)
</content>
</invoke>
