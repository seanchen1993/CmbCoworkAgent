import { parseProjectComposition } from "../../../shared/project-runtime/composition"
import type { CompositionCatalogSnapshot } from "../../plugins/project-composition-catalog"
import { compositionSourceKey } from "../../plugins/project-composition-catalog"
import { nativeClosureInvocation, nativeClosureSelectedNodes, validateNativeClosure, type NativeNodeContext } from "../node-composition"

/** Use the original adapter's dependency resolver before freezing the executable preview. */
export async function resolveCompositionWorkflows(
  value: unknown,
  snapshot: CompositionCatalogSnapshot,
  dependencies: {
    run(invocation: NativeNodeContext["invocation"]): Promise<unknown>
    verify(context: NativeNodeContext): Promise<void>
    assertCurrent(): void
    reviewed?(unitId: string, omissions: Array<{ nodeId: string; path: string }>,
      entryInputs: Array<{ nodeId: string; path: string; guidance: string }>): void
  }
) {
  const definition = parseProjectComposition(value)
  for (const unit of definition.units) {
    if (!unit.workflow) continue
    const source = snapshot.sources.find((item) =>
      compositionSourceKey(item.entry.source) === compositionSourceKey(unit.source))
    const context = source?.nodeContext
    if (!source?.entry.available || source.capability.kind !== "flow" ||
      source.capability.runtimeMode !== "legacy" || !context)
      throw Error("此流程尚未提供可验证的步骤选择，请重新读取项目能力。")
    const { templateId, nodeIds } = unit.workflow
    // Reject unknown IDs before invoking a plugin, then validate its complete closure response.
    const includeOptional = unit.workflow.includeOptionalDependencies ?? true
    const requiredSelection = nativeClosureSelectedNodes(context, templateId, nodeIds, includeOptional)
    dependencies.assertCurrent()
    await dependencies.verify(context)
    const response = await dependencies.run(nativeClosureInvocation(
      context, templateId, requiredSelection, includeOptional))
    const { ordered, optionalOmissions, entryInputFallbacks } = validateNativeClosure(context, templateId, nodeIds, response, includeOptional)
    if (entryInputFallbacks.length && !definition.goal?.trim())
      throw Error("自选流程需要明确本次任务目标，并按预览中的入口要求补充资料。")
    await dependencies.verify(context)
    dependencies.assertCurrent()
    unit.workflow = { ...unit.workflow, nodeIds: ordered }
    dependencies.reviewed?.(unit.id, optionalOmissions, entryInputFallbacks)
  }
  return definition
}
