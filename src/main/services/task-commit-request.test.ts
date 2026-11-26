import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"
import { tmpdir } from "node:os"
import path from "node:path"
import { expect, it, vi } from "vitest"
import { getDb, initializeDatabase, closeDatabase, createThread } from "../db"
import { taskCommitCall, withTaskCommitCall } from "../agent/task-commit-call"
import { ApprovalStore } from "../agent/approval-store"
import { LocalSandbox } from "../agent/local-sandbox"
import { prepareLiteralTaskShellWrite } from "../agent/task-commit-shell-write"
import { ToolOrchestrator } from "../agent/tool-orchestrator"
import {
  authorizeTaskCommitBinding,
  beginTaskCommitBindingEdit,
  readTaskCommitBinding
} from "./task-commit-binding"
import { recordTaskCommitEdit } from "./task-commit-edits"
import { tryTaskBoundCommit } from "./task-commit-request"
import { forgetTaskCommitIndex, rememberTaskCommitIndex } from "./task-commit-recovery"
import { withoutGitRepositoryOverrides } from "./git-environment"

const fixture = vi.hoisted(() => ({ db: "", record: vi.fn() }))
vi.mock("../storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../storage")>()),
  getDbPath: () => fixture.db,
  getMemorySessionOptInMigrationState: () => ({ migrated: true }),
  markMemorySessionOptInMigrated: vi.fn()
}))
vi.mock("../ipc/models", () => ({ recordPublishedTaskCommit: fixture.record }))

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: withoutGitRepositoryOverrides(process.env, "workspace")
  }).trimEnd()
}

function initializeGitRepository(cwd: string): void {
  git(cwd, "init", "-q", "-b", "main")
  git(cwd, "config", "user.name", "Test")
  git(cwd, "config", "user.email", "fixture@example.test")
  git(cwd, "config", "core.autocrlf", "false")
  git(cwd, "config", "commit.gpgsign", "false")
  git(cwd, "config", "core.hooksPath", ".git/hooks")
}

it("commits only the bound external checkout and replays the same tool-call receipt", async () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "task-commit-flow-")))
  const workspace = path.join(parent, "session")
  const repo = path.join(parent, "billing")
  const other = path.join(parent, "other")
  for (const dir of [workspace, repo, other]) mkdirSync(dir)
  fixture.db = path.join(parent, "thread.sqlite")
  try {
    for (const cwd of [repo, other]) {
      initializeGitRepository(cwd)
      writeFileSync(path.join(cwd, "file.txt"), "before\n")
      git(cwd, "add", "file.txt")
      git(cwd, "commit", "-qm", "initial")
    }
    await initializeDatabase()
    const threadId = "fixture-task"
    createThread(threadId, { workspacePath: workspace })
    const { identity } = beginTaskCommitBindingEdit(threadId)
    await authorizeTaskCommitBinding(identity, "CARD-1", [repo], false)
    const binding = (await readTaskCommitBinding(threadId))!
    expect(binding).not.toBeNull()
    writeFileSync(path.join(other, "file.txt"), "unrelated\n")
    writeFileSync(path.join(repo, "file.txt"), "after\n")
    const request = { threadId, binding, target: repo, files: ["file.txt"], suggestion: "update" }
    const invoke = (callId: string) =>
      taskCommitCall.run({ threadId, callId }, () => tryTaskBoundCommit(request))
    expect((await invoke("unobserved")).status).toBe("review")
    recordTaskCommitEdit(
      threadId,
      binding.version,
      path.join(repo, "file.txt"),
      "before\n",
      "after\n"
    )
    const [first, concurrent] = await Promise.all([invoke("one"), invoke("one")])
    expect(first).toEqual(concurrent)
    expect(first).toMatchObject({ status: "committed" })
    expect(await invoke("one")).toEqual(first)
    expect(git(repo, "log", "-1", "--format=%s")).toBe("CARD-1 #comment fix:update #CMBDevClaw")
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("2")
    expect(git(other, "rev-list", "--count", "HEAD")).toBe("1")
    expect(git(other, "diff", "--name-only")).toBe("file.txt")
    expect(fixture.record).toHaveBeenCalledTimes(1)
    expect(getDb().exec("SELECT recorded FROM task_commit_receipts")[0].values).toEqual([[1]])
    const sandbox = new LocalSandbox({
      rootDir: workspace,
      windowsSandbox: "none",
      runId: threadId,
      taskCommitRepositoryPaths: () => taskCommitCall.getStore()?.binding?.repositoryPaths,
      onTaskCommitEdit: (name, before, after) => {
        const version = taskCommitCall.getStore()?.binding?.version
        if (version) recordTaskCommitEdit(threadId, version, name, before, after)
      }
    })
    const shellFile = path.join(repo, "generated.ts").replace(/\\/g, "/")
    const edited = await withTaskCommitCall(threadId, "edit", () =>
      sandbox.execute(`echo changed > "${shellFile}"`, workspace)
    )
    expect(edited.exitCode, edited.output).toBe(0)
    const ask = vi.fn()
    const raw = vi.fn()
    const agent = new ToolOrchestrator(
      new ApprovalStore(),
      raw,
      ask,
      () => false,
      false,
      true,
      workspace,
      { threadId, canReview: () => false }
    )
    sandbox.setOrchestrator(agent)
    const refused = await sandbox.execute("echo unrelated", repo)
    expect(refused.exitCode).toBe(1)
    const result = await withTaskCommitCall(threadId, "two", () =>
      sandbox.execute('git commit -m "second" -- generated.ts', repo)
    )
    expect(result, result.output).toMatchObject({ exitCode: 0 })
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("3")
    expect(ask).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
    const note = path.join(repo, "note.ts")
    const otherNote = path.join(repo, "unrelated.ts")
    const literal = 'echo model > "note.ts"'
    const edit = await prepareLiteralTaskShellWrite(literal, repo, [repo], async () => "bash")
    expect(edit).toBeTruthy()
    // An editor saves a second file and replaces the named output during the same shell call.
    writeFileSync(otherNote, "user")
    writeFileSync(note, "editor overwrite")
    recordTaskCommitEdit(threadId, binding.version, edit!.file, edit!.before, edit!.after)
    for (const file of ["note.ts", "unrelated.ts"]) {
      const outcome = await withTaskCommitCall(threadId, file, () =>
        tryTaskBoundCommit({ ...request, files: [file] })
      )
      expect(outcome.status).toBe("review")
    }
    expect(
      await prepareLiteralTaskShellWrite("npm run generate", repo, [repo], async () => "bash")
    ).toBeNull()
    const old = binding.version
    await withTaskCommitCall(threadId, "in-flight-edit", async () => {
      const editor = beginTaskCommitBindingEdit(threadId)
      const next = await authorizeTaskCommitBinding(editor.identity, "CARD-2", [repo], false)
      expect(taskCommitCall.getStore()?.binding?.version).toBe(old)
      await withTaskCommitCall(threadId, "next-edit", async () => {
        expect(taskCommitCall.getStore()?.binding?.version).toBe(next.version)
      })
      expect(taskCommitCall.getStore()?.binding?.version).toBe(old)
    })
  } finally {
    await closeDatabase()
    rmSync(parent, { recursive: true, force: true })
  }
}, 60_000)

it("retains the first index receipt when a concurrent candidate has the same SHA", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "task-index-receipt-"))
  fixture.db = path.join(root, "db.sqlite")
  try {
    await initializeDatabase()
    const first = {
      parent: "parent",
      sha: "same-commit",
      tree: "tree",
      branch: "refs/heads/main",
      files: [],
      indexRecovery: {
        parent: "parent",
        previousDigest: "before",
        preparedDigest: "after",
        lockDevice: "1",
        lockInode: "10",
        pid: process.pid,
        processInstance: "one"
      }
    }
    const second = { ...first, indexRecovery: { ...first.indexRecovery, lockInode: "11" } }
    rememberTaskCommitIndex("task", root, first)
    expect(() => rememberTaskCommitIndex("task", root, second)).toThrow()
    forgetTaskCommitIndex(root, second)
    const count = () =>
      getDb().exec("SELECT COUNT(*) FROM task_commit_pending_indexes")[0].values[0][0]
    expect(count()).toBe(1)
    forgetTaskCommitIndex(root, first)
    expect(count()).toBe(0)
  } finally {
    await closeDatabase()
    rmSync(root, { recursive: true, force: true })
  }
})

// Opt in with CMB_TASK_COMMIT_PERF=1 and run this file with -t "measures task-bound commit".
it.skipIf(process.env.CMB_TASK_COMMIT_PERF !== "1")(
  "measures task-bound commit with durable authorization, edit attribution and receipts",
  async () => {
    const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "task-commit-request-perf-")))
    const workspace = path.join(parent, "session")
    const repo = path.join(parent, "external-code")
    const names = Array.from({ length: 1024 }, (_, i) => `file-${String(i).padStart(4, "0")}.ts`)
    const rounds = 3
    fixture.db = path.join(parent, "threads.sqlite")
    try {
      mkdirSync(workspace)
      mkdirSync(repo)
      initializeGitRepository(repo)
      git(repo, "config", "core.fsmonitor", "false")
      for (const name of names) writeFileSync(path.join(repo, name), `// Original ${name}\n`)
      git(repo, "add", ".")
      git(repo, "commit", "-qm", "seed")
      await initializeDatabase()
      console.log(
        JSON.stringify({
          benchmark: "task-commit-request",
          node: process.version,
          git: git(repo, "--version"),
          platform: process.platform,
          arch: process.arch,
          trackedFiles: names.length,
          rounds
        })
      )
      for (const count of [1, 32, 256]) {
        const files = names.slice(0, count)
        const samples: {
          authorizeMs: number
          editAndRecordMs: number
          commitMs: number
          totalMs: number
        }[] = []
        for (let round = 1; round <= rounds; round++) {
          const id = `case-${count}-${round}`
          const callId = `commit-${id}`
          const parentSha = git(repo, "rev-parse", "HEAD")
          createThread(id, { workspacePath: workspace })
          const start = performance.now()
          const editor = beginTaskCommitBindingEdit(id)
          const binding = await authorizeTaskCommitBinding(editor.identity, "CARD-1", [repo], false)
          const authorized = performance.now()
          for (const file of files) {
            const target = path.join(repo, file)
            const before = readFileSync(target)
            const after = `// ${id}: ${file}\n`
            writeFileSync(target, after)
            recordTaskCommitEdit(id, binding.version, target, before, after)
          }
          const recorded = performance.now()
          const outcome = await withTaskCommitCall(id, callId, async () => {
            const current = await readTaskCommitBinding(id)
            if (!current) throw new Error("Benchmark task authorization disappeared")
            return tryTaskBoundCommit({
              threadId: id,
              binding: current,
              target: repo,
              files,
              suggestion: id
            })
          })
          const finished = performance.now()
          const sha = git(repo, "rev-parse", "HEAD")
          expect(outcome.status, outcome.message).toBe("committed")
          expect(outcome.message).toContain(sha)
          expect(git(repo, "rev-parse", "HEAD^")).toBe(parentSha)
          expect(git(repo, "show", "-s", "--format=%s", sha)).toBe(
            `CARD-1 #comment fix:${id} #CMBDevClaw`
          )
          const changed = git(repo, "diff-tree", "-r", "--name-only", "-z", "--no-commit-id", sha)
          expect(changed.split("\0").filter(Boolean).sort()).toEqual(files)
          expect(git(repo, "status", "--porcelain")).toBe("")
          expect(
            getDb().exec(
              "SELECT json_extract(candidate, '$.sha'), recorded, result FROM task_commit_receipts WHERE thread_id=? AND call_id=?",
              [id, callId]
            )[0]?.values
          ).toEqual([[sha, 1, outcome.message]])
          samples.push({
            authorizeMs: Math.round(authorized - start),
            editAndRecordMs: Math.round(recorded - authorized),
            commitMs: Math.round(finished - recorded),
            totalMs: Math.round(finished - start)
          })
        }
        const median = (field: keyof (typeof samples)[number]) =>
          samples.map((sample) => sample[field]).sort((a, b) => a - b)[Math.floor(rounds / 2)]
        console.log(
          JSON.stringify({
            files: count,
            samples,
            medianMs: {
              authorize: median("authorizeMs"),
              editAndRecord: median("editAndRecordMs"),
              commit: median("commitMs"),
              total: median("totalMs")
            }
          })
        )
      }
    } finally {
      await closeDatabase()
      rmSync(parent, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 })
    }
  },
  360_000
)
