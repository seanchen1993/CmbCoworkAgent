import { spawn } from "node:child_process"
import { once } from "node:events"
import { lstat, mkdir, open, opendir, realpath, rm, rmdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import {
  captureBotDirectory,
  restoreBotDirectory,
  verifyBotDirectory,
  botDirectoryEntries
} from "./directory-checkpoint"
import { hashBackupFile, readPrivateJson, writePrivateJson } from "./backup-io"
import {
  loadCurrentWorkflowWorktreeRecord,
  resolveWorkflowWorktreeIsolationBoundary,
  assertWorkflowWorktreeDeliverableDescendsFromBase
} from "../services/git-worktree"
import type { WorkflowWorktreeRecord } from "../agent/workflow/types"
import { ComputerBudget, type ComputerOwner } from "./computer-checkpoint-ports"
import { BOT_COMPUTER_NATIVE_PHASE_MS } from "../../shared/bot-computer-maintenance-progress"
import { abortBackupIoProcess, observedBackupGit, observedBackupIo } from "./backup-io-observer"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
const file = z
  .object({
    size: z
      .number()
      .int()
      .nonnegative()
      .max(20 * 1024 ** 3),
    sha256: hash
  })
  .strict()
export const computerGitManifest = z
  .object({
    format: z.literal(1),
    id: z.string().min(1).max(512),
    runId: z.string().min(1).max(512),
    mode: z.literal("independent"),
    base: oid,
    head: oid,
    objects: z
      .object({
        count: z.number().int().positive().max(50_000),
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(20 * 1024 ** 3),
        largest: z
          .number()
          .int()
          .nonnegative()
          .max(64 * 1024 ** 2)
      })
      .strict(),
    bundle: file,
    stagedPatch: file,
    entries: botDirectoryEntries,
    reviewRequired: z.literal(true),
    externalObjectStoresIncluded: z.literal(false),
    externalFiltersExecuted: z.literal(false),
    lfsNetworkUsed: z.literal(false)
  })
  .strict()
export type ComputerGitManifest = z.infer<typeof computerGitManifest>
const gitMetadata = new Set([".git"])
const failed = () => new Error("独立代码工作区无法完整封存，未将其标记为可独立恢复")

/** Serial, bounded Git subprocess transport. stdout is streamed to an owned
 * private file; only command metadata is accumulated (at most 8 MiB). No shell,
 * Git hooks, user global configuration, network commands or lazy object fetch. */
class PrivateGit {
  private active = false
  constructor(
    private readonly cwd: string,
    private readonly owner: ComputerOwner,
    private readonly signal: AbortSignal,
    private readonly hooks: string
  ) {}
  async run(args: string[], output?: { path: string; max: number }, input?: string) {
    if (this.active) throw failed()
    this.active = true
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      this.signal.throwIfAborted()
      await this.owner.checkCurrent()
      this.owner.assertCurrent()
      if (output) handle = await open(output.path, "wx", 0o600)
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key]
      Object.assign(env, {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_REPLACE_OBJECTS: "1"
      })
      const child = spawn(
        "git",
        [
          "-c",
          `core.hooksPath=${this.hooks}`,
          "-c",
          "core.fsmonitor=false",
          "-c",
          "credential.helper=",
          "-c",
          "init.templateDir=",
          "-c",
          "core.quotePath=true",
          "-c",
          "diff.renames=false",
          "-c",
          "pack.threads=1",
          "-c",
          "index.threads=1",
          "-c",
          "core.deltaBaseCacheLimit=16m",
          "-c",
          "pack.windowMemory=64m",
          "-c",
          "pack.deltaCacheSize=16m",
          ...args
        ],
        {
          cwd: this.cwd,
          env,
          stdio: [input ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true
        }
      )
      const completed = once(child, "close") as Promise<[number | null, NodeJS.Signals | null]>
      // Register rejection observation immediately; error events must not become
      // unhandled while stdout is being streamed.
      void completed.catch(() => {})
      observedBackupGit(true)
      let timedOut = false
      let hardKill: ReturnType<typeof setTimeout> | undefined
      let exited = false
      void completed.then(
        () => {
          exited = true
        },
        () => {
          exited = true
        }
      )
      const abort = () => {
        child.kill("SIGTERM")
        hardKill ??= setTimeout(() => {
          child.kill("SIGKILL")
          // A descendant retaining the transport or writing a private pack may
          // survive killing git itself. End the group/Job-owning coordinator.
          if (!exited) abortBackupIoProcess()
        }, 2000)
      }
      this.signal.addEventListener("abort", abort, { once: true })
      const deadline = setTimeout(() => {
          timedOut = true
          abort()
        }, BOT_COMPUTER_NATIVE_PHASE_MS),
        chunks: Buffer[] = []
      let count = 0,
        stderr = Buffer.alloc(0)
      const stdout = child.stdout,
        stderrPipe = child.stderr
      if (!stdout || !stderrPipe) {
        child.kill("SIGKILL")
        throw failed()
      }
      stderrPipe.on("data", (part: Buffer) => {
        stderr = Buffer.concat([stderr, part]).subarray(-64 * 1024)
      })
      if (input) {
        const stdin = child.stdin
        if (!stdin || Buffer.byteLength(input) > 8 * 1024 ** 2) {
          abort()
          throw failed()
        }
        // Bounded metadata only; no file-sized stdin buffer or unobserved
        // promise waiting on drain after an early process failure.
        stdin.on("error", () => {})
        stdin.end(input)
      }
      try {
        for await (const part of stdout) {
          this.signal.throwIfAborted()
          this.owner.assertCurrent()
          count += part.length
          if (count > (output?.max ?? 8 * 1024 ** 2)) throw failed()
          if (handle) await handle.writeFile(part)
          else chunks.push(part)
          observedBackupIo(part.length)
        }
        const [code] = await completed
        if (timedOut || code !== 0)
          throw new Error(`Git 封存失败：${stderr.toString().slice(-4096)}`)
        this.signal.throwIfAborted()
        this.owner.assertCurrent()
        await handle?.sync()
        return Buffer.concat(chunks).toString().trimEnd()
      } catch (error) {
        abort()
        await Promise.allSettled([completed])
        throw error
      } finally {
        clearTimeout(deadline)
        if (hardKill) clearTimeout(hardKill)
        this.signal.removeEventListener("abort", abort)
        observedBackupGit(false)
      }
    } finally {
      await handle?.close()
      this.active = false
    }
  }
}
async function objectBudget(git: PrivateGit, commits?: string[]) {
  const inventory = commits
    ? await git.run(["rev-list", "--objects", "--no-object-names", ...commits])
    : undefined
  if (inventory && inventory.split("\n").length > 50_000) throw failed()
  const text = await git.run(
    commits ? ["cat-file", "--batch-check"] : ["cat-file", "--batch-all-objects", "--batch-check"],
    undefined,
    inventory ? inventory + "\n" : undefined
  )
  let count = 0,
    bytes = 0,
    largest = 0
  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64}) (blob|tree|commit|tag) (\d+)$/.exec(line)
    if (!match) throw failed()
    const size = Number(match[3])
    ++count
    bytes += size
    largest = Math.max(largest, size)
    if (
      count > 50_000 ||
      !Number.isSafeInteger(bytes) ||
      bytes > 20 * 1024 ** 3 ||
      largest > 64 * 1024 ** 2
    )
      throw failed()
  }
  return { count, bytes, largest }
}
async function assertIndexSupported(git: PrivateGit) {
  if (await git.run(["ls-files", "--unmerged"]))
    throw new Error("工作区含未解决冲突，代码恢复点未封存")
  // Intent-to-add and skip-worktree/assume-unchanged affect index semantics but
  // are not representable by a binary patch. Refuse instead of silently losing.
  const flagged = await git.run(["ls-files", "-v"])
  if (flagged.split("\n").some((line) => line && line[0] !== "H"))
    throw new Error("工作区含特殊 Git 索引标志，未封存代码恢复点")
  const stages = await git.run(["ls-files", "--stage"])
  if (stages.split("\n").some((line) => line.startsWith("160000 ")))
    throw new Error("代码恢复点暂不封存子模块，请单独保存子模块")
  // --ita-visible-in-index produces a difference for intent-to-add entries.
  const ordinary = await git.run([
    "diff",
    "--cached",
    "--name-only",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD"
  ])
  const ita = await git.run([
    "diff",
    "--cached",
    "--name-only",
    "--ita-visible-in-index",
    "--no-ext-diff",
    "--no-textconv",
    "HEAD"
  ])
  if (ordinary !== ita) throw new Error("代码恢复点暂不封存 intent-to-add 索引")
}
async function cleanOrdinaryCheckout(path: string, owner: ComputerOwner) {
  const directory = await opendir(path)
  for await (const entry of directory) {
    if (entry.name === ".git") continue
    owner.assertCurrent()
    await rm(join(path, entry.name), { force: true, recursive: true })
  }
}
export async function captureComputerGit(input: {
  record: WorkflowWorktreeRecord
  appDataRoot: string
  destination: string
  scratch: string
  budget: ComputerBudget
  owner: ComputerOwner
  signal: AbortSignal
}) {
  const current = await loadCurrentWorkflowWorktreeRecord(input.record, input.appDataRoot)
  await resolveWorkflowWorktreeIsolationBoundary(
    { ...current, name: current.id },
    input.appDataRoot
  )
  await mkdir(input.destination, { mode: 0o700 })
  await mkdir(input.scratch, { mode: 0o700 })
  const hooks = join(input.scratch, "hooks")
  await mkdir(hooks, { mode: 0o700 })
  const source = new PrivateGit(current.directory, input.owner, input.signal, hooks)
  await assertIndexSupported(source)
  const base = oid.parse(current.baseCommit),
    head = oid.parse(await source.run(["rev-parse", "HEAD"]))
  // Refuse oversized historical objects before any bundle/unbundle work. Git
  // object IDs are immutable, and replacement objects/lazy fetch are disabled.
  const objectsBudget = await objectBudget(source, [base, head])
  await assertWorkflowWorktreeDeliverableDescendsFromBase(
    current.directory,
    base,
    head,
    60_000,
    input.signal
  )
  const gitDir = await source.run(["rev-parse", "--absolute-git-dir"]),
    index = await hashBackupFile(gitDir, "index")
  const objectFormat = head.length === 64 ? "sha256" : "sha1"
  const bare = join(input.scratch, "bare")
  await source.run(["init", "--bare", `--object-format=${objectFormat}`, bare])
  // All source refs remain untouched. Only private scratch refs point into a
  // pinned, read-only source object store, and the sealed bundle is verified in
  // a second empty object store with no alternates or source dependency.
  const objects = await realpath(join(current.commonDir, "objects"))
  if (/[\r\n]/.test(objects) || !(await lstat(objects)).isDirectory()) throw failed()
  await writeFile(
    join(bare, "objects", "info", "alternates"),
    `${objects.replaceAll("\\", "/")}\n`,
    { flag: "wx", mode: 0o600 }
  )
  const privateGit = new PrivateGit(bare, input.owner, input.signal, hooks)
  await privateGit.run(["update-ref", "refs/heads/cmb-recovery/base", base])
  await privateGit.run(["update-ref", "refs/heads/cmb-recovery/head", head])
  await privateGit.run(
    ["bundle", "create", "-", "refs/heads/cmb-recovery/base", "refs/heads/cmb-recovery/head"],
    { path: join(input.destination, "history.bundle"), max: input.budget.remaining().bytes }
  )
  const bundle = await hashBackupFile(input.destination, "history.bundle")
  input.budget.consume(1, bundle.size)
  await source.run(
    ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD"],
    { path: join(input.destination, "staged.patch"), max: input.budget.remaining().bytes }
  )
  const stagedPatch = await hashBackupFile(input.destination, "staged.patch")
  input.budget.consume(1, stagedPatch.size)
  const remaining = input.budget.remaining(),
    entries = await captureBotDirectory(
      current.directory,
      join(input.destination, "files"),
      () => input.owner.assertCurrent(),
      { maxEntries: remaining.entries, maxBytes: remaining.bytes, excludeRoot: gitMetadata }
    )
  input.budget.consume(
    entries.length,
    entries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0)
  )
  const after = await loadCurrentWorkflowWorktreeRecord(current, input.appDataRoot)
  if ((await source.run(["rev-parse", "HEAD"])) !== head || after.baseCommit !== base)
    throw failed()
  await hashBackupFile(gitDir, "index", index)
  const manifest = computerGitManifest.parse({
    format: 1,
    id: current.id,
    runId: current.threadId,
    mode: "independent",
    base,
    head,
    objects: objectsBudget,
    bundle: { size: bundle.size, sha256: bundle.sha256 },
    stagedPatch: { size: stagedPatch.size, sha256: stagedPatch.sha256 },
    entries,
    reviewRequired: true,
    externalObjectStoresIncluded: false,
    externalFiltersExecuted: false,
    lfsNetworkUsed: false
  })
  await writePrivateJson(join(input.destination, "manifest.json"), manifest)
  const verification = join(input.scratch, "verification")
  await restoreComputerGit({
    source: input.destination,
    destination: verification,
    owner: input.owner,
    signal: input.signal,
    maxExpandedBytes: 20 * 1024 ** 3
  })
  await rm(input.scratch, { recursive: true })
  return manifest
}
export async function restoreComputerGit(input: {
  source: string
  destination: string
  owner: ComputerOwner
  signal: AbortSignal
  maxExpandedBytes: number
}) {
  const manifest = computerGitManifest.parse(
    (await readPrivateJson(input.source, "manifest.json")).value
  )
  const ordinaryBytes = manifest.entries.reduce(
    (n, entry) => n + (entry.kind === "file" ? entry.size : 0),
    0
  )
  if (
    manifest.objects.bytes + ordinaryBytes + manifest.objects.count * 512 + 256 * 1024 >
    input.maxExpandedBytes
  )
    throw failed()
  await hashBackupFile(input.source, "history.bundle", manifest.bundle)
  await hashBackupFile(input.source, "staged.patch", manifest.stagedPatch)
  await verifyBotDirectory(join(input.source, "files"), manifest.entries)
  await mkdir(input.destination, { mode: 0o700 })
  const hooks = join(input.destination, ".recovery-hooks")
  await mkdir(hooks, { mode: 0o700 })
  const git = new PrivateGit(input.destination, input.owner, input.signal, hooks)
  await git.run(["init", `--object-format=${manifest.head.length === 64 ? "sha256" : "sha1"}`])
  await git.run(["bundle", "verify", join(input.source, "history.bundle")])
  const heads = (await git.run(["bundle", "list-heads", join(input.source, "history.bundle")]))
    .split("\n")
    .sort()
  if (
    JSON.stringify(heads) !==
    JSON.stringify(
      [
        `${manifest.base} refs/heads/cmb-recovery/base`,
        `${manifest.head} refs/heads/cmb-recovery/head`
      ].sort()
    )
  )
    throw failed()
  await git.run(["bundle", "unbundle", join(input.source, "history.bundle")])
  if (JSON.stringify(await objectBudget(git)) !== JSON.stringify(manifest.objects)) throw failed()
  // Verify expanded object storage before materializing a checkout. This cap
  // supplements compressed bundle bytes; no network can supply omitted objects.
  const counts = await git.run(["count-objects", "-v"])
  const kib = [...counts.matchAll(/^(?:size|size-pack): (\d+)$/gm)].reduce(
    (n, m) => n + Number(m[1]),
    0
  )
  if (!Number.isSafeInteger(kib) || kib * 1024 > input.maxExpandedBytes) throw failed()
  await git.run(["update-ref", "HEAD", manifest.head])
  // No checkout filters are needed: populate only the index from immutable HEAD,
  // then apply the full staged patch and overlay the exact ordinary file tree.
  await git.run(["read-tree", manifest.head])
  if (manifest.stagedPatch.size)
    await git.run([
      "apply",
      "--cached",
      "--binary",
      "--whitespace=nowarn",
      join(input.source, "staged.patch")
    ])
  await cleanOrdinaryCheckout(input.destination, input.owner)
  const overlay = `${input.destination}.ordinary`
  await restoreBotDirectory(join(input.source, "files"), overlay, manifest.entries)
  const directory = await opendir(overlay)
  const { rename } = await import("node:fs/promises")
  for await (const entry of directory) {
    input.owner.assertCurrent()
    await rename(join(overlay, entry.name), join(input.destination, entry.name))
  }
  await rmdir(overlay)
  await verifyBotDirectory(input.destination, manifest.entries, false, { excludeRoot: gitMetadata })
  if ((await git.run(["rev-parse", "HEAD"])) !== manifest.head) throw failed()
  return { head: manifest.head, reviewRequired: true as const }
}
