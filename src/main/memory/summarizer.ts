import { ChatOpenAI } from "@langchain/openai"
import { HumanMessage, SystemMessage } from "@langchain/core/messages"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { getMemoryStore } from "./store"
import { notifyMemoryChanged } from "./events"
import { trackEvent } from "../services/event-reporter"
import {
  scanMemoryFiles,
  formatManifest,
  regenerateManifest,
  buildFrontmatter,
  isValidFactFilename,
  generateFactFilename,
  parseFrontmatter,
  parseMemoryType,
  type MemoryType,
  type MemoryHeader
} from "./manifest"

/**
 * Per-fact memory extractor + manifest curator.
 *
 * Strategy (Claude Code style):
 * 1. Scan existing per-fact files; read current MEMORY.md.
 * 2. Send both + the conversation to an LLM in a single call.
 * 3. LLM returns a JSON object containing:
 *    - operations[]: create/update/skip on per-fact files
 *    - memory_md: the full new content of MEMORY.md (post-operations)
 * 4. Apply file operations.
 * 5. Write MEMORY.md from the LLM's output (NOT regenerated from frontmatter),
 *    so the LLM owns curation, ordering, and any human notes within MEMORY.md.
 */

const SUMMARIZE_SYSTEM_PROMPT = `You are a memory curation agent. You read a conversation, extract durable facts worth remembering, and you also maintain MEMORY.md — the human-readable index that is injected into every future conversation.

You will be given:
1. The CURRENT MEMORY.md content (may be empty on first run)
2. A list of EXISTING per-fact memory files (filename, type, name, description)
3. A conversation transcript

You MUST output a single JSON object with this exact shape:

{
  "operations": [
    {
      "action": "create",
      "type": "user" | "feedback" | "project" | "reference",
      "filename": "{type}_{short_slug}.md",
      "name": "短标题（一句话）",
      "description": "一句话摘要，用来在索引中描述这条记忆",
      "content": "记忆正文。详细但精炼。"
    },
    {
      "action": "update",
      "filename": "feedback_xxx.md",
      "name": "新标题（可与原相同）",
      "description": "新摘要",
      "content": "更新后的正文"
    },
    {
      "action": "skip",
      "filename": "feedback_xxx.md",
      "reason": "已覆盖，无需更新"
    }
  ],
  "memory_md": "# Memory Index\\n\\n## Feedback\\n- [Title](feedback_xxx.md) — one-line description\\n..."
}

## Memory types

- **user**: 用户的角色、目标、责任、知识。例：「用户是高级 Electron 工程师，有 10 年经验」。
- **feedback**: 用户给的反馈、纠正、约定。例：「不要在测试里 mock 数据库」。**Why:** 和 **How to apply:** 是好的结构。
- **project**: 项目内的事实、决策、事件。例：「auth 中间件正在被重写以满足合规要求」。
- **reference**: 外部系统资源指针。例：「线上日志在 Grafana grafana.internal/d/api」。

## What to extract

- 用户表达的偏好、审美、协作风格
- 用户角色、职责、关注的项目
- 已做的决策和它的 *why*
- 项目背景、依赖、约束、deadline
- 反馈和纠正——尤其要捕捉 *why* 而不只是 *what*

## What NOT to extract

- 对话的描述（"用户问了 X"、"助手解释了 Y"）
- 一次性任务请求（"帮我看下这个文件"）
- 寒暄和确认（"好的"、"谢谢"）
- 可以从代码或 git history 推导的事实
- 临时状态（"我马上下班"）
- API key、密码、凭证 — 永远不要保存

## Filename rules

- 只能小写字母、数字、下划线、连字符、中文
- 必须以 type 前缀开头：\`user_\`、\`feedback_\`、\`project_\`、\`reference_\`
- 例：\`feedback_no_db_mock.md\`、\`user_role_engineer.md\`、\`project_auth_rewrite.md\`

## Content field rules

- \`content\` 字段是**纯正文**，**禁止**包含任何 YAML frontmatter
- **禁止**在 \`content\` 开头写 \`---\` 分隔符或 \`name:\` / \`type:\` / \`description:\` 这些字段
- frontmatter 由系统根据 \`name\` / \`description\` / \`type\` 字段自动生成

## Decision rules

- 如果一条新事实和现有记忆描述的是**同一回事**：用 update（覆盖原文件）
- 如果新事实**完全等价**于现有记忆：用 skip
- 否则：用 create
- 同一个对话提取的事实之间也要去重

## MEMORY.md curation rules

- memory_md 必须反映**应用 operations 之后**的状态：包括所有未被删除的现有 fact 文件 + 你 create 的新文件 + 你 update 后的新 name/description
- 顶部以 \`# Memory Index\` 开头
- 用 \`## User\`、\`## Feedback\`、\`## Project\`、\`## Reference\` 分组（空的分组直接省略）
- 每条目格式：\`- [name](filename.md) — description\`
- **必须保留**用户或你之前手写的注释、说明、章节、提示——不要凭空删除任何不属于本轮 operations 范围的内容
- **必须保留**你不认识但确实存在的 fact 文件链接（这些可能是别的会话写的，你要把它们继续列在合适的分组里）
- 总长度控制在 200 行 / 25KB 以内；超出时优先保留最近 update 的条目
- 如果 operations 为空且 MEMORY.md 已经准确，原样回传当前 MEMORY.md 内容
- 不要写时间戳或 "(updated)" 之类的元信息

## Output format

- 必须是合法 JSON，没有 markdown 围栏
- 如果没有任何值得记的，operations 为 []，memory_md 仍然输出当前 MEMORY.md 的原文
- 用与用户相同的语言书写 name/description/content
`

// When truncating long conversations, keep the head AND the tail — the tail
// usually contains the conclusions/decisions/confirmations worth remembering.
const CONVERSATION_HEAD_CHARS = 4000
const CONVERSATION_TAIL_CHARS = 8000
// Only truncate when there's actually material to drop. The marker text is
// ~30 chars, so a borderline conversation would otherwise grow after "truncation".
const MAX_CONVERSATION_CHARS = CONVERSATION_HEAD_CHARS + CONVERSATION_TAIL_CHARS + 200
const MAX_CONTENT_CHARS = 8000
const MAX_MEMORY_MD_BYTES = 25_000
const MAX_CURRENT_MEMORY_MD_PROMPT_CHARS = 25_000

export interface SummarizeOptions {
  model: ChatOpenAI
  conversation: string
  memoryDir: string
  scopeHint?: string
  allowedTypes?: MemoryType[]
}

interface CreateOp {
  action: "create"
  type: MemoryType
  filename: string
  name: string
  description: string
  content: string
}
interface UpdateOp {
  action: "update"
  filename: string
  name: string
  description: string
  content: string
}
interface SkipOp {
  action: "skip"
  filename: string
  reason?: string
}
type Operation = CreateOp | UpdateOp | SkipOp

function buildManifestForPrompt(headers: MemoryHeader[]): string {
  if (headers.length === 0) return "(没有现有记忆)"
  return headers.map((h) => `- [${h.type}] ${h.filename} — ${h.name}: ${h.description}`).join("\n")
}

function stripCodeFences(s: string): string {
  // Some models wrap JSON in ```json ... ``` despite instructions.
  return s.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "")
}

function stripThinkBlocks(s: string): string {
  // Strip well-formed <think>...</think> blocks. We deliberately do NOT try
  // to handle "lone closing tag" cases because the LLM's JSON content can
  // contain a literal "</think>" inside a string, and any heuristic that
  // greedily eats from start-of-string to "</think>" will swallow legitimate
  // JSON whenever the tag appears mid-content.
  return s.replace(/<think>[\s\S]*?<\/think>\s*/g, "")
}

/**
 * If the LLM included a YAML frontmatter block at the top of `op.content`
 * (often by mirroring the prompt's example), strip it so we don't end up
 * with two stacked frontmatters in the saved file.
 */
function stripLeadingFrontmatter(body: string): string {
  const m = body.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? body.slice(m[0].length) : body
}

interface ParsedResponse {
  operations: Operation[]
  memoryMd: string | null
}

function parseResponse(raw: string): ParsedResponse {
  const empty: ParsedResponse = { operations: [], memoryMd: null }
  let cleaned = stripThinkBlocks(raw).trim()
  cleaned = stripCodeFences(cleaned).trim()
  if (!cleaned) return empty
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start === -1 || end === -1 || end < start) return empty
  const jsonStr = cleaned.slice(start, end + 1)
  try {
    const parsed = JSON.parse(jsonStr) as { operations?: unknown; memory_md?: unknown }
    if (!parsed || typeof parsed !== "object") return empty
    const operations = Array.isArray(parsed.operations)
      ? parsed.operations.filter((o): o is Operation => isValidOperation(o))
      : []
    const memoryMd = typeof parsed.memory_md === "string" ? parsed.memory_md : null
    return { operations, memoryMd }
  } catch (e) {
    console.warn("[Memory] Failed to parse extraction JSON:", e instanceof Error ? e.message : e)
    return empty
  }
}

function isValidOperation(o: unknown): boolean {
  if (!o || typeof o !== "object") return false
  const op = o as Record<string, unknown>
  if (op.action === "create") {
    return (
      typeof op.type === "string" &&
      ["user", "feedback", "project", "reference"].includes(op.type) &&
      typeof op.name === "string" &&
      typeof op.content === "string" &&
      op.name.length > 0 &&
      op.content.length > 0
    )
  }
  if (op.action === "update") {
    return (
      typeof op.filename === "string" &&
      op.filename.endsWith(".md") &&
      typeof op.content === "string" &&
      op.content.length > 0
    )
  }
  if (op.action === "skip") {
    return typeof op.filename === "string"
  }
  return false
}

function clampContent(s: string): string {
  if (s.length <= MAX_CONTENT_CHARS) return s
  return s.slice(0, MAX_CONTENT_CHARS) + "\n…(truncated)"
}

function isAllowedType(type: MemoryType, allowedTypes?: Set<MemoryType>): boolean {
  return !allowedTypes || allowedTypes.has(type)
}

function applyCreate(
  memoryDir: string,
  op: CreateOp,
  existing: Set<string>,
  allowedTypes?: Set<MemoryType>
): string | null {
  if (!isAllowedType(op.type, allowedTypes)) {
    console.warn("[Memory] Create op rejected by scope type policy:", op.type, op.name)
    return null
  }
  // Validate or regenerate filename.
  let filename = op.filename
  if (!filename || !isValidFactFilename(filename, op.type)) {
    filename = generateFactFilename(op.name, op.type)
  }
  // Avoid clobbering an existing file. Check both the in-memory set (known
  // per-fact files from this scan) and the actual disk (orphan .md files
  // without valid frontmatter that scanMemoryFiles excluded).
  const isTaken = (name: string): boolean => existing.has(name) || existsSync(join(memoryDir, name))
  if (isTaken(filename)) {
    let i = 2
    while (isTaken(filename.replace(/\.md$/, `_${i}.md`))) i++
    filename = filename.replace(/\.md$/, `_${i}.md`)
  }
  const fullPath = join(memoryDir, filename)
  const body = stripLeadingFrontmatter(clampContent(op.content.trim()))
  const fm = buildFrontmatter({ name: op.name, description: op.description ?? "", type: op.type })
  writeFileSync(fullPath, fm + body + "\n", "utf-8")
  existing.add(filename)
  return fullPath
}

function applyUpdate(
  memoryDir: string,
  op: UpdateOp,
  allowedTypes?: Set<MemoryType>
): string | null {
  // Path-traversal guard: the LLM-supplied filename must be a bare filename
  // (no slashes, no parent traversal) and must match the per-fact file shape.
  const safe = basename(op.filename)
  if (
    safe !== op.filename ||
    safe === "MEMORY.md" ||
    !safe.endsWith(".md") ||
    safe.startsWith(".")
  ) {
    console.warn("[Memory] Update target rejected (unsafe filename):", op.filename)
    return null
  }
  const fullPath = join(memoryDir, safe)
  if (!existsSync(fullPath)) {
    console.warn("[Memory] Update target not found, skipping:", safe)
    return null
  }
  // Preserve type from existing frontmatter if LLM didn't supply one.
  // Validate the on-disk value via parseMemoryType — a bare type assertion
  // would let an invalid string ("Feedback", "memo", etc.) round-trip
  // and silently break scanMemoryFiles which uses the same validator.
  const existingContent = readFileSync(fullPath, "utf-8")
  const { frontmatter } = parseFrontmatter(existingContent)
  const type = parseMemoryType(frontmatter.type)
  if (!type) {
    console.warn("[Memory] Update target has invalid/missing type, skipping:", safe)
    return null
  }
  if (!isAllowedType(type, allowedTypes)) {
    console.warn("[Memory] Update op rejected by scope type policy:", type, safe)
    return null
  }
  const fm = buildFrontmatter({
    name: op.name || frontmatter.name || safe,
    description: op.description || frontmatter.description || "",
    type
  })
  const body = stripLeadingFrontmatter(clampContent(op.content.trim()))
  writeFileSync(fullPath, fm + body + "\n", "utf-8")
  return fullPath
}

function clampMemoryMd(s: string): string {
  if (Buffer.byteLength(s, "utf-8") <= MAX_MEMORY_MD_BYTES) return s
  // Cut on a line boundary just under the byte cap.
  const buf = Buffer.from(s, "utf-8").subarray(0, MAX_MEMORY_MD_BYTES)
  let out = buf.toString("utf-8")
  const lastNl = out.lastIndexOf("\n")
  if (lastNl > 0) out = out.slice(0, lastNl)
  return out + "\n"
}

function readCurrentMemoryMd(memoryDir: string): string {
  const memoryMdPath = join(memoryDir, "MEMORY.md")
  if (!existsSync(memoryMdPath)) return ""
  const content = readFileSync(memoryMdPath, "utf-8")
  if (content.length <= MAX_CURRENT_MEMORY_MD_PROMPT_CHARS) return content
  return content.slice(0, MAX_CURRENT_MEMORY_MD_PROMPT_CHARS) + "\n...(truncated)"
}

function buildScopedMemoryMd(memoryDir: string, allowedTypes: Set<MemoryType>): string {
  const headers = scanMemoryFiles(memoryDir).filter((header) =>
    header.type ? isAllowedType(header.type, allowedTypes) : false
  )
  return formatManifest(headers)
}

/**
 * Per-directory serialization queues: prevents concurrent writes to the same
 * memory directory (MEMORY.md clobber / slug collision) while allowing
 * global and project directories to be summarized in parallel.
 */
const summarizeQueues = new Map<string, Promise<void>>()

export function summarizeAndSave(options: SummarizeOptions): Promise<void> {
  const key = options.memoryDir
  const prev = summarizeQueues.get(key) ?? Promise.resolve()
  const next = prev.then(() => summarizeAndSaveInner(options))
  // Swallow errors so one failure doesn't block subsequent calls for this dir.
  summarizeQueues.set(key, next.catch(() => undefined))
  return next
}

async function summarizeAndSaveInner(options: SummarizeOptions): Promise<void> {
  const { model, conversation, memoryDir, scopeHint } = options
  const allowedTypes = options.allowedTypes ? new Set(options.allowedTypes) : undefined

  if (!conversation.trim()) return

  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true })
  }

  let uiChanged = false
  try {
    const headers = scanMemoryFiles(memoryDir)
    const manifestText = buildManifestForPrompt(headers)
    const currentMemoryMd = readCurrentMemoryMd(memoryDir)
    const existingFilenames = new Set(headers.map((h) => h.filename))

    const truncated =
      conversation.length > MAX_CONVERSATION_CHARS
        ? conversation.slice(0, CONVERSATION_HEAD_CHARS) +
          `\n...(${conversation.length - CONVERSATION_HEAD_CHARS - CONVERSATION_TAIL_CHARS} chars truncated)...\n` +
          conversation.slice(conversation.length - CONVERSATION_TAIL_CHARS)
        : conversation

    const userPrompt =
      (scopeHint?.trim() ? `SCOPE RULES:\n${scopeHint.trim()}\n\n` : "") +
      `CURRENT MEMORY.md:\n${currentMemoryMd || "(empty)"}\n\n` +
      `EXISTING PER-FACT FILES:\n${manifestText}\n\n` +
      `CONVERSATION:\n${truncated}\n\n` +
      `Output the JSON object with operations and the updated memory_md now.`

    const response = await model.invoke([
      new SystemMessage(SUMMARIZE_SYSTEM_PROMPT),
      new HumanMessage(userPrompt)
    ])

    const raw =
      typeof response.content === "string" ? response.content : JSON.stringify(response.content)
    const { operations, memoryMd } = parseResponse(raw)

    const touched: string[] = []
    let creates = 0
    let updates = 0
    let skips = 0

    for (const op of operations) {
      try {
        if (op.action === "create") {
          const path = applyCreate(memoryDir, op, existingFilenames, allowedTypes)
          if (path) {
            touched.push(path)
            creates++
          }
        } else if (op.action === "update") {
          const path = applyUpdate(memoryDir, op, allowedTypes)
          if (path) {
            touched.push(path)
            updates++
          }
        } else if (op.action === "skip") {
          skips++
        }
      } catch (e) {
        console.warn(
          "[Memory] Failed to apply operation:",
          op.action,
          "—",
          e instanceof Error ? e.message : e
        )
      }
    }

    // Write MEMORY.md from the LLM's curated output (preserving its grouping
    // and any user-added notes). Fall back to bootstrap regeneration only if
    // the LLM produced nothing usable AND MEMORY.md doesn't yet exist.
    // NOTE: This path only runs when the main agent did NOT call write_file /
    // edit_file on any file inside the memory directory during the conversation
    // (checked via fileWritePaths in ipc/agent.ts), so there is no risk of
    // overwriting the agent's mid-conversation edits.
    const memoryMdPath = join(memoryDir, "MEMORY.md")
    let manifestWritten = false
    let manifestSource = "unchanged"
    if (allowedTypes) {
      try {
        writeFileSync(
          memoryMdPath,
          clampMemoryMd(buildScopedMemoryMd(memoryDir, allowedTypes)),
          "utf-8"
        )
        manifestWritten = true
        manifestSource = "scope-filtered"
      } catch (e) {
        console.warn(
          "[Memory] Failed to write scope-filtered MEMORY.md:",
          e instanceof Error ? e.message : e
        )
      }
    } else if (memoryMd && memoryMd.trim()) {
      try {
        writeFileSync(memoryMdPath, clampMemoryMd(memoryMd), "utf-8")
        manifestWritten = true
        manifestSource = "rewritten by LLM"
      } catch (e) {
        console.warn(
          "[Memory] Failed to write LLM-curated MEMORY.md:",
          e instanceof Error ? e.message : e
        )
      }
    }
    if (!manifestWritten && !existsSync(memoryMdPath)) {
      try {
        regenerateManifest(memoryDir)
        manifestWritten = true
        manifestSource = "bootstrapped"
      } catch (e) {
        console.warn("[Memory] Failed to bootstrap MEMORY.md:", e instanceof Error ? e.message : e)
      }
    }

    // Re-index touched files in the search store.
    if (touched.length > 0 || manifestWritten) {
      try {
        const store = await getMemoryStore(memoryDir)
        for (const path of touched) {
          const content = readFileSync(path, "utf-8")
          store.addDocument(path, content)
        }
        if (existsSync(memoryMdPath)) {
          store.addDocument(memoryMdPath, readFileSync(memoryMdPath, "utf-8"))
        }
      } catch (e) {
        console.warn(
          "[Memory] Failed to re-index touched files:",
          e instanceof Error ? e.message : e
        )
      }
    }

    if (touched.length > 0 || manifestWritten) {
      uiChanged = true
    }

    console.log(
      `[Memory] Applied ${creates} create, ${updates} update, ${skips} skip; ` +
        `manifest ${manifestWritten ? manifestSource : "unchanged"}`
    )

    // Telemetry: background memory writes (summarizer) aren't tool calls, so they
    // never appear in any conversation trace — emit a dedicated event when
    // something was actually written.
    if (touched.length > 0 || manifestWritten) {
      try {
        trackEvent("memory.write.applied", "memory", {
          creates,
          updates,
          skips,
          manifestWritten
        })
      } catch (e) {
        console.warn("[event] failed to emit memory.write.applied:", e)
      }
    }
  } catch (e) {
    console.warn("[Memory] Failed to summarize:", e instanceof Error ? e.message : e)
  } finally {
    // Notify any open MemoryPanel so it re-loads from disk. Without this,
    // the renderer never sees background summarizer writes.
    if (uiChanged) {
      try {
        notifyMemoryChanged()
      } catch (e) {
        console.warn(
          "[Memory] Failed to broadcast memory:changed:",
          e instanceof Error ? e.message : e
        )
      }
    }
  }
}
