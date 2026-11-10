import { execFileSync } from "child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { afterEach, describe, expect, it } from "vitest"
import {
  countAddedNonBlankLines,
  formatLineRanges,
  parseUnifiedZeroDiff,
  placeAgentLines,
  readCommitFileDiffs,
  unquoteGitPath,
  type CommittedLineIndex
} from "./commit-file-agent-lines"

/** Index a file the way the adoption measurement does, with a readable stand-in hash. */
function indexLines(lines: string[], hashOf: (text: string) => number): CommittedLineIndex {
  const lineNumbers: number[] = []
  const hashes: number[] = []
  lines.forEach((line, i) => {
    const norm = line.trim().replace(/\s+/g, " ")
    if (!norm) return
    lineNumbers.push(i + 1)
    hashes.push(hashOf(norm))
  })
  return {
    lineNumbers: Uint32Array.from(lineNumbers),
    hashes: Uint32Array.from(hashes),
    totalLines: lines.length
  }
}

function contentHasher(): (text: string) => number {
  const ids = new Map<string, number>()
  return (text) => {
    let id = ids.get(text)
    if (id === undefined) {
      id = ids.size + 1
      ids.set(text, id)
    }
    return id
  }
}

describe("parseUnifiedZeroDiff", () => {
  it("reads added ranges and counts per file, skipping content by count", () => {
    const output = [
      "diff --git a/src/f.ts b/src/f.ts",
      "index de98044..376bbbe 100644",
      "--- a/src/f.ts",
      "+++ b/src/f.ts",
      "@@ -1,0 +2 @@ a",
      "+NEW1",
      "@@ -3,2 +5,3 @@ c",
      // Content that looks like headers must be consumed as content.
      "--- this was a deleted line",
      "-@@ -9 +9 @@",
      "+++ an added line",
      "+diff --git a/x b/x",
      "+NEW2",
      "\\ No newline at end of file",
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..de98044",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+a",
      "+b",
      "+c",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "index de98044..0000000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,4 +0,0 @@",
      "-a",
      "-b",
      "-c",
      "-d",
      ""
    ].join("\n")

    const files = parseUnifiedZeroDiff(output)
    expect([...files.keys()]).toEqual(["src/f.ts", "new.ts", "gone.ts"])
    expect(files.get("src/f.ts")).toEqual({
      addedRanges: [
        [2, 2],
        [5, 7]
      ],
      addedLineCount: 4,
      deletedLineCount: 2,
      binary: false
    })
    expect(files.get("new.ts")).toMatchObject({ addedRanges: [[1, 3]], addedLineCount: 3 })
    expect(files.get("gone.ts")).toMatchObject({
      addedRanges: [],
      addedLineCount: 0,
      deletedLineCount: 4
    })
  })

  it("decodes quoted paths and strips git's space separator tab", () => {
    const output = [
      "diff --git a/dir/中文 名.ts b/dir/中文 名.ts",
      "--- a/dir/中文 名.ts\t",
      "+++ b/dir/中文 名.ts\t",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      'diff --git "a/q\\"uote\\\\d.ts" "b/q\\"uote\\\\d.ts"',
      '--- "a/q\\"uote\\\\d.ts"',
      '+++ "b/q\\"uote\\\\d.ts"',
      "@@ -0,0 +1 @@",
      "+z",
      "diff --git a/img.ts b/img.ts",
      "index 1111111..2222222 100644",
      "Binary files a/img.ts and b/img.ts differ"
    ].join("\n")

    const files = parseUnifiedZeroDiff(output)
    expect(files.get("dir/中文 名.ts")).toMatchObject({ addedRanges: [[1, 1]] })
    expect(files.get('q"uote\\d.ts')).toMatchObject({ addedRanges: [[1, 1]] })
    expect(files.get("img.ts")).toMatchObject({ binary: true, addedRanges: [] })
  })

  it("decodes octal UTF-8 escapes", () => {
    expect(unquoteGitPath('"b/\\346\\226\\207.ts"')).toBe("b/文.ts")
    expect(unquoteGitPath('"b/tab\\there"')).toBe("b/tab\there")
    expect(unquoteGitPath("b/plain.ts")).toBe("b/plain.ts")
  })
})

describe("placeAgentLines", () => {
  const javaFile = [
    "public void a() {", // 1  old
    "}", //                  2  old
    "", //                   3
    "public void b() {", // 4  added, agent
    "  doB();", //           5  added, agent
    "}", //                  6  added, agent
    "", //                   7
    "public void c() {", // 8  added, human
    "  doC();", //           9  added, human
    "}" //                   10 added, human
  ]

  it("puts a repeated `}` next to the other agent lines inside the diff", () => {
    const hashOf = contentHasher()
    const index = indexLines(javaFile, hashOf)
    const adopted = new Map([
      [hashOf("public void b() {"), 1],
      [hashOf("doB();"), 1],
      [hashOf("}"), 1]
    ])
    const placement = placeAgentLines(index, adopted, [[4, 10]])
    expect(placement).toEqual({ lineNumbers: [4, 5, 6], outsideDiff: 0 })
  })

  it("counts lines that had to be placed outside the commit's added lines", () => {
    const hashOf = contentHasher()
    const index = indexLines(javaFile, hashOf)
    // The agent's own copy of line 1 never reached the commit, but the file
    // still has one; the measurement counts it, so it must be placed.
    const adopted = new Map([
      [hashOf("public void a() {"), 1],
      [hashOf("doB();"), 1]
    ])
    expect(placeAgentLines(index, adopted, [[4, 10]])).toEqual({
      lineNumbers: [1, 5],
      outsideDiff: 1
    })
  })

  it("falls back to file order without a diff and never changes the count", () => {
    const hashOf = contentHasher()
    const index = indexLines(javaFile, hashOf)
    const adopted = new Map([
      [hashOf("doC();"), 1],
      [hashOf("}"), 2]
    ])
    const placement = placeAgentLines(index, adopted, null)
    // doC() anchors the braces: the nearest two are lines 10 and 6.
    expect(placement).toEqual({ lineNumbers: [6, 9, 10], outsideDiff: null })
    expect(placement.lineNumbers).toHaveLength(3)
  })

  it("takes the earliest candidates when nothing anchors them", () => {
    const hashOf = contentHasher()
    const index = indexLines(javaFile, hashOf)
    expect(placeAgentLines(index, new Map([[hashOf("}"), 2]]), null).lineNumbers).toEqual([2, 6])
    expect(placeAgentLines(index, new Map(), [[4, 10]])).toEqual({
      lineNumbers: [],
      outsideDiff: 0
    })
  })

  it("counts non-blank added lines", () => {
    const index = indexLines(javaFile, contentHasher())
    expect(countAddedNonBlankLines(index, [[3, 10]])).toBe(6)
  })
})

describe("formatLineRanges", () => {
  it("writes every range as start-end, single lines included", () => {
    expect(formatLineRanges([2026, 3, 4, 5, 9].sort((a, b) => a - b))).toEqual({
      ranges: ["3-5", "9-9", "2026-2026"],
      truncated: false
    })
    expect(formatLineRanges([])).toEqual({ ranges: [], truncated: false })
  })

  it("truncates past the range cap", () => {
    expect(formatLineRanges([1, 3, 5], 2)).toEqual({ ranges: ["1-1", "3-3"], truncated: true })
    expect(formatLineRanges([1, 3], 2)).toEqual({ ranges: ["1-1", "3-3"], truncated: false })
  })
})

describe("readCommitFileDiffs", () => {
  const repos: string[] = []

  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
  })

  function git(repo: string, args: string[]): string {
    return execFileSync("git", args, { cwd: repo, encoding: "utf-8" }).trim()
  }

  function makeRepo(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "commit-file-diff-")))
    repos.push(repo)
    git(repo, ["init", "-q", "-b", "main"])
    git(repo, ["config", "user.email", "test@example.com"])
    git(repo, ["config", "user.name", "Test"])
    return repo
  }

  it("diffs a root commit as a creation and later commits against their parent", async () => {
    const repo = makeRepo()
    mkdirSync(join(repo, "src dir"))
    writeFileSync(join(repo, "src dir", "中文.ts"), "a\nb\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "root"])
    const root = git(repo, ["rev-parse", "HEAD"])

    const rootDiff = await readCommitFileDiffs({
      cwd: repo,
      commitSha: root,
      relPaths: ["src dir/中文.ts"]
    })
    expect(rootDiff?.get("src dir/中文.ts")).toMatchObject({ addedRanges: [[1, 2]] })

    writeFileSync(join(repo, "src dir", "中文.ts"), "a\nnew\nb\n")
    writeFileSync(join(repo, "other.ts"), "x\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "second"])
    const second = git(repo, ["rev-parse", "HEAD"])

    const diff = await readCommitFileDiffs({
      cwd: repo,
      commitSha: second,
      relPaths: ["src dir/中文.ts"]
    })
    expect([...(diff?.keys() ?? [])]).toEqual(["src dir/中文.ts"])
    expect(diff?.get("src dir/中文.ts")).toMatchObject({
      addedRanges: [[2, 2]],
      addedLineCount: 1,
      deletedLineCount: 0
    })
  })

  it("diffs a merge commit against its first parent", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "f.ts"), "base\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "base"])
    git(repo, ["checkout", "-q", "-b", "side"])
    writeFileSync(join(repo, "side.ts"), "from side\n")
    git(repo, ["add", "."])
    git(repo, ["commit", "-q", "-m", "side"])
    git(repo, ["checkout", "-q", "main"])
    writeFileSync(join(repo, "f.ts"), "base\nmain\n")
    git(repo, ["commit", "-q", "-am", "main"])
    git(repo, ["merge", "-q", "--no-ff", "--no-edit", "side"])
    const merge = git(repo, ["rev-parse", "HEAD"])

    const diff = await readCommitFileDiffs({
      cwd: repo,
      commitSha: merge,
      relPaths: ["f.ts", "side.ts"]
    })
    // Against the first parent, only the side branch's file is new.
    expect(diff?.has("f.ts")).toBe(false)
    expect(diff?.get("side.ts")).toMatchObject({ addedRanges: [[1, 1]] })
  })

  it("returns null when git cannot run", async () => {
    await expect(
      readCommitFileDiffs({
        cwd: join(tmpdir(), "definitely-missing-commit-file-diff"),
        commitSha: "HEAD",
        relPaths: ["a.ts"]
      })
    ).resolves.toBeNull()
  })
})
