import { mkdtempSync, mkdirSync, writeFileSync, rmSync, linkSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { parseExtensionContract, CONTEXT_HANDOFF_PROTOCOL, DECLARED_CONTEXT_FILES_PROTOCOL } from "../../../shared/project-runtime"
import { readDeclaredContextFiles } from "./declared-context-files"
import { encodeMarketContent, MARKET_CONTENT_PREFIX, protectMarketDirectory } from "../../services/market-content"
import { runtimeDigest } from "./safe-files"

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "declared-context-"))
  roots.push(root)
  const snapshotRoot = join(root, "package"), knowledgeRoot = join(root, "knowledge")
  mkdirSync(snapshotRoot)
  mkdirSync(knowledgeRoot)
  writeFileSync(join(snapshotRoot, "rules.md"), "Required domain rules")
  writeFileSync(join(knowledgeRoot, "AGENTS.md"), "Selected project knowledge")
  const contract = { apiVersion: "devclaw.extension-contract/v1",
    requires: [CONTEXT_HANDOFF_PROTOCOL, DECLARED_CONTEXT_FILES_PROTOCOL],
    context: { sourceAccess: "read-only", mutableData: "host", configuration: "host-resolved",
      knowledge: { required: true, binding: "knowledge" },
      provider: { operations: ["session-context"], files: [
        { source: "package", path: "rules.md" },
        { source: "knowledge", path: "AGENTS.md", stages: ["design"] }
      ] } } }
  return { root, snapshotRoot, knowledgeRoot, contract,
    context: parseExtensionContract(contract).context!, stageId: "design", assertCurrent: () => {} }
}

describe("declarative scoped project context", () => {
  it("decodes only package Markdown within the plaintext budget and retains its stored digest", () => {
    const f = fixture()
    const plain = "x".repeat(23_900)
    writeFileSync(join(f.snapshotRoot, "rules.md"), plain)
    protectMarketDirectory(f.snapshotRoot)
    const external = encodeMarketContent(Buffer.from("External literal content"))
    writeFileSync(join(f.knowledgeRoot, "AGENTS.md"), external)
    const result = JSON.parse(readDeclaredContextFiles(f))
    expect(result.documents[0].text).toBe(plain)
    expect(result.documents[0].digest).toBe(runtimeDigest(readFileSync(join(f.snapshotRoot, "rules.md"))))
    expect(result.documents[1].text).toBe(external.toString("utf8"))
    writeFileSync(join(f.snapshotRoot, "rules.md"), encodeMarketContent(Buffer.from("x".repeat(24_001))))
    expect(() => readDeclaredContextFiles({ ...f, stageId: "normalize" })).toThrow("LIMIT")
    writeFileSync(join(f.snapshotRoot, "rules.md"), MARKET_CONTENT_PREFIX + "invalid!")
    expect(() => readDeclaredContextFiles(f)).toThrow("市场资源编码损坏")
  })

  it("reads only current-stage declared files, preserving exact text and identities without local paths", () => {
    const f = fixture()
    const value = JSON.parse(readDeclaredContextFiles(f))
    expect(value.documents.map((file: { text: string }) => file.text)).toEqual([
      "Required domain rules", "Selected project knowledge"
    ])
    expect(JSON.stringify(value)).not.toContain(f.root)
    expect(JSON.parse(readDeclaredContextFiles({ ...f, stageId: "normalize" })).documents).toHaveLength(1)
    const before = value.documents[1].digest
    writeFileSync(join(f.knowledgeRoot, "AGENTS.md"), "Changed knowledge")
    expect(JSON.parse(readDeclaredContextFiles(f)).documents[1].digest).not.toBe(before)
  })

  it("fails closed for unknown protocol, missing binding, ambiguous source, and path escapes", () => {
    const f = fixture()
    expect(() => parseExtensionContract({ ...f.contract, requires: [CONTEXT_HANDOFF_PROTOCOL] })).toThrow()
    const invalid = structuredClone(f.contract)
    invalid.context.provider.files[0].path = "../outside.md"
    expect(() => parseExtensionContract(invalid)).toThrow()
    expect(() => parseExtensionContract({ ...f.contract, context: { ...f.contract.context,
      knowledge: { required: false },
      provider: { ...f.contract.context.provider, actionId: "also-execute" }
    } })).toThrow()
    expect(() => readDeclaredContextFiles({ ...f, knowledgeRoot: undefined })).toThrow("KNOWLEDGE_REQUIRED")
  })

  it("rejects missing, oversized, non-text, hardlinked files and revoked authority", () => {
    const f = fixture()
    rmSync(join(f.knowledgeRoot, "AGENTS.md"))
    expect(() => readDeclaredContextFiles(f)).toThrow("FILE_MISSING")
    writeFileSync(join(f.knowledgeRoot, "AGENTS.md"), "x".repeat(25_000))
    expect(() => readDeclaredContextFiles(f)).toThrow("LIMIT")
    writeFileSync(join(f.knowledgeRoot, "AGENTS.md"), Buffer.from([0xff]))
    expect(() => readDeclaredContextFiles(f)).toThrow()
    rmSync(join(f.knowledgeRoot, "AGENTS.md"))
    linkSync(join(f.snapshotRoot, "rules.md"), join(f.knowledgeRoot, "AGENTS.md"))
    expect(() => readDeclaredContextFiles(f)).toThrow()
    expect(() => readDeclaredContextFiles({ ...f, assertCurrent: () => { throw Error("revoked") } })).toThrow("revoked")
  })
})
