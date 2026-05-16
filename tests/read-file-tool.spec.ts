/**
 * Regression tests for read_file defaults, pagination, streaming, and truncation.
 *
 * Run:
 *   npx tsx tests/read-file-tool.spec.ts
 */

import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { createFilesystemMiddleware } from "deepagents"
import * as iconv from "iconv-lite"
import { LocalSandbox } from "../src/main/agent/local-sandbox.ts"
import {
  READ_FILE_DEFAULT_LIMIT,
  trimReadFileOutputLines,
  truncateReadFileOutputByChars
} from "../src/main/agent/read-file-output.ts"
import {
  patchRuntimeReadFileTool,
  type ReadableFilesystemBackend
} from "../src/main/agent/read-file-tool.ts"
import type { HookConfig } from "../src/main/hooks/types.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

async function withTempDir<T>(name: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), `${name}-`))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function outputLines(output: string): string[] {
  return output.split("\n")
}

type TestGrepMatch = { path: string; line: number; text: string }

function expectGrepMatches(result: Awaited<ReturnType<LocalSandbox["grepRaw"]>>): TestGrepMatch[] {
  assert(Array.isArray(result), `expected grep matches, got: ${String(result)}`)
  return result
}

type PatchRuntimeReadFileToolParams = Parameters<typeof patchRuntimeReadFileTool>[0]

function findReadFileTool(
  middleware: PatchRuntimeReadFileToolParams["middleware"]
): NonNullable<NonNullable<PatchRuntimeReadFileToolParams["middleware"]["tools"]>[number]> {
  const readTool = middleware.tools?.find((tool) => tool.name === "read_file")
  if (!readTool) throw new Error("patched read_file tool was not found")
  return readTool
}

function nodeCommand(script: string): string {
  const encoded = Buffer.from(script, "utf8").toString("base64")
  return `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`
}

function makeHook(
  partial: Partial<HookConfig> & Pick<HookConfig, "event" | "command">
): HookConfig {
  return {
    id: partial.id ?? "test-hook",
    event: partial.event,
    matcher: partial.matcher,
    type: partial.type ?? "command",
    command: partial.command,
    timeout: partial.timeout ?? 8000,
    enabled: partial.enabled ?? true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial
  }
}

async function testSmallFilePagination(): Promise<void> {
  await withTempDir("read-file-small", async (dir) => {
    const file = join(dir, "small.txt")
    await writeFile(file, "alpha\nbeta\ngamma", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const firstPage = await sandbox.read(file, 0, 2)
    assert(
      firstPage.startsWith("[Lines 1-2 of 3. Use offset=2 to read more.]"),
      `unexpected first page header: ${firstPage}`
    )
    assert(firstPage.includes("     1\talpha"), "first page should include line 1")
    assert(firstPage.includes("     2\tbeta"), "first page should include line 2")
    assert(!firstPage.includes("gamma"), "first page should not include line 3")

    const secondPage = await sandbox.read(file, 2, 2)
    assert(!secondPage.startsWith("[Lines"), "last page should not have pagination header")
    assert(secondPage.includes("     3\tgamma"), "second page should include line 3")
  })
}

async function testSmallFileTrailingNewlineDoesNotAddBlankLine(): Promise<void> {
  await withTempDir("read-file-small-trailing-newline", async (dir) => {
    const file = join(dir, "trailing.txt")
    await writeFile(file, "alpha\nbeta\n", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(!output.startsWith("[Lines"), `trailing newline should not create pagination: ${output}`)
    assert(output.includes("     1\talpha"), "read should include line 1")
    assert(output.includes("     2\tbeta"), "read should include line 2")
    assert(!output.includes("     3\t"), `trailing newline should not add a blank third line: ${output}`)

    const offsetOutput = await sandbox.read(file, 2, 10)
    assert(
      offsetOutput === `Error: Line offset 2 exceeds file length (2 lines)`,
      `offset should see two logical lines: ${offsetOutput}`
    )
  })
}

async function testSmallFilePreservesRealBlankLineBeforeTrailingNewline(): Promise<void> {
  await withTempDir("read-file-real-blank-before-trailing-newline", async (dir) => {
    const file = join(dir, "real-blank.txt")
    await writeFile(file, "alpha\n\n", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(output.includes("     1\talpha"), "read should include line 1")
    assert(output.includes("     2\t"), "read should preserve the real blank line")
    assert(!output.includes("     3\t"), `trailing newline should not add a third line: ${output}`)

    const offsetOutput = await sandbox.read(file, 2, 10)
    assert(
      offsetOutput === `Error: Line offset 2 exceeds file length (2 lines)`,
      `offset should count the real blank line but not the trailing terminator: ${offsetOutput}`
    )
  })
}

async function testLimitValidation(): Promise<void> {
  await withTempDir("read-file-limit", async (dir) => {
    const file = join(dir, "small.txt")
    await writeFile(file, "alpha\nbeta", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 20_001)
    assert(
      output === "Error: limit must be less than or equal to 20000",
      `unexpected max-limit error: ${output}`
    )
  })
}

async function testEmptyFileReminder(): Promise<void> {
  await withTempDir("read-file-empty", async (dir) => {
    const file = join(dir, "empty.txt")
    await writeFile(file, "", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === "System reminder: File exists but has empty contents",
      `unexpected empty file reminder: ${output}`
    )
  })
}

async function testOffsetOutOfRange(): Promise<void> {
  await withTempDir("read-file-offset", async (dir) => {
    const file = join(dir, "small.txt")
    await writeFile(file, "alpha\nbeta", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 10, 2)
    assert(
      output === "Error: Line offset 10 exceeds file length (2 lines)",
      `unexpected offset error: ${output}`
    )
  })
}

async function testKnownBinaryExtensionRejected(): Promise<void> {
  await withTempDir("read-file-binary", async (dir) => {
    const file = join(dir, "image.png")
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error reading file '${file}': Cannot read binary file type: .png`,
      `unexpected binary rejection: ${output}`
    )
  })
}

async function testKnownBinaryExtensionRejectedBeforeContentRead(): Promise<void> {
  await withTempDir("read-file-binary-fast-reject", async (dir) => {
    const file = join(dir, "image.png")
    await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      readEncodingSample: () => Promise<never>
      readFileBuffer: () => Promise<never>
    }
    patchable.readFileBuffer = async () => {
      throw new Error("known binary extension should be rejected before reading the file buffer")
    }
    patchable.readEncodingSample = async () => {
      throw new Error("known binary extension should be rejected before reading samples")
    }

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error reading file '${file}': Cannot read binary file type: .png`,
      `known binary extension should fast reject before content read: ${output}`
    )
  })
}

async function testUnknownBinaryWithNullByteRejected(): Promise<void> {
  await withTempDir("read-file-binary-unknown", async (dir) => {
    const file = join(dir, "blob")
    await writeFile(file, Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64, 0x65]))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error reading file '${file}': Cannot read text for file type: unknown`,
      `unexpected unknown binary rejection: ${output}`
    )
  })
}

async function testLargeUnknownBinaryWithNullByteInMiddleRejected(): Promise<void> {
  await withTempDir("read-file-binary-large-unknown", async (dir) => {
    const file = join(dir, "large-blob")
    const size = 11 * 1024 * 1024
    const content = Buffer.alloc(size, 0x61)
    content[Math.round((size - 8192) / 2) + 128] = 0
    await writeFile(file, content)
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error reading file '${file}': Cannot read text for file type: unknown`,
      `large binary sample should reject NUL outside the head sample: ${output.slice(0, 160)}`
    )
  })
}

async function testGbkFastPathDecoding(): Promise<void> {
  await withTempDir("read-file-gbk-fast", async (dir) => {
    const file = join(dir, "gbk.txt")
    await writeFile(file, iconv.encode("第一行中文\n第二行中文", "gbk"))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 2)
    assert(output.includes("     1\t第一行中文"), `GBK fast path line 1 was not decoded: ${output}`)
    assert(output.includes("     2\t第二行中文"), `GBK fast path line 2 was not decoded: ${output}`)
  })
}

async function testGbkEncodingAwareGrepFallback(): Promise<void> {
  await withTempDir("read-file-gbk-grep-fallback", async (dir) => {
    const file = join(dir, "gbk.txt")
    await writeFile(file, iconv.encode("第一行中文\n第二行中文", "gbk"))
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      readResolvedFileBuffer: (
        resolvedPath: string,
        displayPath: string,
        maxBytes?: number
      ) => Promise<{ buffer: Buffer; resolvedPath: string }>
    }
    patchable.ripgrepSearch = async () => null
    const originalReadResolvedFileBuffer = patchable.readResolvedFileBuffer.bind(sandbox)
    let usedNoFollowReader = false
    patchable.readResolvedFileBuffer = async (
      resolvedPath: string,
      displayPath: string,
      maxBytes?: number
    ) => {
      if (resolvedPath === file && typeof maxBytes === "number") usedNoFollowReader = true
      return originalReadResolvedFileBuffer(resolvedPath, displayPath, maxBytes)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("第二行中文", dir))
    assert(matches.length === 1, `GBK fallback should find one match: ${JSON.stringify(matches)}`)
    assert(
      matches[0]?.path === file,
      `GBK fallback should report the target file: ${matches[0]?.path}`
    )
    assert(
      matches[0]?.text === "第二行中文",
      `GBK fallback should decode matched line: ${matches[0]?.text}`
    )
    assert(usedNoFollowReader, "GBK fallback should read through the no-follow buffer helper")
  })
}

async function testGbkEncodingAwareGrepFallbackWorksInVirtualMode(): Promise<void> {
  await withTempDir("read-file-gbk-grep-fallback-virtual", async (dir) => {
    const file = join(dir, "gbk.txt")
    await writeFile(file, iconv.encode("第一行中文\n第二行中文", "gbk"))
    const sandbox = new LocalSandbox({ rootDir: dir, virtualMode: true })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
    }
    patchable.ripgrepSearch = async () => null

    const matches = expectGrepMatches(await sandbox.grepRaw("第二行中文", "/gbk.txt"))
    assert(
      matches.length === 1,
      `virtual-mode GBK fallback should find one match: ${JSON.stringify(matches)}`
    )
    assert(
      matches[0]?.path === "/gbk.txt",
      `virtual-mode GBK fallback should report virtual path: ${matches[0]?.path}`
    )
    assert(
      matches[0]?.text === "第二行中文",
      `virtual-mode GBK fallback should decode matched line: ${matches[0]?.text}`
    )
  })
}

async function testEncodingAwareGrepFallbackHonorsGlobForSingleFile(): Promise<void> {
  await withTempDir("read-file-grep-single-file-glob", async (dir) => {
    const subdir = join(dir, "sub")
    await mkdir(subdir)
    const textFile = join(dir, "a.txt")
    const jsFile = join(dir, "a.js")
    const subJsFile = join(subdir, "a.js")
    await writeFile(textFile, "needle text", "utf8")
    await writeFile(jsFile, "needle js", "utf8")
    await writeFile(subJsFile, "needle sub js", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<Record<string, Array<[number, string]>>>
    }
    patchable.ripgrepSearch = async () => ({})

    const skipped = expectGrepMatches(await sandbox.grepRaw("needle", textFile, "*.js"))
    assert(
      skipped.length === 0,
      `single-file fallback should honor non-matching glob: ${JSON.stringify(skipped)}`
    )

    const matched = expectGrepMatches(await sandbox.grepRaw("needle", jsFile, "*.js"))
    assert(
      matched.length === 1 && matched[0]?.path === jsFile && matched[0]?.text === "needle js",
      `single-file fallback should keep matching glob: ${JSON.stringify(matched)}`
    )

    const skippedByDirGlob = expectGrepMatches(await sandbox.grepRaw("needle", jsFile, "sub/*.js"))
    assert(
      skippedByDirGlob.length === 0,
      `single-file fallback should honor directory glob mismatch: ${JSON.stringify(skippedByDirGlob)}`
    )

    const matchedByDirGlob = expectGrepMatches(await sandbox.grepRaw("needle", subJsFile, "sub/*.js"))
    assert(
      matchedByDirGlob.length === 1 &&
        matchedByDirGlob[0]?.path === subJsFile &&
        matchedByDirGlob[0]?.text === "needle sub js",
      `single-file fallback should honor directory glob match: ${JSON.stringify(matchedByDirGlob)}`
    )
  })
}

async function testEncodingAwareGrepFallbackTruncatesLongMatchedLinesBeforeStoring(): Promise<void> {
  await withTempDir("read-file-grep-fallback-long-line", async (dir) => {
    const file = join(dir, "long-line.txt")
    const hiddenTail = "tail-should-not-be-retained"
    await writeFile(file, `needle ${"x".repeat(20_000)} ${hiddenTail}`, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
    }
    patchable.ripgrepSearch = async () => null

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", file))
    assert(matches.length === 1, `fallback should return one long-line match: ${matches.length}`)
    assert(matches[0]?.path === file, `fallback should report the target file: ${matches[0]?.path}`)
    assert(matches[0]?.text.startsWith("needle "), `fallback should keep the matched prefix`)
    assert(
      matches[0]?.text.endsWith("...(truncated)"),
      `fallback should truncate long matched lines: ${matches[0]?.text.length}`
    )
    assert(
      !matches[0]?.text.includes(hiddenTail),
      "fallback should not retain hidden tail content after truncation"
    )
  })
}

async function testEncodingAwareGrepFallbackSkipsSensitiveBeforeDecode(): Promise<void> {
  await withTempDir("read-file-grep-sensitive-prefilter", async (dir) => {
    const safeFile = join(dir, "safe.txt")
    const blockedFile = join(dir, "blocked.txt")
    await writeFile(safeFile, "needle safe", "utf8")
    await writeFile(blockedFile, "needle blocked", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir, windowsSandbox: "elevated" })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      isSensitiveSandboxPath: (
        filePath: string,
        realpathCache?: Map<string, string | null>
      ) => boolean
      detectEncoding: (buffer: Buffer, ext?: string) => string
    }
    patchable.ripgrepSearch = async () => null
    const originalIsSensitiveSandboxPath = patchable.isSensitiveSandboxPath.bind(sandbox)
    patchable.isSensitiveSandboxPath = (
      filePath: string,
      realpathCache?: Map<string, string | null>
    ) => {
      return filePath === blockedFile || originalIsSensitiveSandboxPath(filePath, realpathCache)
    }
    const originalDetectEncoding = patchable.detectEncoding.bind(sandbox)
    let decodedBlockedFile = false
    patchable.detectEncoding = (buffer: Buffer, ext?: string) => {
      if (buffer.includes("needle blocked")) decodedBlockedFile = true
      return originalDetectEncoding(buffer, ext)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", dir))
    assert(
      matches.some((match) => match.path === safeFile && match.text === "needle safe"),
      `fallback should keep normal grep results: ${JSON.stringify(matches)}`
    )
    assert(
      !matches.some((match) => match.path === blockedFile),
      `fallback should filter sensitive grep results: ${JSON.stringify(matches)}`
    )
    assert(!decodedBlockedFile, "fallback should skip sensitive candidates before decoding")
  })
}

async function testEncodingAwareGrepFallbackDoesNotFollowSymlinkFiles(): Promise<void> {
  await withTempDir("read-file-grep-symlink-prefilter", async (dir) => {
    const safeFile = join(dir, "safe.txt")
    const targetFile = join(dir, "target.txt")
    const linkFile = join(dir, "linked.txt")
    await writeFile(safeFile, "needle safe", "utf8")
    await writeFile(targetFile, "needle target", "utf8")
    try {
      await symlink(targetFile, linkFile)
    } catch (error) {
      console.warn(
        `Skipping grep symlink fallback test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      detectEncoding: (buffer: Buffer, ext?: string) => string
    }
    patchable.ripgrepSearch = async () => null
    const originalDetectEncoding = patchable.detectEncoding.bind(sandbox)
    let decodedSymlinkTarget = false
    patchable.detectEncoding = (buffer: Buffer, ext?: string) => {
      if (buffer.includes("needle target")) decodedSymlinkTarget = true
      return originalDetectEncoding(buffer, ext)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", dir, "{safe.txt,linked.txt}"))
    assert(
      matches.some((match) => match.path === safeFile && match.text === "needle safe"),
      `fallback should keep normal file matches: ${JSON.stringify(matches)}`
    )
    assert(
      !matches.some((match) => match.path === linkFile || match.text.includes("target")),
      `fallback should not follow or read symlink file matches: ${JSON.stringify(matches)}`
    )
    assert(!decodedSymlinkTarget, "fallback should skip symlink candidates before decoding")
  })
}

async function testEncodingAwareGrepFallbackSkipsHiddenSkillBeforeDecode(): Promise<void> {
  await withTempDir("read-file-grep-hidden-prefilter", async (dir) => {
    const safeFile = join(dir, "safe.txt")
    const hiddenDir = join(dir, "hidden-skill")
    const hiddenFile = join(hiddenDir, "SKILL.md")
    await mkdir(hiddenDir)
    await writeFile(safeFile, "needle safe", "utf8")
    await writeFile(hiddenFile, "needle hidden skill", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    sandbox.setHiddenSkillDirs([hiddenDir])
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      detectEncoding: (buffer: Buffer, ext?: string) => string
    }
    patchable.ripgrepSearch = async () => null
    const originalDetectEncoding = patchable.detectEncoding.bind(sandbox)
    let decodedHiddenFile = false
    patchable.detectEncoding = (buffer: Buffer, ext?: string) => {
      if (buffer.includes("needle hidden skill")) decodedHiddenFile = true
      return originalDetectEncoding(buffer, ext)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", dir))
    assert(
      matches.some((match) => match.path === safeFile && match.text === "needle safe"),
      `fallback should keep normal grep results: ${JSON.stringify(matches)}`
    )
    assert(
      !matches.some((match) => match.path === hiddenFile || match.text.includes("hidden skill")),
      `fallback should not return hidden skill results: ${JSON.stringify(matches)}`
    )
    assert(!decodedHiddenFile, "fallback should skip hidden skill candidates before decoding")
  })
}

async function testEncodingAwareGrepFallbackStopsAtOutputLimits(): Promise<void> {
  await withTempDir("read-file-grep-fallback-cap", async (dir) => {
    const fileCount = 230
    for (let index = 0; index < fileCount; index++) {
      await writeFile(join(dir, `match-${String(index).padStart(3, "0")}.txt`), "needle", "utf8")
    }
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      readResolvedFileBuffer: (
        resolvedPath: string,
        displayPath: string,
        maxBytes?: number
      ) => Promise<{ buffer: Buffer; resolvedPath: string }>
    }
    patchable.ripgrepSearch = async () => null
    const originalReadResolvedFileBuffer = patchable.readResolvedFileBuffer.bind(sandbox)
    let readCount = 0
    patchable.readResolvedFileBuffer = async (
      resolvedPath: string,
      displayPath: string,
      maxBytes?: number
    ) => {
      readCount++
      return originalReadResolvedFileBuffer(resolvedPath, displayPath, maxBytes)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", dir))
    assert(
      readCount <= 201,
      `fallback should stop reading files after reaching match limits, read ${readCount}`
    )
    assert(
      matches.some(
        (match) =>
          match.path === "(truncated)" &&
          match.text.includes("Fallback search stopped after reaching scan/output limits")
      ),
      `fallback should report early stop: ${JSON.stringify(matches.slice(-3))}`
    )
    assert(
      matches.filter((match) => match.path !== "(truncated)").length <= 200,
      `fallback should cap normal matches before returning: ${matches.length}`
    )
  })
}

async function testEncodingAwareGrepFallbackStopsAtScanLimitWithoutMatches(): Promise<void> {
  await withTempDir("read-file-grep-fallback-scan-cap", async (dir) => {
    const fileCount = 1_020
    for (let index = 0; index < fileCount; index++) {
      await writeFile(
        join(dir, `candidate-${String(index).padStart(4, "0")}.txt`),
        "haystack",
        "utf8"
      )
    }
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<null>
      readResolvedFileBuffer: (
        resolvedPath: string,
        displayPath: string,
        maxBytes?: number
      ) => Promise<{ buffer: Buffer; resolvedPath: string }>
    }
    patchable.ripgrepSearch = async () => null
    const originalReadResolvedFileBuffer = patchable.readResolvedFileBuffer.bind(sandbox)
    let readCount = 0
    patchable.readResolvedFileBuffer = async (
      resolvedPath: string,
      displayPath: string,
      maxBytes?: number
    ) => {
      readCount++
      return originalReadResolvedFileBuffer(resolvedPath, displayPath, maxBytes)
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle-never-present", dir))
    assert(
      readCount === 1_000,
      `fallback should stop reading candidates at the scan limit, read ${readCount}`
    )
    assert(
      matches.length === 1 &&
        matches[0]?.path === "(truncated)" &&
        matches[0]?.text.includes("Fallback search stopped after reaching scan/output limits"),
      `fallback should report scan-limit early stop without matches: ${JSON.stringify(matches)}`
    )
  })
}

async function testGrepRawRejectsHiddenSkillSymlinkBeforeRipgrep(): Promise<void> {
  await withTempDir("read-file-grep-hidden-symlink-base", async (dir) => {
    const hiddenDir = join(dir, "hidden-skill")
    const targetFile = join(hiddenDir, "SKILL.md")
    const linkFile = join(dir, "link.md")
    await mkdir(hiddenDir)
    await writeFile(targetFile, "needle hidden skill", "utf8")
    try {
      await symlink(targetFile, linkFile)
    } catch (error) {
      console.warn(
        `Skipping grep hidden symlink base test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir })
    sandbox.setHiddenSkillDirs([hiddenDir])
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<Record<string, Array<[number, string]>>>
    }
    let calledRipgrep = false
    patchable.ripgrepSearch = async () => {
      calledRipgrep = true
      return { [linkFile]: [[1, "needle hidden skill"]] }
    }

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", linkFile))
    assert(
      matches.length === 0,
      `grep should reject hidden skill symlink base: ${JSON.stringify(matches)}`
    )
    assert(!calledRipgrep, "grep should reject symlink base before invoking ripgrep")
  })
}

async function testGrepRawFiltersHiddenSkillSymlinkResults(): Promise<void> {
  await withTempDir("read-file-grep-hidden-symlink-result", async (dir) => {
    const safeFile = join(dir, "safe.md")
    const hiddenDir = join(dir, "hidden-skill")
    const targetFile = join(hiddenDir, "SKILL.md")
    const linkFile = join(dir, "link.md")
    await mkdir(hiddenDir)
    await writeFile(safeFile, "needle safe", "utf8")
    await writeFile(targetFile, "needle hidden skill", "utf8")
    try {
      await symlink(targetFile, linkFile)
    } catch (error) {
      console.warn(
        `Skipping grep hidden symlink result test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir })
    sandbox.setHiddenSkillDirs([hiddenDir])
    const patchable = sandbox as unknown as {
      ripgrepSearch: () => Promise<Record<string, Array<[number, string]>>>
    }
    patchable.ripgrepSearch = async () => ({
      [safeFile]: [[1, "needle safe"]],
      [linkFile]: [[1, "needle hidden skill"]]
    })

    const matches = expectGrepMatches(await sandbox.grepRaw("needle", dir))
    assert(
      matches.some((match) => match.path === safeFile && match.text === "needle safe"),
      `grep should keep normal ripgrep results: ${JSON.stringify(matches)}`
    )
    assert(
      !matches.some((match) => match.path === linkFile || match.text.includes("hidden skill")),
      `grep should filter symlink results that resolve into hidden skills: ${JSON.stringify(matches)}`
    )
  })
}

async function testReadFileBufferRejectsFileOverMaxBytes(): Promise<void> {
  await withTempDir("read-file-buffer-max-bytes", async (dir) => {
    const file = join(dir, "oversized.txt")
    await writeFile(file, "needle oversized", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      readFileBuffer: (
        filePath: string,
        maxBytes?: number
      ) => Promise<{ buffer: Buffer; resolvedPath: string }>
    }

    let rejected = false
    try {
      await patchable.readFileBuffer(file, 4)
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("exceeds maximum readable size")
    }
    assert(rejected, "readFileBuffer should reject files larger than maxBytes")
  })
}

async function testReadFileBufferAcceptsFileAtMaxBytes(): Promise<void> {
  await withTempDir("read-file-buffer-max-bytes-equal", async (dir) => {
    const file = join(dir, "exact.txt")
    await writeFile(file, "1234", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    const patchable = sandbox as unknown as {
      readFileBuffer: (
        filePath: string,
        maxBytes?: number
      ) => Promise<{ buffer: Buffer; resolvedPath: string }>
    }

    const { buffer } = await patchable.readFileBuffer(file, 4)
    assert(buffer.toString("utf8") === "1234", "readFileBuffer should accept file at maxBytes")
  })
}

async function testGbkStreamingPathDecoding(): Promise<void> {
  await withTempDir("read-file-gbk-stream", async (dir) => {
    const file = join(dir, "large-gbk.txt")
    const line = `中文内容${"x".repeat(1024)}`
    const content = Array.from({ length: 12_000 }, (_, index) => `${line}-${index + 1}`).join("\n")
    await writeFile(file, iconv.encode(content, "gbk"))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 11_998, 2)
    assert(
      output.includes(" 11999\t中文内容"),
      `GBK streaming path target line 11999 was not decoded: ${output.slice(0, 160)}`
    )
    assert(
      output.includes(" 12000\t中文内容"),
      `GBK streaming path target line 12000 was not decoded: ${output.slice(0, 160)}`
    )
  })
}

async function testGbkStreamingDetectionAfterAsciiPrefix(): Promise<void> {
  await withTempDir("read-file-gbk-stream-prefix", async (dir) => {
    const file = join(dir, "large-gbk-prefix.txt")
    const asciiPrefix = Buffer.from(`${"a".repeat(9 * 1024)}\n`, "utf8")
    const gbkBody = iconv.encode("第二行中文内容".repeat(900_000), "gbk")
    await writeFile(file, Buffer.concat([asciiPrefix, gbkBody]))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 1, 1)
    assert(
      output.includes("第二行中文内容"),
      `GBK streaming path should sample beyond ASCII prefix: ${output.slice(0, 160)}`
    )
    assert(
      !output.includes("�ڶ�"),
      `GBK streaming path should not be decoded as UTF-8: ${output.slice(0, 160)}`
    )
  })
}

async function testGbkStreamingDetectionNearTargetOffset(): Promise<void> {
  await withTempDir("read-file-gbk-stream-target", async (dir) => {
    const file = join(dir, "large-gbk-target.txt")
    const asciiPrefix = Buffer.from(`${"a".repeat(9 * 1024)}\n`, "utf8")
    const gbkLine = iconv.encode("第二行中文内容", "gbk")
    const asciiTail = Buffer.from(`\n${"b".repeat(11 * 1024 * 1024)}`, "utf8")
    await writeFile(file, Buffer.concat([asciiPrefix, gbkLine, asciiTail]))
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 1, 1)
    assert(
      output.includes("第二行中文内容"),
      `GBK target line should be decoded after target-region fallback: ${output.slice(0, 160)}`
    )
    assert(
      !output.includes("�ڶ�"),
      `GBK target line should not remain UTF-8 mojibake: ${output.slice(0, 160)}`
    )
  })
}

async function testLocalSandboxDefaultLimitMatchesReadFileTool(): Promise<void> {
  await withTempDir("read-file-default-limit", async (dir) => {
    const file = join(dir, "default-limit.txt")
    const content = Array.from({ length: READ_FILE_DEFAULT_LIMIT + 1 }, (_, index) => {
      return `line-${index + 1}`
    }).join("\n")
    await writeFile(file, content, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file)
    assert(
      output.startsWith(
        `[Lines 1-${READ_FILE_DEFAULT_LIMIT} of ${READ_FILE_DEFAULT_LIMIT + 1}. Use offset=${READ_FILE_DEFAULT_LIMIT} to read more.]`
      ),
      `LocalSandbox.read default limit should be ${READ_FILE_DEFAULT_LIMIT}: ${output.slice(0, 120)}`
    )
    assert(
      output.includes(`  ${READ_FILE_DEFAULT_LIMIT}\tline-${READ_FILE_DEFAULT_LIMIT}`),
      "default read should include line 2000"
    )
    assert(
      !output.includes(`line-${READ_FILE_DEFAULT_LIMIT + 1}`),
      "default read should not include line 2001"
    )
  })
}

async function testSymlinkRejected(): Promise<void> {
  await withTempDir("read-file-symlink", async (dir) => {
    const target = join(dir, "target.txt")
    const link = join(dir, "link.txt")
    await writeFile(target, "secret through symlink", "utf8")
    try {
      await symlink(target, link)
    } catch (error) {
      console.warn(
        `Skipping symlink rejection test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(link, 0, 10)
    assert(
      output === `Error reading file '${link}': Symlinks are not allowed: ${link}`,
      `unexpected symlink rejection: ${output}`
    )
  })
}

async function testElevatedSandboxBlocksSensitiveHomePath(): Promise<void> {
  const file = join(homedir(), ".ssh", "cmb-read-file-policy-test-does-not-need-to-exist")
  const sandbox = new LocalSandbox({ windowsSandbox: "elevated" })

  const output = await sandbox.read(file, 0, 10)
  assert(
    output === `Error: Access denied — '${file}' is restricted by sandbox policy.`,
    `unexpected sandbox policy rejection: ${output}`
  )
}

async function testElevatedSandboxBlocksSensitivePathViaParentSymlink(): Promise<void> {
  await withTempDir("read-file-sensitive-symlink", async (dir) => {
    const link = join(dir, "home-link")
    try {
      await symlink(homedir(), link, "dir")
    } catch (error) {
      console.warn(
        `Skipping parent symlink sandbox test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const file = join(link, ".ssh", "cmb-read-file-policy-test-does-not-need-to-exist")
    const sandbox = new LocalSandbox({ rootDir: dir, windowsSandbox: "elevated" })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error: Access denied — '${file}' is restricted by sandbox policy.`,
      `sensitive path through parent symlink should be rejected: ${output}`
    )
  })
}

async function testElevatedSandboxRealpathCacheDoesNotOutliveToolCall(): Promise<void> {
  await withTempDir("read-file-sensitive-realpath-cache", async (dir) => {
    const safeTarget = join(dir, "safe-target")
    await mkdir(join(safeTarget, ".ssh"), { recursive: true })
    await writeFile(join(safeTarget, ".ssh", "cache-test"), "safe content", "utf8")

    const link = join(dir, "home-link")
    try {
      await symlink(safeTarget, link, "dir")
    } catch (error) {
      console.warn(
        `Skipping realpath cache sandbox test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir, windowsSandbox: "elevated" })
    const file = join(link, ".ssh", "cache-test")

    const safeOutput = await sandbox.read(file, 0, 10)
    assert(
      safeOutput.includes("safe content"),
      `initial non-home symlink target should be readable: ${safeOutput}`
    )

    await rm(link, { force: true })
    await symlink(homedir(), link, "dir")

    const blockedOutput = await sandbox.read(file, 0, 10)
    assert(
      blockedOutput === `Error: Access denied — '${file}' is restricted by sandbox policy.`,
      `realpath cache should not survive across tool calls after symlink target changes: ${blockedOutput}`
    )
  })
}

async function testElevatedSandboxLsKeepsNormalEntriesAndFiltersSensitiveSymlink(): Promise<void> {
  await withTempDir("read-file-ls-sensitive-filter", async (dir) => {
    const safeFile = join(dir, "safe.txt")
    const link = join(dir, "home-link")
    await writeFile(safeFile, "safe content", "utf8")
    const sensitiveTarget = await findExistingSensitiveHomeDir()
    if (!sensitiveTarget) {
      console.warn("Skipping ls sensitive symlink filter test: no sensitive home dir exists")
      return
    }
    try {
      await symlink(sensitiveTarget, link, "dir")
    } catch (error) {
      console.warn(
        `Skipping ls sensitive symlink filter test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir, windowsSandbox: "elevated" })

    const entries = await sandbox.lsInfo(dir)
    const paths = entries.map((entry) => entry.path)
    assert(paths.includes(safeFile), `ls should keep normal entries: ${JSON.stringify(paths)}`)
    assert(
      !paths.some((entryPath) => entryPath.includes("home-link")),
      `ls should filter entries that resolve through a sensitive parent symlink: ${JSON.stringify(paths)}`
    )
  })
}

async function testElevatedSandboxGlobKeepsNormalEntriesAndFiltersSensitiveSymlink(): Promise<void> {
  await withTempDir("read-file-glob-sensitive-filter", async (dir) => {
    const safeFile = join(dir, "safe.txt")
    const link = join(dir, "home-link")
    await writeFile(safeFile, "safe content", "utf8")
    const sensitiveTarget = await findExistingSensitiveHomeDir()
    if (!sensitiveTarget) {
      console.warn("Skipping glob sensitive symlink filter test: no sensitive home dir exists")
      return
    }
    try {
      await symlink(sensitiveTarget, link, "dir")
    } catch (error) {
      console.warn(
        `Skipping glob sensitive symlink filter test: ${error instanceof Error ? error.message : error}`
      )
      return
    }
    const sandbox = new LocalSandbox({ rootDir: dir, windowsSandbox: "elevated" })

    const entries = await sandbox.globInfo("**/*", dir)
    const paths = entries.map((entry) => entry.path)
    assert(paths.includes(safeFile), `glob should keep normal entries: ${JSON.stringify(paths)}`)
    assert(
      !paths.some((entryPath) => entryPath.includes("home-link")),
      `glob should filter entries that resolve through a sensitive parent symlink: ${JSON.stringify(paths)}`
    )
  })
}

async function testLsAndGlobHiddenSkillChecksReuseRealpathCache(): Promise<void> {
  await withTempDir("read-file-hidden-skill-cache", async (dir) => {
    const hiddenDir = join(dir, "hidden-skill")
    const visibleFile = join(dir, "visible.txt")
    await mkdir(hiddenDir)
    await writeFile(join(hiddenDir, "SKILL.md"), "hidden skill", "utf8")
    await writeFile(visibleFile, "visible", "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })
    sandbox.setHiddenSkillDirs([hiddenDir])

    const patchable = sandbox as unknown as {
      isHiddenSkillPath: (filePath: string, realpathCache?: Map<string, string | null>) => boolean
    }
    const originalIsHiddenSkillPath = patchable.isHiddenSkillPath.bind(sandbox)

    const assertReusesSingleCache = async (
      label: string,
      action: () => Promise<unknown>
    ): Promise<void> => {
      const observedCaches: Array<Map<string, string | null> | undefined> = []
      patchable.isHiddenSkillPath = (
        filePath: string,
        realpathCache?: Map<string, string | null>
      ) => {
        observedCaches.push(realpathCache)
        return originalIsHiddenSkillPath(filePath, realpathCache)
      }

      await action()

      assert(observedCaches.length > 1, `${label} should check multiple hidden-skill paths`)
      assert(
        observedCaches.every((cache) => cache instanceof Map),
        `${label} should pass the per-tool realpath cache to every hidden-skill check`
      )
      const firstCache = observedCaches[0]
      assert(
        observedCaches.every((cache) => cache === firstCache),
        `${label} should reuse one realpath cache across hidden-skill checks`
      )
    }

    try {
      await assertReusesSingleCache("lsInfo", async () => sandbox.lsInfo(dir))
      await assertReusesSingleCache("globInfo", async () => sandbox.globInfo("**/*", dir))
    } finally {
      patchable.isHiddenSkillPath = originalIsHiddenSkillPath
    }
  })
}

async function findExistingSensitiveHomeDir(): Promise<string | null> {
  for (const name of [".ssh", ".aws", ".kube", ".docker", ".config"]) {
    const candidate = join(homedir(), name)
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next common sensitive directory.
    }
  }
  return null
}

async function testPreToolUseHookBlocksReadFile(): Promise<void> {
  await withTempDir("read-file-hook-block", async (dir) => {
    const file = join(dir, "blocked.txt")
    await writeFile(file, "must not be read", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      hooks: [
        makeHook({
          id: "block-read-file",
          event: "PreToolUse",
          matcher: "read_file",
          command: nodeCommand("console.log('blocked by read_file test'); process.exit(2)")
        })
      ]
    })

    const output = await sandbox.read(file, 0, 10)
    assert(
      output === `Error reading file '${file}': [Hook blocked] blocked by read_file test`,
      `unexpected hook block output: ${output}`
    )
  })
}

async function testPreToolUseHookCanUpdateReadFilePathWithSchemaName(): Promise<void> {
  await withTempDir("read-file-hook-file-path-schema-name", async (dir) => {
    const originalFile = join(dir, "original.txt")
    const redirectedFile = join(dir, "redirected.txt")
    const observedInput = join(dir, "hook-input.json")
    await writeFile(originalFile, "original content", "utf8")
    await writeFile(redirectedFile, "redirected content", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      hooks: [
        makeHook({
          id: "rewrite-read-file-schema-path",
          event: "PreToolUse",
          matcher: "read_file",
          command: nodeCommand(`
const fs = require('fs')
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(input)
  fs.writeFileSync(${JSON.stringify(observedInput)}, JSON.stringify(payload.tool_input))
  console.log(JSON.stringify({ updatedInput: { file_path: ${JSON.stringify(redirectedFile)} } }))
})
`)
        })
      ]
    })

    const output = await sandbox.read(originalFile, 0, 10)
    const hookInput = JSON.parse(await readFile(observedInput, "utf8")) as Record<string, unknown>
    assert(
      hookInput.file_path === originalFile && hookInput.filePath === originalFile,
      `read_file hook should expose both path keys: ${JSON.stringify(hookInput)}`
    )
    assert(
      output.includes("redirected content"),
      `read_file should honor updatedInput.file_path: ${output}`
    )
    assert(!output.includes("original content"), `read_file should not read original file: ${output}`)
  })
}

async function testPreToolUseHookCanUpdateReadFilePathWithCamelCaseName(): Promise<void> {
  await withTempDir("read-file-hook-file-path-camel-case", async (dir) => {
    const originalFile = join(dir, "original.txt")
    const redirectedFile = join(dir, "redirected.txt")
    await writeFile(originalFile, "original content", "utf8")
    await writeFile(redirectedFile, "redirected content", "utf8")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      hooks: [
        makeHook({
          id: "rewrite-read-file-camel-path",
          event: "PreToolUse",
          matcher: "read_file",
          command: nodeCommand(`
console.log(JSON.stringify({ updatedInput: { filePath: ${JSON.stringify(redirectedFile)} } }))
`)
        })
      ]
    })

    const output = await sandbox.read(originalFile, 0, 10)
    assert(
      output.includes("redirected content"),
      `read_file should honor updatedInput.filePath: ${output}`
    )
    assert(!output.includes("original content"), `read_file should not read original file: ${output}`)
  })
}

async function testLargeFileStreamingRange(): Promise<void> {
  await withTempDir("read-file-large", async (dir) => {
    const file = join(dir, "large.log")
    const payload = "x".repeat(1000)
    const lineCount = 11_050
    const content = Array.from({ length: lineCount }, (_, index) => {
      const lineNumber = index + 1
      return `line-${lineNumber}-${payload}`
    }).join("\n")
    await writeFile(file, content, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 5000, 3)
    assert(
      output.startsWith("[Lines 5001-5003 of 11050. Use offset=5003 to read more.]"),
      `unexpected streaming header: ${output.slice(0, 120)}`
    )
    assert(output.includes("  5001\tline-5001-"), "streaming read should include first target line")
    assert(output.includes("  5003\tline-5003-"), "streaming read should include last target line")
    assert(!output.includes("line-5004-"), "streaming read should not include the next line")
  })
}

async function testLargeFileTrailingNewlineDoesNotAddBlankLine(): Promise<void> {
  await withTempDir("read-file-large-trailing-newline", async (dir) => {
    const file = join(dir, "large-trailing.log")
    const payload = "x".repeat(1000)
    const lineCount = 11_050
    const content =
      Array.from({ length: lineCount }, (_, index) => {
        const lineNumber = index + 1
        return `line-${lineNumber}-${payload}`
      }).join("\n") + "\n"
    await writeFile(file, content, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, lineCount - 1, 5)
    assert(!output.startsWith("[Lines"), `last page should not have pagination: ${output.slice(0, 120)}`)
    assert(output.includes(` ${lineCount}\tline-${lineCount}-`), "last logical line should be readable")
    assert(
      !output.includes(` ${lineCount + 1}\t`),
      `trailing newline should not add a blank streaming line: ${output.slice(0, 200)}`
    )

    const offsetOutput = await sandbox.read(file, lineCount, 5)
    assert(
      offsetOutput === `Error: Line offset ${lineCount} exceeds file length (${lineCount} lines)`,
      `streaming offset should see ${lineCount} logical lines: ${offsetOutput}`
    )
  })
}

async function testLongLineContinuationTrimWarning(): Promise<void> {
  await withTempDir("read-file-long-line", async (dir) => {
    const file = join(dir, "long.json")
    await writeFile(file, "a".repeat(11 * 1024 * 1024), "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const directOutput = await sandbox.read(file, 0, 2)
    const directLines = outputLines(directOutput)
    assert(
      directLines.length === 3,
      `direct read should include truncation header plus 2 content lines, got ${directLines.length}`
    )
    assert(
      directLines[0] ===
        "[Lines 1-1 of 1. Output was truncated within line 1; reformat long lines or use a more specific command before continuing.]",
      `direct read should report within-line truncation: ${directLines[0]}`
    )
    assert(!directOutput.includes("   1.2\t"), "direct read should not expose lookahead output")

    const backendOutput = await sandbox.read(file, 0, 2, { includeLookahead: true })
    const backendLines = outputLines(backendOutput)
    assert(
      backendLines.length === 3,
      `includeLookahead read should return trimmed warning plus 2 content lines, got ${backendLines.length}`
    )
    assert(!backendOutput.includes("   1.2\t"), "includeLookahead read should not expose lookahead output")

    const trimmed = trimReadFileOutputLines(backendOutput, 2)
    const trimmedLines = outputLines(trimmed)
    assert(
      trimmedLines[0].includes("Output was truncated within line 1"),
      `missing continuation truncation warning: ${trimmedLines[0]}`
    )
    assert(trimmedLines.length === 3, `trimmed output should contain warning plus 2 lines`)
    assert(trimmedLines[1].startsWith("     1\t"), "trimmed output should keep the first chunk")
    assert(trimmedLines[2].startsWith("   1.1\t"), "trimmed output should keep the second chunk")
    assert(!trimmed.includes("   1.2\t"), "trimmed output should remove the lookahead continuation")
  })
}

async function testLongLineContinuationDoesNotHideNextSourceLine(): Promise<void> {
  await withTempDir("read-file-long-line-next-source", async (dir) => {
    const file = join(dir, "long-with-next.txt")
    await writeFile(file, `${"a".repeat(15_000)}\nSECOND`, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const directOutput = await sandbox.read(file, 0, 2)
    assert(
      directOutput.startsWith(
        "[Lines 1-1 of 2. Output was truncated before line 2; use offset=1 to read more.]"
      ),
      `direct read should point at hidden next source line: ${directOutput.slice(0, 160)}`
    )
    assert(directOutput.includes("     1\t"), "direct read should include the long line")
    assert(directOutput.includes("   1.1\t"), "direct read should include the continuation chunk")
    assert(
      !directOutput.includes("SECOND"),
      "direct read should not silently include partial next page"
    )

    const secondPage = await sandbox.read(file, 1, 2)
    assert(
      secondPage.includes("     2\tSECOND"),
      `second page should read hidden line: ${secondPage}`
    )

    const backendOutput = await sandbox.read(file, 0, 2, { includeLookahead: true })
    const trimmed = trimReadFileOutputLines(backendOutput, 2)
    assert(
      trimmed.startsWith("[More content is available after line 1; use offset=1 to read more.]"),
      `runtime trim should preserve next source line pagination: ${trimmed.slice(0, 160)}`
    )
    assert(!trimmed.includes("SECOND"), "runtime trim should remove lookahead next line")
  })
}

async function testReadFilePostHookSeesTrimmedLookaheadOutput(): Promise<void> {
  await withTempDir("read-file-hook-trimmed-lookahead", async (dir) => {
    const file = join(dir, "long-with-next.txt")
    const observed = join(dir, "hook-tool-result.txt")
    await writeFile(file, `${"a".repeat(15_000)}\nSECOND`, "utf8")
    const sandbox = new LocalSandbox({
      rootDir: dir,
      hooks: [
        makeHook({
          id: "capture-read-file-result",
          event: "PostToolUse",
          matcher: "read_file",
          command: nodeCommand(`
const fs = require('fs')
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const payload = JSON.parse(input)
  fs.writeFileSync(${JSON.stringify(observed)}, String(payload.tool_response || ''))
})
`)
        })
      ]
    })

    const output = await sandbox.read(file, 0, 2, { includeLookahead: true })
    const hookResult = await readFile(observed, "utf8")
    assert(!output.includes("SECOND"), `runtime-visible output should not expose lookahead: ${output}`)
    assert(
      output.startsWith("[More content is available after line 1; use offset=1 to read more.]"),
      `runtime-visible output should preserve pagination hint: ${output.slice(0, 160)}`
    )
    assert(!hookResult.includes("SECOND"), `PostToolUse hook should not see lookahead: ${hookResult}`)
    assert(
      hookResult.startsWith("[More content is available after line 1; use offset=1 to read more.]"),
      `PostToolUse hook should see the same trimmed pagination hint: ${hookResult.slice(0, 160)}`
    )
  })
}

async function testStreamingLastLongLineReportsContinuationTruncation(): Promise<void> {
  await withTempDir("read-file-streaming-last-long-line", async (dir) => {
    const file = join(dir, "large-last-long-line.txt")
    await writeFile(file, `${"p".repeat(11 * 1024 * 1024)}\n${"z".repeat(15_000)}`, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 1, 1)
    assert(
      output.startsWith(
        "[Lines 2-2 of 2. Output was truncated within line 2; reformat long lines or use a more specific command before continuing.]"
      ),
      `streaming read should report continuation truncation on the final line: ${output.slice(0, 160)}`
    )
    assert(output.includes("     2\t"), "streaming read should include the first chunk")
    assert(!output.includes("   2.1\t"), "direct streaming read should not expose overflow chunks")
  })
}

async function testLocalSandboxStopsFormattingAtCharBudget(): Promise<void> {
  await withTempDir("read-file-format-budget", async (dir) => {
    const file = join(dir, "large-lines.txt")
    await writeFile(file, `${"a".repeat(25_000)}\n${"b".repeat(25_000)}`, "utf8")
    const sandbox = new LocalSandbox({ rootDir: dir })

    const output = await sandbox.read(file, 0, 2, { maxFormattedContentChars: 12_000 })
    assert(
      output.startsWith(
        "[Lines 1-1 of 2. Output was truncated within line 1; reformat long lines or use a more specific command before continuing.]"
      ),
      `read should report early formatter truncation: ${output.slice(0, 160)}`
    )
    assert(output.includes("     1\t"), "read should keep the first visible chunk")
    assert(!output.includes("   1.1\t"), "read should not format beyond the char budget")
    assert(
      output.length < 13_000,
      `read output should stay near the requested budget: ${output.length}`
    )
  })
}

async function testPaginationHeaderDoesNotCountAgainstLimit(): Promise<void> {
  const raw = [
    "[Lines 1-3 of 5. Use offset=3 to read more.]",
    "     1\talpha",
    "     2\tbeta",
    "     3\tgamma"
  ].join("\n")

  const trimmed = trimReadFileOutputLines(raw, 2)
  assert(
    trimmed ===
      ["[Lines 1-2 of 5. Use offset=2 to read more.]", "     1\talpha", "     2\tbeta"].join("\n"),
    `pagination header should be adjusted after trimming: ${trimmed}`
  )
}

async function testPostHookFeedbackSurvivesLineTrim(): Promise<void> {
  const raw = [
    "[Lines 1-3 of 5. Use offset=3 to read more.]",
    "     1\talpha",
    "     2\tbeta",
    "     3\tgamma",
    "",
    "[Hook output]",
    "keep this feedback"
  ].join("\n")

  const trimmed = trimReadFileOutputLines(raw, 2)
  assert(
    trimmed.startsWith("[Lines 1-2 of 5. Use offset=2 to read more.]"),
    `pagination header should still be adjusted: ${trimmed}`
  )
  assert(!trimmed.includes("     3\tgamma"), "file content should still be trimmed to limit")
  assert(
    trimmed.endsWith("[Hook output]\nkeep this feedback"),
    `PostToolUse feedback should survive line trimming: ${trimmed}`
  )
}

async function testPostHookFeedbackSurvivesCharTruncation(): Promise<void> {
  const raw = [
    "[Lines 1-6 of 8. Use offset=6 to read more.]",
    `     1\t${"a".repeat(120)}`,
    `     2\t${"b".repeat(120)}`,
    `     3\t${"c".repeat(120)}`,
    `     4\t${"d".repeat(120)}`,
    `     5\t${"e".repeat(120)}`,
    `     6\t${"f".repeat(120)}`,
    "",
    "[Hook context]",
    "keep this policy feedback"
  ].join("\n")

  const truncated = truncateReadFileOutputByChars(raw, "/tmp/large.json", 120)
  assert(
    truncated.includes("[Output was truncated due to size limits."),
    `size truncation message should be present: ${truncated}`
  )
  assert(
    truncated.includes("[Hook context]\nkeep this policy feedback"),
    `PostToolUse feedback should survive char truncation: ${truncated}`
  )
  assert(!truncated.includes("     6\t"), "file content should still be truncated by char budget")
}

async function testCharTruncationStaysWithinBudgetAfterHeaderAdjustment(): Promise<void> {
  const raw = [
    "[Lines 1-6 of 8. Use offset=6 to read more.]",
    `     1\t${"a".repeat(120)}`,
    `     2\t${"b".repeat(120)}`,
    `     3\t${"c".repeat(120)}`,
    `     4\t${"d".repeat(120)}`,
    `     5\t${"e".repeat(120)}`,
    `     6\t${"f".repeat(120)}`
  ].join("\n")

  const truncated = truncateReadFileOutputByChars(raw, "/tmp/large.json", 100)
  assert(
    truncated.length <= 400,
    `char truncation should stay within the output budget after header adjustment: ${truncated.length}`
  )
  assert(
    truncated.includes("[Output was truncated due to size limits."),
    `size truncation message should be present: ${truncated}`
  )
}

async function testCharTruncationLeavesExactBudgetUntouched(): Promise<void> {
  const raw = "x".repeat(400)
  const output = truncateReadFileOutputByChars(raw, "/tmp/exact.txt", 100)
  assert(output === raw, "char truncation should not add a truncation message at the exact budget")
}

async function testPostHookFeedbackIsCappedDuringLineTrim(): Promise<void> {
  const raw = ["     1\talpha", "", "[Hook output]", "x".repeat(12_000)].join("\n")

  const trimmed = trimReadFileOutputLines(raw, 10)
  assert(trimmed.includes("[Hook output]"), "capped hook feedback should keep its header")
  assert(
    trimmed.includes("[Hook feedback truncated due to size limits.]"),
    `large hook feedback should be capped: ${trimmed.slice(-160)}`
  )
  assert(trimmed.length < 8_300, `capped hook feedback should stay bounded: ${trimmed.length}`)
}

async function testPostHookFeedbackIsCappedDuringCharTruncation(): Promise<void> {
  const raw = [
    "[Lines 1-4 of 8. Use offset=4 to read more.]",
    `     1\t${"a".repeat(120)}`,
    `     2\t${"b".repeat(120)}`,
    `     3\t${"c".repeat(120)}`,
    `     4\t${"d".repeat(120)}`,
    "",
    "[Hook output]",
    "x".repeat(12_000)
  ].join("\n")

  const truncated = truncateReadFileOutputByChars(raw, "/tmp/large.json", 120)
  assert(
    truncated.length <= 480,
    `char truncation should include capped suffix within budget: ${truncated.length}`
  )
  assert(
    truncated.includes("[Output was truncated due to size limits."),
    `size truncation message should be present: ${truncated}`
  )
  assert(
    !truncated.includes("x".repeat(1000)),
    "large hook feedback should not be preserved in full"
  )
}

async function testRuntimeReadFileToolPatchDefaultsAndTrims(): Promise<void> {
  const calls: Array<{
    filePath: string
    offset?: number
    limit?: number
    options?: { maxFormattedContentChars?: number; includeLookahead?: boolean }
  }> = []
  const backend: ReadableFilesystemBackend = {
    read(filePath, offset, limit, options) {
      calls.push({ filePath, offset, limit, options })
      return Array.from({ length: (limit ?? 0) + 1 }, (_, index) => {
        return `${(index + 1).toString().padStart(6)}\tline-${index + 1}`
      }).join("\n")
    }
  }
  const middleware = createFilesystemMiddleware({
    backend
  }) as unknown as PatchRuntimeReadFileToolParams["middleware"]
  patchRuntimeReadFileTool({ middleware, filesystemBackend: backend })
  const readTool = findReadFileTool(middleware)
  const schema = readTool.schema as { safeParse(input: unknown): { success: boolean } } | undefined

  assert(
    schema?.safeParse({ file_path: "/tmp/default.txt", limit: 20_001 }).success === false,
    "runtime read_file schema should reject limit > 20000"
  )

  const output = String(await readTool.invoke?.({ file_path: "/tmp/default.txt" }))
  assert(
    calls[0]?.offset === 0,
    `runtime read_file default offset should be 0: ${calls[0]?.offset}`
  )
  assert(
    calls[0]?.limit === READ_FILE_DEFAULT_LIMIT,
    `runtime read_file default limit should be ${READ_FILE_DEFAULT_LIMIT}: ${calls[0]?.limit}`
  )
  assert(
    outputLines(output).length === READ_FILE_DEFAULT_LIMIT + 1,
    `runtime read_file should trim output to ${READ_FILE_DEFAULT_LIMIT} content lines plus warning`
  )
  assert(
    output.startsWith(
      `[More content is available after line ${READ_FILE_DEFAULT_LIMIT}; use offset=${READ_FILE_DEFAULT_LIMIT} to read more.]`
    ),
    `runtime read_file should warn when an overflow source line is hidden: ${output.slice(0, 120)}`
  )
  assert(
    !output.includes(`line-${READ_FILE_DEFAULT_LIMIT + 1}`),
    "runtime read_file should remove overflow line"
  )
}

async function testRuntimeReadFileToolPassesOutputCharBudget(): Promise<void> {
  const observed: { maxFormattedContentChars?: number; includeLookahead?: boolean } = {}
  const backend: ReadableFilesystemBackend = {
    read(_filePath, _offset, _limit, options) {
      observed.maxFormattedContentChars = options?.maxFormattedContentChars
      observed.includeLookahead = options?.includeLookahead
      return "     1\tok"
    }
  }
  const middleware = createFilesystemMiddleware({
    backend
  }) as unknown as PatchRuntimeReadFileToolParams["middleware"]
  patchRuntimeReadFileTool({
    middleware,
    filesystemBackend: backend,
    toolTokenLimitBeforeEvict: 123
  })
  const readTool = findReadFileTool(middleware)

  await readTool.invoke?.({ file_path: "/tmp/budget.txt" })
  assert(
    observed.maxFormattedContentChars === 492,
    `runtime read_file should pass char budget to backend: ${observed.maxFormattedContentChars}`
  )
  assert(observed.includeLookahead === true, "runtime read_file should request lookahead")
}

async function testRuntimeReadFileToolUsesDefaultCharBudget(): Promise<void> {
  const observed: { maxFormattedContentChars?: number } = {}
  const backend: ReadableFilesystemBackend = {
    read(_filePath, _offset, _limit, options) {
      observed.maxFormattedContentChars = options?.maxFormattedContentChars
      return `     1\t${"x".repeat(90_000)}`
    }
  }
  const middleware = createFilesystemMiddleware({
    backend
  }) as unknown as PatchRuntimeReadFileToolParams["middleware"]
  patchRuntimeReadFileTool({ middleware, filesystemBackend: backend })
  const readTool = findReadFileTool(middleware)

  const output = String(await readTool.invoke?.({ file_path: "/tmp/default-budget.txt" }))
  assert(
    observed.maxFormattedContentChars === 80_000,
    `runtime read_file should inherit deepagents default char budget: ${observed.maxFormattedContentChars}`
  )
  assert(
    output.length <= 80_000,
    `runtime read_file should cap output by default: ${output.length}`
  )
  assert(
    output.includes("[Output was truncated due to size limits."),
    `runtime read_file should add truncation message by default: ${output.slice(-200)}`
  )
}

async function testRuntimeReadFileToolPreservesHookFeedback(): Promise<void> {
  const backend: ReadableFilesystemBackend = {
    read() {
      return [
        "[Lines 1-3 of 5. Use offset=3 to read more.]",
        "     1\talpha",
        "     2\tbeta",
        "     3\tgamma",
        "",
        "[Hook output]",
        "keep this feedback"
      ].join("\n")
    }
  }
  const middleware = createFilesystemMiddleware({
    backend
  }) as unknown as PatchRuntimeReadFileToolParams["middleware"]
  patchRuntimeReadFileTool({ middleware, filesystemBackend: backend })
  const readTool = findReadFileTool(middleware)

  const output = String(await readTool.invoke?.({ file_path: "/tmp/hook.txt", limit: 2 }))
  assert(
    output.startsWith("[Lines 1-2 of 5. Use offset=2 to read more.]"),
    `runtime read_file should adjust header: ${output}`
  )
  assert(!output.includes("     3\tgamma"), "runtime read_file should trim overflow file content")
  assert(
    output.endsWith("[Hook output]\nkeep this feedback"),
    `runtime read_file should preserve PostToolUse feedback: ${output}`
  )
}

async function testRuntimeReadFileToolFactoryReceivesGraphState(): Promise<void> {
  const state = { messages: ["current graph state"] }
  const store = { marker: "runtime store" }
  const observed: { state?: unknown; store?: unknown; limit?: number } = {}
  const backendFactory: PatchRuntimeReadFileToolParams["filesystemBackend"] = (config) => {
    observed.state = config.state
    observed.store = config.store
    return {
      read(_filePath, _offset, limit) {
        observed.limit = limit
        return "     1\tok"
      }
    }
  }
  const middleware = createFilesystemMiddleware({
    backend: { read: () => "     1\told" }
  }) as unknown as PatchRuntimeReadFileToolParams["middleware"]
  patchRuntimeReadFileTool({ middleware, filesystemBackend: backendFactory })
  const readTool = findReadFileTool(middleware)

  await readTool.invoke?.(
    { file_path: "/tmp/state.txt" },
    {
      configurable: {
        __pregel_scratchpad: {
          currentTaskInput: state
        }
      },
      store
    }
  )

  assert(
    observed.state === state,
    "runtime read_file backend factory should receive current graph state"
  )
  assert(observed.store === store, "runtime read_file backend factory should receive runtime store")
  assert(
    observed.limit === READ_FILE_DEFAULT_LIMIT,
    "runtime read_file backend factory path should use default limit"
  )
}

async function main(): Promise<void> {
  await testSmallFilePagination()
  await testSmallFileTrailingNewlineDoesNotAddBlankLine()
  await testSmallFilePreservesRealBlankLineBeforeTrailingNewline()
  await testLimitValidation()
  await testEmptyFileReminder()
  await testOffsetOutOfRange()
  await testKnownBinaryExtensionRejected()
  await testKnownBinaryExtensionRejectedBeforeContentRead()
  await testUnknownBinaryWithNullByteRejected()
  await testLargeUnknownBinaryWithNullByteInMiddleRejected()
  await testGbkFastPathDecoding()
  await testGbkEncodingAwareGrepFallback()
  await testGbkEncodingAwareGrepFallbackWorksInVirtualMode()
  await testEncodingAwareGrepFallbackHonorsGlobForSingleFile()
  await testEncodingAwareGrepFallbackTruncatesLongMatchedLinesBeforeStoring()
  await testEncodingAwareGrepFallbackSkipsSensitiveBeforeDecode()
  await testEncodingAwareGrepFallbackDoesNotFollowSymlinkFiles()
  await testEncodingAwareGrepFallbackSkipsHiddenSkillBeforeDecode()
  await testEncodingAwareGrepFallbackStopsAtOutputLimits()
  await testEncodingAwareGrepFallbackStopsAtScanLimitWithoutMatches()
  await testGrepRawRejectsHiddenSkillSymlinkBeforeRipgrep()
  await testGrepRawFiltersHiddenSkillSymlinkResults()
  await testReadFileBufferRejectsFileOverMaxBytes()
  await testReadFileBufferAcceptsFileAtMaxBytes()
  await testGbkStreamingPathDecoding()
  await testGbkStreamingDetectionAfterAsciiPrefix()
  await testGbkStreamingDetectionNearTargetOffset()
  await testLocalSandboxDefaultLimitMatchesReadFileTool()
  await testSymlinkRejected()
  await testElevatedSandboxBlocksSensitiveHomePath()
  await testElevatedSandboxBlocksSensitivePathViaParentSymlink()
  await testElevatedSandboxRealpathCacheDoesNotOutliveToolCall()
  await testElevatedSandboxLsKeepsNormalEntriesAndFiltersSensitiveSymlink()
  await testElevatedSandboxGlobKeepsNormalEntriesAndFiltersSensitiveSymlink()
  await testLsAndGlobHiddenSkillChecksReuseRealpathCache()
  await testPreToolUseHookBlocksReadFile()
  await testPreToolUseHookCanUpdateReadFilePathWithSchemaName()
  await testPreToolUseHookCanUpdateReadFilePathWithCamelCaseName()
  await testLargeFileStreamingRange()
  await testLargeFileTrailingNewlineDoesNotAddBlankLine()
  await testLongLineContinuationTrimWarning()
  await testLongLineContinuationDoesNotHideNextSourceLine()
  await testReadFilePostHookSeesTrimmedLookaheadOutput()
  await testStreamingLastLongLineReportsContinuationTruncation()
  await testLocalSandboxStopsFormattingAtCharBudget()
  await testPaginationHeaderDoesNotCountAgainstLimit()
  await testPostHookFeedbackSurvivesLineTrim()
  await testPostHookFeedbackSurvivesCharTruncation()
  await testCharTruncationStaysWithinBudgetAfterHeaderAdjustment()
  await testCharTruncationLeavesExactBudgetUntouched()
  await testPostHookFeedbackIsCappedDuringLineTrim()
  await testPostHookFeedbackIsCappedDuringCharTruncation()
  await testRuntimeReadFileToolPatchDefaultsAndTrims()
  await testRuntimeReadFileToolPassesOutputCharBudget()
  await testRuntimeReadFileToolUsesDefaultCharBudget()
  await testRuntimeReadFileToolPreservesHookFeedback()
  await testRuntimeReadFileToolFactoryReceivesGraphState()
  console.log("read-file-tool.spec.ts passed")
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
