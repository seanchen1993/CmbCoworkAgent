export { isReviewedAutobizProtocol } from "./business-adapters/autobiz-flow-composition"
import { prepareAutobizFlowCompositionFiles } from "./business-adapters/autobiz-flow-composition"
import { parsePluginCapabilities } from "../../shared/plugin-capabilities"
import { parseProjectRuntimeManifest } from "../../shared/project-runtime"
import { assertHostPackageSupported } from "../harness-board/project-runtime/package-preflight"
import type { DerivationSnapshot } from "./derivation-source"

const runtimePath = "devclaw.project-runtime.json"
const capabilitiesPath = "devclaw.capabilities.json"
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
    files.push(...prepareAutobizFlowCompositionFiles(snapshot))
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
