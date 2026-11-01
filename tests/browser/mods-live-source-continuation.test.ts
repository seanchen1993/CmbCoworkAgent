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
          trials: [
            {
              draftId: "generic",
              revision: 1,
              bundleDigest: source.digest,
              compiledDigest: "original-compile"
            }
          ],
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
      compiledDigest: "original-compile",
      source
    }
    writeFileSync(record, JSON.stringify(native))
    const newer = join(run, "data/mod-development/scope/newer/record.json")
    mkdirSync(join(newer, ".."), { recursive: true })
    writeFileSync(newer, JSON.stringify({ ...native, compiledDigest: "later-native-compile" }))
    const resumed = readGenericLiveSourceContinuation(root, run)
    expect(resumed.files).toEqual(source.files)
    expect(Object.keys(resumed).sort()).toEqual([
      "evidencePath",
      "files",
      "id",
      "name",
      "originalBuild",
      "profile",
      "revision",
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

  it("uses an exact later successful native receipt when the original prepared version was collected", () => {
    const root = mkdtempSync(join(tmpdir(), "mods-source-native-witness-"))
    const run = join(root, "output/phase3-source-generic-mod-123456ab/journey/run-abc123")
    const write = (path: string, value: unknown) => {
      mkdirSync(join(path, ".."), { recursive: true })
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value))
    }
    const files = [
      { path: "plugin.json", text: '{"name":"generic"}' },
      { path: "mods/main.ts", text: "export const source = 1" }
    ]
    const source = createAuthoringSourceBundle(files)
    const original = {
      realAuthoring: true,
      threadId: "native-original-thread",
      build: { execution: "source-isolated" },
      observations: [
        {
          drafts: [{ id: "generic", name: "Generic", revision: 1, digest: source.digest }],
          nativeReadCount: 1,
          nativeReadReceipt: { messageId: "original-read" },
          sourceFiles: files.map((file) => ({
            path: file.path,
            sha256: createHash("sha256").update(file.text).digest("hex")
          })),
          trials: [
            {
              draftId: "generic",
              revision: 1,
              bundleDigest: source.digest,
              compiledDigest: "collected-old-compile"
            }
          ]
        }
      ],
      requests: [{ status: 200, tools: [{ action: "catalog", sdkQuery: "prompt.paint" }] }]
    }
    const originalPath = join(run, "evidence.json")
    write(originalPath, original)
    const candidate = join(root, "output/phase3-source-generic-mod-876543ab/candidate")
    const artifactFiles = {
      "out/main/index.js": "actual-old-main",
      "out/preload/index.js": "actual-old-preload"
    }
    for (const [path, text] of Object.entries(artifactFiles)) write(join(candidate, path), text)
    write(join(root, "package-lock.json"), "fixed-lock")
    const manifest = {
      execution: "source-isolated",
      repository: root,
      root: candidate,
      head: "a".repeat(40),
      entry: join(candidate, "out/main/index.js"),
      rendererUrl: "http://127.0.0.1:1234",
      files: Object.fromEntries(
        Object.entries(artifactFiles).map(([path, text]) => [
          path,
          createHash("sha256").update(text).digest("hex")
        ])
      ),
      dependencies: createHash("sha256").update("fixed-lock").digest("hex"),
      sources: { "src/old-source.ts": "a".repeat(64) },
      sourceRoots: ["src"]
    }
    const manifestPath = join(candidate, "source-candidate.json")
    write(manifestPath, manifest)
    write(join(candidate, "../run.json"), {
      head: manifest.head,
      candidate: manifestPath,
      manifestSha256: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
      driverIntegrityVerified: true,
      realModel: true,
      driverHashes: { "tests/entry.ts": "b".repeat(64) }
    })
    const witness = {
      ...original,
      build: {
        execution: "source-isolated",
        sourceManifest: manifestPath,
        path: join(candidate, "out/main/index.js"),
        sha256: createHash("sha256").update("actual-old-main").digest("hex")
      },
      sourceContinuation: { evidence: originalPath, sourceDigest: source.digest },
      observations: [
        {
          ...original.observations[0],
          nativeReadReceipt: { messageId: "actual-new-read" },
          paint: {
            jobId: "actual-paint-job",
            textUnchanged: true,
            cursorUnchanged: true,
            virtualTextVisible: true
          },
          trials: [
            {
              draftId: "generic",
              revision: 1,
              bundleDigest: source.digest,
              compiledDigest: "new-observed-compile"
            }
          ]
        }
      ]
    }
    const witnessPath = join(run, "source-continuation-123456789.json")
    write(witnessPath, witness)
    const record = join(run, "data/mod-development/scope/new-version/record.json")
    write(record, {
      schemaVersion: 1,
      coverage: "prepared-source-only-v1",
      workspace: join(run, "workspace"),
      draftId: "generic",
      revision: 1,
      sourceDigest: source.digest,
      compiledDigest: "new-observed-compile",
      source
    })
    expect(() => readGenericLiveSourceContinuation(root, run)).toThrow(
      "EXACT_NATIVE_RECORD_REQUIRED"
    )
    const resumed = readGenericLiveSourceContinuation(root, run, witnessPath)
    expect(resumed.files).toEqual(source.files)
    expect(Object.keys(resumed.receiptProof!.hashes)).toContain(witnessPath)
    expect(JSON.stringify(resumed)).not.toMatch(/grant|credential/)
    witness.threadId = "different-thread"
    write(witnessPath, witness)
    expect(() => readGenericLiveSourceContinuation(root, run, witnessPath)).toThrow(
      "THREAD_CHANGED"
    )
    witness.threadId = original.threadId
    witness.observations[0].paint.virtualTextVisible = false
    write(witnessPath, witness)
    expect(() => readGenericLiveSourceContinuation(root, run, witnessPath)).toThrow(
      "EXACT_SUCCESSFUL_NATIVE_WITNESS"
    )
  })
})
