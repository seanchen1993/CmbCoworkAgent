import * as fs from "node:fs/promises"
import { constants } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import type { RequirementSafeStorage } from "../requirements/credential-store"
import {
  parsePartnerDescriptor,
  PartnerLocalFault,
  partnerId,
  partnerObject,
  type PartnerConnectionDescriptor
} from "./partner-local-client"

export interface PartnerPendingAction {
  kind: string
  fingerprint: string
  commandId: string
  deadline: string
}
export interface PartnerLocalConfig {
  descriptor: PartnerConnectionDescriptor
  workspacePath: string | null
  groupId: string | null
  botId: string | null
  botVersionId: string | null
  pending: PartnerPendingAction | null
  lastRunId: string | null
  lastTaskNumber: string | null
}
function privateStat(s: import("node:fs").Stats, directory = false): void {
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile()) ||
    (!directory && s.nlink !== 1) ||
    (process.platform !== "win32" &&
      ((s.mode & 0o777) !== (directory ? 0o700 : 0o600) || s.uid !== process.getuid?.()))
  )
    throw new PartnerLocalFault("STORAGE_FAILURE")
}
/** Imported launch descriptor must be a private, regular, owned file. Check
 * both handle and pathname identity; refuse symlinks rather than following. */
export async function readPartnerPrivateJson(path: string): Promise<unknown> {
  let handle: fs.FileHandle | undefined
  try {
    const parent = await fs.lstat(dirname(path))
    privateStat(parent, true)
    const before = await fs.lstat(path)
    privateStat(before)
    if (before.size > 32768) throw Error()
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    privateStat(opened)
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw Error()
    const bytes = await handle.readFile()
    if (bytes.length > 32768) throw Error()
    const after = await fs.lstat(path),
      afterParent = await fs.lstat(dirname(path))
    if (
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      afterParent.ino !== parent.ino ||
      afterParent.dev !== parent.dev
    )
      throw Error()
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new PartnerLocalFault("STORAGE_FAILURE")
  } finally {
    await handle?.close()
  }
}
export function parsePartnerLocalConfig(raw: unknown): PartnerLocalConfig {
  const v = partnerObject(raw, [
    "descriptor",
    "workspacePath",
    "groupId",
    "botId",
    "botVersionId",
    "pending",
    "lastRunId",
    "lastTaskNumber"
  ])
  if (
    v.workspacePath !== null &&
    (typeof v.workspacePath !== "string" ||
      !v.workspacePath ||
      v.workspacePath.length > 4096 ||
      v.workspacePath.includes("\0"))
  )
    throw new PartnerLocalFault("STORAGE_FAILURE")
  for (const k of ["groupId", "botId", "botVersionId", "lastRunId"])
    if (v[k] !== null) partnerId(v[k])
  if (
    v.lastTaskNumber !== null &&
    (typeof v.lastTaskNumber !== "string" || !/^TASK-[1-9][0-9]{0,15}$/.test(v.lastTaskNumber))
  )
    throw new PartnerLocalFault("STORAGE_FAILURE")
  if (v.pending !== null) {
    const a = partnerObject(v.pending, ["kind", "fingerprint", "commandId", "deadline"])
    partnerId(a.commandId)
    if (
      typeof a.kind !== "string" ||
      typeof a.fingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(a.fingerprint) ||
      typeof a.deadline !== "string" ||
      !Number.isFinite(Date.parse(a.deadline))
    )
      throw new PartnerLocalFault("STORAGE_FAILURE")
  }
  return { ...v, descriptor: parsePartnerDescriptor(v.descriptor) } as unknown as PartnerLocalConfig
}
/** One purpose, no plaintext fallback. This store is used only by main; it
 * does not auto-connect or execute after App restart. Controller serializes edits. */
export class PartnerLocalConfigStore {
  constructor(
    private readonly directory: string,
    private readonly storage: RequirementSafeStorage
  ) {}
  private secure(): void {
    if (
      !this.storage.isEncryptionAvailable() ||
      (process.platform === "linux" &&
        !["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
          this.storage.getSelectedStorageBackend?.() ?? ""
        ))
    )
      throw new PartnerLocalFault("STORAGE_UNAVAILABLE")
  }
  async load(): Promise<PartnerLocalConfig | null> {
    try {
      await fs.lstat(join(this.directory, "connection.enc.json"))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
      throw new PartnerLocalFault("STORAGE_FAILURE")
    }
    try {
      this.secure()
      const v = partnerObject(
        await readPartnerPrivateJson(join(this.directory, "connection.enc.json")),
        ["version", "ciphertext"]
      )
      if (v.version !== 1 || typeof v.ciphertext !== "string" || v.ciphertext.length > 32000)
        throw Error()
      return parsePartnerLocalConfig(
        JSON.parse(this.storage.decryptString(Buffer.from(v.ciphertext, "base64")))
      )
    } catch (error) {
      throw error instanceof PartnerLocalFault ? error : new PartnerLocalFault("STORAGE_FAILURE")
    }
  }
  async save(config: PartnerLocalConfig): Promise<void> {
    this.secure()
    parsePartnerLocalConfig(config)
    const file = join(this.directory, "connection.enc.json"),
      temp = join(this.directory, `connection-${randomUUID()}.tmp`)
    let created = false
    try {
      await fs.mkdir(this.directory, { mode: 0o700 }).catch((error) => {
        if (error.code !== "EEXIST") throw error
      })
      const parent = await fs.lstat(this.directory)
      privateStat(parent, true)
      try {
        privateStat(await fs.lstat(file))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      const plain = JSON.stringify(config),
        ciphertext = this.storage.encryptString(plain)
      if (this.storage.decryptString(ciphertext) !== plain) throw Error()
      const handle = await fs.open(temp, "wx", 0o600)
      created = true
      try {
        await handle.writeFile(
          JSON.stringify({ version: 1, ciphertext: ciphertext.toString("base64") })
        )
        await handle.sync()
      } finally {
        await handle.close()
      }
      const after = await fs.lstat(this.directory)
      if (after.ino !== parent.ino || after.dev !== parent.dev) throw Error()
      await fs.rename(temp, file)
      created = false
    } catch (error) {
      throw error instanceof PartnerLocalFault ? error : new PartnerLocalFault("STORAGE_FAILURE")
    } finally {
      if (created) await fs.unlink(temp).catch(() => undefined)
    }
  }
}
