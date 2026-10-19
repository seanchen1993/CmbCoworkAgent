import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { lstat, mkdir, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"
import {
  snapshotDerivationSource,
  writeDerivationFiles
} from "../src/main/plugins/derivation-source"
import previous from "../src/main/plugins/autobiz-business-kernel-spec-role-reviewed.json"

export const AUTOBIZ_UTEST_LITERAL_SOURCE_DIGEST =
  "726f66acb1c275090d9059758847d9856984f396f7137bbb45fd888d2a0763bf"
export const AUTOBIZ_UTEST_LITERAL_FROM_SHA256 =
  "483be49a2ad837e1fb24797ffbbf8e53b47bdcbd017ffa6029d1cbfa926c2d3a"
export const AUTOBIZ_UTEST_LITERAL_TO_SHA256 =
  "c315b5d820427bdb2e30dea4e4929fdb648bf1d2ac049723465d8587b4b74824"
export const AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256 =
  "7a49595b62bc1b8498ab3413be9304eed4de8ada37a8e43f906e43be51874667"
export const AUTOBIZ_UTEST_LITERAL_PATH = "hooks/augment_test_engineer_task_prompt.py"
const digest = (value: Buffer | string) => createHash("sha256").update(value).digest("hex")

/** Creates an independently identified source; never patches upstream or an installed package. */
export async function prepareAutobizUtestLiteralSource(output: string, source: string) {
  const inside = relative(resolve(source), resolve(output))
  assert(
    inside && (inside.split(/[\\/]/)[0] === ".." || isAbsolute(inside)),
    "New source must be outside the read-only 1.0.3 source"
  )
  for (const path of [output, output + ".receipt.json"]) {
    try {
      await lstat(path)
      throw Error("AUTOBIZ_UTEST_OUTPUT_EXISTS")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
  }
  const original = await snapshotDerivationSource(source)
  assert.equal(
    original.digest,
    AUTOBIZ_UTEST_LITERAL_SOURCE_DIGEST,
    "Exact reviewed 1.0.3 source bytes required; unknown sources must not be transformed"
  )
  const files = new Map(original.files.map((file) => [file.path, file]))
  for (const file of previous.files)
    assert.equal(files.get(file.path)?.digest, file.digest, file.path)
  assert.equal(
    files.get("workflows/code-batched-execution.workflow.js")?.digest,
    AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256
  )
  const hook = files.get(AUTOBIZ_UTEST_LITERAL_PATH)!
  assert.equal(hook.digest, AUTOBIZ_UTEST_LITERAL_FROM_SHA256)
  const text = hook.bytes.toString("utf8")
  assert.equal(text.split("${PIPESTATUS[0]}").length, 2, "Exact single template literal required")
  const repaired = Buffer.from(text.replace("${PIPESTATUS[0]}", "${{PIPESTATUS[0]}}"))
  assert.equal(digest(repaired), AUTOBIZ_UTEST_LITERAL_TO_SHA256)
  const manifest = JSON.parse(files.get("mods/business/manifest.json")!.bytes.toString("utf8"))
  assert.deepEqual(
    { id: manifest.kernel.id, version: manifest.kernel.version },
    { id: previous.id, version: "1.0.3" }
  )
  manifest.kernel.version = "1.0.4"
  const plugin = JSON.parse(files.get("plugin.json")!.bytes.toString("utf8"))
  plugin.name = "autobiz-utest-literal-compatible"
  plugin.version = "1.0.4"
  plugin.description += "；UTest Hook shell字面量转义修订 1.0.4"
  const runtime = JSON.parse(files.get("devclaw.project-runtime.json")!.bytes.toString("utf8"))
  const declaration =
    runtime.apiVersion === "devclaw.project-runtime/v2" ? runtime.runtime : runtime
  declaration.plugin = { id: plugin.name, version: plugin.version }
  const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + "\n")
  const changes = new Map([
    [AUTOBIZ_UTEST_LITERAL_PATH, repaired],
    ["mods/business/manifest.json", json(manifest)],
    ["plugin.json", json(plugin)],
    ["devclaw.project-runtime.json", json(runtime)]
  ])
  await mkdir(output)
  await writeDerivationFiles(
    output,
    original.files.map((file) =>
      changes.has(file.path)
        ? { ...file, bytes: changes.get(file.path)!, digest: digest(changes.get(file.path)!) }
        : file
    )
  )
  const created = await snapshotDerivationSource(output)
  assert.equal(created.files.length, original.files.length)
  for (const file of original.files)
    assert.equal(
      created.files.find((row) => row.path === file.path)?.digest,
      changes.has(file.path) ? digest(changes.get(file.path)!) : file.digest,
      file.path
    )
  assert.equal((await snapshotDerivationSource(source)).digest, original.digest)
  const receipt = {
    apiVersion: "devclaw.autobiz-utest-literal/v1",
    kernelVersion: "1.0.4",
    source: resolve(source),
    output: resolve(output),
    fromDigest: original.digest,
    toDigest: created.digest,
    changedFiles: [...changes.keys()],
    fromHookSha256: hook.digest,
    toHookSha256: digest(repaired),
    workflowUnchangedSha256: AUTOBIZ_UTEST_LITERAL_WORKFLOW_SHA256,
    semantics:
      "Escape Python format braces only; emitted Bash PIPESTATUS literal and assignment validation unchanged",
    sourceUnchanged: true,
    noOverwrite: true
  }
  await writeFile(output + ".receipt.json", JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  return receipt
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === join(__dirname, "prepare-autobiz-utest-literal-source.ts")
) {
  assert(
    process.argv[2] && process.argv[3],
    "Explicit fresh output and exact reviewed 1.0.3 source required"
  )
  void prepareAutobizUtestLiteralSource(resolve(process.argv[2]), resolve(process.argv[3]))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
