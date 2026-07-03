/**
 * Unit tests for the plugin file-editing gate helpers.
 *
 * Run:
 *   npx tsx tests/plugin-file-gates.spec.ts
 */

import * as path from "path"
import {
  BINARY_EXTENSIONS,
  EDITABLE_EXTENSIONS,
  isBinaryExtension,
  isEditableExtension,
  isPathInsideDir,
  isPluginEditable
} from "../src/main/ipc/plugin-file-gates.ts"

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function testEditableTextExtensions(): void {
  // A representative slice across each category (docs, configs, shells,
  // scripts, web). Not an exhaustive enumeration — that would just mirror
  // the set definition. We want to catch accidental removals of common
  // categories.
  const editableSamples = [
    "md",
    "markdown",
    "mdx",
    "txt",
    "json",
    "yaml",
    "yml",
    "toml",
    "ini",
    "sh",
    "ps1",
    "bat",
    "py",
    "js",
    "ts",
    "css",
    "html",
    "xml"
  ]
  for (const ext of editableSamples) {
    assert(EDITABLE_EXTENSIONS.has(ext), `${ext} should be in the editable allowlist`)
    assert(
      isEditableExtension(`/x/y/file.${ext}`) === true,
      `${ext} should be detected as editable`
    )
    assert(
      isEditableExtension(`/x/y/FILE.${ext.toUpperCase()}`) === true,
      `${ext} uppercase should also be detected`
    )
  }
  console.log("PASS editable extensions cover docs, configs, shells, scripts, web")
}

function testBinaryExtensions(): void {
  const binarySamples = [
    "exe",
    "dll",
    "so",
    "dylib",
    "png",
    "jpg",
    "ico",
    "pdf",
    "zip",
    "gz",
    "woff",
    "woff2",
    "ttf",
    "mp4",
    "sqlite"
  ]
  for (const ext of binarySamples) {
    assert(BINARY_EXTENSIONS.has(ext), `${ext} should be in the binary list`)
    assert(isBinaryExtension(`/x/y/blob.${ext}`) === true, `${ext} should be flagged binary`)
    assert(
      isEditableExtension(`/x/y/blob.${ext}`) === false,
      `${ext} must never be editable, even by accident`
    )
  }

  // No-extension files are neither editable nor binary by default — they
  // fall through to "we don't know, leave alone".
  assert(
    isEditableExtension("/x/y/no-extension") === false,
    "unmarked file is not editable"
  )
  assert(isBinaryExtension("/x/y/no-extension") === false, "unmarked file is not binary either")

  console.log("PASS binary extensions never collide with editable allowlist")
}

function testDotfilesEditable(): void {
  // Dotfiles have no real extname; only the explicitly listed ones should
  // remain editable, others stay closed.
  for (const name of [".gitignore", ".npmignore", ".dockerignore", ".editorconfig", ".env"]) {
    assert(
      isEditableExtension(`/x/y/${name}`) === true,
      `${name} should be editable via dotfile fall-through`
    )
  }
  // A made-up dotfile must NOT be editable — guard against the dotfile
  // fall-through becoming a wildcard.
  assert(
    isEditableExtension("/x/y/.unknown-dotfile") === false,
    "unknown dotfile must stay non-editable"
  )
  console.log("PASS editable dotfiles list is explicit, no implicit dotfile wildcard")
}

function testPathContainment(): void {
  const root = path.resolve("/tmp/plugins/my-plugin")

  assert(
    isPathInsideDir(path.join(root, "SKILL.md"), root) === true,
    "direct child file is inside"
  )
  assert(
    isPathInsideDir(path.join(root, "skills", "review", "SKILL.md"), root) === true,
    "nested file is inside"
  )
  assert(
    isPathInsideDir(root, root) === true,
    "the root itself counts as inside (matches existing skills.ts gate)"
  )
  assert(
    isPathInsideDir(path.resolve("/tmp/plugins/other-plugin/SKILL.md"), root) === false,
    "sibling plugin must be rejected"
  )
  assert(
    isPathInsideDir(path.resolve("/etc/passwd"), root) === false,
    "totally unrelated path must be rejected"
  )

  // A relative target string with .. that does NOT escape after resolution
  // stays inside; one that escapes must be rejected.
  assert(
    isPathInsideDir(path.join(root, "skills/../SKILL.md"), root) === true,
    "in-bounds traversal after resolution stays inside"
  )
  assert(
    isPathInsideDir(path.join(root, "../escape/SKILL.md"), root) === false,
    "traversal that escapes the root is rejected"
  )

  // Prefix-collision regression: a sibling whose name starts with the dir
  // name (e.g. "/x/y2" vs "/x/y") must not be treated as inside after we
  // trim trailing slashes for comparison.
  const yRoot = path.resolve("/tmp/x/y")
  const ySibling = path.resolve("/tmp/x/y2/SKILL.md")
  assert(
    isPathInsideDir(ySibling, yRoot) === false,
    `prefix-named sibling must be rejected after slash trim; got inside for ${ySibling}`
  )
  console.log("PASS isPathInsideDir rejects symlink-style escapes and sibling reads")
}

function testPluginEditableOriginGate(): void {
  assert(isPluginEditable({ origin: "local" }) === true, "local plugins are editable")
  assert(isPluginEditable({ origin: "market" }) === false, "market plugins are read-only")
  assert(
    isPluginEditable({ origin: undefined }) === false,
    "pre-origin legacy installs treated as read-only until migration"
  )
  assert(isPluginEditable(null) === false, "null is not editable")
  assert(isPluginEditable(undefined) === false, "undefined is not editable")
  console.log("PASS isPluginEditable allows only origin === \"local\"")
}

testEditableTextExtensions()
testBinaryExtensions()
testDotfilesEditable()
testPathContainment()
testPluginEditableOriginGate()
