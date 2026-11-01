/** Pure approval boundary checks. Never launches a native app or a subprocess. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, sep } from "node:path"
import {
  verifyWorkbenchNodeVersionApproval,
  workbenchNativeStateDetails,
  workbenchWorkspacePackets
} from "./support/developer-workbench-native-protocol"

const workspace = mkdtempSync(join(tmpdir(), "workbench-approval-unit-"))
const executable = realpathSync(process.execPath)
const executableSha256 = createHash("sha256").update(readFileSync(executable)).digest("hex")
const expected = {
  executable,
  executableSha256,
  workspace,
  requester: "function:developer-workbench"
}
function pending(
  update: Record<string, unknown> = {},
  proposalUpdate: Record<string, unknown> = {}
) {
  const request = { argv: [executable, "--version"], cwd: workspace, env: {}, ...update }
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(request, null, 2))
    .digest("hex")
  const proposal = {
    title: "批准插件运行本机命令",
    message: `插件 ${JSON.stringify(expected.requester)} 请求运行 ${JSON.stringify(executable)}`,
    buttons: ["拒绝", "允许本次命令", "查看完整请求"],
    requestDigest,
    detail: `完整请求 SHA-256：${requestDigest}`,
    request,
    ...proposalUpdate
  }
  return { digest: createHash("sha256").update(JSON.stringify(proposal)).digest("hex"), proposal }
}
try {
  const approved = verifyWorkbenchNodeVersionApproval(pending(), expected)
  assert.match(approved.digest, /^[a-f0-9]{64}$/)
  let accepted = 1
  if (process.platform === "win32") {
    assert.match(
      verifyWorkbenchNodeVersionApproval(pending({ cwd: workspace.toLowerCase() }), expected)
        .digest,
      /^[a-f0-9]{64}$/
    )
    accepted++
  }
  let rejected = 0
  for (const value of [
    pending({ argv: [executable, "-e", "arbitrary command"] }),
    pending({ argv: [executable, "--version", "extra"] }),
    pending({ cwd: dirname(workspace) }),
    pending({ env: { PATH: "unexpected overlay" } }),
    pending({ unsetEnv: ["PATH"] }),
    pending({ input: "" }),
    pending({ timeoutMs: 1000 }),
    pending({ arbitrary: true }),
    pending({}, { message: "插件 another-plugin 请求运行 node" }),
    pending({}, { title: "Different native prompt" }),
    { ...pending(), digest: "0".repeat(64) }
  ]) {
    assert.throws(() => verifyWorkbenchNodeVersionApproval(value, expected))
    rejected++
  }
  assert.throws(() =>
    verifyWorkbenchNodeVersionApproval(pending(), { ...expected, executableSha256: "0".repeat(64) })
  )
  const tampered = pending()
  tampered.proposal.request.cwd += sep
  tampered.digest = createHash("sha256").update(JSON.stringify(tampered.proposal)).digest("hex")
  assert.throws(
    () => verifyWorkbenchNodeVersionApproval(tampered, expected),
    /REQUEST_DIGEST_CHANGED/
  )
  assert.throws(
    () =>
      verifyWorkbenchNodeVersionApproval(
        pending({}, { detail: `完整请求 SHA-256：${"0".repeat(64)}` }),
        expected
      ),
    /APPROVAL_DETAIL_CHANGED/
  )
  assert.equal(
    workbenchWorkspacePackets([{ states: { "native.workspace": { value: { observing: false } } } }])
      .length,
    0
  )
  const state = {
    revision: 1,
    source: {
      provider: "native.workspace",
      digest: "native.workspace/changes/1.0.0",
      generation: "thread-incarnation"
    },
    value: { observing: false }
  }
  assert.equal(
    workbenchWorkspacePackets([
      { events: [], resync: false, state: { ...state, status: "unknown" } }
    ]).length,
    0
  )
  assert.equal(
    workbenchWorkspacePackets([{ events: [], resync: false, state: { ...state, status: "ready" } }])
      .length,
    1
  )
  assert.equal(
    workbenchNativeStateDetails([{ states: { "native.code": { value: { status: "running" } } } }])
      .length,
    0
  )
  const detail = {
    ref: { provider: "native.code", id: "java", version: "1.0.0" },
    capabilitySource: { available: true },
    state: { status: "ready" },
    observation: { status: "unavailable" },
    source: {},
    catalog: { total: 5 },
    truncatedFields: 0
  }
  assert.equal(workbenchNativeStateDetails([detail])[0].observation.status, "unavailable")
  console.log(
    `PASS workbench exact Node-version approval: ${accepted} accepted, ${rejected + 3} rejected; workspace packet boundaries; no app or process launched`
  )
} finally {
  assert.equal(dirname(realpathSync(workspace)), realpathSync(tmpdir()))
  assert(basename(workspace).startsWith("workbench-approval-unit-"))
  rmSync(workspace, { recursive: true, force: true })
}
