import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRequire } from "node:module"
import { build } from "esbuild"
import { modsGitTree } from "../support/mods-git-tree"
import { readModsSourceCandidate } from "../support/mods-source-candidate"
import { modsSourceNodeWorkers } from "../support/mods-source-node-workers"
import { creatorLiveBudgetObservation } from "../support/creator-live-budget-observation"
import {
  captureModsSourceSnapshot,
  verifyModsSourceSnapshot
} from "../support/mods-source-snapshot"

describe("immutable complete baseline source", () => {
  it("rejects renderer-only edits and added files against the pre-compilation snapshot", () => {
    const root = mkdtempSync(join(tmpdir(), "phase3-input-snapshot-"))
    mkdirSync(join(root, "src/renderer"), { recursive: true })
    const file = join(root, "src/renderer/entry.tsx")
    writeFileSync(file, "before")
    const original = captureModsSourceSnapshot(root, ["src"])
    writeFileSync(file, "during compile")
    expect(() => verifyModsSourceSnapshot(root, ["src"], original)).toThrow(
      "SOURCE_CHECKOUT_CHANGED"
    )
    writeFileSync(file, "before")
    writeFileSync(join(root, "src/renderer/new.ts"), "new input")
    expect(() => verifyModsSourceSnapshot(root, ["src"], original)).toThrow(
      "SOURCE_CHECKOUT_CHANGED"
    )
  })
  it("records request size and output budgets without storing provider or prompt secrets", () => {
    const observed = creatorLiveBudgetObservation({
      model: "private-model",
      apiKey: "secret-key",
      messages: [{ role: "user", content: "private prompt" }],
      max_tokens: 8192,
      tools: [{ function: { name: "private-tool", description: "private description" } }]
    })
    expect(observed).toMatchObject({
      messageCount: 1,
      offeredToolCount: 1,
      requestedOutputTokens: 8192
    })
    expect(observed.promptBytes).toBeGreaterThan(0)
    expect(JSON.stringify(observed)).not.toMatch(/private|secret/)
  })
  it("loads a historical dependency outside mods and rejects current-only imports", async () => {
    const root = mkdtempSync(join(tmpdir(), "phase3-git-tree-"))
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        [
          "-c",
          `core.hooksPath=${join(root, "disabled-hooks")}`,
          "-c",
          "commit.gpgsign=false",
          ...args
        ],
        { cwd: root, encoding: "utf8", windowsHide: true }
      )
    git("init", "--quiet")
    mkdirSync(join(root, "src/main/mods"), { recursive: true })
    mkdirSync(join(root, "src/shared"), { recursive: true })
    writeFileSync(join(root, "src/main/mods/entry.ts"), 'export {value} from "../../shared/知识"')
    writeFileSync(join(root, "src/shared/知识.ts"), 'export const value="historical"')
    writeFileSync(join(root, "package-lock.json"), "{}\n")
    git("add", ".")
    git(
      "-c",
      "user.name=Isolated Fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-qm",
      "fixture"
    )
    const tree = modsGitTree(root, "HEAD")
    expect(tree.commit).toBe(git("rev-parse", "HEAD").trim())
    expect(tree.assertSameDependencies()).toMatch(/^[a-f0-9]{64}$/)
    writeFileSync(join(root, "src/shared/知识.ts"), 'export const value="working-tree"')
    const result = await build({
      entryPoints: [join(root, "src/main/mods/entry.ts")],
      bundle: true,
      write: false,
      plugins: [tree.plugin],
      logLevel: "silent"
    })
    expect(result.outputFiles[0].text).toContain("historical")
    expect(result.outputFiles[0].text).not.toContain("working-tree")
    writeFileSync(join(root, "src/shared/current-only.ts"), "export const value=1")
    expect(() => tree.resolveSource("src/shared/current-only")).toThrow("BASELINE_IMPORT_MISSING")
    expect(() => tree.resolveSource("../outside")).toThrow("BASELINE_IMPORT_OUTSIDE_TREE")
    writeFileSync(join(root, "package-lock.json"), '{"changed":true}')
    expect(() => tree.assertSameDependencies()).toThrow("BASELINE_DEPENDENCY_LOCK_CHANGED")
  })
  it("uses actual worker factories and preserves resource limits", async () => {
    const root = mkdtempSync(join(tmpdir(), "phase3-worker-"))
    writeFileSync(
      join(root, "entry.ts"),
      'import create from "./worker?nodeWorker"; export const worker=create({resourceLimits:{maxOldGenerationSizeMb:32}})'
    )
    writeFileSync(
      join(root, "worker.ts"),
      'import {parentPort} from "node:worker_threads";parentPort?.on("message",()=>parentPort?.postMessage("real"))'
    )
    const workers = modsSourceNodeWorkers(root)
    await build({
      entryPoints: [join(root, "entry.ts")],
      platform: "node",
      bundle: true,
      format: "cjs",
      outfile: join(root, "entry.cjs"),
      plugins: [workers.plugin],
      logLevel: "silent"
    })
    expect(workers.entries.size).toBe(1)
    for (const [source, name] of workers.entries)
      await build({
        entryPoints: [source],
        outfile: join(root, name),
        platform: "node",
        bundle: true,
        format: "cjs",
        logLevel: "silent"
      })
    const { worker } = createRequire(import.meta.url)(join(root, "entry.cjs")) as {
      worker: import("node:worker_threads").Worker
    }
    try {
      const value = await new Promise((done, fail) => {
        worker.once("message", done)
        worker.once("error", fail)
        worker.postMessage("probe")
      })
      expect(value).toBe("real")
      expect(worker.resourceLimits.maxOldGenerationSizeMb).toBe(32)
    } finally {
      await worker.terminate()
    }
  })
  it("rejects tampered candidate bundles and changed checkout sources", () => {
    const root = mkdtempSync(join(tmpdir(), "phase3-source-proof-"))
    mkdirSync(join(root, "out/main"), { recursive: true })
    const entry = join(root, "out/main/index.js")
    const digest = (text: string) => createHash("sha256").update(text).digest("hex")
    writeFileSync(entry, "fixture")
    writeFileSync(join(root, "package-lock.json"), "{}")
    writeFileSync(join(root, "source.ts"), "source")
    const manifest = join(root, "source-candidate.json")
    writeFileSync(
      manifest,
      JSON.stringify({
        execution: "source-isolated",
        root,
        repository: root,
        head: "fixture",
        entry,
        rendererUrl: "http://127.0.0.1:1/",
        files: { "out/main/index.js": digest("fixture") },
        sources: { "source.ts": digest("source") },
        sourceRoots: ["source.ts"],
        dependencies: digest("{}")
      })
    )
    expect(readModsSourceCandidate(manifest).entry).toBe(entry)
    writeFileSync(entry, "tampered")
    expect(() => readModsSourceCandidate(manifest)).toThrow("SOURCE_CANDIDATE_CHANGED")
    writeFileSync(entry, "fixture")
    writeFileSync(join(root, "source.ts"), "changed")
    expect(() => readModsSourceCandidate(manifest)).toThrow("SOURCE_CHECKOUT_CHANGED")
  })
})
