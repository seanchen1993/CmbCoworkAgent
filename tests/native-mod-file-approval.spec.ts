import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInNewContext } from "node:vm"
import {
  installNativeModFileApproval,
  nativeModFileApprovalDecision,
  nativeVerifiedReportText
} from "./support/native-mod-file-approval"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const files = [
  {
    id: "warehouse_quality",
    value: {
      qualityStatus: "passed",
      summary: { validAmountCents: 43575 },
      businessAcceptance: "needs_review",
      productionAcceptance: "not_evaluated"
    }
  },
  { id: "warehouse_sql_results", value: { validAmountCents: 43575 } }
].map(({ id, value }) => {
  const content = JSON.stringify(value)
  return {
    id,
    path: id + ".json",
    digest: digest(content),
    content,
    outputNodeId: "original-node",
    checkedBy: { nodeId: "original-node", checkId: id, contractDigest: "c".repeat(64) }
  }
})
const bundle = JSON.stringify({
  apiVersion: "devclaw.autobiz-context/v1",
  producer: {
    compositionRunId: "run",
    unitId: "warehouse",
    engineRunId: "engine",
    source: { pluginId: "actual-source", packageDigest: "a".repeat(64) },
    evidenceDigest: "b".repeat(64)
  },
  files
})
const expectedContent = nativeVerifiedReportText(bundle, digest)
const base = {
  ownerMatches: true,
  aborted: false,
  used: false,
  title: "批准插件操作",
  message: "插件 function:verified-artifact-consumer 请求执行 host:write_file",
  modId: "function:verified-artifact-consumer",
  actualPath: "c:/private/consumer/consumed-report.json",
  expectedPath: "c:/private/consumer/consumed-report.json",
  actualContent: expectedContent,
  expectedContent
}
assert.equal(nativeModFileApprovalDecision(base).response, 1)
for (const change of [
  { ownerMatches: false },
  { aborted: true },
  { used: true },
  { actualPath: "c:/private/warehouse/consumed-report.json" },
  { message: "插件 function:foreign 请求执行 host:write_file" },
  { actualContent: expectedContent.replace("43575", "1") },
  { actualContent: expectedContent.replace("needs_review", "accepted") },
  { actualContent: expectedContent.replace("not_evaluated", "production_approved") },
  { title: "批准流程操作" }
])
  assert.equal(nativeModFileApprovalDecision({ ...base, ...change }).response, 0)
assert.throws(
  () => nativeVerifiedReportText(bundle.replace("43575", "1"), digest),
  /INVALID_ARTIFACT/
)
assert.throws(
  () => nativeVerifiedReportText(bundle.replace("warehouse_quality", "foreign"), digest),
  /INVALID_ARTIFACT/
)
const projected = JSON.parse(expectedContent)
assert.equal(projected.bundleDigest, digest(bundle))
assert.deepEqual(projected.requiredIds, ["warehouse_sql_results", "warehouse_quality"])
assert.equal(projected.artifacts[0].value.businessAcceptance, "needs_review")
// The exact helper also works when serialized into the original private Electron main process.
const serializedDecision = new Function(
  "__name",
  "return (" + nativeModFileApprovalDecision.toString() + ")"
)((value: unknown) => value) as typeof nativeModFileApprovalDecision
const serializedProjection = new Function(
  "__name",
  "return (" + nativeVerifiedReportText.toString() + ")"
)((value: unknown) => value) as typeof nativeVerifiedReportText
assert.equal(serializedDecision(base).response, 1)
assert.equal(serializedProjection(bundle, digest), expectedContent)
console.log(
  "native-mod-file-approval: exact native approval plus 9 fail-closed cases, byte projection/tamper/serialization PASS"
)

async function originalNativeCallback() {
  const directory = mkdtempSync(join(tmpdir(), "native-mod-approval-"))
  const producerWorkspace = join(directory, "producer")
  const consumerWorkspace = join(directory, "consumer")
  mkdirSync(join(producerWorkspace, ".devclaw/handoffs"), { recursive: true })
  mkdirSync(join(consumerWorkspace, "inputs"), { recursive: true })
  writeFileSync(join(producerWorkspace, ".devclaw/handoffs/verified-context.json"), bundle)
  writeFileSync(join(consumerWorkspace, "inputs/verified-context.json"), bundle)
  const owner = { id: 7, isDestroyed: () => false }
  const dialog: {
    showMessageBox?: (
      owner: unknown,
      options: {
        title: string
        message: string
        detail: string
        signal?: AbortSignal
      }
    ) => Promise<{ response: number }>
  } = {}
  const context = { process }
  // No __name is supplied here. The exact exported callback must establish its own binding
  // before any nested arrow rewritten by tsx/esbuild executes in the isolated native realm.
  const install = runInNewContext(
    "(" + installNativeModFileApproval.toString() + ")",
    context
  ) as typeof installNativeModFileApproval
  install(
    {
      dialog,
      BrowserWindow: { fromId: (id: number) => (id === owner.id ? owner : null) }
    } as unknown as Parameters<typeof install>[0],
    {
      ownerId: owner.id,
      producerWorkspace,
      consumerWorkspace,
      validator: nativeModFileApprovalDecision.toString(),
      projector: nativeVerifiedReportText.toString()
    }
  )
  const request = {
    title: base.title,
    message: base.message,
    detail: JSON.stringify({ file_path: "consumed-report.json", content: expectedContent })
  }
  assert.equal((await dialog.showMessageBox!({ ...owner, id: 8 }, request)).response, 0)
  const controller = new AbortController()
  controller.abort()
  assert.equal(
    (await dialog.showMessageBox!(owner, { ...request, signal: controller.signal })).response,
    0
  )
  assert.equal((await dialog.showMessageBox!(owner, request)).response, 1)
  assert.equal((await dialog.showMessageBox!(owner, request)).response, 0)
  const records = (context as unknown as { __a12NativeFileApprovals: Array<{ response: number }> })
    .__a12NativeFileApprovals
  assert.deepEqual(
    Array.from(records, (record) => record.response),
    [0, 0, 1, 0]
  )
  console.log(
    "native-mod-file-approval: complete exported native callback in fresh realm PASS; no prebound __name"
  )
}
void originalNativeCallback().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
