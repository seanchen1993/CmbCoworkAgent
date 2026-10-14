import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, rm, writeFile, access, rename, link } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BuiltinChangeReviewService, type ChangeReviewScope } from "./change-review"
import { CHANGE_REVIEW_LIMITS, excludedReviewPath } from "./change-review-reader"
import { withoutGitRepositoryOverrides } from "../../services/git-environment"
import type { ProjectFactObservation } from "./project-facts"

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function git(root: string, args: string[]) {
  return execute("git", args, {
    cwd: root,
    windowsHide: true,
    env: withoutGitRepositoryOverrides(process.env)
  })
}
async function fixture(commit = true) {
  const root = await mkdtemp(join(tmpdir(), "builtin-review-"))
  roots.push(root)
  await git(root, ["init"])
  await git(root, ["config", "user.email", "test@example.invalid"])
  await git(root, ["config", "user.name", "Test"])
  if (commit) {
    await writeFile(join(root, "file.txt"), "committed\n")
    await git(root, ["add", "file.txt"])
    await git(root, ["commit", "-m", "fixture"])
  }
  const scope: ChangeReviewScope = {
    threadId: "thread",
    runId: "run",
    incarnationKey: "one",
    workspace: root
  }
  return { root, scope, service: new BuiltinChangeReviewService() }
}

describe("bounded read-only change review", () => {
  it("adopts the host pre-Hook snapshot only for its same bound operation and incarnation", async () => {
    const { root, scope } = await fixture()
    const facts: ProjectFactObservation = {
      identity: "operation",
      facts: { state: "unavailable" },
      review: {
        projectId: "p",
        pluginDigest: "digest",
        stageId: "draft",
        firstProjectAttempt: true,
        firstStageAttempt: true,
        evidence: {
          projectName: "任务",
          stageTitle: "草稿",
          operationId: "operation",
          matchesProjectVersion: true,
          checks: []
        }
      }
    }
    const service = new BuiltinChangeReviewService(4, () => facts)
    const prepared = { ...scope, runId: "project-operation:operation" }
    const token = service.begin(prepared)
    expect(await service.capture(prepared, token)).toBe(true)
    await writeFile(join(root, "file.txt"), "changed by SessionStart Hook\n")
    expect(service.begin(scope)).toBe(token)
    expect(await service.capture(scope, token)).toBe(false)
    expect((await service.read(scope, "task")).files[0].patch).toContain(
      "+changed by SessionStart Hook"
    )
    expect((await service.read({ ...scope, incarnationKey: "recreated" }, "task")).status).toBe(
      "unavailable"
    )
  })

  it("retains first project and stage baselines across attempts and associates only host evidence", async () => {
    const { root, scope } = await fixture()
    let facts: ProjectFactObservation = {
      identity: "attempt-1",
      facts: { state: "unavailable" },
      review: {
        projectId: "project",
        pluginDigest: "digest",
        stageId: "draft",
        firstProjectAttempt: true,
        firstStageAttempt: true,
        evidence: {
          projectName: "文档任务",
          stageTitle: "草稿",
          operationId: "attempt-1",
          matchesProjectVersion: true,
          checks: []
        }
      }
    }
    const service = new BuiltinChangeReviewService(4, () => facts)
    await writeFile(join(root, "file.txt"), "pre-existing dirty\n")
    expect(await service.capture(scope, service.begin(scope))).toBe(true)
    await writeFile(join(root, "file.txt"), "first attempt\n")
    facts = {
      ...facts,
      identity: "attempt-2",
      review: {
        ...facts.review!,
        firstProjectAttempt: false,
        firstStageAttempt: false,
        evidence: {
          ...facts.review!.evidence,
          operationId: "attempt-2",
          checks: [{ checkId: "draft-check", result: "failed", checkedAt: 10 }]
        }
      }
    }
    const retry = { ...scope, threadId: "retry", runId: "retry" }
    expect(await service.capture(retry, service.begin(retry))).toBe(true)
    await writeFile(join(root, "file.txt"), "repaired\n")
    const stage = await service.read(retry, "stage")
    expect(stage.files[0].patch).toContain("-pre-existing dirty")
    expect((await service.read(retry, "task")).files[0].patch).toContain("-first attempt")
    expect(stage.evidence?.checks).toEqual(facts.review!.evidence.checks)
    facts = {
      ...facts,
      identity: "next-stage",
      review: {
        ...facts.review!,
        stageId: "review",
        firstStageAttempt: true,
        evidence: {
          ...facts.review!.evidence,
          stageTitle: "审阅",
          operationId: "next-stage",
          checks: []
        }
      }
    }
    const next = { ...scope, threadId: "review", runId: "review" }
    expect(await service.capture(next, service.begin(next))).toBe(true)
    await writeFile(join(root, "file.txt"), "reviewed\n")
    expect((await service.read(next, "stage")).files[0].patch).toContain("-repaired")
    expect((await service.read(next, "project")).files[0].patch).toContain("-pre-existing dirty")
    facts = {
      ...facts,
      identity: "changed-package",
      review: { ...facts.review!, pluginDigest: "new" }
    }
    expect((await service.read(next, "project")).status).toBe("unavailable")
    expect((await service.read({ ...next, workspace: root + "-other" }, "stage")).status).toBe(
      "unavailable"
    )
  }, 20000)

  it("does not manufacture a first-stage baseline on restart or a later attempt", async () => {
    const { scope } = await fixture()
    const facts: ProjectFactObservation = {
      identity: "late",
      facts: { state: "unavailable" },
      review: {
        projectId: "project",
        pluginDigest: "digest",
        stageId: "draft",
        firstProjectAttempt: false,
        firstStageAttempt: false,
        evidence: {
          projectName: "任务",
          stageTitle: "草稿",
          operationId: "late",
          matchesProjectVersion: false,
          checks: []
        }
      }
    }
    const service = new BuiltinChangeReviewService(4, () => facts)
    expect(await service.capture(scope, service.begin(scope))).toBe(true)
    expect((await service.read(scope, "task")).status).toBe("available")
    expect((await service.read(scope, "stage")).status).toBe("unavailable")
    expect((await service.read(scope, "project")).status).toBe("unavailable")
  })

  it("captures dirty tracked and existing untracked content before the task", async () => {
    const { root, scope, service } = await fixture()
    await writeFile(join(root, "file.txt"), "pre-existing dirty\n")
    await writeFile(join(root, "untracked.txt"), "pre-existing untracked\n")
    expect(await service.capture(scope, service.begin(scope))).toBe(true)
    await writeFile(join(root, "file.txt"), "task edit\n")
    await writeFile(join(root, "untracked.txt"), "task edits untracked\n")
    const task = await service.read(scope, "task")
    expect(task.status).toBe("available")
    expect(task.files.find((file) => file.path === "file.txt")?.patch).toContain(
      "-pre-existing dirty"
    )
    expect(task.files.find((file) => file.path === "file.txt")?.patch).not.toContain("-committed")
    expect(task.files.find((file) => file.path === "untracked.txt")?.status).toBe("modified")
    const head = await service.read(scope, "head")
    expect(head.files.find((file) => file.path === "file.txt")?.patch).toContain("-committed")
    expect(head.baselineLabel).toContain("包括任务前改动")
  }, 20000)

  it("never creates a task baseline on read and does not revive another incarnation", async () => {
    const { scope, service } = await fixture()
    expect((await service.read(scope, "task")).status).toBe("unavailable")
    const token = service.begin(scope)
    expect(await service.capture(scope, token)).toBe(true)
    expect((await service.read({ ...scope, incarnationKey: "two" }, "task")).status).toBe(
      "unavailable"
    )
    service.begin({ ...scope, runId: "new" })
    expect(await service.capture(scope, token)).toBe(false)
    expect((await service.read(scope, "task")).status).toBe("unavailable")
  })

  it("excludes sensitive paths and never calls clean filters, fsmonitor or external diff", async () => {
    const { root, scope, service } = await fixture()
    await writeFile(join(root, ".gitattributes"), "file.txt filter=review-test diff=review-test\n")
    await writeFile(join(root, ".env"), "FAKE_TEST_SENTINEL=not-a-real-secret\n")
    await git(root, ["add", ".gitattributes", ".env"])
    await git(root, ["commit", "-m", "fixture attributes"])
    await writeFile(
      join(root, "probe.cjs"),
      "require('node:fs').writeFileSync('unexpected-probe', 'ran')"
    )
    const command = `"${process.execPath.replace(/\\/g, "/")}" probe.cjs`
    await git(root, ["config", "filter.review-test.clean", command])
    await git(root, ["config", "diff.review-test.command", command])
    await git(root, ["config", "core.fsmonitor", command])
    await git(root, ["config", "diff.external", command])
    await writeFile(join(root, "file.txt"), "edited\n")
    const view = await service.read(scope, "head")
    expect(view.status).toBe("available")
    expect(JSON.stringify(view)).not.toContain("FAKE_TEST_SENTINEL")
    expect(view.files.some((file) => file.path === ".env")).toBe(false)
    await expect(access(join(root, "unexpected-probe"))).rejects.toThrow()
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("edited\n")
  }, 20000)

  it("distinguishes unborn and non-repository states and rejects oversized snapshots", async () => {
    const { root, scope, service } = await fixture(false)
    expect((await service.read(scope, "head")).message).toContain("尚无 HEAD")
    await writeFile(join(root, "large.txt"), Buffer.alloc(CHANGE_REVIEW_LIMITS.fileBytes + 1, 65))
    expect(await service.capture(scope, service.begin(scope))).toBe(false)
    expect((await service.read(scope, "task")).message).toContain("大小")
    const other = await mkdtemp(join(tmpdir(), "builtin-review-nonrepo-"))
    roots.push(other)
    expect((await service.read({ ...scope, workspace: other }, "head")).message).toContain("不是")
  })

  it("ignores inherited Git redirection and limits a nested workspace to its own paths", async () => {
    const { root, scope, service } = await fixture()
    const other = await fixture()
    vi.stubEnv("GIT_DIR", join(other.root, ".git"))
    await mkdir(join(root, "nested"))
    await writeFile(join(root, "nested", "new.txt"), "nested\n")
    await writeFile(join(root, "file.txt"), "outside nested\n")
    const view = await service.read({ ...scope, workspace: join(root, "nested") }, "head")
    expect(view.status).toBe("available")
    expect(view.files.map((file) => file.path)).toEqual(["nested/new.txt"])
  })

  it("excludes common credential and key names before file reads", () => {
    for (const path of [
      ".env",
      ".env.local",
      "nested/credentials.json",
      ".ssh/id_ed25519",
      "cert.key",
      ".npmrc"
    ]) {
      expect(excludedReviewPath(path)).toBe(true)
    }
    expect(excludedReviewPath("src/example.ts")).toBe(false)
  })

  it("reports rename as deletion/addition and binary changes without inventing textual evidence", async () => {
    const { root, scope, service } = await fixture()
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]))
    expect(await service.capture(scope, service.begin(scope))).toBe(true)
    await rename(join(root, "file.txt"), join(root, "renamed.txt"))
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 3]))
    const indexBefore = await readFile(join(root, ".git", "index"))
    const view = await service.read(scope, "task")
    expect(view.status).toBe("available")
    expect(view.files.find((file) => file.path === "file.txt")?.status).toBe("deleted")
    expect(view.files.find((file) => file.path === "renamed.txt")?.status).toBe("added")
    expect(view.files.find((file) => file.path === "binary.bin")).toMatchObject({
      binary: true,
      status: "modified"
    })
    expect(view.files.find((file) => file.path === "binary.bin")).not.toHaveProperty("patch")
    expect(await readFile(join(root, ".git", "index"))).toEqual(indexBefore)
  })

  it("retains committed edits on the same branch but rejects branch switches and hard links", async () => {
    const { root, scope, service } = await fixture()
    expect(await service.capture(scope, service.begin(scope))).toBe(true)
    await writeFile(join(root, "file.txt"), "committed task edit\n")
    await git(root, ["add", "file.txt"])
    await git(root, ["commit", "-m", "new head"])
    expect((await service.read(scope, "task")).files[0].patch).toContain("+committed task edit")
    await git(root, ["checkout", "-b", "other-fixture-branch"])
    expect((await service.read(scope, "task")).message).toContain("分支已切换")
    await link(join(root, "file.txt"), join(root, "alias.txt"))
    const next = { ...scope, runId: "next" }
    expect(await service.capture(next, service.begin(next))).toBe(false)
    expect((await service.read(next, "task")).message).toContain("硬链接")
  })
})
