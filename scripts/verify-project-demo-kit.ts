import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { copyFile, readFile, readdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { inspectPluginZip } from "../src/main/ipc/plugins"

async function main() {
  const directory = resolve(process.argv[2] || "output/deliveries/project-leadership-demo-20261016")
  const report = JSON.parse(await readFile(join(directory, "verification.json"), "utf8"))
  const results: unknown[] = []
  for (const item of report.packages as Array<{ name: string; zip: string; sha256: string }>) {
    const bytes = await readFile(join(directory, item.zip))
    assert.equal(createHash("sha256").update(bytes).digest("hex"), item.sha256)
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer
    const inspected = await inspectPluginZip(buffer)
    assert.equal(inspected.manifest?.name, item.name)
    assert(inspected.skills.length > 0)
    results.push({
      plugin: item.name,
      sha256: item.sha256,
      skills: inspected.skills.length,
      hooks: inspected.hookCount,
      validation: "Ordinary plugin ZIP inspection API; inspected, not installed or approved"
    })
  }
  assert.deepEqual(await readdir(join(directory, "workspace")), [])
  const handoffEvidence = process.argv[3] ? resolve(process.argv[3]) : undefined
  let handoff: unknown
  if (handoffEvidence) {
    const run = JSON.parse(await readFile(handoffEvidence, "utf8"))
    assert.equal(run.testMode, "ordered-flows-and-handoff")
    assert.deepEqual(run.errors, [])
    assert(
      run.handoffRequests.some(
        (row: { reader: boolean; tool?: string }) => row.reader && row.tool === "read_file"
      )
    )
    assert(
      run.handoffRequests.some(
        (row: { reader: boolean; tool?: string }) => row.reader && row.tool === "write_file"
      )
    )
    await copyFile(handoffEvidence, join(directory, "current-platform-handoff.json"))
    handoff = {
      file: "current-platform-handoff.json",
      source: handoffEvidence,
      model: "loopback controlled provider",
      requests: run.handoffRequests.length,
      candidate: run.candidate,
      captureWarnings: run.captureWarnings,
      scope:
        "Real IPC ordered file handoff and failed predecessor isolation with separate controlled test plugins; not commercial-model execution of the delivered ZIPs"
    }
  }
  const result = {
    passed: true,
    packages: results,
    workspaceInitiallyEmpty: true,
    modelCalls: 0,
    ...(handoff ? { platformHandoff: handoff } : {}),
    limitation:
      "Does not execute Skills, start a project, approve effects or validate business model quality"
  }
  await writeFile(
    join(directory, "install-inspection.json"),
    JSON.stringify(result, null, 2) + "\n"
  )
  console.log(JSON.stringify(result))
}
void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
