/**
 * Integration tests for agent auto-commit logic against real temporary git repos.
 *
 * Run:
 *   npx tsx tests/auto-commit.spec.ts
 *
 * NOTE: this spec mutates the user's `~/.cmbcoworkagent/agent-auto-commit-settings.json`
 * via the storage module. The file is backed up once at the start and restored
 * in a finally block.
 */

import { execFile } from "child_process"
import { mkdtemp, mkdir, rm, writeFile, readFile } from "fs/promises"
import { existsSync } from "fs"
import { tmpdir, homedir } from "os"
import { join } from "path"
import { promisify } from "util"

const execFileAsync = promisify(execFile)
const CARD_NUMBER = "Z990880"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function removeTempDir(dir: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await sleep(125)
    }
  }
  throw lastError
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await removeTempDir(dir)
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd })
  return stdout
}

async function initRepo(cwd: string): Promise<void> {
  await git(cwd, ["init", "-q", "-b", "main"])
  await git(cwd, ["config", "user.email", "test@example.com"])
  await git(cwd, ["config", "user.name", "Test"])
  await writeFile(join(cwd, "README.md"), "init\n")
  await git(cwd, ["add", "."])
  await git(cwd, ["commit", "-q", "-m", "init"])
}

const SETTINGS_FILE = join(homedir(), ".cmbcoworkagent", "agent-auto-commit-settings.json")
let savedSettings: string | null = null
let savedSettingsExisted = false

function enabledSettings(
  messageStrategy: "prompt" | "diff" | "template" = "diff",
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    mode: "always",
    push: false,
    cardNumber: CARD_NUMBER,
    messageStrategy,
    ...extra
  }
}

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(homedir(), ".cmbcoworkagent"), { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8")
}

async function backupSettings(): Promise<void> {
  if (existsSync(SETTINGS_FILE)) {
    savedSettingsExisted = true
    savedSettings = await readFile(SETTINGS_FILE, "utf8")
  } else {
    savedSettingsExisted = false
  }
}

async function restoreSettings(): Promise<void> {
  if (savedSettingsExisted && savedSettings !== null) {
    await writeFile(SETTINGS_FILE, savedSettings, "utf8")
  } else if (existsSync(SETTINGS_FILE)) {
    await rm(SETTINGS_FILE, { force: true })
  }
}

async function importAutoCommit(): Promise<
  typeof import("../src/main/services/agent-auto-commit.ts")
> {
  return await import("../src/main/services/agent-auto-commit.ts")
}

async function testDisabledMode(): Promise<void> {
  await setSettings({ mode: "off", push: false, messageStrategy: "diff" })
  const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
  const snap = await startAgentGitSnapshot("t-c1", undefined)
  const result = await maybeAutoCommitAfterAgentRun({
    threadId: "t-c1",
    workspacePath: undefined,
    snapshot: snap
  })
  assert(result.status === "disabled", `expected disabled, got ${result.status}`)
}

async function testNonGitWorkspaceSkipped(): Promise<void> {
  await withTempDir("ac-nongit", async (workspace) => {
    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c2", workspace)
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c2",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("不是 Git 仓库")) ?? false,
      `expected non-git reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testCleanWorkspaceNoChanges(): Promise<void> {
  await withTempDir("ac-clean", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c3", workspace)
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c3",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("未发现本轮 Agent 产生的可提交改动")) ?? false,
      `expected no-changes reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testAgentNewFileGetsCommitted(): Promise<void> {
  await withTempDir("ac-newfile", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()

    const snap = await startAgentGitSnapshot("t-c4", workspace)
    await writeFile(join(workspace, "feature.ts"), "export const x = 1\n")
    recordAgentTouchedFile("t-c4", workspace, "feature.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c4",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      result.committedFiles?.includes("feature.ts") ?? false,
      `expected feature.ts in commit, got ${JSON.stringify(result.committedFiles)}`
    )
    assert(
      result.commitMessage === `${CARD_NUMBER} #comment fix:update feature.ts #CMBDevClaw`,
      `expected business commit message, got ${result.commitMessage}`
    )
  })
}

async function testPreExistingDirtyPreserved(): Promise<void> {
  await withTempDir("ac-preexisting", async (workspace) => {
    await initRepo(workspace)
    await writeFile(join(workspace, "user-edit.ts"), "user wrote this\n")

    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c5", workspace)

    await writeFile(join(workspace, "agent.ts"), "agent wrote this\n")
    recordAgentTouchedFile("t-c5", workspace, "agent.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c5",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(result.committedFiles?.includes("agent.ts") ?? false, "agent.ts should be committed")
    assert(
      !(result.committedFiles?.includes("user-edit.ts") ?? false),
      `user-edit.ts must not be committed, got ${JSON.stringify(result.committedFiles)}`
    )
    const status = await git(workspace, ["status", "--porcelain"])
    assert(status.includes("user-edit.ts"), "user-edit.ts should remain dirty")
  })
}

async function testPreExistingDirtyTouchedAndModifiedIncluded(): Promise<void> {
  await withTempDir("ac-preexisting-mod", async (workspace) => {
    await initRepo(workspace)
    await writeFile(join(workspace, "shared.ts"), "user content\n")

    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c6", workspace)

    await writeFile(join(workspace, "shared.ts"), "agent changed this\n")
    recordAgentTouchedFile("t-c6", workspace, "shared.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c6",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(result.committedFiles?.includes("shared.ts") ?? false, "shared.ts should be committed")
    assert(
      result.warnings?.some((w) => w.includes("开始前已有未提交改动")) ?? false,
      `expected overlap warning, got ${JSON.stringify(result.warnings)}`
    )
  })
}

async function testPreExistingTouchedButUnchangedSkipped(): Promise<void> {
  await withTempDir("ac-touch-no-mod", async (workspace) => {
    await initRepo(workspace)
    await writeFile(join(workspace, "shared.ts"), "user content\n")

    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c7", workspace)

    recordAgentTouchedFile("t-c7", workspace, "shared.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c7",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      !(result.committedFiles?.includes("shared.ts") ?? false),
      "shared.ts should not be committed when fingerprint is unchanged"
    )
    const status = await git(workspace, ["status", "--porcelain"])
    assert(status.includes("shared.ts"), "shared.ts should remain dirty")
  })
}

async function testHeadDriftAborts(): Promise<void> {
  await withTempDir("ac-head-drift", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c8", workspace)

    await writeFile(join(workspace, "agent.ts"), "agent content\n")
    recordAgentTouchedFile("t-c8", workspace, "agent.ts")

    await writeFile(join(workspace, "user.ts"), "user content\n")
    await git(workspace, ["add", "user.ts"])
    await git(workspace, ["commit", "-q", "-m", "user manual commit"])

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c8",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("HEAD 发生变化")) ?? false,
      `expected HEAD drift reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testUnmergedConflictSkipped(): Promise<void> {
  await withTempDir("ac-unmerged", async (workspace) => {
    await initRepo(workspace)
    await writeFile(join(workspace, "conflict.txt"), "base\n")
    await git(workspace, ["add", "conflict.txt"])
    await git(workspace, ["commit", "-q", "-m", "base conflict"])
    await git(workspace, ["checkout", "-q", "-b", "feature"])
    await writeFile(join(workspace, "conflict.txt"), "feature\n")
    await git(workspace, ["commit", "-am", "feature change"])
    await git(workspace, ["checkout", "-q", "main"])
    await writeFile(join(workspace, "conflict.txt"), "main\n")
    await git(workspace, ["commit", "-am", "main change"])
    try {
      await git(workspace, ["merge", "feature"])
    } catch {
      // Expected conflict.
    }

    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c9", workspace)
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c9",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("冲突文件")) ?? false,
      `expected conflict reason, got ${JSON.stringify(result.reasons)}`
    )
    assert(
      result.skippedFiles?.includes("conflict.txt") ?? false,
      `expected conflict.txt skipped, got ${JSON.stringify(result.skippedFiles)}`
    )
  })
}

async function testForeignStagedAborts(): Promise<void> {
  await withTempDir("ac-foreign-stage", async (workspace) => {
    await initRepo(workspace)
    await writeFile(join(workspace, "user-a.ts"), "user a\n")
    await writeFile(join(workspace, "user-b.ts"), "user b\n")

    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c10", workspace)

    await writeFile(join(workspace, "agent.ts"), "agent\n")
    recordAgentTouchedFile("t-c10", workspace, "agent.ts")
    await git(workspace, ["add", "user-a.ts"])

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c10",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("非本轮 Agent 改动已暂存")) ?? false,
      `expected foreign-staged reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testMissingCardNumberSkipped(): Promise<void> {
  await withTempDir("ac-no-card", async (workspace) => {
    await initRepo(workspace)
    await setSettings({ mode: "always", push: false, messageStrategy: "diff" })
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c11", workspace)
    await writeFile(join(workspace, "x.ts"), "x\n")
    recordAgentTouchedFile("t-c11", workspace, "x.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c11",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("缺少卡片编号")) ?? false,
      `expected missing-card reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testPromptStrategyBusinessFormat(): Promise<void> {
  await withTempDir("ac-prompt", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("prompt"))
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c12", workspace)
    await writeFile(join(workspace, "prompt.ts"), "x\n")
    recordAgentTouchedFile("t-c12", workspace, "prompt.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c12",
      workspacePath: workspace,
      userPrompt: "修复登录校验",
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      result.commitMessage === `${CARD_NUMBER} #comment fix:修复登录校验 #CMBDevClaw`,
      `expected prompt-based business message, got ${result.commitMessage}`
    )
  })
}

async function testTemplateMessageStrategy(): Promise<void> {
  await withTempDir("ac-template", async (workspace) => {
    await initRepo(workspace)
    await setSettings(
      enabledSettings("template", {
        template: "[{threadShort}] {fileCount} files: {summary}"
      })
    )
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("abcdef0123456789", workspace)
    await writeFile(join(workspace, "x.ts"), "x\n")
    recordAgentTouchedFile("abcdef0123456789", workspace, "x.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "abcdef0123456789",
      workspacePath: workspace,
      userPrompt: "fix typo",
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      result.commitMessage ===
        `${CARD_NUMBER} #comment fix:[abcdef01] 1 files: fix typo #CMBDevClaw`,
      `expected templated business message, got ${result.commitMessage}`
    )
  })
}

async function testDiffStrategySingleFile(): Promise<void> {
  await withTempDir("ac-diff-1", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c14", workspace)
    await writeFile(join(workspace, "alone.ts"), "x\n")
    recordAgentTouchedFile("t-c14", workspace, "alone.ts")
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c14",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      result.commitMessage === `${CARD_NUMBER} #comment fix:update alone.ts #CMBDevClaw`,
      `expected single-file diff msg, got ${result.commitMessage}`
    )
  })
}

async function testDiffStrategyMultiFile(): Promise<void> {
  await withTempDir("ac-diff-N", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c15", workspace)

    await mkdir(join(workspace, "src"), { recursive: true })
    await writeFile(join(workspace, "src", "a.ts"), "a\n")
    await writeFile(join(workspace, "src", "b.ts"), "b\n")
    recordAgentTouchedFile("t-c15", workspace, "src/a.ts")
    recordAgentTouchedFile("t-c15", workspace, "src/b.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c15",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      new RegExp(`^${CARD_NUMBER} #comment fix:update 2 files in src #CMBDevClaw$`).test(
        result.commitMessage ?? ""
      ),
      `expected multi-file diff msg, got ${result.commitMessage}`
    )
  })
}

async function testAskModeUserCancels(): Promise<void> {
  await withTempDir("ac-ask-cancel", async (workspace) => {
    await initRepo(workspace)
    await setSettings({ ...enabledSettings("diff"), mode: "ask" })
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c16", workspace)
    await writeFile(join(workspace, "f.ts"), "x\n")
    recordAgentTouchedFile("t-c16", workspace, "f.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c16",
      workspacePath: workspace,
      snapshot: snap,
      confirm: async () => false
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("用户取消")) ?? false,
      `expected user-cancel reason, got ${JSON.stringify(result.reasons)}`
    )
    const status = await git(workspace, ["status", "--porcelain"])
    assert(status.includes("f.ts"), "f.ts should remain dirty after cancel")
  })
}

async function testAskModeUserConfirms(): Promise<void> {
  await withTempDir("ac-ask-ok", async (workspace) => {
    await initRepo(workspace)
    await setSettings({ ...enabledSettings("diff"), mode: "ask" })
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c17", workspace)
    await writeFile(join(workspace, "g.ts"), "x\n")
    recordAgentTouchedFile("t-c17", workspace, "g.ts")

    let previewSeen = false
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c17",
      workspacePath: workspace,
      snapshot: snap,
      confirm: async (preview) => {
        previewSeen = true
        assert(preview.committedFiles?.includes("g.ts") ?? false, "preview should include g.ts")
        assert(
          preview.commitMessage === `${CARD_NUMBER} #comment fix:update g.ts #CMBDevClaw`,
          `preview should use business format, got ${preview.commitMessage}`
        )
        return true
      }
    })
    assert(previewSeen, "confirm should have been called")
    assert(result.status === "committed", `expected committed, got ${result.status}`)
  })
}

async function testLlmModifiedMetadataClearedAfterCommit(): Promise<void> {
  await withTempDir("ac-metadata", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    const threadId = `auto-commit-metadata-${Date.now()}`
    const db = await import("../src/main/db/index.ts")
    await db.initializeDatabase()
    db.createThread(threadId, {
      llmModifiedFiles: [join(workspace, "panel.ts")],
      llmFileHistory: { "panel.ts": ["dirty"] },
      llmRecentlyRevertedFiles: ["panel.ts"]
    })

    try {
      const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
      const snap = await startAgentGitSnapshot(threadId, workspace)
      await writeFile(join(workspace, "panel.ts"), "tracked by git panel\n")

      const result = await maybeAutoCommitAfterAgentRun({
        threadId,
        workspacePath: workspace,
        snapshot: snap
      })
      assert(result.status === "committed", `expected committed, got ${result.status}`)
      assert(result.committedFiles?.includes("panel.ts") ?? false, "panel.ts should be committed")

      const thread = db.getThread(threadId)
      const metadata = JSON.parse(thread?.metadata || "{}") as Record<string, unknown>
      assert(
        Array.isArray(metadata.llmModifiedFiles) && metadata.llmModifiedFiles.length === 0,
        `llmModifiedFiles should be cleared, got ${JSON.stringify(metadata.llmModifiedFiles)}`
      )
      assert(
        metadata.llmFileHistory && Object.keys(metadata.llmFileHistory).length === 0,
        `llmFileHistory should be cleared, got ${JSON.stringify(metadata.llmFileHistory)}`
      )
      assert(
        Array.isArray(metadata.llmRecentlyRevertedFiles) &&
          metadata.llmRecentlyRevertedFiles.length === 0,
        `llmRecentlyRevertedFiles should be cleared, got ${JSON.stringify(metadata.llmRecentlyRevertedFiles)}`
      )
    } finally {
      db.deleteThread(threadId)
      await db.flush()
    }
  })
}

async function testExternalNewFileNotCommitted(): Promise<void> {
  await withTempDir("ac-external-new", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c19", workspace)

    await writeFile(join(workspace, "external.ts"), "external user file\n")
    await writeFile(join(workspace, "agent.ts"), "agent file\n")
    recordAgentTouchedFile("t-c19", workspace, "agent.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c19",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(result.committedFiles?.includes("agent.ts") ?? false, "agent.ts should be committed")
    assert(
      !(result.committedFiles?.includes("external.ts") ?? false),
      `external.ts must not be committed, got ${JSON.stringify(result.committedFiles)}`
    )
    assert(
      result.skippedFiles?.includes("external.ts") ?? false,
      `external.ts should be listed as skipped, got ${JSON.stringify(result.skippedFiles)}`
    )
    const status = await git(workspace, ["status", "--porcelain"])
    assert(status.includes("external.ts"), "external.ts should remain dirty")
  })
}

async function run(): Promise<void> {
  await backupSettings()
  try {
    await testDisabledMode()
    console.log("PASS C1 mode:off -> disabled")
    await testNonGitWorkspaceSkipped()
    console.log("PASS C2 non-git workspace skipped")
    await testCleanWorkspaceNoChanges()
    console.log("PASS C3 clean workspace skipped")
    await testAgentNewFileGetsCommitted()
    console.log("PASS C4 agent new file committed")
    await testPreExistingDirtyPreserved()
    console.log("PASS C5 pre-existing dirty preserved")
    await testPreExistingDirtyTouchedAndModifiedIncluded()
    console.log("PASS C6 pre-existing dirty touched+modified included")
    await testPreExistingTouchedButUnchangedSkipped()
    console.log("PASS C7 touched but unchanged skipped")
    await testHeadDriftAborts()
    console.log("PASS C8 HEAD drift aborts")
    await testUnmergedConflictSkipped()
    console.log("PASS C9 unmerged conflict skipped")
    await testForeignStagedAborts()
    console.log("PASS C10 foreign staged aborts")
    await testMissingCardNumberSkipped()
    console.log("PASS C11 missing card number skipped")
    await testPromptStrategyBusinessFormat()
    console.log("PASS C12 prompt summary uses business format")
    await testTemplateMessageStrategy()
    console.log("PASS C13 template summary uses business format")
    await testDiffStrategySingleFile()
    console.log("PASS C14 diff summary single file")
    await testDiffStrategyMultiFile()
    console.log("PASS C15 diff summary multi file")
    await testAskModeUserCancels()
    console.log("PASS C16 ask mode cancel")
    await testAskModeUserConfirms()
    console.log("PASS C17 ask mode confirm")
    await testLlmModifiedMetadataClearedAfterCommit()
    console.log("PASS C18 llmModifiedFiles metadata cleared")
    await testExternalNewFileNotCommitted()
    console.log("PASS C19 external new file not committed")
  } finally {
    await restoreSettings()
  }
}

run().catch((err: Error) => {
  console.error(`FAIL ${err.message}`)
  console.error(err.stack)
  restoreSettings()
    .catch(() => {
      /* swallow */
    })
    .finally(() => process.exit(1))
})
