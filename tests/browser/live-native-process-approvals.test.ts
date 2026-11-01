import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod, symlink } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { confirmFunctionProcess } from "../../src/main/ipc/mods-process-approval"
import { installLiveNativeProcessApprovals } from "../support/live-native-process-approvals"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const tail = relative(resolve(tmpdir()), resolve(root))
    if (
      !tail ||
      isAbsolute(tail) ||
      tail.startsWith("..") ||
      !tail.startsWith("live-process-review-")
    )
      throw Error("UNSAFE_TEST_CLEANUP")
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const isolated = await mkdtemp(join(tmpdir(), "live-process-review-"))
  roots.push(isolated)
  const workspace = join(isolated, "workspace"),
    userData = join(isolated, "electron")
  await Promise.all([mkdir(workspace), mkdir(userData)])
  const original = vi.fn(async () => ({ response: 0 }))
  const dialog: { showMessageBox: (...args: unknown[]) => Promise<{ response: number }> } = {
    showMessageBox: original
  }
  const reinstall = () => installLiveNativeProcessApprovals(
    { app: { getPath: () => userData }, dialog } as never,
    { isolated, workspace }
  )
  reinstall()
  const controller = new AbortController()
  const request = Object.freeze({
    argv: Object.freeze(["node", "-e", "console.log('reviewed')"]),
    cwd: workspace,
    env: Object.freeze({}),
    input: "actual input",
    timeoutMs: 30_000
  })
  const host = {
    signal: controller.signal,
    tempRoot: userData,
    assertCurrent: () => {},
    openPath: vi.fn(async () => ""),
    showDialog: (options: import("electron").MessageBoxOptions) =>
      dialog.showMessageBox(options as never)
  }
  const pending = async (id = 1) => {
    let proposal:
      | { digest: string; proposal: { id: number; requestDigest: string; request: unknown } }
      | undefined
    await vi.waitFor(async () => {
      proposal = JSON.parse(await readFile(join(isolated, "pending-native-approval.json"), "utf8"))
      expect(proposal!.proposal.id).toBe(id)
    })
    return proposal!
  }
  const decide = (map: Record<string, string>) =>
    writeFile(join(isolated, "reviewed-approvals.json"), JSON.stringify(map))
  return {
    isolated,
    workspace,
    userData,
    original,
    dialog,
    host,
    request,
    controller,
    pending,
    decide,
    reinstall
  }
}

it("records the full original native request and waits for its exact one-shot review digest", async () => {
  const f = await fixture()
  let finished = false
  const first = confirmFunctionProcess("function:generic-check", f.request, f.host).then(() => {
    finished = true
  })
  const one = await f.pending()
  expect(one.proposal.request).toEqual(f.request)
  await f.decide({ "*": "approve", ["a".repeat(64)]: "approve" })
  await new Promise((done) => setTimeout(done, 180))
  expect(finished).toBe(false)
  await f.decide({ [one.digest]: "approve" })
  await first
  expect(f.original).not.toHaveBeenCalled()
  expect(await readdir(f.userData)).toEqual([])
  const second = confirmFunctionProcess("function:generic-check", f.request, f.host)
  const rejected = expect(second).rejects.toThrow("MODS_PROCESS_DENIED")
  const two = await f.pending(2)
  expect(two.proposal.requestDigest).toBe(one.proposal.requestDigest)
  expect(two.digest).not.toBe(one.digest)
  await f.decide({ [one.digest]: "approve", [two.digest]: "reject" })
  await rejected
  expect(await readdir(f.userData)).toEqual([])
})

it("continues persisted review numbering after same-run reinstall and requires fresh approval", async () => {
  const f = await fixture()
  const first = confirmFunctionProcess("function:generic-check", f.request, f.host)
  const one = await f.pending()
  await f.decide({ [one.digest]: "approve" })
  await first
  const retained = await readFile(join(f.isolated, "native-dialog-reviews/1.proposal.json"), "utf8")

  f.reinstall()
  let finished = false
  const second = confirmFunctionProcess("function:generic-check", f.request, f.host).then(() => {
    finished = true
  })
  const two = await f.pending(2)
  expect(two.proposal.requestDigest).toBe(one.proposal.requestDigest)
  expect(two.digest).not.toBe(one.digest)
  await new Promise(done => setTimeout(done, 180))
  expect(finished).toBe(false)
  await f.decide({ [one.digest]: "approve", [two.digest]: "approve" })
  await second
  expect(await readFile(join(f.isolated, "native-dialog-reviews/1.proposal.json"), "utf8"))
    .toBe(retained)
  expect(await readdir(join(f.isolated, "native-dialog-reviews"))).toEqual([
    "1.decision.json", "1.proposal.json", "2.decision.json", "2.proposal.json"
  ])
})

it("cancellation never becomes approval and records the native cancellation", async () => {
  const f = await fixture()
  const running = confirmFunctionProcess("function:generic-check", f.request, f.host)
  const rejected = expect(running).rejects.toThrow("cancelled")
  await f.pending()
  f.controller.abort(Error("cancelled"))
  await rejected
  const record = JSON.parse(
    await readFile(join(f.isolated, "native-dialog-reviews/1.decision.json"), "utf8")
  )
  expect(record).toMatchObject({ decision: "reject", reason: "native-aborted" })
})

it("rejects changed request bytes despite an exact previously reviewed digest", async () => {
  const f = await fixture()
  const running = confirmFunctionProcess("function:generic-check", f.request, f.host)
  const rejected = expect(running).rejects.toThrow("MODS_PROCESS_DENIED")
  const proposal = await f.pending()
  const [directory] = await readdir(f.userData)
  const file = join(f.userData, directory, "request.json")
  await chmod(file, 0o600)
  await writeFile(file, "{}")
  await f.decide({ [proposal.digest]: "approve" })
  await rejected
})

it("rejects a process outside the isolated workspace and leaves unrelated dialogs native", async () => {
  const f = await fixture()
  await expect(
    confirmFunctionProcess("function:generic-check", { ...f.request, cwd: f.isolated }, f.host)
  ).rejects.toThrow("MODS_PROCESS_DENIED")
  await f.dialog.showMessageBox({ title: "Unrelated dialog" } as never)
  expect(f.original).toHaveBeenCalledOnce()
})

async function managedCheckout(f: Awaited<ReturnType<typeof fixture>>) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: f.workspace, stdio: "pipe" })
  git("init")
  git(
    "-c",
    "user.name=Acceptance",
    "-c",
    "user.email=acceptance@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "test baseline"
  )
  const checkout = join(f.isolated, "data", "worktrees", "repo", "candidate")
  await mkdir(join(f.isolated, "data", "worktrees", "repo"), { recursive: true })
  git("worktree", "add", "--detach", checkout)
  return checkout
}

it("reviews a real managed worktree only when gitdir and commondir bind the isolated source", async () => {
  const f = await fixture()
  const cwd = await managedCheckout(f)
  const running = confirmFunctionProcess("function:generic-build", { ...f.request, cwd }, f.host)
  const proposal = await f.pending()
  await f.decide({ [proposal.digest]: "approve" })
  await running
  const saved = JSON.parse(
    await readFile(join(f.isolated, "native-dialog-reviews/1.proposal.json"), "utf8")
  )
  expect(saved.proposal.workspaceProof).toMatchObject({ kind: "managed-worktree" })
})

it.each(["forged-git-file", "foreign-repository", "symlink-escape"])(
  "rejects %s before a managed-worktree process can be approved",
  async (kind) => {
    const f = await fixture()
    const cwd = await managedCheckout(f)
    let requested = cwd
    if (kind === "forged-git-file") {
      await rm(join(cwd, ".git"))
      await writeFile(join(cwd, ".git"), `gitdir: ${join(f.workspace, ".git")}\n`)
    } else if (kind === "foreign-repository") {
      const other = await fixture()
      const foreign = await managedCheckout(other)
      await rm(join(cwd, ".git"))
      await writeFile(join(cwd, ".git"), await readFile(join(foreign, ".git"), "utf8"))
    } else {
      const other = await fixture()
      requested = join(f.isolated, "data", "worktrees", "escaped")
      await symlink(other.workspace, requested, "junction")
    }
    await expect(
      confirmFunctionProcess("function:generic-build", { ...f.request, cwd: requested }, f.host)
    ).rejects.toThrow("MODS_PROCESS_DENIED")
    expect(await readdir(join(f.isolated, "native-dialog-reviews"))).toEqual(["1.rejected.json"])
  }
)
