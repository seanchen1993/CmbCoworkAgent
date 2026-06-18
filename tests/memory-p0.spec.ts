/**
 * P0 memory regression tests.
 *
 * Run:
 *   npx tsx tests/memory-p0.spec.ts
 */

import { mkdtemp, rm, mkdir } from "fs/promises"
import { existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { execFileSync } from "child_process"
import { join, resolve } from "path"
import { getMemoryStore, closeMemoryStore } from "../src/main/memory/store.ts"
import { createMemorySearchTool } from "../src/main/memory/tools.ts"
import { summarizeAndSave } from "../src/main/memory/summarizer.ts"
import { scanMemoryFiles } from "../src/main/memory/manifest.ts"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import {
  clearGitRootCache,
  findCanonicalGitRoot,
  isMemoryStoragePath,
  MEMORY_ROOT_DIR,
  resolveProjectId
} from "../src/main/memory/paths.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error("ASSERT FAIL: " + msg)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await closeMemoryStore()
    await rm(dir, { recursive: true, force: true })
  }
}

class FakeChatModel {
  constructor(private readonly response: string) {}
  async invoke(): Promise<{ content: string }> {
    return { content: this.response }
  }
}

const asModel = (m: FakeChatModel): import("@langchain/openai").ChatOpenAI =>
  m as unknown as import("@langchain/openai").ChatOpenAI

async function testScopedStoresAreIsolated(): Promise<void> {
  await withTempDir("memory-p0-scope", async (base) => {
    const globalDir = join(base, "global")
    const projectDir = join(base, "projects", "abc123")
    await mkdir(globalDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })

    const globalStore = await getMemoryStore(globalDir)
    const projectStore = await getMemoryStore(projectDir)

    const globalPath = join(globalDir, "feedback_global.md")
    const projectPath = join(projectDir, "project_stack.md")
    globalStore.addDocument(globalPath, "全局偏好：默认回复简短。")
    projectStore.addDocument(projectPath, "项目事实：这个仓库使用 pnpm 和 Electron。")

    assert(globalStore.search("pnpm", 5).length === 0, "global store does not see project fact")
    assert(projectStore.search("pnpm", 5).length === 1, "project store sees project fact")
    assert(
      projectStore.search("默认回复", 5).length === 0,
      "project store does not see global fact"
    )
  })
  console.log("PASS P0-1 scoped MemoryStore instances are isolated")
}

async function testGitRootLookupBehavior(): Promise<void> {
  await withTempDir("memory-p0-git-root", async (base) => {
    clearGitRootCache()
    const nonGitDir = join(base, "non-git")
    await mkdir(nonGitDir, { recursive: true })
    assert(findCanonicalGitRoot(nonGitDir) === null, "non-git directory has no project root")

    const repo = join(base, "repo")
    const nested = join(repo, "src", "nested")
    await mkdir(nested, { recursive: true })
    execFileSync("git", ["init", "--quiet"], { cwd: repo, stdio: "ignore" })

    clearGitRootCache()
    const root = findCanonicalGitRoot(nested)
    assert(root === resolve(repo), `nested dir resolves to repo root, got ${root}`)

    await rm(join(repo, ".git"), { recursive: true, force: true })
    assert(findCanonicalGitRoot(nested) === root, "git root lookup uses in-process cache")

    clearGitRootCache()
    assert(findCanonicalGitRoot(nested) === null, "cleared cache reflects missing .git dir")

    const projectId = resolveProjectId(root!)
    assert(projectId.length === 12, "project id uses compact 12-char hash")
    assert(projectId === resolveProjectId(root!), "project id is stable")
  })
  console.log("PASS P0-2 git root lookup handles non-git dirs and caches results")
}

async function testCjkRelativeScoreFloorFiltersWeakHits(): Promise<void> {
  await withTempDir("memory-p0-floor", async (base) => {
    const store = await getMemoryStore(join(base, "global"))
    const strongPath = join(base, "global", "feedback_strong.md")
    const weakPath = join(base, "global", "feedback_weak.md")
    store.addDocument(strongPath, "支付回调异常超时重试策略需要记录幂等键和失败原因。")
    store.addDocument(weakPath, "支付模块整体说明。")

    const hits = store.search("支付回调异常超时重试策略", 5)
    assert(
      hits.some((hit) => hit.path === strongPath),
      "strong CJK match is returned"
    )
    assert(!hits.some((hit) => hit.path === weakPath), "single-bigram weak match is filtered")
  })
  console.log("PASS P0-3 CJK relative score floor filters weak LIKE hits")
}

async function testSearchReturnsCitation(): Promise<void> {
  await withTempDir("memory-p0-citation", async (base) => {
    const store = await getMemoryStore(join(base, "global"))
    const factPath = join(base, "global", "feedback_test.md")
    store.addDocument(factPath, "integration tests should use a real database")

    const hits = store.search("integration database", 1)
    assert(hits.length === 1, "search returns one hit")
    assert(
      hits[0].citation === `${factPath}#L1-1`,
      `citation includes file and line range, got ${hits[0].citation}`
    )
  })
  console.log("PASS P0-4 search result includes citation")
}

async function testMultiStoreToolTracksOnlyDisplayedResults(): Promise<void> {
  await withTempDir("memory-p0-tool-recall", async (base) => {
    const globalDir = join(base, "global")
    const projectDir = join(base, "projects", "abc123")
    await mkdir(globalDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })

    const globalStore = await getMemoryStore(globalDir)
    const projectStore = await getMemoryStore(projectDir)
    const globalPath = join(globalDir, "global_recall.md")
    const projectPath = join(projectDir, "project_recall.md")
    globalStore.addDocument(globalPath, "recall target")
    projectStore.addDocument(projectPath, "project only recall target")

    const searchTool = createMemorySearchTool([projectStore, globalStore])
    const output = await searchTool.invoke({ query: "project only recall target", max_results: 1 })

    assert(typeof output === "string", "memory_search returns formatted text")
    assert(output.includes(projectPath), "top project hit is displayed")
    assert(
      (projectStore.getRecallStats().get(projectPath)?.totalRecalls ?? 0) === 1,
      "displayed project hit is counted"
    )
    assert(
      (globalStore.getRecallStats().get(globalPath)?.totalRecalls ?? 0) === 0,
      "hidden over-fetched global hit is not counted"
    )
  })
  console.log("PASS P0-5 multi-store tool tracks recall only for displayed hits")
}

async function testSummarizerRejectsDisallowedScopeTypes(): Promise<void> {
  await withTempDir("memory-p0-scope-policy", async (base) => {
    const memoryDir = join(base, "global")
    await mkdir(memoryDir, { recursive: true })
    const response = JSON.stringify({
      operations: [
        {
          action: "create",
          type: "project",
          filename: "project_wrong_scope.md",
          name: "Wrong scope",
          description: "This project fact should not be saved globally",
          content: "The repo uses Electron."
        },
        {
          action: "create",
          type: "user",
          filename: "user_allowed_scope.md",
          name: "Allowed scope",
          description: "This user fact can be saved globally",
          content: "The user prefers concise summaries."
        }
      ],
      memory_md:
        "# Memory Index\n\n## Project\n- [Wrong scope](project_wrong_scope.md) — This should not stay in global\n\n## User\n- [Allowed scope](user_allowed_scope.md) — This user fact can be saved globally\n"
    })

    await summarizeAndSave({
      model: asModel(new FakeChatModel(response)),
      conversation: "User: 我喜欢简洁总结。本项目使用 Electron。",
      memoryDir,
      allowedTypes: ["user", "feedback"]
    })

    assert(!existsSync(join(memoryDir, "project_wrong_scope.md")), "project fact is rejected")
    assert(existsSync(join(memoryDir, "user_allowed_scope.md")), "allowed user fact is written")
    const memoryMd = readFileSync(join(memoryDir, "MEMORY.md"), "utf-8")
    assert(
      !memoryMd.includes("project_wrong_scope.md"),
      "scope-filtered MEMORY.md excludes rejected project links"
    )
    assert(
      memoryMd.includes("user_allowed_scope.md"),
      "scope-filtered MEMORY.md includes allowed links"
    )
    assert(
      scanMemoryFiles(memoryDir).every((header) => header.type !== "project"),
      "rejected project type is absent from scanned facts"
    )
  })
  console.log("PASS P0-6 summarizer rejects disallowed scope types")
}

async function testSandboxBlocksDirectMemoryWrites(): Promise<void> {
  await withTempDir("memory-p0-write-guard", async (base) => {
    const sandbox = new LocalSandbox({ rootDir: base })
    const blockedPath = join(
      MEMORY_ROOT_DIR,
      "global",
      `project_direct_write_blocked_${process.pid}_${Date.now()}.md`
    )
    assert(isMemoryStoragePath(blockedPath), "test target is inside managed memory storage")

    const writeResult = await sandbox.write(blockedPath, "should not be written")
    assert(writeResult.error, "write_file to memory storage is blocked")
    assert(!existsSync(blockedPath), "blocked write does not create memory file")

    const editResult = await sandbox.edit(blockedPath, "", "should not be written")
    assert(editResult.error, "edit_file to memory storage is blocked")
    assert(!existsSync(blockedPath), "blocked edit does not create memory file")
  })
  console.log("PASS P0-7 sandbox blocks direct write/edit to memory storage")
}

async function main(): Promise<void> {
  await testScopedStoresAreIsolated()
  await testGitRootLookupBehavior()
  await testCjkRelativeScoreFloorFiltersWeakHits()
  await testSearchReturnsCitation()
  await testMultiStoreToolTracksOnlyDisplayedResults()
  await testSummarizerRejectsDisallowedScopeTypes()
  await testSandboxBlocksDirectMemoryWrites()
  console.log("\nAll P0 memory regression tests passed.")
}

main().catch((e) => {
  console.error("\nFAIL:", e instanceof Error ? e.message : e)
  if (e instanceof Error && e.stack) console.error(e.stack)
  process.exit(1)
})
