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
import { normalizeWorkspacePathKey } from "../src/shared/workspace-path.ts"

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
const WORKSPACE_CARDS_FILE = join(
  homedir(),
  ".cmbcoworkagent",
  "agent-auto-commit-workspace-cards.json"
)
let savedSettings: string | null = null
let savedSettingsExisted = false
let savedWorkspaceCards: string | null = null
let savedWorkspaceCardsExisted = false

function enabledSettings(
  messageStrategy: "prompt" | "diff" | "template" = "diff",
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    mode: "always",
    push: false,
    messageStrategy,
    ...extra
  }
}

async function setSettings(settings: Record<string, unknown>): Promise<void> {
  await mkdir(join(homedir(), ".cmbcoworkagent"), { recursive: true })
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8")
}

function workspaceCardKey(workspacePath: string): string {
  return normalizeWorkspacePathKey(workspacePath)
}

async function setWorkspaceCard(
  workspacePath: string,
  cardNumber: string = CARD_NUMBER
): Promise<void> {
  await mkdir(join(homedir(), ".cmbcoworkagent"), { recursive: true })
  const key = workspaceCardKey(workspacePath)
  await writeFile(
    WORKSPACE_CARDS_FILE,
    JSON.stringify(
      {
        [key]: {
          workspacePath,
          cardNumber,
          updatedAt: "2026-06-04T00:00:00.000Z"
        }
      },
      null,
      2
    ),
    "utf8"
  )
}

async function backupSettings(): Promise<void> {
  if (existsSync(SETTINGS_FILE)) {
    savedSettingsExisted = true
    savedSettings = await readFile(SETTINGS_FILE, "utf8")
  } else {
    savedSettingsExisted = false
  }
  if (existsSync(WORKSPACE_CARDS_FILE)) {
    savedWorkspaceCardsExisted = true
    savedWorkspaceCards = await readFile(WORKSPACE_CARDS_FILE, "utf8")
  } else {
    savedWorkspaceCardsExisted = false
  }
}

async function restoreSettings(): Promise<void> {
  if (savedSettingsExisted && savedSettings !== null) {
    await writeFile(SETTINGS_FILE, savedSettings, "utf8")
  } else if (existsSync(SETTINGS_FILE)) {
    await rm(SETTINGS_FILE, { force: true })
  }
  if (savedWorkspaceCardsExisted && savedWorkspaceCards !== null) {
    await writeFile(WORKSPACE_CARDS_FILE, savedWorkspaceCards, "utf8")
  } else if (existsSync(WORKSPACE_CARDS_FILE)) {
    await rm(WORKSPACE_CARDS_FILE, { force: true })
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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

async function testForeignStagedNewFileAborts(): Promise<void> {
  // Regression guard: under the broadened candidate selection, a user-created file
  // that gets `git add`-ed during the run is in `candidate` (it's a new dirty file)
  // — so a gate keyed on `stagedEnd \ candidate` would let it through. The actual
  // gate keys on `stagedEnd \ agentReported`, which must abort here because the
  // agent never reported user-new.ts via recordAgentTouchedFile.
  await withTempDir("ac-foreign-stage-new", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings())
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c10b", workspace)

    await writeFile(join(workspace, "agent.ts"), "agent\n")
    recordAgentTouchedFile("t-c10b", workspace, "agent.ts")

    await writeFile(join(workspace, "user-new.ts"), "user new file\n")
    await git(workspace, ["add", "user-new.ts"])

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c10b",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped, got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("非本轮 Agent 改动已暂存")) ?? false,
      `expected foreign-staged reason, got ${JSON.stringify(result.reasons)}`
    )
    assert(
      result.skippedFiles?.includes("user-new.ts") ?? false,
      `expected user-new.ts in skippedFiles, got ${JSON.stringify(result.skippedFiles)}`
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
      result.reasons?.some((r) => r.includes("未选择任务卡片")) ?? false,
      `expected missing-card reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testLegacyGlobalCardMigratesToWorkspace(): Promise<void> {
  await withTempDir("ac-legacy-card", async (workspace) => {
    await initRepo(workspace)
    await setSettings({
      mode: "always",
      push: false,
      messageStrategy: "diff",
      cardNumber: CARD_NUMBER
    })
    if (existsSync(WORKSPACE_CARDS_FILE)) {
      await rm(WORKSPACE_CARDS_FILE, { force: true })
    }

    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c11-legacy", workspace)
    await writeFile(join(workspace, "legacy.ts"), "legacy\n")
    recordAgentTouchedFile("t-c11-legacy", workspace, "legacy.ts")

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c11-legacy",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(
      result.commitMessage === `${CARD_NUMBER} #comment fix:update legacy.ts #CMBDevClaw`,
      `expected legacy card in commit message, got ${result.commitMessage}`
    )

    const migrated = JSON.parse(await readFile(WORKSPACE_CARDS_FILE, "utf8")) as Record<
      string,
      { cardNumber?: string }
    >
    assert(
      migrated[workspaceCardKey(workspace)]?.cardNumber === CARD_NUMBER,
      `expected workspace card migration, got ${JSON.stringify(migrated)}`
    )
  })
}

async function testClearedWorkspaceCardBlocksLegacy(): Promise<void> {
  await withTempDir("ac-clear-legacy", async (workspace) => {
    await initRepo(workspace)
    await setSettings({
      mode: "always",
      push: false,
      messageStrategy: "diff",
      cardNumber: CARD_NUMBER
    })
    if (existsSync(WORKSPACE_CARDS_FILE)) {
      await rm(WORKSPACE_CARDS_FILE, { force: true })
    }

    const storage = await import("../src/main/storage.ts")
    // User picks a card for this workspace, then clears it.
    storage.saveAgentAutoCommitWorkspaceCard(workspace, "M999-1")
    storage.saveAgentAutoCommitWorkspaceCard(workspace, undefined)

    // A deliberately cleared workspace must NOT fall back to the legacy global card.
    const card = storage.getAgentAutoCommitWorkspaceCard(workspace)
    assert(!card.cardNumber, `cleared workspace should report no card, got ${card.cardNumber}`)

    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c11c", workspace)
    await writeFile(join(workspace, "cleared.ts"), "x\n")
    recordAgentTouchedFile("t-c11c", workspace, "cleared.ts")
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c11c",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "skipped", `expected skipped (no card), got ${result.status}`)
    assert(
      result.reasons?.some((r) => r.includes("未选择任务卡片")) ?? false,
      `expected missing-card reason, got ${JSON.stringify(result.reasons)}`
    )
  })
}

async function testPromptStrategyBusinessFormat(): Promise<void> {
  await withTempDir("ac-prompt", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("prompt"))
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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
    await setWorkspaceCard(workspace)
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

async function testNewDirtyFilesAllCommitted(): Promise<void> {
  // Under the broadened detection policy, all dirty files that appeared during the
  // run are candidates regardless of whether the agent reported them via tool
  // callbacks. This fixes the prior bug where shell-tool side effects (npm install
  // lockfile updates, prettier --write, code generators, git mv) were silently
  // dropped. Unstaged manual edits during the run are folded in as well — that is
  // an accepted trade-off. Manual `git add` during the run is NOT folded in: the
  // foreign-staged gate keys off agentReported, so any staging the agent did not
  // perform aborts the commit (see testForeignStagedNewFileAborts).
  await withTempDir("ac-new-all", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings("diff"))
    await setWorkspaceCard(workspace)
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c19", workspace)

    // unreported.ts simulates a file created by a shell command (npm install, etc.)
    // — never passed through recordAgentTouchedFile.
    await writeFile(join(workspace, "unreported.ts"), "shell-tool produced this\n")
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
      result.committedFiles?.includes("unreported.ts") ?? false,
      `unreported.ts should now be committed, got ${JSON.stringify(result.committedFiles)}`
    )
    assert(
      result.warnings?.some((w) => w.includes("未被 Agent 工具主动报告")) ?? false,
      `expected unreported-files warning, got ${JSON.stringify(result.warnings)}`
    )
  })
}

async function testSubdirectoryWorkspacePathspecs(): Promise<void> {
  await withTempDir("ac-subdir-workspace", async (repo) => {
    await initRepo(repo)
    await setSettings(enabledSettings("diff"))
    const workspace = join(repo, "OSA_MicroService", "OSA_GateWay")
    const fileRel = join("src", "main", "java", "com", "example", "ue", "filter", "AuthHeaderFilter.java")
    const modifiedRel = join("src", "main", "java", "com", "example", "ue", "filter", "TrackedFilter.java")
    const renameOldRel = join("src", "main", "java", "com", "example", "ue", "filter", "OldFilter.java")
    const renameNewRel = join("src", "main", "java", "com", "example", "ue", "filter", "RenamedFilter.java")
    await mkdir(join(workspace, "src", "main", "java", "com", "example", "ue", "filter"), {
      recursive: true
    })
    await writeFile(join(workspace, modifiedRel), "public class TrackedFilter {}\n")
    await writeFile(join(workspace, renameOldRel), "public class OldFilter {}\n")
    await git(repo, ["add", "."])
    await git(repo, ["commit", "-q", "-m", "add gateway tracked files"])
    await setWorkspaceCard(workspace)

    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c19-subdir", workspace)
    await writeFile(join(workspace, fileRel), "public class AuthHeaderFilter {}\n")
    await writeFile(join(workspace, modifiedRel), "public class TrackedFilter { int changed; }\n")
    await git(workspace, ["mv", renameOldRel, renameNewRel])
    // `git mv` leaves a staged rename; mark the new path as Agent-touched.
    recordAgentTouchedFile("t-c19-subdir", workspace, renameNewRel)

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c19-subdir",
      workspacePath: workspace,
      snapshot: snap
    })

    assert(result.status === "committed", `expected committed, got ${result.status}: ${JSON.stringify(result.reasons)}`)
    const expectedNew = fileRel.replace(/\\/g, "/")
    const expectedModified = modifiedRel.replace(/\\/g, "/")
    const expectedRenamed = renameNewRel.replace(/\\/g, "/")
    for (const expected of [expectedNew, expectedModified, expectedRenamed]) {
      assert(
        result.committedFiles?.includes(expected) ?? false,
        `expected workspace-relative committed file ${expected}, got ${JSON.stringify(result.committedFiles)}`
      )
    }
    const committed = await git(repo, ["show", "--name-only", "--format=", "HEAD"])
    for (const expected of [
      "OSA_MicroService/OSA_GateWay/src/main/java/com/example/ue/filter/AuthHeaderFilter.java",
      "OSA_MicroService/OSA_GateWay/src/main/java/com/example/ue/filter/TrackedFilter.java",
      "OSA_MicroService/OSA_GateWay/src/main/java/com/example/ue/filter/RenamedFilter.java"
    ]) {
      assert(
        committed.includes(expected),
        `expected repo-root path ${expected} in commit, got ${committed}`
      )
    }
  })
}

async function testPushSuccessAgainstBareRemote(): Promise<void> {
  await withTempDir("ac-push-ok", async (workspace) => {
    const bare = await mkdtemp(join(tmpdir(), "ac-push-ok-bare-"))
    try {
      await git(bare, ["init", "--bare", "-q"])
      await initRepo(workspace)
      await git(workspace, ["remote", "add", "origin", bare])
      await git(workspace, ["push", "-q", "-u", "origin", "main"])

      await setSettings(enabledSettings("diff", { push: true }))
      await setWorkspaceCard(workspace)
      const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
        await importAutoCommit()
      const snap = await startAgentGitSnapshot("t-c20", workspace)
      await writeFile(join(workspace, "feat.ts"), "feat\n")
      recordAgentTouchedFile("t-c20", workspace, "feat.ts")

      const result = await maybeAutoCommitAfterAgentRun({
        threadId: "t-c20",
        workspacePath: workspace,
        snapshot: snap
      })
      assert(result.status === "committed", `expected committed, got ${result.status}`)
      assert(result.pushed === true, `expected pushed=true, got ${result.pushed}`)
      assert(!result.pushError, `expected no pushError, got ${result.pushError}`)

      const remoteLog = await git(bare, ["log", "--all", "--oneline"])
      assert(
        remoteLog.includes(CARD_NUMBER),
        `expected commit message in bare remote, got ${remoteLog}`
      )
    } finally {
      await removeTempDir(bare)
    }
  })
}

async function testPushFailureReportedButCommitKept(): Promise<void> {
  await withTempDir("ac-push-fail", async (workspace) => {
    // No remote configured — `git push` should fail. The commit must remain locally.
    await initRepo(workspace)
    await setSettings(enabledSettings("diff", { push: true }))
    await setWorkspaceCard(workspace)
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-c21", workspace)
    await writeFile(join(workspace, "feat.ts"), "feat\n")
    recordAgentTouchedFile("t-c21", workspace, "feat.ts")

    const headBefore = (await git(workspace, ["rev-parse", "HEAD"])).trim()
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-c21",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(result.pushed === false, `expected pushed=false, got ${result.pushed}`)
    assert(typeof result.pushError === "string", `expected pushError, got ${result.pushError}`)
    const headAfter = (await git(workspace, ["rev-parse", "HEAD"])).trim()
    assert(headAfter !== headBefore, "HEAD must advance — commit must not be rolled back on push failure")
  })
}

// C22 — #3a regression: removing launch-baseline auto-commit means a workflow's
// completion notification turn takes a FRESH snapshot and reports the result
// without editing files. A workflow subagent's edits AND the user's concurrent
// foreground edits are all dirty BEFORE that snapshot, so they are pre-existing
// and untouched this turn → never auto-committed. The user's work is never swept
// into a workflow commit, and the run's edits are left in the tree for review.
async function testWorkflowNotificationLeavesConcurrentEditsUncommitted(): Promise<void> {
  await withTempDir("ac-wf-notify", async (workspace) => {
    await initRepo(workspace)
    // Both produced while the background run was in flight (a workflow subagent
    // edit and a user foreground edit), already dirty when the notification
    // turn's fresh snapshot is taken.
    await writeFile(join(workspace, "workflow-edit.ts"), "workflow subagent wrote this\n")
    await writeFile(join(workspace, "user-edit.ts"), "user wrote this concurrently\n")

    await setSettings(enabledSettings())
    await setWorkspaceCard(workspace)
    const { startAgentGitSnapshot, maybeAutoCommitAfterAgentRun } = await importAutoCommit()
    // Fresh snapshot (post-#3a: no launch baseline is reused for workflow turns).
    const snap = await startAgentGitSnapshot("t-wf-notify", workspace)

    // The notification turn only reports the outcome; it edits no files.
    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-wf-notify",
      workspacePath: workspace,
      snapshot: snap
    })

    assert(
      result.status === "skipped",
      `notification turn must not commit pre-existing dirty, got ${result.status}`
    )
    const status = await git(workspace, ["status", "--porcelain"])
    assert(status.includes("workflow-edit.ts"), "workflow edit should remain dirty for review")
    assert(status.includes("user-edit.ts"), "user edit must never be swept into a workflow commit")
  })
}

// C23 — #3: CmbCoworkAgent's own internal dir (.cmbdevclaw/, e.g. workflow run
// state) lives inside the user's workspace. If the user hasn't gitignored it, its
// files show up dirty — auto-commit must NEVER sweep them into the user's repo.
async function testInternalCmbdevclawDirNotCommitted(): Promise<void> {
  await withTempDir("ac-internal-dir", async (workspace) => {
    await initRepo(workspace)
    await setSettings(enabledSettings())
    await setWorkspaceCard(workspace)
    const { startAgentGitSnapshot, recordAgentTouchedFile, maybeAutoCommitAfterAgentRun } =
      await importAutoCommit()
    const snap = await startAgentGitSnapshot("t-internal", workspace)

    // A real agent edit + CmbCoworkAgent's own internal workflow state.
    await writeFile(join(workspace, "agent.ts"), "agent wrote this\n")
    recordAgentTouchedFile("t-internal", workspace, "agent.ts")
    await mkdir(join(workspace, ".cmbdevclaw", "workflows", "thread-x"), { recursive: true })
    await writeFile(join(workspace, ".cmbdevclaw", "workflows", "thread-x", "wf_abc.json"), "{}\n")
    await writeFile(
      join(workspace, ".cmbdevclaw", "workflows", "thread-x", "wf_abc.workflow.js"),
      "// script\n"
    )

    const result = await maybeAutoCommitAfterAgentRun({
      threadId: "t-internal",
      workspacePath: workspace,
      snapshot: snap
    })
    assert(result.status === "committed", `expected committed, got ${result.status}`)
    assert(result.committedFiles?.includes("agent.ts") ?? false, "agent.ts should be committed")
    assert(
      !(result.committedFiles?.some((f) => f.includes(".cmbdevclaw")) ?? false),
      `.cmbdevclaw must never be auto-committed, got ${JSON.stringify(result.committedFiles)}`
    )
    // The internal files stay untracked, not swept into the user's repo.
    const tracked = await git(workspace, ["ls-files", ".cmbdevclaw"])
    assert(tracked.trim() === "", `.cmbdevclaw must not be tracked, got: ${tracked}`)
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
    await testForeignStagedNewFileAborts()
    console.log("PASS C10b foreign staged new file aborts")
    await testMissingCardNumberSkipped()
    console.log("PASS C11 missing card number skipped")
    await testLegacyGlobalCardMigratesToWorkspace()
    console.log("PASS C11b legacy global card migrates to workspace")
    await testClearedWorkspaceCardBlocksLegacy()
    console.log("PASS C11c cleared workspace card does not fall back to legacy")
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
    await testNewDirtyFilesAllCommitted()
    console.log("PASS C19 all new dirty files included (incl. unreported)")
    await testSubdirectoryWorkspacePathspecs()
    console.log("PASS C19b subdirectory workspace pathspecs")
    await testPushSuccessAgainstBareRemote()
    console.log("PASS C20 push: true with bare remote -> pushed=true")
    await testPushFailureReportedButCommitKept()
    console.log("PASS C21 push fails -> commit kept, pushError reported")
    await testWorkflowNotificationLeavesConcurrentEditsUncommitted()
    console.log("PASS C22 workflow notification leaves concurrent edits uncommitted (#3a)")
    await testInternalCmbdevclawDirNotCommitted()
    console.log("PASS C23 .cmbdevclaw internal dir never auto-committed (#3)")
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
