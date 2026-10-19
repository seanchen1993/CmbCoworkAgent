import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import AdmZip from "adm-zip"
import { inspectPluginZip } from "../src/main/ipc/plugins"
import { checkFunctionPlugin } from "../src/main/mods/devtools/check"

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

async function main() {
  const directory = resolve(
    process.argv[2] || "output/deliveries/platform-leadership-demo-20261016-final"
  )
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as {
    packages: Array<{
      name: string
      zip: string
      sha256: string
      pluginName: string
      compiledDigest: string
      files: Array<{ path: string; bytes: number; sha256: string }>
    }>
  }
  assert.equal(manifest.packages.length, 5)
  const results: unknown[] = []
  for (const item of manifest.packages) {
    const bytes = await readFile(join(directory, item.zip))
    assert.equal(hash(bytes), item.sha256)
    const zip = new AdmZip(bytes)
    assert.deepEqual(
      zip
        .getEntries()
        .map((entry) => entry.entryName)
        .sort(),
      item.files.map((entry) => entry.path).sort()
    )
    for (const entry of item.files) {
      const archived = zip.readFile(entry.path)!
      assert.equal(archived.length, entry.bytes)
      assert.equal(hash(archived), entry.sha256)
      assert.equal(
        hash(await readFile(join(directory, "sources", item.name, entry.path))),
        entry.sha256
      )
    }
    const report = await checkFunctionPlugin(join(directory, "sources", item.name))
    assert(report.valid)
    assert(report.compatibility.strictCompatible)
    assert.equal(report.digest, item.compiledDigest)
    const inspected = await inspectPluginZip(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    )
    assert.equal(inspected.manifest?.name, item.pluginName)
    results.push({
      plugin: item.pluginName,
      digest: report.digest,
      inspected: true,
      sdkStaticStrict: report.sdkCompatibility.strictCompatible,
      sdkDiagnostics: report.sdkCompatibility.diagnostics
    })
  }
  assert.equal((await readdir(join(directory, "workspace"))).length, 16)
  assert(
    !(await readFile(join(directory, "现场操作.md"), "utf8").then((text) =>
      text.includes("紧凑提醒")
    ))
  )
  const result = {
    passed: true,
    packages: results,
    inputFiles: 16,
    modelCalls: 0,
    validation: "ZIP bytes, frozen-source digest, native ZIP inspection; no business action"
  }
  await writeFile(join(directory, "verification.json"), JSON.stringify(result, null, 2) + "\n")
  console.log(JSON.stringify({ passed: true, packages: results.length, directory }))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
