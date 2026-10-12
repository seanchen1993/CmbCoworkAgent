import { createHash, randomUUID } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import { BotDomainError } from "../../shared/bot-types"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { privateDirectory, readPrivateJson, syncDirectory } from "./backup-io"

const directoryIdentity = z
  .object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) })
  .strict()
export const botSharedWorkspaceReference = z
  .object({ id: z.string().uuid(), identity: directoryIdentity })
  .strict()
export type BotSharedWorkspaceReference = z.infer<typeof botSharedWorkspaceReference>
const manifest = z.discriminatedUnion("state", [
  z
    .object({ version: z.literal(1), id: z.string().uuid(), state: z.literal("preparing") })
    .strict(),
  z
    .object({
      version: z.literal(1),
      id: z.string().uuid(),
      state: z.literal("ready"),
      identity: directoryIdentity
    })
    .strict()
])
const filename = "workspace.private.json"
const failed = () =>
  new BotDomainError(
    "shared_workspace_changed",
    "共享工作目录已丢失或被替换，请检查本机文件后重启 Bot 后台"
  )

async function saveRecord(root: string, value: z.infer<typeof manifest>): Promise<void> {
  const recordPath = join(root, filename),
    temporary = `${recordPath}.${randomUUID()}.tmp`
  const file = await open(temporary, "wx", 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(value))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, recordPath)
    await syncDirectory(root)
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
  }
}

async function readRecord(root: string): Promise<z.infer<typeof manifest>> {
  const path = join(root, filename),
    info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw failed()
  const file = await openStableFileHandle(root, path)
  try {
    if ((await file.handle.stat()).nlink !== 1) throw failed()
    const record = manifest.parse(
      JSON.parse((await readStableFileHandleBounded(file, 4096)).toString())
    )
    await file.assertPathIdentity()
    return record
  } finally {
    await file.handle.close()
  }
}

/** A managed working directory is outside the private control/credential root.
 * Its identity is recorded before any task can write to it. Host lifetime locking
 * serializes creation; preparing state recovers an interruption before first use. */
export class BotSharedWorkspace {
  private constructor(
    readonly path: string,
    private readonly pinned: BotSharedWorkspaceReference
  ) {}

  get reference(): BotSharedWorkspaceReference {
    return { id: this.pinned.id, identity: { ...this.pinned.identity } }
  }

  /** Offline maintenance may inspect the pinned identity while a replacement is
   * between renames. It cannot supply another destination path. */
  static async reference(
    privateRoot: string
  ): Promise<{ path: string; reference: BotSharedWorkspaceReference }> {
    const root = await realpath(privateRoot),
      record = await readRecord(root)
    if (record.state !== "ready") throw failed()
    return {
      path: join(`${root}.workspace`, record.id),
      reference: { id: record.id, identity: record.identity }
    }
  }

  /** Only the offline recovery owner calls this while holding the Host lock.
   * Both identities come from its durable journal; a retry cannot adopt a third tree. */
  static async finishReplacement(
    privateRoot: string,
    original: BotSharedWorkspaceReference,
    replacement: BotSharedWorkspaceReference
  ): Promise<void> {
    const before = botSharedWorkspaceReference.parse(original),
      next = botSharedWorkspaceReference.parse(replacement)
    const root = await realpath(privateRoot),
      current = await this.reference(root)
    const same = (a: BotSharedWorkspaceReference, b: BotSharedWorkspaceReference) =>
      a.id === b.id && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino
    if (
      before.id !== next.id ||
      (!same(current.reference, before) && !same(current.reference, next))
    )
      throw failed()
    new BotSharedWorkspace(current.path, next).assertCurrent()
    if (!same(current.reference, next))
      await saveRecord(root, { version: 1, state: "ready", ...next })
  }

  /** Does not initialize an absent workspace merely to inspect or capture it. */
  static async inspectForRecovery(
    privateRoot: string
  ): Promise<
    | { state: "absent" }
    | { state: "established"; reference: BotSharedWorkspaceReference; recordSha256: string }
  > {
    const root = await realpath(privateRoot)
    try {
      await lstat(join(root, filename))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "absent" }
      throw error
    }
    const record = await readRecord(root)
    if (record.state !== "ready") throw failed()
    const reference = { id: record.id, identity: record.identity }
    return {
      state: "established",
      reference,
      recordSha256: (await readPrivateJson(root, filename, 4096)).sha256
    }
  }

  static recoveryRecordHash(reference: BotSharedWorkspaceReference): string {
    return createHash("sha256")
      .update(JSON.stringify({ version: 1, state: "ready", ...reference }))
      .digest("hex")
  }

  /** One global journal supplies both authorized identities. Logical workspace
   * IDs may differ after full computer recovery; no user-selected repo path is
   * accepted. A retry compares exact record bytes before replacing/removing. */
  static async replaceControlForRecovery(
    privateRoot: string,
    original: Awaited<ReturnType<typeof BotSharedWorkspace.inspectForRecovery>>,
    replacement: Awaited<ReturnType<typeof BotSharedWorkspace.inspectForRecovery>>,
    guard: () => void | Promise<void>
  ): Promise<void> {
    const root = await realpath(privateRoot),
      current = await this.inspectForRecovery(root)
    const equal = (a: typeof current, b: typeof current) =>
      a.state === b.state &&
      (a.state === "absent" ||
        (b.state === "established" &&
          a.recordSha256 === b.recordSha256 &&
          a.reference.id === b.reference.id &&
          a.reference.identity.dev === b.reference.identity.dev &&
          a.reference.identity.ino === b.reference.identity.ino))
    if (!equal(current, original) && !equal(current, replacement)) throw failed()
    if (replacement.state === "established")
      new BotSharedWorkspace(
        join(`${root}.workspace`, replacement.reference.id),
        replacement.reference
      ).assertCurrent()
    if (equal(current, replacement)) return
    await guard()
    // Recheck after the asynchronous guard and before publishing control state.
    if (!equal(await this.inspectForRecovery(root), original)) throw failed()
    if (replacement.state === "established")
      await saveRecord(root, { version: 1, state: "ready", ...replacement.reference })
    else {
      await unlink(join(root, filename))
      await syncDirectory(root)
    }
  }

  static async open(privateRoot: string): Promise<BotSharedWorkspace> {
    const root = await realpath(privateRoot)
    const container = `${root}.workspace`
    await privateDirectory(container)
    const recordPath = join(root, filename)
    const stamp = await lstat(recordPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    let record: z.infer<typeof manifest>
    if (stamp) {
      record = await readRecord(root)
    } else {
      record = { version: 1, id: randomUUID(), state: "preparing" }
      await saveRecord(root, record)
    }
    const path = join(container, record.id)
    if (record.state === "preparing") {
      await mkdir(path, { mode: 0o700 }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
        // No product writer can access a workspace before its ready record.
        if (
          (await realpath(path)) !== path ||
          !(await lstat(path)).isDirectory() ||
          (await readdir(path)).length
        )
          throw failed()
      })
      await syncDirectory(container)
      const info = await lstat(path, { bigint: true })
      record = {
        ...record,
        state: "ready",
        identity: { dev: String(info.dev), ino: String(info.ino) }
      }
      await saveRecord(root, record)
    }
    const workspace = new BotSharedWorkspace(path, { id: record.id, identity: record.identity })
    workspace.assertCurrent()
    return workspace
  }

  assertCurrent(): void {
    try {
      const info = lstatSync(this.path, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        realpathSync(this.path) !== resolve(this.path) ||
        String(info.dev) !== this.pinned.identity.dev ||
        String(info.ino) !== this.pinned.identity.ino
      )
        throw failed()
    } catch {
      throw failed()
    }
  }
}
