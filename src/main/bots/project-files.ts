import { globWorkflowFiles } from "../agent/workflow/glob"
import { detectCmbFileEncoding, CMB_KNOWN_BINARY_EXTENSIONS } from "../agent/file-text-encoding"
import { searchBotProject } from "./project-search"
import * as iconv from "iconv-lite"
import micromatch from "micromatch"
import { withBotProjectMutation } from "./project-lock"
import { createHash } from "node:crypto"
import { lstat, open, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { replace } from "../agent/replace"
import { BOT_FILE_BYTES } from "../../shared/bot-files"
import { hasControlCharacters } from "./validation"
import {
  openStableFileHandle,
  openStableWritableFileHandle,
  readStableFileHandleBounded
} from "../services/stable-file-handle"

const MAX_BYTES = 2 * 1024 * 1024
const SEARCH_MILLISECONDS = 10_000
class ProjectSearchDeadline extends Error {}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const inside = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

export interface ProjectFileChange {
  path: string
  beforeHash: string | null
  afterHash: string
  beforeBytes: Buffer | null
  after: string
  diff: string
}

/** Host-independent adapter over Cmb's stable file capabilities and edit matching.
 * Every write is an optimistic, action-approved change, never a blind overwrite.
 */
export class BotProjectFiles {
  get identity(): { root: string; dev: string; ino: string } {
    return {
      root: this.root,
      dev: String(this.rootIdentity.dev),
      ino: String(this.rootIdentity.ino)
    }
  }
  private constructor(
    readonly root: string,
    private readonly deniedRoots: string[],
    private readonly rootIdentity: { dev: bigint; ino: bigint }
  ) {}

  static async open(root: string, deniedRoots: string[] = []): Promise<BotProjectFiles> {
    if (!path.isAbsolute(root)) throw new Error("请配置项目的绝对路径")
    const canonical = await realpath(root)
    const info = await stat(canonical, { bigint: true })
    if (!info.isDirectory()) throw new Error("项目路径不是目录")
    const denied = await Promise.all(deniedRoots.map((item) => realpath(item)))
    if (denied.some((item) => inside(item, canonical)))
      throw new Error("Bot 后台数据目录不能作为项目目录")
    return new BotProjectFiles(canonical, denied, { dev: info.dev, ino: info.ino })
  }

  private resolve(relative: string, directory = false): string {
    if (directory && relative === ".") return this.root
    // Apply Windows restrictions on all hosts so paths keep the same authority after migration.
    const parts = relative.replaceAll("\\", "/").split("/")
    if (
      !relative ||
      relative.length > 4096 ||
      path.isAbsolute(relative) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          /[<>:"|?*]/.test(part) ||
          hasControlCharacters(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
          part.toLowerCase() === ".git"
      )
    )
      throw new Error("路径必须是项目内的相对路径，不能访问 Git 内部文件")
    const candidate = path.resolve(this.root, ...parts)
    if (!inside(this.root, candidate)) throw new Error("路径超出项目范围")
    if (this.deniedRoots.some((root) => inside(root, candidate)))
      throw new Error("禁止访问 Bot 后台凭据和控制数据")
    return candidate
  }

  async assertCurrent(): Promise<void> {
    await this.validate(this.root)
  }

  /** Read-only instruction capabilities must retain their parent's path boundary.
   * Reuse the same component checks as project tools before opening a child root. */
  async assertInstructionPath(absolutePath: string): Promise<void> {
    if (!path.isAbsolute(absolutePath) || !inside(this.root, absolutePath))
      throw new Error("项目指令路径超出授权目录")
    const relative = path.relative(this.root, absolutePath) || "."
    await this.validate(this.resolve(relative, relative === "."))
  }

  async openInstructionDirectory(absolutePath: string): Promise<BotProjectFiles> {
    await this.assertInstructionPath(absolutePath)
    const child = await BotProjectFiles.open(absolutePath, this.deniedRoots)
    await this.assertInstructionPath(absolutePath)
    await child.assertCurrent()
    return child
  }

  private async validate(candidate: string, writing = false, newFile = false): Promise<void> {
    if ((await realpath(this.root)) !== this.root) throw new Error("项目目录已变化，请重新配置")
    const root = await lstat(this.root, { bigint: true })
    if (
      !root.isDirectory() ||
      root.dev !== this.rootIdentity.dev ||
      root.ino !== this.rootIdentity.ino
    )
      throw new Error("项目目录已被替换，请重新确认任务")
    const parts = path.relative(this.root, candidate).split(path.sep).filter(Boolean)
    let current = this.root
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index])
      const last = index === parts.length - 1
      const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (last && newFile && error.code === "ENOENT") return null
        throw error
      })
      if (!info) return
      if (info.isSymbolicLink() || !inside(this.root, await realpath(current)))
        throw new Error("项目工具不跟随符号链接或目录联接")
      if (!last && !info.isDirectory()) throw new Error("父路径不是目录")
      if (info.isFile() && info.nlink !== 1) throw new Error("项目工具不读取或修改硬链接文件")
      if (writing && info.isDirectory()) {
        const nestedGit = await lstat(path.join(current, ".git")).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null
            throw error
          }
        )
        if (nestedGit) throw new Error("嵌套 Git 仓库为只读，请单独配置该项目")
      }
    }
  }

  /** Observe presence/type without reading contents, under the same exact root,
   * link and private-data boundaries as other project reads. */
  async probe(
    relative: string,
    type: "file" | "directory",
    signal?: AbortSignal
  ): Promise<boolean> {
    signal?.throwIfAborted()
    const candidate = this.resolve(relative)
    try {
      await this.validate(candidate)
      signal?.throwIfAborted()
      const info = await lstat(candidate, { bigint: true })
      await this.validate(candidate)
      signal?.throwIfAborted()
      return type === "file" ? info.isFile() : info.isDirectory()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      await this.assertCurrent()
      // A missing leaf is known absence only after all existing ancestors pass
      // the original path/link checks. Replaced/inaccessible parents are errors.
      let parent = path.dirname(candidate)
      while (parent !== this.root) {
        try {
          await this.validate(parent)
          break
        } catch (failure) {
          if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure
          parent = path.dirname(parent)
        }
      }
      await this.assertCurrent()
      signal?.throwIfAborted()
      return false
    }
  }

  async list(relative = ".", offset = 0): Promise<unknown> {
    const candidate = this.resolve(relative, true)
    await this.validate(candidate)
    const entries = (await readdir(candidate, { withFileTypes: true }))
      .filter((entry) => entry.name.toLowerCase() !== ".git")
      .sort(
        (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
      )
    return {
      directory: relative,
      entries: entries.slice(offset, offset + 200).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "link-unavailable"
          : entry.isDirectory()
            ? "directory"
            : "file"
      })),
      nextOffset: offset + 200 < entries.length ? offset + 200 : null
    }
  }

  private globPattern(pattern: string): void {
    if (
      !pattern ||
      pattern.length > 4096 ||
      path.isAbsolute(pattern) ||
      pattern
        .replaceAll("\\", "/")
        .split("/")
        .some((part) => part === "..") ||
      pattern.includes(":") ||
      hasControlCharacters(pattern)
    )
      throw new Error("匹配表达式必须位于项目内")
  }

  /** Permission checks validate the root and pattern without traversing the tree. */
  async assertGlob(pattern: string, relative = "."): Promise<void> {
    this.globPattern(pattern)
    const candidate = this.resolve(relative, true)
    await this.validate(candidate)
    if (!(await lstat(candidate)).isDirectory()) throw new Error("匹配目录不是文件夹")
  }

  async glob(pattern: string, directory = ".", check: () => void = () => {}): Promise<string[]> {
    check()
    await this.assertGlob(pattern, directory)
    check()
    const candidate = this.resolve(directory, true)
    const matches = await globWorkflowFiles(candidate, pattern, check)
    const visible: string[] = []
    for (let offset = 0; offset < matches.length; offset += 4) {
      check()
      const batch = matches
        .slice(offset, offset + 4)
        .map((match) =>
          path.relative(this.root, path.join(candidate, match)).split(path.sep).join("/")
        )
      const results = await Promise.allSettled(
        batch.map((relative) => this.assertReadable(relative))
      )
      check()
      for (const [index, result] of results.entries()) {
        if (result.status === "fulfilled") visible.push(batch[index])
        // Exclude links, private Host roots and Git internal paths.
      }
    }
    await this.validate(candidate)
    check()
    return visible
  }

  /** Permission-only probe for shared plugin file SDKs; it returns no file data. */
  async assertReadable(relative: string): Promise<void> {
    await this.validate(this.resolve(relative, true))
  }

  async assertWritable(relative: string): Promise<void> {
    await this.validate(this.resolve(relative), true, true)
  }

  async assertSearch(pattern: string, relative = ".", glob = "**/*"): Promise<void> {
    if (!pattern || pattern.length > 2000 || /[\r\n\0]/.test(pattern))
      throw new Error("搜索内容必须是 1～2000 字符的单行文本")
    this.globPattern(glob)
    await this.assertReadable(relative)
    const info = await lstat(this.resolve(relative, true))
    if (!info.isFile() && !info.isDirectory()) throw new Error("搜索目标必须是文件或目录")
  }

  async search(pattern: string, relative = ".", glob = "**/*", check: () => void = () => {}) {
    const deadline = performance.now() + SEARCH_MILLISECONDS
    const traversalCheck = () => {
      check()
      if (performance.now() >= deadline) throw new ProjectSearchDeadline()
    }
    check()
    await this.assertSearch(pattern, relative, glob)
    const target = this.resolve(relative, true)
    const single = (await lstat(target)).isFile()
    const filename = path.relative(this.root, target).split(path.sep).join("/")
    let files: string[]
    try {
      traversalCheck()
      files = single
        ? micromatch.isMatch(filename, glob, { matchBase: !glob.includes("/") })
          ? [filename]
          : []
        : (
            await this.glob(glob.includes("/") ? glob : `**/${glob}`, relative, traversalCheck)
          ).filter((file) => {
            const nested = path.relative(target, path.join(this.root, file)).split(path.sep)
            return !nested
              .slice(0, -1)
              .some((part) => ["dist", "build", ".next", "__pycache__"].includes(part))
          })
    } catch (error) {
      if (!(error instanceof ProjectSearchDeadline)) throw error
      await this.validate(target)
      check()
      return {
        matches: [],
        scannedFiles: 0,
        skippedFiles: 0,
        incomplete: true,
        stoppedReason: "time" as const
      }
    }
    const result = await searchBotProject(
      files,
      pattern,
      async (relative, maxBytes) => {
        const candidate = this.resolve(relative)
        const extension = path.extname(candidate).toLowerCase()
        if (CMB_KNOWN_BINARY_EXTENSIONS.has(extension)) throw new Error("二进制文件不参与内容搜索")
        const bytes = await this.readBytes(relative, maxBytes)
        return {
          text: iconv.decode(bytes, detectCmbFileEncoding(bytes, extension)),
          bytes: bytes.length
        }
      },
      check,
      deadline
    )
    await this.validate(target)
    check()
    return result
  }

  private async readBytes(relative: string, maxBytes: number): Promise<Buffer> {
    const candidate = this.resolve(relative)
    await this.validate(candidate)
    const opened = await openStableFileHandle(this.root, candidate)
    try {
      if ((await opened.handle.stat()).nlink !== 1)
        throw new Error("项目工具不读取或修改硬链接文件")
      const bytes = await readStableFileHandleBounded(opened, maxBytes)
      await this.validate(candidate)
      return bytes
    } finally {
      await opened.handle.close()
    }
  }

  private async readText(relative: string) {
    const bytes = await this.readBytes(relative, MAX_BYTES)
    if (bytes.includes(0)) throw new Error("项目文件是二进制格式")
    // Match exact UTF-8 skill copying: decode BOM as text instead of discarding it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    return { bytes, text, sha256: hash(bytes) }
  }

  async read(relative: string): Promise<{ text: string; sha256: string }> {
    const { text, sha256 } = await this.readText(relative)
    return { text, sha256 }
  }

  async readArtifact(relative: string): Promise<{ bytes: Buffer; sha256: string }> {
    const bytes = await this.readBytes(relative, BOT_FILE_BYTES)
    return { bytes, sha256: hash(bytes) }
  }

  async assertNewArtifact(relative: string): Promise<void> {
    const candidate = this.resolve(relative)
    await this.validate(candidate, true, true)
    const exists = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (exists) throw new Error("目标文件已存在，请选择新文件名")
  }

  private async createBytes(candidate: string, bytes: Buffer, check: () => void): Promise<void> {
    await this.validate(candidate, true, true)
    check()
    const handle = await open(candidate, "wx", 0o600)
    try {
      await this.validate(candidate, true)
      const [opened, named] = await Promise.all([handle.stat(), stat(candidate)])
      if (opened.ino !== named.ino || opened.dev !== named.dev || opened.nlink !== 1)
        throw new Error("创建文件时路径已变化")
      check()
      await handle.writeFile(bytes)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /** Binary templates use exclusive creation. Existing binary files are never
   * overwritten, and the caller's approved effect records an interrupted copy.
   */
  async createArtifact(
    relative: string,
    bytes: Buffer,
    check: () => void
  ): Promise<{ path: string; sha256: string; size: number }> {
    if (bytes.length > BOT_FILE_BYTES) throw new Error("项目文件最大 25 MiB")
    const expected = hash(bytes)
    return withBotProjectMutation(this.root, async () => {
      check()
      await this.assertNewArtifact(relative)
      const candidate = this.resolve(relative)
      await this.createBytes(candidate, bytes, check)
      const copied = await this.readArtifact(relative)
      if (copied.sha256 !== expected) throw new Error("复制后文件已变化，需人工核对")
      return { path: relative, sha256: expected, size: bytes.length }
    })
  }

  async prepare(input: {
    path: string
    expectedHash: string | null
    content?: string
    oldText?: string
    newText?: string
    replaceAll?: boolean
    /** Exact skill-file copies retain the source format, including absence of a BOM. */
    format?: "preserve" | "verbatim"
  }): Promise<ProjectFileChange> {
    const candidate = this.resolve(input.path)
    await this.validate(candidate, true, input.expectedHash === null)
    const existing = await this.readText(input.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && input.expectedHash === null) return null
      throw error
    })
    if ((existing?.sha256 ?? null) !== input.expectedHash)
      throw new Error("文件已变化，请重新读取后生成修改；不能覆盖他人的改动")
    const preserve = input.format !== "verbatim"
    // A homogeneous Windows file keeps CRLF even when model arguments use LF.
    // Mixed endings are left intact; normalizing them would change unrelated lines.
    const crlf =
      preserve && existing?.text.includes("\r\n") && !/(^|[^\r])\n|\r(?!\n)/.test(existing.text)
    const format = (text: string) => (crlf ? text.replace(/\r?\n/g, "\r\n") : text)
    let after =
      input.content !== undefined
        ? format(input.content)
        : replace(
            existing?.text ?? "",
            format(input.oldText ?? ""),
            format(input.newText ?? ""),
            input.replaceAll
          ).newContent
    if (preserve && existing?.text.startsWith("\ufeff") && !after.startsWith("\ufeff"))
      after = "\ufeff" + after
    if (Buffer.byteLength(after) > MAX_BYTES) throw new Error("项目文本文件最大 2 MB")
    if (after === existing?.text) throw new Error("文件内容没有变化")
    return {
      path: input.path,
      beforeHash: existing?.sha256 ?? null,
      afterHash: hash(Buffer.from(after)),
      beforeBytes: existing?.bytes ?? null,
      after,
      diff: createTwoFilesPatch(
        input.path,
        input.path,
        existing?.text ?? "",
        after,
        "修改前",
        "修改后"
      )
    }
  }

  async commit(
    change: ProjectFileChange,
    check: () => void
  ): Promise<{ path: string; sha256: string }> {
    return withBotProjectMutation(this.root, async () => {
      check()
      const candidate = this.resolve(change.path)
      await this.validate(candidate, true, change.beforeHash === null)
      const bytes = Buffer.from(change.after)
      if (bytes.length > MAX_BYTES || hash(bytes) !== change.afterHash)
        throw new Error("修改内容校验失败")
      if (change.beforeHash === null) {
        // Exclusive creation cannot overwrite a file produced while the approval card was open.
        await this.createBytes(candidate, bytes, check)
      } else {
        const opened = await openStableWritableFileHandle(this.root, candidate)
        try {
          const before = await readStableFileHandleBounded(opened, MAX_BYTES)
          if (hash(before) !== change.beforeHash)
            throw new Error("审批期间文件已变化，请重新读取并审批")
          await opened.assertPathIdentity()
          check()
          // Use the authorized inode. Replacing by pathname could follow a swapped parent directory.
          let offset = 0
          while (offset < bytes.length) {
            const result = await opened.handle.write(bytes, offset, bytes.length - offset, offset)
            if (!result.bytesWritten) throw new Error("文件写入未取得进展")
            offset += result.bytesWritten
          }
          await opened.handle.truncate(bytes.length)
          await opened.handle.sync()
          await opened.assertPathIdentity()
        } finally {
          await opened.handle.close()
        }
      }
      const after = await this.read(change.path)
      if (after.sha256 !== change.afterHash) throw new Error("写入后文件已变化，需人工核对")
      return { path: change.path, sha256: after.sha256 }
    })
  }
}
