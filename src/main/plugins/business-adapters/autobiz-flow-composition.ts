import { isReviewedAutobizProtocol } from "../autobiz-composition-protocol"
export { isReviewedAutobizProtocol } from "../autobiz-composition-protocol"
import { parseProjectRuntimeManifest } from "../../../shared/project-runtime"
import type { DerivationSnapshot } from "../derivation-source"
import {
  AUTOBIZ_CONTEXT_OUTPUT,
  SOURCE_HANDOFF_PATH,
  SOURCE_HANDOFF_DECLARATION
} from "../../../shared/project-runtime/autobiz-handoff"

/** Read-only compatibility proposal for the reviewed original business executor. */
export function prepareAutobizFlowCompositionFiles(snapshot: DerivationSnapshot) {
  const get = (path: string) => snapshot.files.find((file) => file.path === path)
  const runtimePath = "devclaw.project-runtime.json"
  const checksPath = "devclaw.stage-checks.json"
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
  const files: Array<{ path: string; before: string; after: string }> = []
  if (get(checksPath) || get(SOURCE_HANDOFF_PATH))
    throw Error("此副本已有阶段检查或源码交接配置，不能覆盖")
  if (!isReviewedAutobizProtocol(snapshot))
    throw Error("这个插件版本尚未通过流程组合适配；请继续从原项目入口使用")
  const manifestFile = snapshot.manifests.map(get).find(Boolean)
  const metadata = manifestFile && JSON.parse(manifestFile.bytes.toString("utf8"))
  const board = get("board_core/board_config.json")
  if (!metadata || metadata.name !== snapshot.name || !board || board.bytes.length > 1024 * 1024)
    throw Error("插件身份或原流程配置无效")
  const nodes = JSON.parse(board.bytes.toString("utf8")).workflow?.nodes
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 64) throw Error("原流程没有有效阶段")
  // These names support discovery only. Execution compiles the original dynamic contracts.
  const runtime = parseProjectRuntimeManifest({
    apiVersion: "devclaw.project-runtime/v1",
    plugin: { id: metadata.name, version: metadata.version },
    mode: "legacy",
    stateOwner: "plugin",
    stages: nodes.map((node: { id: unknown; label: unknown }) => ({
      id: node.id,
      title: node.label,
      actionIds: [],
      artifactIds: [],
      checkIds: [],
      approval: "none"
    })),
    actions: [],
    artifacts: [{ ...AUTOBIZ_CONTEXT_OUTPUT, required: true }],
    checks: [],
    environment: [],
    capabilities: {
      execution: true,
      conditionalTransition: false,
      idempotency: false,
      reconciliation: false,
      cancellation: true
    }
  })
  files.push(
    { path: runtimePath, before: "", after: json(runtime) },
    {
      path: checksPath,
      before: "",
      after: json({
        apiVersion: "devclaw.stage-check-adapter/v1",
        adapter: "autobiz-v1"
      })
    },
    { path: SOURCE_HANDOFF_PATH, before: "", after: json(SOURCE_HANDOFF_DECLARATION) }
  )
  return files
}
