import { randomUUID, createHash } from "node:crypto"
import * as fs from "fs/promises"
import { join, dirname } from "node:path"
import { z } from "zod"

const filePath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !value.includes("\\") &&
      value.split("/").every((part) => part && part !== "." && part !== ".." && !part.includes(":"))
  )
const sha = z.string().regex(/^[a-f0-9]{64}$/)
const manifestSchema = z
  .object({
    version: z.literal(1),
    id: z.string().uuid(),
    sourceSha256: sha,
    skillName: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => !/[\\/]/.test(value) && value !== "." && value !== ".."),
    status: z.enum(["building", "prepared", "completed"]),
    files: z
      .array(
        z
          .object({
            path: filePath,
            sha256: sha,
            size: z
              .number()
              .int()
              .min(0)
              .max(4 * 1024 * 1024)
          })
          .strict()
      )
      .min(1)
      .max(512)
      .refine((files) => files.reduce((total, file) => total + file.size, 0) <= 16 * 1024 * 1024)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length),
    createdAt: z.number().int().nonnegative()
  })
  .strict()
type Manifest = z.infer<typeof manifestSchema>
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === "ENOENT"

async function assertDirectory(path: string): Promise<void> {
  const stat = await fs.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("技能安装目录已被替换")
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path)
    return true
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Windows does not support POSIX directory fsync. Each file is still flushed;
  // the persisted journal makes interruption visible instead of guessing success.
  if (process.platform === "win32") return
  const handle = await fs.open(path, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeManifest(directory: string, value: Manifest): Promise<void> {
  const temp = join(directory, `manifest-${randomUUID()}.tmp`)
  const handle = await fs.open(temp, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temp, join(directory, "manifest.json"))
  await syncDirectory(directory)
}

async function readManifest(directory: string): Promise<Manifest | null> {
  try {
    await assertDirectory(directory)
    const path = join(directory, "manifest.json")
    const stat = await fs.lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024)
      throw new Error("技能安装记录无效，请核对安装目录")
    return manifestSchema.parse(JSON.parse(await fs.readFile(path, "utf8")))
  } catch (error) {
    if (missing(error)) return null
    throw error
  }
}

/** A retained receipt describes the completed operation, not the current user-
 * editable skill. A repeated request must never recreate a later-deleted skill. */
export class SkillImportInstaller {
  constructor(
    private readonly receiptsRoot: string,
    private readonly skillsRoot: string
  ) {}

  private directory(id: string): string {
    return join(this.receiptsRoot, z.string().uuid().parse(id))
  }

  private async prepareRoot(): Promise<void> {
    await fs.mkdir(this.receiptsRoot, { recursive: true, mode: 0o700 })
    await assertDirectory(this.receiptsRoot)
    await fs.mkdir(this.skillsRoot, { recursive: true })
    await assertDirectory(this.skillsRoot)
  }

  private async verify(directory: string, manifest: Manifest): Promise<void> {
    await assertDirectory(directory)
    const expected = new Set(manifest.files.map((file) => file.path))
    const directories = [""]
    let count = 0
    for (const relative of directories) {
      for (const entry of await fs.readdir(join(directory, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (++count > 1024) throw new Error("技能目录内容与安装记录不一致，请核对")
        if (entry.isDirectory() && !entry.isSymbolicLink()) directories.push(path)
        else if (!entry.isFile() || !expected.has(path))
          throw new Error("技能目录出现安装记录之外的文件，请核对；没有覆盖现有内容")
      }
    }
    for (const item of manifest.files) {
      const parts = item.path.split("/")
      for (let i = 1; i < parts.length; ++i)
        await assertDirectory(join(directory, ...parts.slice(0, i)))
      const file = join(directory, item.path)
      const stat = await fs.lstat(file)
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size !== item.size ||
        hash(await fs.readFile(file)) !== item.sha256
      )
        throw new Error("已发布技能与安装记录不一致，请在技能目录核对；没有覆盖现有文件")
    }
  }

  async recover(id: string, sourceSha256: string): Promise<string | null> {
    await this.prepareRoot()
    const directory = this.directory(id)
    const manifest = await readManifest(directory)
    if (!manifest) return null
    if (manifest.id !== id || manifest.sourceSha256 !== sha.parse(sourceSha256))
      throw new Error("此安装请求的内容已变化，请重新预览")
    if (manifest.status === "completed") return manifest.skillName
    if (manifest.status !== "prepared" || (await exists(join(directory, "payload")))) return null
    // Rename published the entire directory, but the completion response or
    // receipt was lost. Verify that exact publication; never repeat the writes.
    await this.verify(join(this.skillsRoot, manifest.skillName), manifest)
    await writeManifest(directory, { ...manifest, status: "completed" })
    return manifest.skillName
  }

  async install(input: {
    id: string
    sourceSha256: string
    skillName: string
    files: { path: string; bytes: Buffer }[]
  }): Promise<void> {
    if (await this.recover(input.id, input.sourceSha256)) return
    const directory = this.directory(input.id)
    let previous = await readManifest(directory)
    if (previous && previous.skillName !== input.skillName) throw new Error("技能安装目录已变化")
    if (!previous) {
      const entries = await fs.readdir(this.receiptsRoot, { withFileTypes: true })
      const records: { name: string; manifest: Manifest }[] = []
      let incomplete = 0
      for (const entry of entries) {
        if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue
        const record = await readManifest(join(this.receiptsRoot, entry.name))
        if (record) records.push({ name: entry.name, manifest: record })
        if (entry.name !== input.id && record?.status !== "completed") ++incomplete
      }
      // Completed receipts are small and bounded. Incomplete staging is never
      // evicted by quota cleanup, so a published-but-unacknowledged import survives.
      if (incomplete >= 16) throw new Error("有 16 项技能安装尚未结算，请先重试或核对这些导入")
      for (const record of records
        .filter((record) => record.manifest.status === "completed")
        .sort((a, b) => a.manifest.createdAt - b.manifest.createdAt)
        .slice(0, Math.max(0, records.length - 255)))
        await fs.rm(join(this.receiptsRoot, record.name), { recursive: true })
      await fs.mkdir(directory, { recursive: true, mode: 0o700 })
      await assertDirectory(directory)
      previous = manifestSchema.parse({
        version: 1,
        id: input.id,
        sourceSha256: input.sourceSha256,
        skillName: input.skillName,
        status: "building",
        createdAt: Date.now(),
        files: input.files.map((file) => ({
          path: file.path,
          size: file.bytes.length,
          sha256: hash(file.bytes)
        }))
      })
      await writeManifest(directory, previous)
    }
    const destination = join(this.skillsRoot, input.skillName)
    if (await exists(destination)) throw new Error("同名技能目录已存在，没有覆盖其内容")
    const payload = join(directory, "payload")
    if (previous.status === "building") {
      // This private staging tree has never been published or exposed in the
      // skill catalog. An interrupted copy can be rebuilt from identical input.
      await fs.rm(payload, { recursive: true, force: true })
      await fs.mkdir(payload)
      for (const file of input.files) {
        const target = join(payload, filePath.parse(file.path))
        await fs.mkdir(dirname(target), { recursive: true })
        const handle = await fs.open(target, "wx", 0o600)
        try {
          await handle.writeFile(file.bytes)
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      await this.verify(payload, previous)
      await syncDirectory(payload)
      previous = { ...previous, status: "prepared" }
      await writeManifest(directory, previous)
    } else await this.verify(payload, previous)
    if (await exists(destination)) throw new Error("同名技能目录已存在，没有覆盖其内容")
    await fs.rename(payload, destination)
    await syncDirectory(this.skillsRoot)
    await writeManifest(directory, { ...previous, status: "completed" })
  }
}

/** Serialize installation with a small admission bound. All existing upload
 * callers share this path; waiting requests cannot exhaust renderer IPC memory. */
export class SkillImportQueue {
  private tail = Promise.resolve()
  private count = 0
  async run<T>(action: () => Promise<T>): Promise<T> {
    if (this.count >= 4) throw new Error("技能安装队列已满，请稍后重试")
    this.count++
    const prior = this.tail
    let release!: () => void
    this.tail = new Promise<void>((done) => {
      release = done
    })
    try {
      await prior
      return await action()
    } finally {
      --this.count
      release()
    }
  }
}
