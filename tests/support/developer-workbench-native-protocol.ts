import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import type { Locator } from "playwright"

export function verifyWorkbenchNodeVersionApproval(
  pending: unknown,
  expected: { executable: string; executableSha256: string; workspace: string; requester: string }
): { digest: string; requestDigest: string } {
  assert(pending && typeof pending === "object" && !Array.isArray(pending))
  const outer = pending as Record<string, unknown>
  const proposal = outer.proposal as Record<string, unknown>
  assert(proposal && typeof proposal === "object" && !Array.isArray(proposal))
  const digest = createHash("sha256").update(JSON.stringify(proposal)).digest("hex")
  assert.equal(outer.digest, digest, "WORKBENCH_APPROVAL_PROPOSAL_CHANGED")
  assert.equal(proposal.title, "批准插件运行本机命令")
  assert(
    typeof proposal.message === "string" &&
      proposal.message.startsWith(`插件 ${JSON.stringify(expected.requester)} 请求运行 `),
    "WORKBENCH_REQUESTER_CHANGED"
  )
  assert.deepEqual(proposal.buttons, ["拒绝", "允许本次命令", "查看完整请求"])
  assert(
    typeof proposal.requestDigest === "string" && /^[a-f0-9]{64}$/.test(proposal.requestDigest)
  )
  const request = proposal.request as Record<string, unknown>
  assert(request && typeof request === "object" && !Array.isArray(request))
  const requestDigest = createHash("sha256")
    .update(JSON.stringify(request, null, 2))
    .digest("hex")
  assert.equal(proposal.requestDigest, requestDigest, "WORKBENCH_REQUEST_DIGEST_CHANGED")
  assert(
    typeof proposal.detail === "string" &&
      /完整请求 SHA-256：([a-f0-9]{64})/.exec(proposal.detail)?.[1] === requestDigest,
    "WORKBENCH_APPROVAL_DETAIL_CHANGED"
  )
  assert(
    Object.keys(request).every((key) =>
      ["argv", "cwd", "env", "unsetEnv", "input", "timeoutMs"].includes(key)
    )
  )
  assert.deepEqual(
    request.argv,
    [expected.executable, "--version"],
    "WORKBENCH_ONLY_NODE_VERSION_ALLOWED"
  )
  assert(typeof request.cwd === "string")
  assert.equal(realpathSync(request.cwd), realpathSync(expected.workspace))
  assert.deepEqual(request.env, {}, "WORKBENCH_UNEXPECTED_ENVIRONMENT_OVERLAY")
  assert(
    request.unsetEnv === undefined ||
      (Array.isArray(request.unsetEnv) && request.unsetEnv.length === 0)
  )
  assert(request.input === undefined && request.timeoutMs === undefined)
  assert.equal(
    createHash("sha256").update(readFileSync(expected.executable)).digest("hex"),
    expected.executableSha256
  )
  return { digest, requestDigest: proposal.requestDigest }
}

/** Only observes production-rendered text; no SDK callbacks or native ACKs are fabricated. */
export async function workbenchVisibleJson(
  surface: Locator
): Promise<Array<Record<string, unknown>>> {
  return surface.locator("span,div,p").evaluateAll((nodes) =>
    nodes.flatMap((node) => {
      if (
        node.childElementCount ||
        !node.getClientRects().length ||
        node.closest('[hidden],[aria-hidden="true"]') ||
        getComputedStyle(node).visibility === "hidden" ||
        getComputedStyle(node).display === "none"
      )
        return []
      const visible = node.textContent?.trim() ?? ""
      const text = visible.startsWith("开发信息：") ? visible.slice("开发信息：".length) : visible
      if (!text.startsWith("{")) return []
      try {
        const value: unknown = JSON.parse(text)
        return value && typeof value === "object" && !Array.isArray(value)
          ? [value as Record<string, unknown>]
          : []
      } catch {
        return []
      }
    })
  )
}

export interface WorkbenchWorkspacePacket {
  events: Array<{
    revision: number
    source: Record<string, string>
    value: Record<string, unknown>
  }>
  resync: boolean
  state: {
    status: "ready"
    revision: number
    source: Record<string, string>
    value: Record<string, unknown>
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
export function workbenchNativeStateDetails(rows: readonly Record<string, unknown>[]) {
  return rows.flatMap((row) => {
    if (
      !object(row.ref) ||
      typeof row.ref.provider !== "string" ||
      typeof row.ref.id !== "string" ||
      typeof row.ref.version !== "string" ||
      !object(row.state) ||
      !object(row.observation) ||
      !object(row.capabilitySource) ||
      !object(row.catalog) ||
      !Number.isSafeInteger(row.truncatedFields)
    )
      return []
    return [
      {
        ref: { provider: row.ref.provider, id: row.ref.id, version: row.ref.version },
        state: row.state,
        observation: row.observation,
        capabilitySource: row.capabilitySource,
        source: row.source,
        catalog: row.catalog,
        truncatedFields: row.truncatedFields
      }
    ]
  })
}
function workspaceSource(value: unknown): value is Record<string, string> {
  return (
    object(value) &&
    value.provider === "native.workspace" &&
    typeof value.digest === "string" &&
    value.digest.length > 0 &&
    typeof value.generation === "string" &&
    value.generation.length > 0
  )
}
/** Ignore retained refresh/status JSON. Only genuine rendered workspace poll packets qualify. */
export function workbenchWorkspacePackets(
  rows: readonly Record<string, unknown>[]
): WorkbenchWorkspacePacket[] {
  return rows.flatMap((row) => {
    if (
      !Array.isArray(row.events) ||
      typeof row.resync !== "boolean" ||
      !object(row.state) ||
      row.state.status !== "ready" ||
      !Number.isSafeInteger(row.state.revision) ||
      !workspaceSource(row.state.source) ||
      !object(row.state.value)
    )
      return []
    const events: WorkbenchWorkspacePacket["events"] = []
    for (const event of row.events) {
      if (
        !object(event) ||
        !Number.isSafeInteger(event.revision) ||
        !workspaceSource(event.source) ||
        !object(event.value)
      )
        return []
      events.push({ revision: Number(event.revision), source: event.source, value: event.value })
    }
    return [
      {
        events,
        resync: row.resync,
        state: {
          status: "ready",
          revision: Number(row.state.revision),
          source: row.state.source,
          value: row.state.value
        }
      }
    ]
  })
}
