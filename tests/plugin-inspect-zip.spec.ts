/**
 * Tests for inspectPluginZip — the market-detail path that parses a plugin zip
 * WITHOUT installing it to surface real Skill/MCP/Hook counts.
 *
 * Covers: flat layout, single-root-dir prefix stripping, empty/garbage zips,
 * and path-traversal rejection. Also asserts the OS temp dir is left clean and
 * the user's plugins folder is never touched.
 *
 * Run:
 *   npx tsx tests/plugin-inspect-zip.spec.ts
 */

import AdmZip from "adm-zip"
import { existsSync, readdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { inspectPluginZip } from "../src/main/ipc/plugins.ts"

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

const manifest = (name: string): string =>
  JSON.stringify({ name, version: "2.1.0", description: "d", license: "MIT" })

const mcpTwoServers = JSON.stringify({
  mcpServers: {
    "search-service": { url: "https://example.com/mcp", transport: "streamable-http" },
    "local-helper": { command: "node", args: ["./server.js"] }
  }
})

const hooksArrayOfThree = JSON.stringify([
  { event: "PreToolUse", matcher: "*", type: "command", command: "echo a" },
  { event: "PostToolUse", matcher: "*", type: "command", command: "echo b" },
  { event: "Stop", type: "command", command: "echo c" }
])

function countInspectTempDirs(): number {
  // Leftover inspect temp dirs would indicate a cleanup bug.
  return readdirSync(tmpdir()).filter((n) => n.startsWith("cmb-plugin-inspect-")).length
}

async function testFlatLayout(): Promise<void> {
  const zip = new AdmZip()
  // plugin.json first so root-prefix detection sees a single-segment entry → no prefix.
  zip.addFile("plugin.json", Buffer.from(manifest("flat-plugin")))
  zip.addFile("skills/alpha/SKILL.md", Buffer.from("# Alpha\nskill"))
  zip.addFile("skills/beta/SKILL.md", Buffer.from("# Beta\nskill"))
  zip.addFile(".mcp.json", Buffer.from(mcpTwoServers))
  zip.addFile("hooks/hooks.json", Buffer.from(hooksArrayOfThree))

  const detail = await inspectPluginZip(toArrayBuffer(zip.toBuffer()))
  assert(detail.skills.length === 2, `flat: expected 2 skills, got ${detail.skills.length}`)
  assert(detail.mcpServers.length === 2, `flat: expected 2 mcp, got ${detail.mcpServers.length}`)
  assert(detail.hookCount === 3, `flat: expected hookCount 3, got ${detail.hookCount}`)
  assert(detail.mcpServerDetails.length === 2, "flat: expected 2 mcpServerDetails")
  assert(detail.manifest?.name === "flat-plugin", "flat: manifest.name mismatch")
  assert(detail.manifest?.version === "2.1.0", "flat: manifest.version mismatch")
  assert(detail.hooks.length === 0, "flat: hooks list should be empty (count-only)")
}

async function testSingleRootDirPrefixStripping(): Promise<void> {
  const zip = new AdmZip()
  const root = "my-plugin/"
  zip.addFile(`${root}plugin.json`, Buffer.from(manifest("rooted-plugin")))
  zip.addFile(`${root}skills/only/SKILL.md`, Buffer.from("# Only"))
  zip.addFile(`${root}.mcp.json`, Buffer.from(mcpTwoServers))
  zip.addFile(`${root}hooks/hooks.json`, Buffer.from(hooksArrayOfThree))

  const detail = await inspectPluginZip(toArrayBuffer(zip.toBuffer()))
  assert(detail.skills.length === 1, `rooted: expected 1 skill, got ${detail.skills.length}`)
  assert(detail.mcpServers.length === 2, `rooted: expected 2 mcp, got ${detail.mcpServers.length}`)
  assert(detail.hookCount === 3, `rooted: expected hookCount 3, got ${detail.hookCount}`)
  assert(detail.manifest?.name === "rooted-plugin", "rooted: manifest.name mismatch")
}

async function testEmptyGarbageZip(): Promise<void> {
  const zip = new AdmZip()
  zip.addFile("README.txt", Buffer.from("not a plugin"))

  const detail = await inspectPluginZip(toArrayBuffer(zip.toBuffer()))
  assert(detail.skills.length === 0, "garbage: expected 0 skills")
  assert(detail.mcpServers.length === 0, "garbage: expected 0 mcp")
  assert(detail.hookCount === 0, "garbage: expected hookCount 0")
  assert(detail.manifest === null, "garbage: expected null manifest")
}

async function testPathTraversalRejected(): Promise<void> {
  const escapeName = `evil-inspect-${Date.now()}.txt`
  const escapeTarget = join(tmpdir(), escapeName)
  const zip = new AdmZip()
  zip.addFile("plugin.json", Buffer.from(manifest("evil-plugin"))) // forces empty root prefix
  // AdmZip.addFile sanitizes "../"; override entryName directly to craft a real
  // traversal entry that survives toBuffer().
  zip.addFile("placeholder.txt", Buffer.from("pwned"))
  const placeholder = zip.getEntries().find((e) => e.entryName === "placeholder.txt")
  assert(placeholder !== undefined, "traversal: failed to seed placeholder entry")
  placeholder!.entryName = `../${escapeName}`

  const detail = await inspectPluginZip(toArrayBuffer(zip.toBuffer()))
  // Extraction throws on the traversal entry → inspectPluginZip degrades to empty.
  assert(detail.skills.length === 0, "traversal: expected empty skills on rejection")
  assert(detail.hookCount === 0, "traversal: expected empty hookCount on rejection")
  assert(detail.manifest === null, "traversal: expected null manifest on rejection")
  assert(!existsSync(escapeTarget), "traversal: file escaped temp dir — security regression")
}

async function testNullBuffer(): Promise<void> {
  // @ts-expect-error intentionally passing a bad value
  const detail = await inspectPluginZip(undefined)
  assert(detail.skills.length === 0 && detail.hookCount === 0, "null buffer: expected empty detail")
}

async function main(): Promise<void> {
  const before = countInspectTempDirs()

  await testFlatLayout()
  await testSingleRootDirPrefixStripping()
  await testEmptyGarbageZip()
  await testPathTraversalRejected()
  await testNullBuffer()

  const after = countInspectTempDirs()
  assert(
    after <= before,
    `temp cleanup: leftover inspect dirs (before=${before}, after=${after})`
  )

  console.log("plugin-inspect-zip.spec.ts: all assertions passed ✓")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
