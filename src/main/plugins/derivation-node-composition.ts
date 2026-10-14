import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import type { DerivationSnapshot } from "./derivation-source"

export const COMPOSITION_CONFIG = "board_core/board_config.json"
export const COMPOSITION_TEMPLATE = "devclaw-composed"
// Reviewed AutoBiz protocol implementation, normalized only for checkout line endings.
// Unknown versions require another compatibility review; never infer capability from a filename.
const protocol = {
  "hooks/inspect_workflow_templates.py":
    "25f5b86b54997865179f297173479f16871932d61df37edb81140174dfd46fe8",
  "board_core/workflow_compiler.py":
    "46ff11027fdf54b2a742b09eca581ff45dbf6ed9049216a145e61423626ea5eb",
  "hooks/init_workspace.py": "a64e0d531ca494a8160466e2d00008a4c2e9746d58d3af949df4124676e35b5a",
  "board_core/workflow_closure.py":
    "e7b6e7556102d8e0fb137cbb3a3a1551178f4eb9e65699224ea283a3b20a1b4f"
}
const template = {
  kind: "custom",
  label: "自选项目步骤",
  description: "选择原生节点并补齐依赖，保留原检查和人工审批。",
  requiredNodes: ["dev.code", "ops.archive"]
}

/** Validate duplicate keys and locate the original template object's closing brace. */
function templateBoundary(text: string): number {
  JSON.parse(text)
  const tokens = [...text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]:,]|[^\s{}[\]:,]+/g)]
  let index = 0
  let boundary = -1
  const visit = (path: string[]) => {
    const token = tokens[index++]?.[0]
    if (token === "{") {
      const keys = new Set<string>()
      while (tokens[index]?.[0] !== "}") {
        const key = JSON.parse(tokens[index++][0]) as string
        if (keys.has(key)) throw Error("配置含重复字段，不能安全追加模板")
        keys.add(key)
        index++ // colon; JSON.parse has already validated grammar
        visit([...path, key])
        if (tokens[index]?.[0] === ",") index++
      }
      if (path.join("/") === "workflow/templates") boundary = tokens[index].index!
      index++
    } else if (token === "[") {
      while (tokens[index]?.[0] !== "]") {
        visit([...path, "[]"])
        if (tokens[index]?.[0] === ",") index++
      }
      index++
    }
  }
  visit([])
  if (boundary < 0) throw Error("插件没有原生模板配置")
  return boundary
}

/** Host-only deterministic exception. No caller supplies a path, template, or patch. */
export function prepareNodeCompositionFiles(snapshot: DerivationSnapshot) {
  for (const [path, digest] of Object.entries(protocol)) {
    const source = snapshot.files.find((file) => file.path === path)
    if (
      !source ||
      createHash("sha256")
        .update(source.bytes.toString("utf8").replace(/\r\n/g, "\n"))
        .digest("hex") !== digest
    )
      throw Error("这个插件版本尚不支持启用节点组合，请使用原项目入口")
  }
  const source = snapshot.files.find((file) => file.path === COMPOSITION_CONFIG)
  if (!source || source.bytes.length > 1024 * 1024) throw Error("原生模板配置缺失或过大")
  const before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes)
  return appendNodeCompositionConfig(before)
}

export function appendNodeCompositionConfig(before: string) {
  const boundary = templateBoundary(before)
  const original = JSON.parse(before)
  const registry = original.workflow?.templates
  if (!registry || Array.isArray(registry) || typeof registry !== "object")
    throw Error("原生模板配置无效")
  if (Object.hasOwn(registry, COMPOSITION_TEMPLATE))
    throw Error(
      isDeepStrictEqual(registry[COMPOSITION_TEMPLATE], template)
        ? "节点组合已启用，无需重复修改"
        : "节点组合模板名称已被占用，不能覆盖"
    )
  const nodes = original.workflow?.nodes
  if (
    !Array.isArray(nodes) ||
    !template.requiredNodes.every((id) => nodes.some((node) => node?.id === id))
  )
    throw Error("原插件缺少必须保留的编码或归档节点")
  const addition = `${Object.keys(registry).length ? "," : ""}\n${JSON.stringify(COMPOSITION_TEMPLATE)}: ${JSON.stringify(template, null, 2)}\n`
  // Insert only: every original byte and number spelling stays intact.
  const after = before.slice(0, boundary) + addition + before.slice(boundary)
  const restored = JSON.parse(after)
  delete restored.workflow.templates[COMPOSITION_TEMPLATE]
  if (!isDeepStrictEqual(restored, original)) throw Error("原模板配置不可改变")
  return {
    summary:
      "新增 devclaw-composed 自选项目步骤入口，必须保留编码与归档节点；原模板、依赖检查、Hooks 和人工审批保持不变。",
    files: [{ path: COMPOSITION_CONFIG, before, after }]
  }
}
