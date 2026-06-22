/**
 * Shared agent-type registry.
 *
 * One open registry of agent "profiles" that all three execution modes draw from:
 *  - Solo Agent (normal): each profile becomes a deepagents SubAgent the main
 *    agent's task tool can spawn by name (subagent_type).
 *  - Dynamic Workflows: a script's `agent(prompt, { agentType })` resolves a
 *    profile here, then maps it onto the leaf createAgentRuntime.
 *  - Agent Team (coordinator) is intentionally NOT routed through this file — it
 *    keeps its own worker workload mechanism untouched.
 *
 * The tool-access model mirrors Claude Code's built-in agents: a per-agent
 * `disallowedTools` denylist plus a `shellAccess` policy for the execute/Bash
 * tool. Built-in Explore/Plan/verification reproduce CC's prompts and
 * permissions (adapted to this project's tool names). Users drop `<name>.md`
 * files under `.cmbcoworkagent/agents/` to add their own, using either CC-style
 * `tools`/`disallowedTools` frontmatter (CC tool names are auto-mapped) or the
 * coarse `workload` shortcut.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { parseYamlFrontmatter } from "../utils/skill-identifiers"

/** execute/shell policy for an agent. none = no shell at all; read_only = only
 * provably read-only commands (gated by exec-policy's assessCommandSafety);
 * full = any command (still subject to the normal approval flow). */
export type AgentShellAccess = "none" | "read_only" | "full"

export interface AgentProfile {
  /** Identifier used as agentType / subagent_type. */
  name: string
  /** Shown to the model when it picks an agent. */
  description: string
  /** System prompt for this agent's role. */
  systemPrompt: string
  /** Optional model override (undefined = inherit the session model). */
  model?: string
  source: "built-in" | "user"
  /** Project tool names this agent may NOT use (CC aliases already resolved,
   * `execute` handled via shellAccess instead of appearing here). */
  disallowedTools: string[]
  /** execute/shell access tier. */
  shellAccess: AgentShellAccess
}

/** The fs/exec tools an allowlist/denylist can govern in this project. Mirrors
 * the set deepagents' filesystem middleware provides plus our task_output. */
const KNOWN_TOOLS = [
  "read_file",
  "write_file",
  "edit_file",
  "execute",
  "ls",
  "glob",
  "grep",
  "task_output"
] as const

/** Claude Code tool name → this project's tool name. Names absent here (e.g.
 * NotebookEdit, Agent, ExitPlanMode, WebFetch, WebSearch) have no Solo/workflow
 * subagent equivalent and are ignored when seen in a user's frontmatter. */
const CC_TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  write: "write_file",
  bash: "execute",
  shell: "execute",
  glob: "glob",
  grep: "grep",
  ls: "ls",
  taskoutput: "task_output"
}

/** The write tools a read-only/verify agent must never get. */
export const WRITE_TOOL_NAMES = ["write_file", "edit_file"] as const

/**
 * Normalize a profile `model:` value to a custom-model lookup key by dropping the
 * internal `custom:` scheme prefix when present. A profile may write either
 * `model: foo` or `model: custom:foo`; both must resolve the SAME config. The
 * Solo task-subagent path and the workflow agentType path must agree here —
 * otherwise `model: custom:foo` works under a workflow but silently inherits the
 * main model for a Solo subagent (the workflow path prepends `custom:` then the
 * runtime slices it; the Solo path looks up directly, so it needs this strip).
 */
export function stripCustomModelPrefix(model: string): string {
  return model.startsWith("custom:") ? model.slice("custom:".length) : model
}

/** Project-native NON-filesystem tool names a denylist must be able to name.
 * KNOWN_TOOLS (used by the allowlist math) only covers fs/exec tools, so without
 * this a `disallowedTools: browser_playwright` would normalize to null, get
 * filtered out, and silently no-op. These names are blocked by exact match in the
 * guard (registryAgentBlockedTools spreads disallowedTools into its blocked set),
 * so naming one here makes the denylist actually take effect. */
const NON_FS_TOOL_NAMES = new Set([
  "browser_playwright",
  "memory_search",
  "memory_get",
  "code_exec",
  "save_code_exec_tool",
  "invoke_deferred_tool",
  "search_tool",
  "inspect_tool",
  "manage_scheduler",
  "manage_skill"
])

/** The SIDE-EFFECTING subset of NON_FS_TOOL_NAMES. An allowlist (`tools:`) blocks
 * these unless explicitly listed, so e.g. `tools: Read, Bash` no longer silently
 * retains browser automation or the deferred-execution bridge. Read-only memory
 * tools (memory_search/memory_get) and eager MCP are intentionally NOT force-
 * blocked by an allowlist (consistent with the eager-MCP-retained policy). */
const NON_FS_SIDE_EFFECT_TOOLS = [
  "browser_playwright",
  "code_exec",
  "save_code_exec_tool",
  "invoke_deferred_tool",
  "search_tool",
  "inspect_tool",
  "manage_scheduler",
  "manage_skill"
] as const

/**
 * Normalize one tool token to a project tool name, or null if it has no
 * equivalent here. Accepts native fs names (read_file), CC names (Read/Bash),
 * project-native non-fs names (browser_playwright, memory_search, …), and CC
 * permission syntax with a parenthesised qualifier (e.g. `Bash(git:*)` →
 * execute). Case-insensitive. Returns null for genuinely unknown names (e.g.
 * NotebookEdit) so callers can warn.
 */
export function normalizeToolName(raw: string): string | null {
  const base = raw.split("(")[0].trim()
  if (!base) return null
  if ((KNOWN_TOOLS as readonly string[]).includes(base)) return base
  const lower = base.toLowerCase()
  if ((KNOWN_TOOLS as readonly string[]).includes(lower)) return lower
  if (CC_TOOL_ALIASES[lower]) return CC_TOOL_ALIASES[lower]
  if (NON_FS_TOOL_NAMES.has(lower)) return lower
  return null
}

/** Parse a CC-style tool list (comma- or space-separated, `*` = all). Returns the
 * raw tokens (not yet normalized); `*` is preserved so callers can detect it.
 *
 * Splits on commas OR whitespace, but NOT inside parentheses. This handles both
 * forms at once:
 *  - the legacy/space form `Read Grep` → ["Read", "Grep"]
 *  - a CC qualified Bash whose qualifier contains a space `Bash(git log:*)` stays
 *    a single token instead of being torn into "Bash(git" + "log:*)".
 * A comma-only split would regress the space form; a naive whitespace split would
 * break the qualified Bash form. */
function parseToolList(value: string | undefined): string[] {
  if (!value || !value.trim()) return []
  const stripped = value.replace(/^\s*\[|\]\s*$/g, "") // tolerate YAML inline array
  const tokens: string[] = []
  let buf = ""
  let depth = 0
  for (const ch of stripped) {
    if (ch === "(") depth++
    else if (ch === ")") depth = Math.max(0, depth - 1)
    if (depth === 0 && (ch === "," || /\s/.test(ch))) {
      if (buf.trim()) tokens.push(buf.trim())
      buf = ""
    } else {
      buf += ch
    }
  }
  if (buf.trim()) tokens.push(buf.trim())
  return tokens.map((t) => t.replace(/^["']|["']$/g, "")).filter(Boolean) // strip per-item quotes
}

interface ToolPolicy {
  disallowedTools: string[]
  shellAccess: AgentShellAccess
}

/** Derive the effective tool policy from frontmatter. Precedence mirrors CC:
 * an explicit `tools` allowlist and/or `disallowedTools` denylist win; the
 * coarse `workload` is a shortcut used only when neither is present; absent all
 * three → full tools. */
function deriveToolPolicy(fm: Record<string, string>): ToolPolicy {
  const toolsRaw = fm.tools
  const disallowedRaw = fm.disallowedtools ?? fm.disallowedTools
  const hasAllowlist = toolsRaw !== undefined && toolsRaw.trim() !== ""
  const hasDenylist = disallowedRaw !== undefined && disallowedRaw.trim() !== ""

  if (!hasAllowlist && !hasDenylist) {
    const workload = fm.workload?.trim()
    if (workload === "read_only")
      return { disallowedTools: ["write_file", "edit_file"], shellAccess: "read_only" }
    if (workload === "verify")
      return { disallowedTools: ["write_file", "edit_file"], shellAccess: "full" }
    return { disallowedTools: [], shellAccess: "full" }
  }

  const denyExplicit = hasDenylist
    ? (parseToolList(disallowedRaw).map(normalizeToolName).filter(Boolean) as string[])
    : []

  if (hasAllowlist) {
    const allowTokens = parseToolList(toolsRaw)
    if (allowTokens.includes("*")) {
      // All tools, minus any explicit denylist.
      return policyFromDisallowed(denyExplicit)
    }
    const allow = new Set(allowTokens.map(normalizeToolName).filter(Boolean) as string[])
    // task_output is the read-side companion of execute's background mode: a
    // background command is started via execute(run_in_background) and its result
    // is fetched via task_output. Granting execute (Bash) but blocking task_output
    // leaves background commands half-broken (startable, unreadable), so when the
    // allowlist grants execute, grant task_output too. An EXPLICIT
    // `disallowedTools: task_output` still wins (denyExplicit is applied below).
    if (allow.has("execute")) allow.add("task_output")
    // Block every known fs tool AND every fixed non-fs side-effect tool (browser /
    // code_exec / deferred bridge / orchestration) not in the allowlist, then add
    // explicit denies. Including the side-effect set is what makes a `tools: Read,
    // Bash` allowlist not silently keep browser_playwright + the deferred bridge.
    const blocked = [...KNOWN_TOOLS, ...NON_FS_SIDE_EFFECT_TOOLS].filter((t) => !allow.has(t))
    const policy = policyFromDisallowed([...new Set([...blocked, ...denyExplicit])])
    // CC's `Bash(cmd:*)` qualifies the shell to a command prefix. We can't enforce
    // command-level prefixes here, so granting full shell for a qualified-only
    // Bash would INVERT the user's intent to restrict. Downgrade to read_only
    // unless an unqualified Bash/execute/shell token is also present.
    if (policy.shellAccess === "full") {
      const execTokens = allowTokens.filter((t) => normalizeToolName(t) === "execute")
      if (execTokens.length > 0 && execTokens.every((t) => t.includes("("))) {
        policy.shellAccess = "read_only"
      }
    }
    return policy
  }

  return policyFromDisallowed(denyExplicit)
}

/** Split a flat disallowed-tool list into (non-execute denylist, shellAccess).
 * execute is represented by shellAccess, not by appearing in disallowedTools. */
function policyFromDisallowed(disallowed: string[]): ToolPolicy {
  const set = new Set(disallowed)
  const shellAccess: AgentShellAccess = set.has("execute") ? "none" : "full"
  set.delete("execute")
  return { disallowedTools: [...set], shellAccess }
}

// ── Built-in agents (Claude Code parity, tool names adapted to this project) ──

const EXPLORE_PROMPT = `You are a file search specialist for Claude Code, Anthropic's official CLI for Claude. You excel at thoroughly navigating and exploring codebases.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY exploration task. You are STRICTLY PROHIBITED from:
- Creating new files (no write_file, touch, or file creation of any kind)
- Modifying existing files (no edit_file operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to search and analyze existing code. You do NOT have access to file editing tools - attempting to edit files will fail. The execute tool has a safety gate that blocks clearly-dangerous and unrecognized commands, but do NOT rely on it to catch everything — restrict yourself to read-only inspection and never run writes, installs, or build commands.

Your strengths:
- Rapidly finding files using glob patterns
- Searching code and text with powerful regex patterns
- Reading and analyzing file contents

Guidelines:
- Use glob for broad file pattern matching
- Use grep for searching file contents with regex
- Use read_file when you know the specific file path you need to read
- Use execute ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
- NEVER use execute for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification
- Adapt your search approach based on the thoroughness level specified by the caller
- Communicate your final report directly as a regular message - do NOT attempt to create files

NOTE: You are meant to be a fast agent that returns output as quickly as possible. In order to achieve this you must:
- Make efficient use of the tools that you have at your disposal: be smart about how you search for files and implementations
- Wherever possible you should try to spawn multiple parallel tool calls for grepping and reading files

Complete the user's search request efficiently and report your findings clearly.`

const PLAN_PROMPT = `You are a software architect and planning specialist for Claude Code. Your role is to explore the codebase and design implementation plans.

=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===
This is a READ-ONLY planning task. You are STRICTLY PROHIBITED from:
- Creating new files (no write_file, touch, or file creation of any kind)
- Modifying existing files (no edit_file operations)
- Deleting files (no rm or deletion)
- Moving or copying files (no mv or cp)
- Creating temporary files anywhere, including /tmp
- Using redirect operators (>, >>, |) or heredocs to write to files
- Running ANY commands that change system state

Your role is EXCLUSIVELY to explore the codebase and design implementation plans. You do NOT have access to file editing tools - attempting to edit files will fail. The execute tool has a safety gate that blocks clearly-dangerous and unrecognized commands, but do NOT rely on it to catch everything — restrict yourself to read-only inspection and never run writes, installs, or build commands.

You will be provided with a set of requirements and optionally a perspective on how to approach the design process.

## Your Process

1. **Understand Requirements**: Focus on the requirements provided and apply your assigned perspective throughout the design process.

2. **Explore Thoroughly**:
   - Read any files provided to you in the initial prompt
   - Find existing patterns and conventions using glob, grep, and read_file
   - Understand the current architecture
   - Identify similar features as reference
   - Trace through relevant code paths
   - Use execute ONLY for read-only operations (ls, git status, git log, git diff, find, grep, cat, head, tail)
   - NEVER use execute for: mkdir, touch, rm, cp, mv, git add, git commit, npm install, pip install, or any file creation/modification

3. **Design Solution**:
   - Create implementation approach based on your assigned perspective
   - Consider trade-offs and architectural decisions
   - Follow existing patterns where appropriate

4. **Detail the Plan**:
   - Provide step-by-step implementation strategy
   - Identify dependencies and sequencing
   - Anticipate potential challenges

## Required Output

End your response with:

### Critical Files for Implementation
List 3-5 files most critical for implementing this plan:
- path/to/file1.ts
- path/to/file2.ts
- path/to/file3.ts

REMEMBER: You can ONLY explore and plan. You CANNOT and MUST NOT write, edit, or modify any files. You do NOT have access to file editing tools.`

const VERIFICATION_PROMPT = `You are a verification specialist. Your job is not to confirm the implementation works — it's to try to break it.

You have two documented failure patterns. First, verification avoidance: when faced with a check, you find reasons not to run it — you read code, narrate what you would test, write "PASS," and move on. Second, being seduced by the first 80%: you see a polished UI or a passing test suite and feel inclined to pass it, not noticing half the buttons do nothing, the state vanishes on refresh, or the backend crashes on bad input. The first 80% is the easy part. Your entire value is in finding the last 20%. The caller may spot-check your commands by re-running them — if a PASS step has no command output, or output that doesn't match re-execution, your report gets rejected.

=== CRITICAL: DO NOT MODIFY THE PROJECT ===
You are STRICTLY PROHIBITED from:
- Creating, modifying, or deleting any files IN THE PROJECT DIRECTORY
- Installing dependencies or packages
- Running git write operations (add, commit, push)

You MAY write ephemeral test scripts to a temp directory (/tmp or $TMPDIR) via execute when inline commands aren't sufficient — e.g., a multi-step race harness or a Playwright test. Clean up after yourself.

Check your ACTUAL available tools rather than assuming from this prompt. You may have browser automation (browser_playwright), web fetch, or other MCP tools depending on the session — do not skip capabilities you didn't think to check for.

=== WHAT YOU RECEIVE ===
You will receive: the original task description, files changed, approach taken, and optionally a plan file path.

=== VERIFICATION STRATEGY ===
Adapt your strategy based on what was changed:

**Frontend changes**: Start dev server → check your tools for browser automation (browser_playwright) and USE it to navigate, screenshot, click, and read console — do NOT say "needs a real browser" without attempting → curl a sample of page subresources (image-optimizer URLs like /_next/image, same-origin API routes, static assets) since HTML can serve 200 while everything it references fails → run frontend tests
**Backend/API changes**: Start server → curl/fetch endpoints → verify response shapes against expected values (not just status codes) → test error handling → check edge cases
**CLI/script changes**: Run with representative inputs → verify stdout/stderr/exit codes → test edge inputs (empty, malformed, boundary) → verify --help / usage output is accurate
**Infrastructure/config changes**: Validate syntax → dry-run where possible (terraform plan, kubectl apply --dry-run=server, docker build, nginx -t) → check env vars / secrets are actually referenced, not just defined
**Library/package changes**: Build → full test suite → import the library from a fresh context and exercise the public API as a consumer would → verify exported types match README/docs examples
**Bug fixes**: Reproduce the original bug → verify fix → run regression tests → check related functionality for side effects
**Mobile (iOS/Android)**: Clean build → install on simulator/emulator → dump accessibility/UI tree (idb ui describe-all / uiautomator dump), find elements by label, tap by tree coords, re-dump to verify; screenshots secondary → kill and relaunch to test persistence → check crash logs (logcat / device console)
**Data/ML pipeline**: Run with sample input → verify output shape/schema/types → test empty input, single row, NaN/null handling → check for silent data loss (row counts in vs out)
**Database migrations**: Run migration up → verify schema matches intent → run migration down (reversibility) → test against existing data, not just empty DB
**Refactoring (no behavior change)**: Existing test suite MUST pass unchanged → diff the public API surface (no new/removed exports) → spot-check observable behavior is identical (same inputs → same outputs)
**Other change types**: The pattern is always the same — (a) figure out how to exercise this change directly (run/call/invoke/deploy it), (b) check outputs against expectations, (c) try to break it with inputs/conditions the implementer didn't test. The strategies above are worked examples for common cases.

=== REQUIRED STEPS (universal baseline) ===
1. Read the project's CLAUDE.md / README for build/test commands and conventions. Check package.json / Makefile / pyproject.toml for script names. If the implementer pointed you to a plan or spec file, read it — that's the success criteria.
2. Run the build (if applicable). A broken build is an automatic FAIL.
3. Run the project's test suite (if it has one). Failing tests are an automatic FAIL.
4. Run linters/type-checkers if configured (eslint, tsc, mypy, etc.).
5. Check for regressions in related code.

Then apply the type-specific strategy above. Match rigor to stakes: a one-off script doesn't need race-condition probes; production payments code needs everything.

Test suite results are context, not evidence. Run the suite, note pass/fail, then move on to your real verification. The implementer is an LLM too — its tests may be heavy on mocks, circular assertions, or happy-path coverage that proves nothing about whether the system actually works end-to-end.

=== RECOGNIZE YOUR OWN RATIONALIZATIONS ===
You will feel the urge to skip checks. These are the exact excuses you reach for — recognize them and do the opposite:
- "The code looks correct based on my reading" — reading is not verification. Run it.
- "The implementer's tests already pass" — the implementer is an LLM. Verify independently.
- "This is probably fine" — probably is not verified. Run it.
- "Let me start the server and check the code" — no. Start the server and hit the endpoint.
- "I don't have a browser" — did you actually check for browser_playwright? If present, use it. If a tool fails, troubleshoot (server running? selector right?). The fallback exists so you don't invent your own "can't do this" story.
- "This would take too long" — not your call.
If you catch yourself writing an explanation instead of a command, stop. Run the command.

=== ADVERSARIAL PROBES (adapt to the change type) ===
Functional tests confirm the happy path. Also try to break it:
- **Concurrency** (servers/APIs): parallel requests to create-if-not-exists paths — duplicate sessions? lost writes?
- **Boundary values**: 0, -1, empty string, very long strings, unicode, MAX_INT
- **Idempotency**: same mutating request twice — duplicate created? error? correct no-op?
- **Orphan operations**: delete/reference IDs that don't exist
These are seeds, not a checklist — pick the ones that fit what you're verifying.

=== BEFORE ISSUING PASS ===
Your report must include at least one adversarial probe you ran (concurrency, boundary, idempotency, orphan op, or similar) and its result — even if the result was "handled correctly." If all your checks are "returns 200" or "test suite passes," you have confirmed the happy path, not verified correctness. Go back and try to break something.

=== BEFORE ISSUING FAIL ===
You found something that looks broken. Before reporting FAIL, check you haven't missed why it's actually fine:
- **Already handled**: is there defensive code elsewhere (validation upstream, error recovery downstream) that prevents this?
- **Intentional**: does CLAUDE.md / comments / commit message explain this as deliberate?
- **Not actionable**: is this a real limitation but unfixable without breaking an external contract (stable API, protocol spec, backwards compat)? If so, note it as an observation, not a FAIL — a "bug" that can't be fixed isn't actionable.
Don't use these as excuses to wave away real issues — but don't FAIL on intentional behavior either.

=== OUTPUT FORMAT (REQUIRED) ===
Every check MUST follow this structure. A check without a Command run block is not a PASS — it's a skip.

### Check: [what you're verifying]
**Command run:** [exact command you executed]
**Output observed:** [actual terminal output — copy-paste, not paraphrased. Truncate if very long but keep the relevant part.]
**Result: PASS** (or FAIL — with Expected vs Actual)

Bad (rejected): a check with "Result: PASS" but no Command run block, justified by "Reviewed the handler — the logic correctly validates…". Reading code is not verification.
Good: "Command run: curl -s -X POST localhost:8000/api/register -d '{"password":"short"}'; Output observed: {"error":"password must be at least 8 characters"} (HTTP 400); Expected vs Actual: expected 400 with a password-length error, got exactly that; Result: PASS".

End with exactly this line (parsed by caller): \`VERDICT: PASS\` or \`VERDICT: FAIL\` or \`VERDICT: PARTIAL\`. PARTIAL is for environmental limitations only (no test framework, tool unavailable, server can't start) — not for "I'm unsure whether this is a bug." If you can run the check, you must decide PASS or FAIL. Use the literal string \`VERDICT: \` followed by exactly one of \`PASS\`, \`FAIL\`, \`PARTIAL\` — no markdown bold, no punctuation, no variation.
- **FAIL**: include what failed, exact error output, reproduction steps.
- **PARTIAL**: what was verified, what could not be and why (missing tool/env), what the implementer should know.`

/** Built-in profiles mirroring Claude Code's Explore / Plan / verification.
 * general-purpose is intentionally absent: Solo keeps its own general-purpose
 * subagent, and a no-agentType workflow agent() already runs the default agent.
 * Naming follows CC (capital Explore/Plan, lowercase verification). */
export const BUILT_IN_AGENT_PROFILES: readonly AgentProfile[] = [
  {
    name: "Explore",
    description:
      'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.',
    systemPrompt: EXPLORE_PROMPT,
    source: "built-in",
    disallowedTools: ["write_file", "edit_file"],
    shellAccess: "read_only"
  },
  {
    name: "Plan",
    description:
      "Software architect agent for designing implementation plans. Use this when you need to plan the implementation strategy for a task. Returns step-by-step plans, identifies critical files, and considers architectural trade-offs.",
    systemPrompt: PLAN_PROMPT,
    source: "built-in",
    disallowedTools: ["write_file", "edit_file"],
    shellAccess: "read_only"
  },
  {
    name: "verification",
    description:
      "Use this agent to verify that implementation work is correct before reporting completion. Invoke after non-trivial tasks (3+ file edits, backend/API changes, infrastructure changes). Pass the ORIGINAL user task description, list of files changed, and approach taken. The agent runs builds, tests, linters, and checks to produce a PASS/FAIL/PARTIAL verdict with evidence.",
    systemPrompt: VERIFICATION_PROMPT,
    source: "built-in",
    disallowedTools: ["write_file", "edit_file"],
    shellAccess: "full"
  }
]

/** Frontmatter fields this project understands. Anything else — CC-only fields
 * (memory/mcpServers/permissionMode/maxTurns/effort/background/isolation/color/
 * initialPrompt/skills/hooks/…) or typos — is silently dropped by the parser, so
 * warn once per (file, field) to surface that the field had no effect. */
const KNOWN_AGENT_FIELDS = new Set([
  "name",
  "description",
  "tools",
  "disallowedtools",
  "workload",
  "model"
])
const warnedUnknownAgentFields = new Set<string>()

function warnUnknownAgentFields(filePath: string, name: string, fm: Record<string, string>): void {
  for (const key of Object.keys(fm)) {
    if (KNOWN_AGENT_FIELDS.has(key.toLowerCase())) continue
    const warnKey = `${filePath}::${key}`
    if (warnedUnknownAgentFields.has(warnKey)) continue
    warnedUnknownAgentFields.add(warnKey)
    console.warn(
      `[AgentRegistry] Agent "${name}" (${filePath}): frontmatter field "${key}" is not supported and was ignored. ` +
        `Supported: name, description, tools, disallowedTools, workload, model.`
    )
  }
}

/** Warn (once per file+token) about tools/disallowedTools entries that aren't
 * recognized tool names — they normalize to null and are dropped, so a typo or an
 * unsupported tool would otherwise silently fail to constrain the agent. */
function warnUnrecognizedToolNames(
  filePath: string,
  name: string,
  fm: Record<string, string>
): void {
  const raw = [fm.tools, fm.disallowedtools ?? fm.disallowedTools].filter(Boolean).join(",")
  for (const token of parseToolList(raw)) {
    if (token === "*" || normalizeToolName(token)) continue
    const warnKey = `${filePath}::tool::${token}`
    if (warnedUnknownAgentFields.has(warnKey)) continue
    warnedUnknownAgentFields.add(warnKey)
    console.warn(
      `[AgentRegistry] Agent "${name}" (${filePath}): tools/disallowedTools entry "${token}" is not a recognized tool and was ignored — check the spelling.`
    )
  }
}

/** Upper bound on an agent markdown file. Agent prompts are small (a few KB);
 * anything past this is skipped so an oversized file can't bloat registry load,
 * memory, or the prompt/fingerprint we inject downstream. */
const MAX_AGENT_FILE_BYTES = 256 * 1024

/** Parse one `.cmbcoworkagent/agents/<name>.md` file into a profile. Returns null
 * on any problem so one bad file can't break the whole registry. */
function parseAgentFile(filePath: string, fallbackName: string): AgentProfile | null {
  try {
    const bytes = statSync(filePath).size
    if (bytes > MAX_AGENT_FILE_BYTES) {
      console.warn(
        `[AgentRegistry] Agent file ${filePath} is ${bytes} bytes (> ${MAX_AGENT_FILE_BYTES}); skipped to bound load cost and injected prompt size.`
      )
      return null
    }
    const content = readFileSync(filePath, "utf-8")
    const fm = parseYamlFrontmatter(content)
    // Match the loader's frontmatter fields CASE-INSENSITIVELY: a `Workload:` /
    // `Tools:` / `ShellAccess:` typo must not silently fall through to the
    // permissive default (full shell, empty denylist) — that would quietly WIDEN a
    // user agent the author meant to restrict. (warnUnknownAgentFields keeps the
    // original fm so it can report a truly-unknown field by its real casing.)
    const fmLower: Record<string, string> = {}
    for (const [k, v] of Object.entries(fm)) fmLower[k.toLowerCase()] = v
    const body = content.replace(/^---[\s\S]*?\n---\s*\n?/, "").trim()
    const name = (fmLower.name || fallbackName).trim()
    if (!name) return null
    warnUnknownAgentFields(filePath, name, fm)
    warnUnrecognizedToolNames(filePath, name, fmLower)
    const policy = deriveToolPolicy(fmLower)
    return {
      name,
      description: fmLower.description?.trim() || `User-defined agent "${name}".`,
      systemPrompt: body || `You are the "${name}" agent.`,
      model: fmLower.model?.trim() || undefined,
      source: "user",
      disallowedTools: policy.disallowedTools,
      shellAccess: policy.shellAccess
    }
  } catch (error) {
    console.warn(`[AgentRegistry] Failed to parse agent file ${filePath}:`, error)
    return null
  }
}

function loadUserAgents(dir: string): AgentProfile[] {
  if (!existsSync(dir)) return []
  const out: AgentProfile[] = []
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue
      const full = join(dir, entry)
      try {
        if (!statSync(full).isFile()) continue
      } catch {
        continue
      }
      const profile = parseAgentFile(full, entry.slice(0, -".md".length))
      if (profile) out.push(profile)
    }
  } catch (error) {
    console.warn(`[AgentRegistry] Failed to read agents dir ${dir}:`, error)
  }
  return out
}

/** Full registry: built-in profiles + user agents from `~/.cmbcoworkagent/agents/`
 * and `<workspace>/.cmbcoworkagent/agents/`. Project overrides user overrides
 * built-in (last writer wins).
 *
 * Keyed to mirror the resolver: `agentType` resolution treats BUILT-IN names
 * case-insensitively (Explore / explore / EXPLORE), but custom names exact-only.
 * So every casing AND every layer of a built-in logical name must collapse to ONE
 * entry (last writer wins) — else the same logical name splits into profiles with
 * different shellAccess by casing (e.g. home `explore` + project `Explore`), a
 * privilege footgun. We do that by keying a built-in logical name under its
 * CANONICAL built-in name; CUSTOM names key by exact name (so `DB` vs `db` stay
 * SEPARATE — collapsing them would make the dropped casing resolve to null, since
 * the resolver doesn't case-fold custom names). */
const BUILT_IN_NAME_BY_LOWER = new Map(
  BUILT_IN_AGENT_PROFILES.map((p) => [p.name.toLowerCase(), p.name] as const)
)
export function loadAgentProfiles(workspacePath?: string): AgentProfile[] {
  const byName = new Map<string, AgentProfile>()
  const put = (p: AgentProfile): void => {
    // Built-in logical name → canonical key (collapse all casings/layers, last
    // writer wins); custom name → exact key.
    const key = BUILT_IN_NAME_BY_LOWER.get(p.name.toLowerCase()) ?? p.name
    byName.set(key, p)
  }
  for (const p of BUILT_IN_AGENT_PROFILES) put(p)
  for (const p of loadUserAgents(join(homedir(), ".cmbcoworkagent", "agents"))) put(p)
  if (workspacePath) {
    for (const p of loadUserAgents(join(workspacePath, ".cmbcoworkagent", "agents"))) put(p)
  }
  return [...byName.values()]
}

/** Lowercased built-in agent NAMES (Explore/Plan/verification). The
 * case-insensitive fallback keys on the NAME, not on source — so a lowercase
 * `explore` still resolves even after a user file OVERRIDES the built-in (which
 * flips that profile's source to "user"). */
const BUILT_IN_AGENT_NAMES_LOWER = new Set(BUILT_IN_AGENT_PROFILES.map((p) => p.name.toLowerCase()))

/** Resolve an agentType against a profile list: exact match first, then a
 * case-insensitive fallback but ONLY for built-in agent NAMES — regardless of
 * whether that name is still a built-in or has been overridden by a user file.
 * Genuinely unknown names → null (caller decides; the workflow engine fails
 * closed). Shared by resolveAgentProfile and the workflow engine so both behave
 * identically. */
export function resolveProfileFromList<T extends { name: string }>(
  profiles: readonly T[],
  name: string | undefined
): T | null {
  const target = name?.trim()
  if (!target) return null
  const exact = profiles.find((p) => p.name === target)
  if (exact) return exact
  const lower = target.toLowerCase()
  if (!BUILT_IN_AGENT_NAMES_LOWER.has(lower)) return null
  return profiles.find((p) => p.name.toLowerCase() === lower) ?? null
}

export function resolveAgentProfile(name: string, workspacePath?: string): AgentProfile | null {
  return resolveProfileFromList(loadAgentProfiles(workspacePath), name)
}

/**
 * Strip a blocked tool's "- <tool>: …" documentation line — and, when
 * shellAccess is "none", the deepagents "## Execute Tool" section — from an
 * injected filesystem/system prompt.
 *
 * deepagents' filesystem middleware advertises tool usage in the SYSTEM PROMPT,
 * not only through the model's tool list, so hiding a tool from request.tools is
 * not enough: its description would still appear in the prompt. Claude Code's
 * disallowed tools never show up in the agent's prompt at all — this keeps that
 * parity.
 *
 * The injected prompt comes in several shapes here: workflow leaves pass a plain
 * string (filesystemSystemPrompt), while the Solo guard's wrapModelCall passes
 * LangChain's `request.systemMessage` — a SystemMessage OBJECT whose `.content`
 * is EITHER a string OR a content-block array (`[{type:"text", text:"…"}, …]`,
 * which LangChain's normalizeSystemPrompt / SystemMessage.concat() produce when
 * deepagents concatenates tool docs onto a block-array base). Handle all three —
 * earlier versions no-op'd on the object (leaving docs in) and then on array
 * content (same leak via a different shape).
 */
export function stripBlockedToolDocs(systemMessage: unknown, blocked: Iterable<string>): unknown {
  const blockedSet = blocked instanceof Set ? blocked : new Set(blocked)
  const strip = (text: string): string => {
    let out = text
    for (const tool of blockedSet) {
      // Tool names are simple identifiers (\w+), safe to inline into the regex.
      out = out.replace(new RegExp(`\\n- ${tool}:[^\\n]*`, "g"), "")
    }
    // execute is documented in its own "## Execute Tool" section; drop it only
    // when execute itself is blocked. A read-only shell keeps execute (and its
    // section), since it can still run provably read-only commands.
    if (blockedSet.has("execute")) {
      out = out.replace(/\n## Execute Tool[\s\S]*?(?=\n## |\n### |$)/g, "")
    }
    // The "Browser strategy" guidance line steers the model toward
    // browser_playwright but isn't a `- browser_playwright:` entry, so the
    // per-tool strip above misses it. Drop it when the browser tool is blocked,
    // otherwise a read-only/no-shell agent's prompt still advertises a tool it
    // doesn't have.
    if (blockedSet.has("browser_playwright")) {
      out = out.replace(/\n- Browser strategy:[^\n]*/g, "")
    }
    return out
  }

  if (typeof systemMessage === "string") return strip(systemMessage)

  if (!systemMessage || typeof systemMessage !== "object") return systemMessage

  // SystemMessage object. Replace .content on a prototype-preserving clone (keeps
  // it an instanceof SystemMessage with all other fields) + sync LangChain's
  // serialization mirror (lc_kwargs.content) when present.
  const msg = systemMessage as { content?: unknown; lc_kwargs?: { content?: unknown } }
  const cloneWithContent = (content: unknown): unknown => {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(systemMessage)),
      systemMessage
    ) as { content: unknown; lc_kwargs?: { content?: unknown } }
    clone.content = content
    if (clone.lc_kwargs && typeof clone.lc_kwargs === "object") {
      clone.lc_kwargs = { ...clone.lc_kwargs, content }
    }
    return clone
  }

  // .content is a plain string …
  if (typeof msg.content === "string") {
    const stripped = strip(msg.content)
    return stripped === msg.content ? systemMessage : cloneWithContent(stripped)
  }

  // … or a content-block array. LangChain text blocks are `{type:"text", text}`;
  // bare strings can also appear. Strip each text block (the docs deepagents adds
  // live inside one text block, so per-block stripping covers the real shape).
  if (Array.isArray(msg.content)) {
    let changed = false
    const next = msg.content.map((block) => {
      if (typeof block === "string") {
        const s = strip(block)
        if (s !== block) changed = true
        return s
      }
      if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
        const b = block as { text?: unknown }
        if (typeof b.text === "string") {
          const s = strip(b.text)
          if (s !== b.text) {
            changed = true
            return { ...b, text: s }
          }
        }
      }
      return block
    })
    return changed ? cloneWithContent(next) : systemMessage
  }

  return systemMessage
}
