/**
 * E2E test for memory + Dream consolidation flow.
 *
 * 不依赖真实 LLM：用 FakeChatModel 注入预设响应。
 * 不污染用户 ~/.cmbcoworkagent：所有文件操作走 tmpdir。
 *
 * Run:
 *   npx tsx tests/memory-dream-e2e.spec.ts
 */

import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawn } from "child_process"
import { summarizeAndSave } from "../src/main/memory/summarizer.ts"
import {
  consolidateMemories,
  shouldRunDream,
  incrementDreamSessions
} from "../src/main/memory/consolidate.ts"
import { scanMemoryFiles, buildFrontmatter } from "../src/main/memory/manifest.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAIL: " + msg)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ─── Fake ChatOpenAI ──────────────────────────────────────────────────────
class FakeChatModel {
  private responses: string[]
  public calls: Array<{ system: string; user: string }> = []
  constructor(responses: string[]) {
    this.responses = [...responses]
  }
  async invoke(messages: Array<{ content: string }>): Promise<{ content: string }> {
    this.calls.push({
      system: messages[0]?.content ?? "",
      user: messages[1]?.content ?? ""
    })
    const next = this.responses.shift() ?? "{}"
    return { content: next }
  }
}

const asModel = (m: FakeChatModel) => m as unknown as import("@langchain/openai").ChatOpenAI

// ─── Helpers to seed memory files ──────────────────────────────────────────
async function writeFactFile(
  memoryDir: string,
  filename: string,
  type: "user" | "feedback" | "project" | "reference",
  name: string,
  description: string,
  body: string
): Promise<void> {
  const fm = buildFrontmatter({ name, description, type })
  await writeFile(join(memoryDir, filename), fm + body, "utf-8")
}

async function setStateFile(
  memoryDir: string,
  state: { lastRunAt?: number; factCountAtLastRun?: number; sessionsSinceLastRun?: number }
): Promise<void> {
  await writeFile(
    join(memoryDir, ".dream_state.json"),
    JSON.stringify(
      {
        lastRunAt: state.lastRunAt ?? 0,
        factCountAtLastRun: state.factCountAtLastRun ?? 0,
        sessionsSinceLastRun: state.sessionsSinceLastRun ?? 0
      },
      null,
      2
    ),
    "utf-8"
  )
}

async function readStateFile(memoryDir: string): Promise<{
  lastRunAt: number
  factCountAtLastRun: number
  sessionsSinceLastRun: number
}> {
  const raw = await readFile(join(memoryDir, ".dream_state.json"), "utf-8")
  return JSON.parse(raw)
}

// ─── Tests ──────────────────────────────────────────────────────────────────

async function testSummarizeCreatesNewFact(): Promise<void> {
  await withTempDir("memdream-create", async (memDir) => {
    const llmResponse = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "user",
          filename: "user_rust_expert.md",
          name: "Rust 后端工程师",
          description: "10 年 Rust，专注高并发服务",
          content: "用户是资深 Rust 后端工程师，专注高并发服务。新接触 React。"
        },
        {
          action: "create",
          type: "feedback",
          filename: "feedback_no_db_mock.md",
          name: "不要 mock DB",
          description: "集成测试用真实数据库",
          content: "集成测试必须打真实 DB，不要 mock。**Why:** 上季度 mock 通过但 prod 迁移失败。"
        }
      ],
      memory_md:
        "# Memory Index\n\n## User\n- [Rust 后端工程师](user_rust_expert.md) — 10 年 Rust\n\n## Feedback\n- [不要 mock DB](feedback_no_db_mock.md) — 集成测试用真实数据库\n"
    })
    const model = new FakeChatModel([llmResponse])

    await summarizeAndSave({
      model: asModel(model),
      conversation: "User: 我是 Rust 后端…\nAssistant: 好的",
      memoryDir: memDir
    })

    const files = await readdir(memDir)
    assert(files.includes("user_rust_expert.md"), "user fact file created")
    assert(files.includes("feedback_no_db_mock.md"), "feedback fact file created")
    assert(files.includes("MEMORY.md"), "MEMORY.md written")

    const headers = scanMemoryFiles(memDir)
    assert(headers.length === 2, `expected 2 fact files, got ${headers.length}`)
    assert(
      headers.some((h) => h.type === "user" && h.name === "Rust 后端工程师"),
      "user header parsed correctly"
    )
    assert(
      headers.some((h) => h.type === "feedback" && h.name === "不要 mock DB"),
      "feedback header parsed correctly"
    )

    const memoryMd = await readFile(join(memDir, "MEMORY.md"), "utf-8")
    assert(memoryMd.includes("user_rust_expert.md"), "MEMORY.md links to user fact")
    assert(memoryMd.includes("feedback_no_db_mock.md"), "MEMORY.md links to feedback fact")

    assert(model.calls.length === 1, "model invoked once")
    assert(
      model.calls[0].user.includes("CURRENT MEMORY.md"),
      "user prompt carries CURRENT MEMORY.md section"
    )
  })
  console.log("PASS T1 summarizeAndSave creates per-fact files + MEMORY.md")
}

async function testSummarizeUpdatesExistingFact(): Promise<void> {
  await withTempDir("memdream-update", async (memDir) => {
    await writeFactFile(
      memDir,
      "feedback_no_db_mock.md",
      "feedback",
      "不要 mock DB",
      "集成测试用真实数据库",
      "旧正文：mock 数据库不安全。"
    )

    const llmResponse = JSON.stringify({
      operations: [
        {
          action: "update",
          filename: "feedback_no_db_mock.md",
          name: "不要 mock DB",
          description: "集成测试用真实数据库（强化）",
          content: "**Rule:** mock DB 禁止。**Why:** 上季度 prod 迁移失败。**How to apply:** 所有 integration 测试用 docker-compose 真实 DB。"
        }
      ],
      memory_md: "# Memory Index\n\n## Feedback\n- [不要 mock DB](feedback_no_db_mock.md)\n"
    })
    const model = new FakeChatModel([llmResponse])

    await summarizeAndSave({
      model: asModel(model),
      conversation: "User: 再次确认 mock DB 这条规则\nAssistant: 已强化",
      memoryDir: memDir
    })

    const content = await readFile(join(memDir, "feedback_no_db_mock.md"), "utf-8")
    assert(content.includes("**Rule:**"), "fact body updated")
    assert(content.includes("type: feedback"), "frontmatter type preserved")
    assert(content.includes("（强化）"), "description updated in frontmatter")
  })
  console.log("PASS T2 summarizeAndSave updates existing fact with new content & description")
}

async function testIncrementDreamSessions(): Promise<void> {
  await withTempDir("memdream-sessions", async (memDir) => {
    incrementDreamSessions(memDir)
    incrementDreamSessions(memDir)
    incrementDreamSessions(memDir)

    const state = await readStateFile(memDir)
    assert(state.sessionsSinceLastRun === 3, `expected 3, got ${state.sessionsSinceLastRun}`)
    assert(state.lastRunAt === 0, "lastRunAt not touched by session increment")
  })
  console.log("PASS T3 incrementDreamSessions persists count across calls")
}

async function testShouldRunDreamGates(): Promise<void> {
  await withTempDir("memdream-gates", async (memDir) => {
    // Case A: fresh state — ageOk=true (lastRunAt=0), but sessions and growth not satisfied
    assert(
      shouldRunDream(memDir, 0) === false,
      "fresh state with 0 facts: should NOT run (no sessions, no growth)"
    )

    // Case B: enough total facts but lastRunAt is recent → ageOk fails
    await setStateFile(memDir, {
      lastRunAt: Date.now(),
      factCountAtLastRun: 0,
      sessionsSinceLastRun: 10
    })
    assert(
      shouldRunDream(memDir, 60) === false,
      "recent lastRunAt: should NOT run regardless of sessions/growth"
    )

    // Case C: age OK + sessions OK
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000, // 8 days ago
      factCountAtLastRun: 5,
      sessionsSinceLastRun: 5
    })
    assert(shouldRunDream(memDir, 5) === true, "age + sessions gate: should run")

    // Case D: age OK + growth gate (>= 20 new facts)
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000,
      factCountAtLastRun: 0,
      sessionsSinceLastRun: 0
    })
    assert(shouldRunDream(memDir, 25) === true, "age + growth gate: should run")

    // Case E: age OK + total >= DREAM_MIN_TOTAL (50)
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000,
      factCountAtLastRun: 45,
      sessionsSinceLastRun: 0
    })
    assert(shouldRunDream(memDir, 55) === true, "age + total gate: should run at 55 facts")

    // Case F: age OK but neither sessions nor growth
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000,
      factCountAtLastRun: 5,
      sessionsSinceLastRun: 0
    })
    assert(
      shouldRunDream(memDir, 6) === false,
      "age OK but no sessions and only 1 new fact: should NOT run"
    )
  })
  console.log("PASS T4 shouldRunDream gates correctly on age/sessions/growth/total")
}

async function testConsolidateMergeAndSafetyGuard(): Promise<void> {
  await withTempDir("memdream-consolidate", async (memDir) => {
    // Seed 3 facts:
    //   - 1 recent project file (LLM wants to archive, safety guard blocks because <180d)
    //   - 2 duplicates to merge (always archived as merge sources)
    await writeFactFile(
      memDir,
      "project_old_payment.md",
      "project",
      "旧 CKR2002 支付故障",
      "已修复的支付 bug",
      "2025 年的支付故障记忆，已修复。"
    )
    await writeFactFile(
      memDir,
      "feedback_concise_a.md",
      "feedback",
      "回复要简短",
      "用户要求回复简短",
      "用户偏好简短回复"
    )
    await writeFactFile(
      memDir,
      "feedback_concise_b.md",
      "feedback",
      "终端响应简短",
      "终端响应越短越好",
      "终端响应应该简短"
    )

    const llmResponse = JSON.stringify({
      operations: [
        {
          action: "archive",
          filename: "project_old_payment.md",
          reason: "已修复 1 年以上，不再需要"
        },
        {
          action: "merge",
          sources: ["feedback_concise_a.md", "feedback_concise_b.md"],
          type: "feedback",
          filename: "feedback_concise_responses.md",
          name: "回复保持简短",
          description: "所有上下文用户都要求简短回复",
          content: "合并：用户多次要求回复简短、终端响应也简短。**How to apply:** 默认无前导问候。"
        }
      ]
    })
    const model = new FakeChatModel([llmResponse])

    const result = await consolidateMemories({
      model: asModel(model),
      memoryDir: memDir
    })

    // Merge sources count as archives (no age guard on merge sources).
    // The standalone archive op is blocked by the <180d safety guard.
    assert(result.archived === 2, `archived count expected 2 (merge sources only), got ${result.archived}`)
    assert(result.merged === 1, `merged count expected 1, got ${result.merged}`)

    const files = await readdir(memDir)
    assert(
      files.includes("project_old_payment.md"),
      "SAFETY: recent project file NOT archived by LLM op (age guard kicks in)"
    )
    assert(!files.includes("feedback_concise_a.md"), "merge source A archived")
    assert(!files.includes("feedback_concise_b.md"), "merge source B archived")
    assert(files.includes("feedback_concise_responses.md"), "merged result file created")

    // Archive sub-directory should contain merge sources only
    const archiveDir = join(memDir, "archive")
    assert(existsSync(archiveDir), "archive/ subdir created")
    const archived = await readdir(archiveDir)
    assert(archived.length >= 2, `archive contains 2 merge sources, got ${archived.length}`)
    assert(
      archived.some((f) => f.includes("feedback_concise_a")),
      "merge source A in archive/"
    )
    assert(
      archived.some((f) => f.includes("feedback_concise_b")),
      "merge source B in archive/"
    )
    assert(
      !archived.some((f) => f.includes("project_old_payment")),
      "SAFETY: project file should NOT be in archive/ (guard refused)"
    )

    const state = await readStateFile(memDir)
    assert(state.lastRunAt > 0, "lastRunAt set after consolidate")
    assert(state.sessionsSinceLastRun === 0, "sessions counter reset after consolidate")
  })
  console.log("PASS T5 consolidateMemories: merge archives sources + age guard blocks recent files")
}

async function testArchiveSafetyRejectsUserAndRecent(): Promise<void> {
  await withTempDir("memdream-safety", async (memDir) => {
    // user-type files should never be archived by LLM op (regardless of age)
    await writeFactFile(
      memDir,
      "user_engineer.md",
      "user",
      "工程师",
      "用户角色信息",
      "工程师"
    )
    // recent feedback file < 180d should be blocked too
    await writeFactFile(
      memDir,
      "feedback_recent.md",
      "feedback",
      "最近反馈",
      "新增的反馈",
      "feedback body"
    )

    const llmResponse = JSON.stringify({
      operations: [
        { action: "archive", filename: "user_engineer.md", reason: "outdated" },
        { action: "archive", filename: "feedback_recent.md", reason: "too noisy" }
      ]
    })
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel([llmResponse])),
      memoryDir: memDir
    })

    assert(result.archived === 0, `safety: expected 0 archives, got ${result.archived}`)
    const files = await readdir(memDir)
    assert(files.includes("user_engineer.md"), "user fact survives LLM archive attempt")
    assert(files.includes("feedback_recent.md"), "recent fact survives LLM archive attempt")
  })
  console.log("PASS T5b consolidate safety: refuses to archive user-type & recent (<180d) files")
}

async function testConsolidateNoOp(): Promise<void> {
  await withTempDir("memdream-noop", async (memDir) => {
    await writeFactFile(
      memDir,
      "user_solo.md",
      "user",
      "唯一记忆",
      "无可整合",
      "孤立的事实"
    )
    const llmResponse = JSON.stringify({
      operations: [{ action: "skip", filename: "user_solo.md" }]
    })
    const model = new FakeChatModel([llmResponse])

    const result = await consolidateMemories({
      model: asModel(model),
      memoryDir: memDir
    })

    assert(result.archived === 0, "no archives on skip")
    assert(result.merged === 0, "no merges on skip")
    assert(result.skipped === 1, `expected 1 skip, got ${result.skipped}`)

    const files = await readdir(memDir)
    assert(files.includes("user_solo.md"), "fact untouched by skip op")
  })
  console.log("PASS T6 consolidateMemories: skip op leaves files untouched, counters correct")
}

async function testIntegratedFlow(): Promise<void> {
  await withTempDir("memdream-flow", async (memDir) => {
    // Step 1: first conversation → create 1 fact
    const create = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "user",
          filename: "user_role.md",
          name: "Role",
          description: "user role fact",
          content: "用户是 Java 工程师"
        }
      ],
      memory_md: "# Memory Index\n\n## User\n- [Role](user_role.md)\n"
    })
    const summarizer = new FakeChatModel([create])
    await summarizeAndSave({
      model: asModel(summarizer),
      conversation: "User: I'm a Java engineer",
      memoryDir: memDir
    })
    incrementDreamSessions(memDir)

    // Step 2: second conversation → create another fact
    const create2 = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "project",
          filename: "project_alpha.md",
          name: "Alpha",
          description: "alpha project",
          content: "正在做 alpha 项目"
        }
      ],
      memory_md: "# Memory Index\n\n## User\n- [Role](user_role.md)\n\n## Project\n- [Alpha](project_alpha.md)\n"
    })
    const summarizer2 = new FakeChatModel([create2])
    await summarizeAndSave({
      model: asModel(summarizer2),
      conversation: "User: doing alpha",
      memoryDir: memDir
    })
    incrementDreamSessions(memDir)

    // Sanity: 2 facts exist
    const headers = scanMemoryFiles(memDir)
    assert(headers.length === 2, `expected 2 facts after two summarizes, got ${headers.length}`)

    // Step 3: dream gate — sessions=2 < 5 → no auto-trigger even after backdate
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000,
      factCountAtLastRun: 0,
      sessionsSinceLastRun: 2
    })
    assert(
      shouldRunDream(memDir, headers.length) === false,
      "2 sessions and only 2 facts: gate blocks dream"
    )

    // Step 4: bump to satisfy sessions, run dream manually
    await setStateFile(memDir, {
      lastRunAt: Date.now() - 8 * 86400_000,
      factCountAtLastRun: 0,
      sessionsSinceLastRun: 5
    })
    assert(
      shouldRunDream(memDir, headers.length) === true,
      "5 sessions after 8d: gate allows dream"
    )

    const dreamResponse = JSON.stringify({
      operations: [
        { action: "skip", filename: "user_role.md" },
        { action: "skip", filename: "project_alpha.md" }
      ]
    })
    const dreamer = new FakeChatModel([dreamResponse])
    const result = await consolidateMemories({
      model: asModel(dreamer),
      memoryDir: memDir
    })
    assert(result.skipped === 2, "dream applied 2 skips")

    // Step 5: state.lastRunAt is now fresh — gate blocks until 7d pass
    const state = await readStateFile(memDir)
    assert(
      Date.now() - state.lastRunAt < 60_000,
      "lastRunAt within last minute after dream"
    )
    assert(state.sessionsSinceLastRun === 0, "sessions reset after dream run")
    assert(shouldRunDream(memDir, headers.length) === false, "fresh lastRunAt blocks gate")
  })
  console.log("PASS T7 integrated flow: summarize → increment → gate-check → dream → state reset")
}

// ════════════════════════════════════════════════════════════════════════════
//   DEEP COVERAGE: LLM response robustness, edge cases, safety
// ════════════════════════════════════════════════════════════════════════════

// ─── Group A: Summarizer parsing robustness ───────────────────────────────

async function testParseMalformedJson(): Promise<void> {
  await withTempDir("memdream-malformed", async (memDir) => {
    const model = new FakeChatModel(["this is not json at all { invalid }"])
    await summarizeAndSave({
      model: asModel(model),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const headers = scanMemoryFiles(memDir)
    assert(headers.length === 0, "no facts created from malformed JSON")
    // No bootstrap MEMORY.md (no existing facts to bootstrap from)
  })
  console.log("PASS A1 malformed JSON response: 0 facts, no crash")
}

async function testParseThinkBlocks(): Promise<void> {
  await withTempDir("memdream-think", async (memDir) => {
    const payload = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "user",
          filename: "user_via_think.md",
          name: "Via think",
          description: "parsed through think wrapper",
          content: "fact body"
        }
      ],
      memory_md: "# Memory Index\n- user_via_think.md\n"
    })
    const raw = `<think>let me figure this out\nsome reasoning here</think>\n${payload}`
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const files = await readdir(memDir)
    assert(files.includes("user_via_think.md"), "parser strips <think> blocks")
  })
  console.log("PASS A2 <think>...</think> wrapper stripped before JSON parse")
}

async function testParseCodeFences(): Promise<void> {
  await withTempDir("memdream-fences", async (memDir) => {
    const payload = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "feedback",
          filename: "feedback_via_fence.md",
          name: "Via fence",
          description: "parsed through code-fence wrapper",
          content: "fact body"
        }
      ],
      memory_md: "# Memory Index\n"
    })
    const raw = "```json\n" + payload + "\n```"
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const files = await readdir(memDir)
    assert(files.includes("feedback_via_fence.md"), "parser strips ```json fences")
  })
  console.log("PASS A3 ```json``` code fences stripped before JSON parse")
}

async function testEmptyConversation(): Promise<void> {
  await withTempDir("memdream-empty-conv", async (memDir) => {
    const model = new FakeChatModel([
      JSON.stringify({ operations: [{ action: "skip", filename: "x.md" }], memory_md: "# x" })
    ])
    await summarizeAndSave({
      model: asModel(model),
      conversation: "   ",
      memoryDir: memDir
    })
    assert(model.calls.length === 0, "model never invoked for empty conversation")
    assert(!existsSync(join(memDir, "MEMORY.md")), "no MEMORY.md created for empty conversation")
  })
  console.log("PASS A4 empty conversation is no-op (skips LLM call)")
}

async function testInvalidOperationFilter(): Promise<void> {
  await withTempDir("memdream-invalid-op", async (memDir) => {
    const raw = JSON.stringify({
      operations: [
        // Missing type
        { action: "create", filename: "x.md", name: "x", content: "body" },
        // Empty content
        { action: "create", type: "user", filename: "user_x.md", name: "x", content: "" },
        // Invalid action
        { action: "delete", filename: "user_x.md" },
        // Valid one
        {
          action: "create",
          type: "user",
          filename: "user_valid.md",
          name: "valid",
          description: "the only valid op",
          content: "body"
        }
      ],
      memory_md: "# Memory"
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const headers = scanMemoryFiles(memDir)
    assert(headers.length === 1, `expected 1 valid op survives, got ${headers.length}`)
    assert(headers[0].filename === "user_valid.md", "the valid op was applied")
  })
  console.log("PASS A5 invalid operations (missing fields / unknown action) filtered out")
}

async function testInvalidFilenameRegenerated(): Promise<void> {
  await withTempDir("memdream-bad-filename", async (memDir) => {
    const raw = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "project",
          // Invalid: missing type prefix
          filename: "alpha_only.md",
          name: "Alpha 项目",
          description: "...",
          content: "body"
        }
      ],
      memory_md: ""
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const headers = scanMemoryFiles(memDir)
    assert(headers.length === 1, "fact created despite invalid filename")
    assert(
      headers[0].filename.startsWith("project_"),
      `regenerated filename starts with type prefix, got: ${headers[0].filename}`
    )
    assert(headers[0].filename.endsWith(".md"), "regenerated filename ends with .md")
  })
  console.log("PASS A6 invalid filename regenerated via generateFactFilename")
}

async function testFilenameCollisionSuffix(): Promise<void> {
  await withTempDir("memdream-collision", async (memDir) => {
    // Seed an existing file
    await writeFactFile(memDir, "user_alice.md", "user", "Alice", "first Alice", "body 1")

    const raw = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "user",
          filename: "user_alice.md", // collision
          name: "Alice (新)",
          description: "different Alice",
          content: "body 2"
        }
      ],
      memory_md: ""
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })

    const files = (await readdir(memDir)).filter((f) => f.startsWith("user_alice"))
    assert(files.length === 2, `expected 2 files, got ${files.length}: ${files.join(",")}`)
    assert(files.includes("user_alice.md"), "original preserved")
    assert(files.includes("user_alice_2.md"), "collision resolved with _2 suffix")
  })
  console.log("PASS A7 filename collision resolved with _N suffix (no clobber)")
}

async function testLeadingFrontmatterStripped(): Promise<void> {
  await withTempDir("memdream-doublefm", async (memDir) => {
    const raw = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "user",
          filename: "user_double.md",
          name: "Double FM",
          description: "...",
          content: "---\nname: rogue\ntype: project\n---\n\nactual body here"
        }
      ],
      memory_md: ""
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const content = await readFile(join(memDir, "user_double.md"), "utf-8")
    // Should have exactly ONE frontmatter block
    const fmMatches = content.match(/^---\r?\n/gm) || []
    assert(fmMatches.length === 2, `frontmatter delimiters expected 2 (open+close), got ${fmMatches.length}`)
    assert(content.includes("type: user"), "real frontmatter type=user")
    assert(!content.includes("type: project"), "embedded rogue frontmatter discarded")
    assert(content.includes("actual body here"), "body content preserved")
  })
  console.log("PASS A8 embedded frontmatter in content stripped (no double frontmatter)")
}

// ─── Group B: Update op safety ────────────────────────────────────────────

async function testUpdatePathTraversalRejected(): Promise<void> {
  await withTempDir("memdream-traverse", async (memDir) => {
    await writeFactFile(memDir, "user_alice.md", "user", "Alice", "...", "original")
    const raw = JSON.stringify({
      operations: [
        {
          action: "update",
          filename: "../etc/passwd.md",
          name: "evil",
          description: "...",
          content: "pwned"
        },
        {
          action: "update",
          filename: "subdir/sneaky.md",
          name: "evil2",
          description: "...",
          content: "pwned"
        }
      ],
      memory_md: ""
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    // Alice still original; no traversed files
    const alice = await readFile(join(memDir, "user_alice.md"), "utf-8")
    assert(alice.includes("original"), "untouched")
  })
  console.log("PASS B1 update with path traversal (../, subdir/) rejected")
}

async function testUpdateMemoryMdRejected(): Promise<void> {
  await withTempDir("memdream-update-memory", async (memDir) => {
    await writeFile(join(memDir, "MEMORY.md"), "# Original Index\n", "utf-8")
    const raw = JSON.stringify({
      operations: [
        {
          action: "update",
          filename: "MEMORY.md",
          name: "evil",
          description: "...",
          content: "hijacked"
        }
      ],
      memory_md: "# Replaced by memory_md, not by op"
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const content = await readFile(join(memDir, "MEMORY.md"), "utf-8")
    // The update op was rejected (not "hijacked"). memory_md field still wrote.
    assert(!content.includes("hijacked"), "MEMORY.md not updated by update op")
    assert(content.includes("Replaced by memory_md"), "memory_md field wrote MEMORY.md normally")
  })
  console.log("PASS B2 update op targeting MEMORY.md rejected; memory_md field still works")
}

async function testUpdateMissingFileSkipped(): Promise<void> {
  await withTempDir("memdream-update-miss", async (memDir) => {
    const raw = JSON.stringify({
      operations: [
        {
          action: "update",
          filename: "user_nonexistent.md",
          name: "ghost",
          description: "...",
          content: "body"
        }
      ],
      memory_md: ""
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const files = await readdir(memDir)
    assert(!files.includes("user_nonexistent.md"), "missing-target update did not create file")
  })
  console.log("PASS B3 update on non-existent file is skipped (no accidental create)")
}

// ─── Group C: MEMORY.md handling ──────────────────────────────────────────

async function testCurrentMemoryMdPassedToLlm(): Promise<void> {
  await withTempDir("memdream-current-md", async (memDir) => {
    const existingIndex = "# Existing Index\n\n## Reference\n- prior fact\n"
    await writeFile(join(memDir, "MEMORY.md"), existingIndex, "utf-8")
    const model = new FakeChatModel([
      JSON.stringify({ operations: [], memory_md: existingIndex })
    ])
    await summarizeAndSave({
      model: asModel(model),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const userPrompt = model.calls[0].user
    assert(
      userPrompt.includes("# Existing Index"),
      "CURRENT MEMORY.md section carries existing index into the prompt"
    )
  })
  console.log("PASS C1 existing MEMORY.md is passed to LLM as CURRENT MEMORY.md")
}

async function testMemoryMdOmittedKeepsExisting(): Promise<void> {
  await withTempDir("memdream-omit-md", async (memDir) => {
    const existingIndex = "# Original\n"
    await writeFile(join(memDir, "MEMORY.md"), existingIndex, "utf-8")
    const raw = JSON.stringify({
      operations: [{ action: "skip", filename: "anything.md" }]
      // memory_md intentionally omitted
    })
    await summarizeAndSave({
      model: asModel(new FakeChatModel([raw])),
      conversation: "User: hi",
      memoryDir: memDir
    })
    const after = await readFile(join(memDir, "MEMORY.md"), "utf-8")
    assert(after === existingIndex, "MEMORY.md unchanged when LLM omits memory_md")
  })
  console.log("PASS C2 LLM omits memory_md → existing MEMORY.md preserved (not clobbered)")
}

// ─── Group D: scanMemoryFiles filtering ──────────────────────────────────

async function testScanFiltering(): Promise<void> {
  await withTempDir("memdream-scan", async (memDir) => {
    await writeFactFile(memDir, "user_a.md", "user", "A", "a", "body")
    await writeFile(join(memDir, "MEMORY.md"), "# Index\n", "utf-8")
    await writeFile(join(memDir, "2026-03-18.md"), "legacy daily log", "utf-8")
    await writeFile(join(memDir, "no-frontmatter.md"), "just text, no frontmatter", "utf-8")
    await writeFile(
      join(memDir, "user_bad_type.md"),
      "---\nname: bad\ntype: invalidkind\n---\n\nbody",
      "utf-8"
    )
    await mkdir(join(memDir, "archive"))
    await writeFile(
      join(memDir, "archive", "user_archived.md"),
      buildFrontmatter({ name: "archived", description: "...", type: "user" }) + "body",
      "utf-8"
    )

    const headers = scanMemoryFiles(memDir)
    const names = headers.map((h) => h.filename)
    assert(names.length === 1, `only 1 valid fact, got ${names.length}: ${names.join(",")}`)
    assert(names[0] === "user_a.md", "user_a.md scanned")
    assert(!names.includes("MEMORY.md"), "MEMORY.md excluded")
    assert(!names.includes("2026-03-18.md"), "daily log excluded")
    assert(!names.includes("no-frontmatter.md"), "no-frontmatter file excluded")
    assert(!names.includes("user_bad_type.md"), "invalid type excluded")
    assert(!names.includes("user_archived.md"), "archive/ subdir NOT scanned")
  })
  console.log("PASS D1 scanMemoryFiles filters MEMORY.md / daily / no-fm / bad-type / archive/")
}

// ─── Group E: Dream consolidate edge cases ────────────────────────────────

async function testDreamMalformedResponse(): Promise<void> {
  await withTempDir("memdream-dream-malformed", async (memDir) => {
    await writeFactFile(memDir, "user_x.md", "user", "x", "x", "body")
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel(["not json at all"])),
      memoryDir: memDir
    })
    assert(
      result.archived === 0 && result.merged === 0 && result.created === 0 && result.skipped === 0,
      "all counters zero on malformed dream response"
    )
    // State should still update (dream "completed", just no-op)
    const state = await readStateFile(memDir)
    assert(state.lastRunAt > 0, "lastRunAt set even when 0 ops applied")
  })
  console.log("PASS E1 dream malformed response: 0 ops, state still advances")
}

async function testDreamThinkAndFences(): Promise<void> {
  await withTempDir("memdream-dream-think", async (memDir) => {
    await writeFactFile(memDir, "feedback_solo.md", "feedback", "solo", "solo fact", "body")
    const payload = JSON.stringify({
      operations: [{ action: "skip", filename: "feedback_solo.md" }]
    })
    const raw = `<think>analyzing</think>\n\`\`\`json\n${payload}\n\`\`\``
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel([raw])),
      memoryDir: memDir
    })
    assert(result.skipped === 1, "dream parser handles <think> + code fences")
  })
  console.log("PASS E2 dream parser strips <think> and ```json``` wrappers")
}

async function testDreamMergeNonexistentSource(): Promise<void> {
  await withTempDir("memdream-merge-miss", async (memDir) => {
    await writeFactFile(memDir, "feedback_a.md", "feedback", "A", "...", "body A")
    const raw = JSON.stringify({
      operations: [
        {
          action: "merge",
          sources: ["feedback_a.md", "feedback_does_not_exist.md"],
          type: "feedback",
          filename: "feedback_merged.md",
          name: "merged",
          description: "...",
          content: "merged body"
        }
      ]
    })
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel([raw])),
      memoryDir: memDir
    })
    assert(result.merged === 1, "merge created with at least one valid source")
    assert(result.archived === 1, "only existing source counted as archived")
    const files = await readdir(memDir)
    assert(files.includes("feedback_merged.md"), "merge result file written")
    assert(!files.includes("feedback_a.md"), "existing source archived")
  })
  console.log("PASS E3 merge with non-existent source: skips ghost, archives valid sources")
}

async function testDreamCreateMeta(): Promise<void> {
  await withTempDir("memdream-meta", async (memDir) => {
    await writeFactFile(memDir, "project_payment_a.md", "project", "A", "...", "payment A")
    await writeFactFile(memDir, "project_payment_b.md", "project", "B", "...", "payment B")
    const raw = JSON.stringify({
      operations: [
        {
          action: "create_meta",
          type: "project",
          filename: "project_payment_overview.md",
          name: "支付总览",
          description: "汇总所有支付相关 fact 的 meta 文件",
          content: "## Payment Overview\n\n- A: ...\n- B: ...\n"
        }
      ]
    })
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel([raw])),
      memoryDir: memDir
    })
    assert(result.created === 1, "create_meta produces 1 new file")
    assert(result.archived === 0, "create_meta does NOT archive sources (unlike merge)")
    const files = await readdir(memDir)
    assert(files.includes("project_payment_overview.md"), "meta file written")
    assert(files.includes("project_payment_a.md"), "original A preserved")
    assert(files.includes("project_payment_b.md"), "original B preserved")
  })
  console.log("PASS E4 create_meta writes synthesis file without archiving sources")
}

async function testDreamMergeFilenameCollision(): Promise<void> {
  await withTempDir("memdream-merge-collide", async (memDir) => {
    await writeFactFile(memDir, "feedback_a.md", "feedback", "A", "...", "body A")
    await writeFactFile(memDir, "feedback_b.md", "feedback", "B", "...", "body B")
    // Pre-existing file with same name as desired merge output
    await writeFactFile(memDir, "feedback_combined.md", "feedback", "Existing", "preexisting", "preexisting body")

    const raw = JSON.stringify({
      operations: [
        {
          action: "merge",
          sources: ["feedback_a.md", "feedback_b.md"],
          type: "feedback",
          filename: "feedback_combined.md",
          name: "Combined",
          description: "merged",
          content: "merged body"
        }
      ]
    })
    const result = await consolidateMemories({
      model: asModel(new FakeChatModel([raw])),
      memoryDir: memDir
    })
    assert(result.merged === 1, "merge succeeded")

    const files = await readdir(memDir)
    const preexistingContent = await readFile(join(memDir, "feedback_combined.md"), "utf-8")
    assert(
      preexistingContent.includes("preexisting body"),
      "pre-existing file with target name was NOT clobbered"
    )
    assert(
      files.some((f) => /^feedback_combined_\d+\.md$/.test(f)),
      `merge result written under non-colliding name (feedback_combined_N.md), files: ${files.join(",")}`
    )
  })
  console.log("PASS E5 merge filename collision: pre-existing file preserved, output gets _N suffix")
}

// ─── Group F: Dream state robustness ──────────────────────────────────────

async function testCorruptedDreamState(): Promise<void> {
  await withTempDir("memdream-corrupt-state", async (memDir) => {
    await writeFile(join(memDir, ".dream_state.json"), "{ not valid json", "utf-8")
    // Should treat as first run (no crash)
    const result = shouldRunDream(memDir, 100)
    assert(typeof result === "boolean", "corrupted state file does not throw")

    // After successful dream, state is rewritten cleanly
    const dreamerRaw = JSON.stringify({ operations: [] })
    await consolidateMemories({
      model: asModel(new FakeChatModel([dreamerRaw])),
      memoryDir: memDir
    })
    const state = await readStateFile(memDir)
    assert(state.lastRunAt > 0, "state rewritten cleanly after dream")
    assert(state.sessionsSinceLastRun === 0, "sessions field present and zero")
  })
  console.log("PASS F1 corrupted .dream_state.json: treated as first run, dream rewrites cleanly")
}

async function testStateMissingFields(): Promise<void> {
  await withTempDir("memdream-partial-state", async (memDir) => {
    await writeFile(join(memDir, ".dream_state.json"), JSON.stringify({ lastRunAt: 1 }), "utf-8")
    incrementDreamSessions(memDir)
    const state = await readStateFile(memDir)
    assert(state.sessionsSinceLastRun === 1, "missing field defaults to 0, then increments")
    assert(state.factCountAtLastRun === 0, "missing factCountAtLastRun defaults to 0")
  })
  console.log("PASS F2 partial state file: missing fields default to 0, increments cleanly")
}

// ─── Group G: Concurrency ─────────────────────────────────────────────────

async function testParallelSummarizeSerialized(): Promise<void> {
  await withTempDir("memdream-parallel", async (memDir) => {
    let inFlight = 0
    let maxInFlight = 0

    // Wrap FakeChatModel to track concurrent invocations
    class TrackedModel extends FakeChatModel {
      async invoke(messages: Array<{ content: string }>): Promise<{ content: string }> {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        // Yield so a parallel call has a chance to overlap if not serialized
        await new Promise((r) => setTimeout(r, 30))
        inFlight--
        return super.invoke(messages)
      }
    }
    const make = (slug: string) =>
      new TrackedModel([
        JSON.stringify({
          operations: [
            {
              action: "create",
              type: "user",
              filename: `user_${slug}.md`,
              name: slug,
              description: slug,
              content: `body ${slug}`
            }
          ],
          memory_md: `# Index ${slug}\n`
        })
      ])

    const p1 = summarizeAndSave({
      model: asModel(make("alpha")),
      conversation: "User: alpha",
      memoryDir: memDir
    })
    const p2 = summarizeAndSave({
      model: asModel(make("beta")),
      conversation: "User: beta",
      memoryDir: memDir
    })
    const p3 = summarizeAndSave({
      model: asModel(make("gamma")),
      conversation: "User: gamma",
      memoryDir: memDir
    })
    await Promise.all([p1, p2, p3])

    assert(maxInFlight === 1, `parallel calls were serialized (maxInFlight=${maxInFlight})`)
    const headers = scanMemoryFiles(memDir)
    const names = headers.map((h) => h.filename).sort()
    assert(
      JSON.stringify(names) === JSON.stringify(["user_alpha.md", "user_beta.md", "user_gamma.md"]),
      `all three facts persisted, got: ${names.join(",")}`
    )
  })
  console.log("PASS G1 parallel summarizeAndSave calls serialized by module queue")
}

// ─── Group H: MemoryStore + recall_count (via subprocess) ─────────────────
//
// MemoryStore reads os.homedir() at import time and hardcodes the path,
// so we exercise it in a subprocess with USERPROFILE/HOME overridden to
// a temp dir. Each test spawns the probe ONCE with a multi-op command
// sequence (cold start is ~3s on Windows, so we batch).

interface ProbeResult {
  op: string
  ok?: boolean
  hits?: Array<{ text: string; path: string; startLine: number; endLine: number }>
  entries?: Array<[string, { totalRecalls: number; lastRecalledAt: number | null }]>
  error?: string
}

async function runMemoryStoreProbe(
  tmpHome: string,
  commands: Array<Record<string, unknown>>
): Promise<ProbeResult[]> {
  // Write commands to a temp file to dodge shell-quoting on Windows.
  const cmdsPath = join(tmpHome, "_probe_commands.json")
  await writeFile(cmdsPath, JSON.stringify(commands), "utf-8")

  return new Promise((resolve, reject) => {
    const proc = spawn(
      "npx",
      ["tsx", "tests/support/memory-store-probe.ts", cmdsPath],
      {
        env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome },
        shell: true, // resolve npx.cmd on Windows; harmless on Unix
        windowsHide: true
      }
    )
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString()
    })
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString()
    })
    proc.on("error", reject)
    proc.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`probe exit ${code}\nstdout: ${stdout}\nstderr: ${stderr}`))
        return
      }
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("RESULT "))
      if (!line) {
        reject(new Error(`no RESULT line in probe stdout:\n${stdout}\nstderr:\n${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(line.slice("RESULT ".length)))
      } catch (e) {
        reject(new Error(`parse RESULT failed: ${e instanceof Error ? e.message : e}`))
      }
    })
  })
}

async function withTempHome<T>(name: string, fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

async function testStoreAddAndSearch(): Promise<void> {
  await withTempHome("memstore-search", async (home) => {
    const factPath = join(home, "fact1.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      { op: "addDocument", path: factPath, content: "the quick brown fox jumps over the lazy dog" },
      { op: "search", query: "brown fox" }
    ])
    assert(results[0].ok === true, "addDocument succeeded")
    const hits = results[1].hits ?? []
    assert(hits.length >= 1, `search returned ≥1 hit, got ${hits.length}`)
    assert(
      hits.some((h) => h.text.includes("quick brown fox")),
      "search hit contains indexed text"
    )
    assert(
      hits.some((h) => h.path === factPath),
      `search hit references the added path: ${hits[0]?.path}`
    )
  })
  console.log("PASS H1 MemoryStore.addDocument + search returns indexed text")
}

async function testStoreSearchIncrementsRecallCount(): Promise<void> {
  await withTempHome("memstore-recall-inc", async (home) => {
    const factPath = join(home, "fact_inc.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      { op: "addDocument", path: factPath, content: "rust async workflow tokio executor model" },
      { op: "search", query: "rust async" },
      { op: "search", query: "rust async" },
      { op: "search", query: "rust async" },
      { op: "getRecallStats" }
    ])
    const entries = results[4].entries ?? []
    const factEntry = entries.find(([p]) => p === factPath)
    assert(factEntry, `fact path present in stats, entries: ${JSON.stringify(entries)}`)
    assert(
      factEntry![1].totalRecalls === 3,
      `recall_count should be 3 after 3 searches, got ${factEntry![1].totalRecalls}`
    )
    assert(
      typeof factEntry![1].lastRecalledAt === "number" && factEntry![1].lastRecalledAt > 0,
      "lastRecalledAt populated"
    )
  })
  console.log("PASS H2 search increments recall_count exactly once per matching chunk")
}

async function testStoreRecallStatsAggregatePerPath(): Promise<void> {
  await withTempHome("memstore-recall-agg", async (home) => {
    // Use long content so chunkMarkdown produces multiple chunks.
    const longBody = Array.from({ length: 30 }, (_, i) => `line ${i} bigtable scalable system`).join("\n")
    const factPath = join(home, "fact_multi.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      { op: "addDocument", path: factPath, content: longBody },
      { op: "search", query: "bigtable scalable", limit: 5 },
      { op: "getRecallStats" }
    ])
    const hits = results[1].hits ?? []
    const distinctChunks = new Set(hits.map((h) => `${h.startLine}-${h.endLine}`)).size
    assert(distinctChunks >= 2, `expected ≥2 distinct chunks matched, got ${distinctChunks}`)

    const entries = results[2].entries ?? []
    const factEntry = entries.find(([p]) => p === factPath)
    assert(factEntry, "multi-chunk path present in aggregated stats")
    // Aggregated recall_count = number of chunks bumped this round (== hits returned)
    assert(
      factEntry![1].totalRecalls === hits.length,
      `aggregated recall_count (${factEntry![1].totalRecalls}) equals top-K hit count (${hits.length})`
    )
  })
  console.log("PASS H3 getRecallStats aggregates per-path across multiple chunks")
}

async function testStoreReindexReplacesOldChunks(): Promise<void> {
  await withTempHome("memstore-reindex", async (home) => {
    const factPath = join(home, "fact_reindex.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      { op: "addDocument", path: factPath, content: "OLDCONTENT marker zinnia" },
      { op: "search", query: "zinnia" },
      // Re-add with completely different content
      { op: "addDocument", path: factPath, content: "REPLACEMENT marker rhubarb" },
      { op: "search", query: "zinnia" }, // should NOT find the old content
      { op: "search", query: "rhubarb" } // should find the new content
    ])
    const beforeHits = results[1].hits ?? []
    assert(
      beforeHits.some((h) => h.text.includes("OLDCONTENT")),
      "before reindex: search for 'zinnia' finds OLDCONTENT"
    )

    const afterStaleHits = results[3].hits ?? []
    assert(
      !afterStaleHits.some((h) => h.text.includes("OLDCONTENT")),
      `after reindex: search for 'zinnia' returns no stale hits (got ${afterStaleHits.length})`
    )

    const replacementHits = results[4].hits ?? []
    assert(
      replacementHits.some((h) => h.text.includes("REPLACEMENT")),
      "after reindex: search for 'rhubarb' finds REPLACEMENT"
    )
  })
  console.log("PASS H4 re-addDocument on same path drops old chunks (no stale FTS rows)")
}

async function testStoreEmptyQuerySafe(): Promise<void> {
  await withTempHome("memstore-empty-q", async (home) => {
    const factPath = join(home, "fact.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      { op: "addDocument", path: factPath, content: "some indexed content here" },
      { op: "search", query: "" },
      { op: "search", query: "   " },
      { op: "getRecallStats" }
    ])
    assert((results[1].hits ?? []).length === 0, "empty query returns 0 hits")
    assert((results[2].hits ?? []).length === 0, "whitespace query returns 0 hits")
    // recall_count for the user fact should be 0 (not incremented by empty queries)
    const entries = results[3].entries ?? []
    const factEntry = entries.find(([p]) => p === factPath)
    assert(
      factEntry && factEntry[1].totalRecalls === 0,
      `empty query does NOT increment recall_count, got ${factEntry?.[1].totalRecalls}`
    )
  })
  console.log("PASS H5 empty / whitespace queries return 0 hits without incrementing recall_count")
}

async function testStoreCjkSearch(): Promise<void> {
  await withTempHome("memstore-cjk", async (home) => {
    const factPath = join(home, "fact_zh.md").replace(/\\/g, "/")
    const results = await runMemoryStoreProbe(home, [
      {
        op: "addDocument",
        path: factPath,
        content: "用户偏好简短的回复 不要冗长解释 中文环境下尤其如此"
      },
      { op: "search", query: "简短回复" }
    ])
    const hits = results[1].hits ?? []
    assert(hits.length >= 1, `CJK query returns ≥1 hit via LIKE bigram fallback, got ${hits.length}`)
    assert(
      hits.some((h) => h.text.includes("简短")),
      "CJK hit contains the search term"
    )
  })
  console.log("PASS H6 CJK bigram query finds Chinese content via LIKE fallback path")
}

// ─── Run ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("Memory + Dream E2E\n")
  console.log("--- Core flow ---")
  await testSummarizeCreatesNewFact()
  await testSummarizeUpdatesExistingFact()
  await testIncrementDreamSessions()
  await testShouldRunDreamGates()
  await testConsolidateMergeAndSafetyGuard()
  await testArchiveSafetyRejectsUserAndRecent()
  await testConsolidateNoOp()
  await testIntegratedFlow()

  console.log("\n--- Group A: summarizer parsing robustness ---")
  await testParseMalformedJson()
  await testParseThinkBlocks()
  await testParseCodeFences()
  await testEmptyConversation()
  await testInvalidOperationFilter()
  await testInvalidFilenameRegenerated()
  await testFilenameCollisionSuffix()
  await testLeadingFrontmatterStripped()

  console.log("\n--- Group B: update op safety ---")
  await testUpdatePathTraversalRejected()
  await testUpdateMemoryMdRejected()
  await testUpdateMissingFileSkipped()

  console.log("\n--- Group C: MEMORY.md handling ---")
  await testCurrentMemoryMdPassedToLlm()
  await testMemoryMdOmittedKeepsExisting()

  console.log("\n--- Group D: scanMemoryFiles filtering ---")
  await testScanFiltering()

  console.log("\n--- Group E: dream consolidate edges ---")
  await testDreamMalformedResponse()
  await testDreamThinkAndFences()
  await testDreamMergeNonexistentSource()
  await testDreamCreateMeta()
  await testDreamMergeFilenameCollision()

  console.log("\n--- Group F: dream state robustness ---")
  await testCorruptedDreamState()
  await testStateMissingFields()

  console.log("\n--- Group G: concurrency ---")
  await testParallelSummarizeSerialized()

  console.log("\n--- Group H: MemoryStore + recall_count (subprocess) ---")
  await testStoreAddAndSearch()
  await testStoreSearchIncrementsRecallCount()
  await testStoreRecallStatsAggregatePerPath()
  await testStoreReindexReplacesOldChunks()
  await testStoreEmptyQuerySafe()
  await testStoreCjkSearch()

  console.log("\nAll memory E2E tests passed.")
}

main().catch((e) => {
  console.error("\nFAIL:", e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack)
  process.exit(1)
})
