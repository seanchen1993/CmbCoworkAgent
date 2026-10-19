import { BUSINESS_MOD_MANIFEST } from "../../../shared/business-mods"
import type { BusinessModCatalog } from "../../../shared/business-mods"
import { isReviewedAutobizBusinessAssembly } from "../autobiz-business-assembly-protocol"
import { businessModObject, parseBusinessModCatalog } from "../business-mod-manifest"

/** Original dynamic board subsets are admitted against the exact reviewed legacy inventory. */
export function readAutobizSelectableCatalog(snapshot: {
  files: readonly { path: string; bytes: Buffer }[]
}): BusinessModCatalog | undefined {
  if (!isReviewedAutobizBusinessAssembly(snapshot))
    throw Error("业务组装插件校验未通过，请重新检查来源。")
  const board = snapshot.files.find((file) => file.path === "board_core/board_config.json")!
  const workflow = businessModObject(
    businessModObject(JSON.parse(board.bytes.toString("utf8"))).workflow
  )
  if (!businessModObject(workflow.templates).custom) return undefined
  const manifest = snapshot.files.find((file) => file.path === BUSINESS_MOD_MANIFEST)!
  const catalog = parseBusinessModCatalog(JSON.parse(manifest.bytes.toString("utf8")))
  const baseIds = new Set(
    (Array.isArray(workflow.nodes) ? workflow.nodes : []).map((node) =>
      String(businessModObject(node).id)
    )
  )
  // Optional dynamic stages are absent from the original compiler's custom template.
  return {
    ...catalog,
    modules: catalog.modules.filter((mod) => baseIds.has(String(mod.node.id)))
  }
}
