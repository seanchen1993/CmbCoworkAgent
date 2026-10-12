import { lstat, readlink } from "node:fs/promises"
import path from "node:path"
import { createTwoFilesPatch } from "diff"
import { openStableFileHandle, readStableFileHandleBounded } from "./stable-file-handle"

export const WORKTREE_PATCH_CHARACTERS = 256_000
interface PreviewQueryResult {
  code: number
  stdout: string
  stderr: string
  outputLimitExceeded?: boolean
}
type Query = (args: string[], maxBytes: number) => Promise<PreviewQueryResult>

/** Preview the current deliverable against its frozen base, including staged,
 * unstaged and new files. Reads never stage files or execute repository filters. */
export async function readWorktreePreview(input: {
  directory: string
  workspaceDirectory: string
  sourceRelativePath: string
  baseCommit: string
  query: Query
}): Promise<{ patch: string; patchTruncated: boolean; warnings: string[] }> {
  const { query } = input
  const scope = input.sourceRelativePath || "."
  const tracked = await query(
    [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      input.baseCommit,
      "--",
      scope
    ],
    WORKTREE_PATCH_CHARACTERS * 4
  )
  if (tracked.code !== 0 && !tracked.outputLimitExceeded)
    throw new Error(tracked.stderr || "无法读取工作区差异")
  let patch = tracked.stdout.slice(0, WORKTREE_PATCH_CHARACTERS)
  let patchTruncated = Boolean(tracked.outputLimitExceeded || tracked.stdout.length > patch.length)
  const warnings: string[] = []
  if (/^Binary files .+ differ$|^GIT binary patch$/m.test(patch)) {
    patchTruncated = true
    warnings.push("二进制变更未提供文本内容，请在工作区中核对原文件。")
  }
  const append = (value: string) => {
    const remaining = WORKTREE_PATCH_CHARACTERS - patch.length
    patch += value.slice(0, remaining)
    if (value.length > remaining) patchTruncated = true
  }
  const names = await query(
    ["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", scope],
    256_000
  )
  if (names.code !== 0) throw new Error(names.stderr || "无法读取新增文件列表")
  const files = names.stdout.split("\0").filter(Boolean)
  for (const [index, relative] of files.entries()) {
    if (index >= 200 || patch.length >= WORKTREE_PATCH_CHARACTERS) {
      patchTruncated = true
      warnings.push("新增文件超出预览范围，请在工作区中检查剩余文件。")
      break
    }
    const candidate = path.resolve(input.directory, relative)
    const scoped = path.relative(input.workspaceDirectory, candidate)
    if (scoped === ".." || scoped.startsWith(`..${path.sep}`) || path.isAbsolute(scoped))
      throw new Error("新增文件超出任务工作区")
    // Git paths can contain tabs/newlines. Quote those as one header, never
    // interpolate them into a shell command or allow forged patch sections.
    const quote = (value: string) => (/[\s"\\]/.test(value) ? JSON.stringify(value) : value)
    const oldPath = quote(`a/${relative}`),
      newPath = quote(`b/${relative}`)
    const header = `diff --git ${oldPath} ${newPath}\n`
    try {
      const info = await lstat(candidate)
      let text: string
      let mode = "100644"
      if (info.isSymbolicLink()) {
        // Show the link value itself. Never follow it to another checkout or
        // private Host directory, including when the destination is missing.
        text = await readlink(candidate)
        mode = "120000"
      } else {
        const opened = await openStableFileHandle(input.workspaceDirectory, candidate)
        try {
          const bytes = await readStableFileHandleBounded(opened, WORKTREE_PATCH_CHARACTERS)
          if (bytes.includes(0)) throw new Error("二进制文件不提供文本预览")
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
          if (info.mode & 0o111) mode = "100755"
        } finally {
          await opened.handle.close()
        }
      }
      const unified = createTwoFilesPatch("/dev/null", newPath, "", text).replace(/^=+\n/, "")
      append(`${header}new file mode ${mode}\n${unified}`)
    } catch {
      patchTruncated = true
      warnings.push(
        `${JSON.stringify(relative)}：文件过大、非 UTF-8 文本或读取期间发生变化，未预览内容。`
      )
      append(`${header}new file mode 100644\nBinary files /dev/null and ${newPath} differ\n`)
    }
  }
  return { patch, patchTruncated, warnings }
}
