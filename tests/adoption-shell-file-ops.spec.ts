/**
 * Unit tests for agent shell file-op detection used by code-adoption tracking.
 *
 * Covers the scenarios discussed while building the rm/mv monitoring:
 *   - rm / mv / git rm / git mv parsing (incl. directories & flags)
 *   - Windows backslash paths survive quoting (the dedicated file-op tokeniser)
 *   - glued command separators (`a.ts;mv b c`) still segment correctly
 *   - genuinely unresolvable constructs (substitution / redirect / `mv -t`) bail
 *   - path-prefix targeting (`isPathAtOrUnder`) respects directory boundaries
 *   - mv destination resolution (`resolveMvFinalBase`): rename vs move-into-dir
 *
 * Run:
 *   npx tsx tests/adoption-shell-file-ops.spec.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { extractShellFileOps, type ShellFileOp } from "../src/main/agent/exec-policy.ts"
import { isPathAtOrUnder, resolveMvFinalBase } from "../src/main/services/adoption-tracker.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

function assertOps(command: string, expected: ShellFileOp[]): void {
  const actual = extractShellFileOps(command)
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, `extractShellFileOps(${JSON.stringify(command)})\n  expected ${e}\n  got      ${a}`)
}

// ─────────────────────────────────────────────────────────
// extractShellFileOps — happy paths
// ─────────────────────────────────────────────────────────

function testSimpleRm(): void {
  assertOps("rm src/a.ts", [{ op: "rm", paths: ["src/a.ts"] }])
}

function testRmWithFlagsAndDir(): void {
  // -rf skipped; a bare directory is a normal path operand.
  assertOps("rm -rf src/pages/Old", [{ op: "rm", paths: ["src/pages/Old"] }])
}

function testSimpleMv(): void {
  assertOps("mv src/a.ts src/b.ts", [{ op: "mv", paths: ["src/a.ts"], dest: "src/b.ts" }])
}

function testGitRmAndGitMv(): void {
  assertOps("git rm src/a.ts", [{ op: "rm", paths: ["src/a.ts"] }])
  assertOps("git mv src/a.ts src/b.ts", [{ op: "mv", paths: ["src/a.ts"], dest: "src/b.ts" }])
}

function testMvMultipleSourcesIntoDir(): void {
  // `mv a b destdir` → sources a,b ; dest destdir.
  assertOps("mv src/a.ts src/b.ts dest", [
    { op: "mv", paths: ["src/a.ts", "src/b.ts"], dest: "dest" }
  ])
}

function testEndOfOptionsSeparator(): void {
  assertOps("rm -- -weird.ts", [{ op: "rm", paths: ["-weird.ts"] }])
}

function testEnvAssignmentPrefix(): void {
  assertOps("FOO=bar rm src/a.ts", [{ op: "rm", paths: ["src/a.ts"] }])
}

// ─────────────────────────────────────────────────────────
// extractShellFileOps — Windows backslash paths (the file-op tokeniser must
// NOT eat backslashes inside double quotes the way the safety tokeniser does)
// ─────────────────────────────────────────────────────────

function testWindowsBackslashPathPreserved(): void {
  // command string is: rm -rf "D:\proj\Old"
  const ops = extractShellFileOps('rm -rf "D:\\proj\\Old"')
  assert(ops.length === 1 && ops[0].op === "rm", "windows rm should parse as a single rm op")
  // parsed path must keep its backslashes: D:\proj\Old
  assert(
    ops[0].paths[0] === "D:\\proj\\Old",
    `windows path should keep backslashes, got ${JSON.stringify(ops[0].paths[0])}`
  )
}

function testWindowsBackslashMvPreserved(): void {
  // mv "D:\proj\a.ts" "D:\proj\sub\a.ts"
  const ops = extractShellFileOps('mv "D:\\proj\\a.ts" "D:\\proj\\sub\\a.ts"')
  assert(ops.length === 1 && ops[0].op === "mv", "windows mv should parse")
  assert(ops[0].paths[0] === "D:\\proj\\a.ts", "windows mv source backslashes preserved")
  assert(ops[0].dest === "D:\\proj\\sub\\a.ts", "windows mv dest backslashes preserved")
}

// ─────────────────────────────────────────────────────────
// extractShellFileOps — compound commands (glued separators must segment)
// ─────────────────────────────────────────────────────────

function testGluedSemicolon(): void {
  // LLMs write `;` with no leading space — must still split into two ops.
  assertOps("rm src/a.ts;mv src/b.ts src/c.ts", [
    { op: "rm", paths: ["src/a.ts"] },
    { op: "mv", paths: ["src/b.ts"], dest: "src/c.ts" }
  ])
}

function testSemicolonTrailingSpaceOnly(): void {
  assertOps("rm src/a.ts; mv src/b.ts src/c.ts", [
    { op: "rm", paths: ["src/a.ts"] },
    { op: "mv", paths: ["src/b.ts"], dest: "src/c.ts" }
  ])
}

function testMultipleGluedRm(): void {
  assertOps("rm a.ts;rm b.ts;rm c.ts", [
    { op: "rm", paths: ["a.ts"] },
    { op: "rm", paths: ["b.ts"] },
    { op: "rm", paths: ["c.ts"] }
  ])
}

function testSpacedAndChain(): void {
  // mkdir is not a file op; the mv after && is detected.
  assertOps("mkdir -p foo && mv src/a.ts foo/", [
    { op: "mv", paths: ["src/a.ts"], dest: "foo/" }
  ])
}

function testGitRmAndGitMvChain(): void {
  assertOps("git rm a.ts && git mv b.ts c.ts", [
    { op: "rm", paths: ["a.ts"] },
    { op: "mv", paths: ["b.ts"], dest: "c.ts" }
  ])
}

// ─────────────────────────────────────────────────────────
// extractShellFileOps — bail / ignore (conservative: never mis-parse)
// ─────────────────────────────────────────────────────────

function testCommandSubstitutionBails(): void {
  assertOps("rm $(find . -name x.ts)", [])
  assertOps("rm `find . -name x.ts`", [])
}

function testRedirectBails(): void {
  assertOps("rm a.ts > /dev/null", [])
}

function testSubshellBails(): void {
  assertOps("(rm a.ts)", [])
}

function testMvTargetDirectoryFlagBails(): void {
  // `-t DIR` inverts operand order; we skip rather than mis-parse src/dest.
  assertOps("mv -t destdir a.ts b.ts", [])
  assertOps("mv --target-directory=destdir a.ts", [])
}

function testNonFileOpIgnored(): void {
  assertOps("ls -la src", [])
  assertOps("echo rm a.ts", [])
  assertOps("rmdir src/empty", []) // rmdir is not rm
}

function testMalformedQuotingProducesNoOps(): void {
  assertOps('rm "a.ts', []) // unbalanced quote → tokeniser returns null → no ops
}

function testMvWithoutDestinationIgnored(): void {
  assertOps("mv only-one.ts", [])
}

// ─────────────────────────────────────────────────────────
// isPathAtOrUnder — prefix targeting must respect directory boundaries
// ─────────────────────────────────────────────────────────

function testIsPathAtOrUnder(): void {
  assert(isPathAtOrUnder("/a/b/c.ts", "/a/b/c.ts"), "exact path should match")
  assert(isPathAtOrUnder("/a/b/c.ts", "/a/b"), "nested path should match its dir")
  assert(isPathAtOrUnder("/a/b/sub/c.ts", "/a/b"), "deeply nested path should match")
  assert(!isPathAtOrUnder("/a/bfoo/c.ts", "/a/b"), "sibling dir sharing a prefix must NOT match")
  assert(!isPathAtOrUnder("/a/b", "/a/b/c.ts"), "parent should not match a child target")
  assert(!isPathAtOrUnder("/x/y.ts", "/a/b"), "unrelated path should not match")
}

// ─────────────────────────────────────────────────────────
// resolveMvFinalBase — rename vs move-into-directory (fs-dependent, temp dirs)
// ─────────────────────────────────────────────────────────

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "adopt-mv-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function testResolveMvRenameDirectory(): void {
  withTempDir((dir) => {
    // Post-`mv olddir newdir` (rename): newdir exists, newdir/olddir does NOT.
    const src = join(dir, "olddir")
    const dest = join(dir, "newdir")
    mkdirSync(dest, { recursive: true })
    assert(
      resolveMvFinalBase(src, dest) === dest,
      "rename: a moved dir should map to DEST itself"
    )
  })
}

function testResolveMvMoveFileIntoDirectory(): void {
  withTempDir((dir) => {
    // Post-`mv file.ts destdir/`: destdir exists AND destdir/file.ts exists.
    const src = join(dir, "file.ts")
    const dest = join(dir, "destdir")
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, "file.ts"), "x")
    assert(
      resolveMvFinalBase(src, dest) === join(dest, "file.ts"),
      "move-into-dir: file should map to DEST/basename(src)"
    )
  })
}

function testResolveMvMoveDirIntoExistingDirectory(): void {
  withTempDir((dir) => {
    // Post-`mv olddir existingdir` (existing): existingdir/olddir exists.
    const src = join(dir, "olddir")
    const dest = join(dir, "existingdir")
    mkdirSync(join(dest, "olddir"), { recursive: true })
    assert(
      resolveMvFinalBase(src, dest) === join(dest, "olddir"),
      "move-dir-into-existing: should map to DEST/basename(src)"
    )
  })
}

function testResolveMvRenameFile(): void {
  withTempDir((dir) => {
    // Post-`mv a.ts b.ts` (rename file): dest is a FILE, not a directory.
    const src = join(dir, "a.ts")
    const dest = join(dir, "b.ts")
    writeFileSync(dest, "x")
    assert(resolveMvFinalBase(src, dest) === dest, "rename file: should map to DEST itself")
  })
}

// ─────────────────────────────────────────────────────────

function run(): void {
  testSimpleRm()
  testRmWithFlagsAndDir()
  testSimpleMv()
  testGitRmAndGitMv()
  testMvMultipleSourcesIntoDir()
  testEndOfOptionsSeparator()
  testEnvAssignmentPrefix()
  console.log("PASS extractShellFileOps happy paths (rm/mv/git, flags, dir, --, env)")

  testWindowsBackslashPathPreserved()
  testWindowsBackslashMvPreserved()
  console.log("PASS Windows backslash paths survive the file-op tokeniser")

  testGluedSemicolon()
  testSemicolonTrailingSpaceOnly()
  testMultipleGluedRm()
  testSpacedAndChain()
  testGitRmAndGitMvChain()
  console.log("PASS compound commands segment (glued `;`, spaced `&&`)")

  testCommandSubstitutionBails()
  testRedirectBails()
  testSubshellBails()
  testMvTargetDirectoryFlagBails()
  testNonFileOpIgnored()
  testMalformedQuotingProducesNoOps()
  testMvWithoutDestinationIgnored()
  console.log("PASS conservative bail (substitution/redirect/subshell/mv -t/malformed/non-op)")

  testIsPathAtOrUnder()
  console.log("PASS isPathAtOrUnder respects directory boundaries")

  testResolveMvRenameDirectory()
  testResolveMvMoveFileIntoDirectory()
  testResolveMvMoveDirIntoExistingDirectory()
  testResolveMvRenameFile()
  console.log("PASS resolveMvFinalBase distinguishes rename vs move-into-dir")
}

run()
