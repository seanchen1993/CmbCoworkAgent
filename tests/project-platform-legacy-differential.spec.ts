import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { HostPackageSnapshots } from "../src/main/harness-board/project-runtime/package-snapshots"
import { hostProjectFixture } from "../src/main/harness-board/project-runtime/host-fixtures.test-helper"

const execute = promisify(execFile)
const root = mkdtempSync(join(tmpdir(), "legacy-source-differential-"))
const commit = "504e327d2f9a4d9e30e9f541c4432accf8000ad5"
async function main() {
  try {
    const original = join(root, "original")
    mkdirSync(original)
    const archive = await execute(
      "git",
      [
        "--no-replace-objects",
        "-C",
        process.env.CMB_AUTOBIZ_SOURCE || "C:/ai/autobiz_kanban",
        "archive",
        "--format=zip",
        commit,
        "hooks",
        "board_core",
        "skills",
        "agents",
        "workflows",
        "plugin.json"
      ],
      { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, windowsHide: true }
    )
    new AdmZip(archive.stdout).extractAllTo(original, false)
    const plugin = JSON.parse(readFileSync(join(original, "plugin.json"), "utf8"))
    const manifest = hostProjectFixture(root).manifest
    manifest.mode = "legacy"
    manifest.stateOwner = "plugin"
    manifest.plugin = { id: plugin.name, version: plugin.version }
    writeFileSync(join(original, "devclaw.project-runtime.json"), JSON.stringify(manifest))
    const snapshot = new HostPackageSnapshots(join(root, "snapshots")).capture(original)
    const probe = resolve(__dirname, "support/project-platform-legacy-source-probe.py")
    const outcomes: unknown[] = []
    for (const [name, source] of [
      ["original-project", original],
      ["pinned-project", snapshot.root]
    ]) {
      const output = await execute(
        process.env.CMB_AUTOBIZ_PYTHON || "python",
        ["-I", "-B", probe, source, join(root, name)],
        { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
      )
      outcomes.push(JSON.parse(output.stdout))
    }
    assert.deepEqual(outcomes[1], outcomes[0])
    assert.equal(
      new HostPackageSnapshots(join(root, "snapshots")).read(snapshot.digest).digest,
      snapshot.digest
    )
    console.log(
      JSON.stringify({
        passed: true,
        sourceCommit: commit,
        packageDigest: snapshot.digest,
        scope:
          "real original Python validation/guard/compiler versus retained source on independent synthetic projects",
        limitations: [
          "No external business services or model",
          "Not a complete original/new UI transaction comparison",
          "Design gate response is not a human approval or business transition"
        ]
      })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
