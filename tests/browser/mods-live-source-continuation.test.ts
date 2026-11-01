import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAuthoringSourceBundle } from "../../src/main/mods/devtools/authoring-bundle"
import { readGenericLiveSourceContinuation } from "../support/generic-live-source-continuation"
import { modsSourceDriverHashes } from "../support/mods-source-driver-hashes"

describe("real author source continuation boundaries", () => {
  it("returns only exact source and provenance, rejecting changed native bundle bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "mods-source-continuation-"))
    const run = join(root, "output/phase3-source-generic-mod-123456ab/journey/run-abc123")
    const record = join(run, "data/mod-development/scope/revision/record.json")
    mkdirSync(join(record, ".."), { recursive: true })
    const files = [
      { path: "plugin.json", text: '{"name":"generic"}' },
      { path: "mods/main.ts", text: "export const source = 1" }
    ]
    const source = createAuthoringSourceBundle(files)
    const evidence = {
      realAuthoring: true,
      build: { execution: "source-isolated" },
      observations: [
        {
          drafts: [{ id: "generic", name: "Generic", revision: 1, digest: source.digest }],
          nativeReadCount: 1,
          nativeReadReceipt: { messageId: "read-receipt" },
          sourceFiles: files.map((file) => ({
            path: file.path,
            sha256: createHash("sha256").update(file.text).digest("hex")
          }))
        }
      ],
      requests: [{ status: 200, tools: [{ action: "catalog", sdkQuery: "prompt.paint" }] }],
      grants: ["must-not-copy"],
      config: { credential: "must-not-copy" }
    }
    writeFileSync(join(run, "evidence.json"), JSON.stringify(evidence))
    const native = {
      schemaVersion: 1,
      coverage: "prepared-source-only-v1",
      draftId: "generic",
      revision: 1,
      sourceDigest: source.digest,
      source
    }
    writeFileSync(record, JSON.stringify(native))
    const resumed = readGenericLiveSourceContinuation(root, run)
    expect(resumed.files).toEqual(source.files)
    expect(Object.keys(resumed).sort()).toEqual([
      "evidencePath",
      "files",
      "id",
      "name",
      "originalBuild",
      "sourceDigest"
    ])
    expect(JSON.stringify(resumed)).not.toContain("must-not-copy")
    native.source.files[0].text += " "
    writeFileSync(record, JSON.stringify(native))
    expect(() => readGenericLiveSourceContinuation(root, run)).toThrow(
      "CONTINUATION_NATIVE_BUNDLE_CHANGED"
    )
  })

  it("pins selected static and literal dynamic imports plus native runtime launcher only", async () => {
    const root = mkdtempSync(join(tmpdir(), "mods-driver-closure-"))
    mkdirSync(join(root, "tests/support"), { recursive: true })
    const files = {
      "tests/entry.ts": 'import "./support/static"; void import("./support/dynamic")',
      "tests/support/static.ts": 'import "./nested"',
      "tests/support/nested.ts": "export {}",
      "tests/support/dynamic.ts": "export {}",
      "tests/support/unrelated.ts": "export {}",
      "tests/support/electron-launcher.cmd": "@echo off\r\n"
    }
    for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text)
    const actual = await modsSourceDriverHashes(root, ["tests/entry.ts"])
    expect(Object.keys(actual).sort()).toEqual(
      Object.keys(files)
        .filter((path) => !path.endsWith("unrelated.ts"))
        .sort()
    )
    for (const [path, hash] of Object.entries(actual))
      expect(hash).toBe(
        createHash("sha256")
          .update(readFileSync(join(root, path)))
          .digest("hex")
      )
    const unrelated = modsSourceDriverHashes(root, ["tests/entry.ts"])
    writeFileSync(join(root, "tests/support/unrelated.ts"), "export const changed = true")
    await expect(unrelated).resolves.not.toHaveProperty("tests/support/unrelated.ts")
    const changed = modsSourceDriverHashes(root, ["tests/entry.ts"])
    writeFileSync(
      join(root, "tests/entry.ts"),
      files["tests/entry.ts"] + "\n// changed during trace"
    )
    await expect(changed).rejects.toThrow("SOURCE_DRIVER_CHANGED_DURING_TRACE:tests/entry.ts")
  })
})
