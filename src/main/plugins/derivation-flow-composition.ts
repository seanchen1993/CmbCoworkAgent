import { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
export { isReviewedAutobizProtocol } from "./autobiz-composition-protocol"
import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import type { DerivationSnapshot } from "./derivation-source"
import {
  AUTOBIZ_CONTEXT_OUTPUT,
  SOURCE_HANDOFF_PATH,
  SOURCE_HANDOFF_DECLARATION
} from "../../shared/project-runtime/autobiz-handoff"

const runtimePath = "devclaw.project-runtime.json"
const capabilitiesPath = "devclaw.capabilities.json"
const checksPath = "devclaw.stage-checks.json"
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

/** Static proposal only. Never executes plugin code or grants composition admission. */
export function prepareFlowCompositionFiles(snapshot: DerivationSnapshot) {
  const get = (path: string) => snapshot.files.find((file) => file.path === path)
  if (get(capabilitiesPath)) throw Error("此副本已有能力配置，请在项目能力中查看，不能重复覆盖")
  const files: Array<{ path: string; before: string; after: string }> = []
  const source = get(runtimePath)
  if (source) {
    let runtime: ReturnType<typeof parseProjectRuntimeManifest>
    try {
      runtime = parseProjectRuntimeManifest(JSON.parse(source.bytes.toString("utf8")))
    } catch {
      throw Error("流程配置不完整，请先检查副本，修正配置后再试")
    }
    if (runtime.mode !== "host") throw Error("此副本已有旧流程配置，请先完成兼容检查，不能覆盖")
    try {
      assertHostPackageSupported(snapshot.root, runtime)
    } catch {
      throw Error("此流程暂不满足组合要求，请先检查副本，核对插件版本、阶段技能和所需工具")
    }
  } else {
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
    if (!Array.isArray(nodes) || !nodes.length || nodes.length > 64)
      throw Error("原流程没有有效阶段")
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
  }
  const declaration = parsePluginCapabilities({
    apiVersion: "devclaw.capabilities/v1",
    capabilities: [
      {
        id: "project-flow",
        title: `${snapshot.name.slice(0, 110)}完整流程`,
        kind: "flow",
        usage: "project",
        entry: runtimePath,
        dependsOn: []
      }
    ]
  })
  files.push({ path: capabilitiesPath, before: "", after: json(declaration) })
  return {
    summary:
      "为此副本添加完整流程入口，保留原技能、检查和审批。保存后检查并安装副本，再到项目能力中查看可用状态。",
    files
  }
}
