import { join } from "node:path"
import type { FlowCatalog } from "../../../shared/mods/flows/types"
import {
  openStableFileHandle,
  readStableFileHandleBounded
} from "../../services/stable-file-handle"

/** Read-only compatibility discovery, never a stage execution or completion receipt. */
export async function readAutobizFlowFeatureCatalog(
  workspace: string
): Promise<FlowCatalog["features"]> {
  let handle: Awaited<ReturnType<typeof openStableFileHandle>>
  try {
    handle = await openStableFileHandle(workspace, join(workspace, ".autobizdevops/state.json"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  try {
    const state = JSON.parse(
      (await readStableFileHandleBounded(handle, 2 * 1024 * 1024)).toString("utf8")
    )
    if (!state?.features || typeof state.features !== "object" || Array.isArray(state.features))
      throw Error("AUTOBIZ_FEATURE_RECORD_INVALID")
    const entries = Object.entries(state.features)
    if (entries.length > 256) throw Error("AUTOBIZ_FEATURE_LIMIT")
    return entries.map(([id, item]) => {
      const checkpoint = (item as { checkpoint?: unknown })?.checkpoint
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id) ||
        typeof checkpoint !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(checkpoint)
      )
        throw Error("AUTOBIZ_FEATURE_RECORD_INVALID")
      return { id, checkpoint }
    })
  } finally {
    await handle.handle.close()
  }
}

/** A broken optional source must not disable unrelated DIY flow capabilities.
 * Native stage preparation, validators and commit authority remain separate and strict. */
export async function discoverAutobizFlowFeatures(
  workspace: string
): Promise<Pick<FlowCatalog, "features" | "diagnostics">> {
  try {
    return { features: await readAutobizFlowFeatureCatalog(workspace) }
  } catch {
    return {
      features: [],
      diagnostics: [
        {
          source: "autobiz-v1",
          code: "OPTIONAL_FLOW_CATALOG_UNAVAILABLE",
          message: "AutoBiz 阶段候选暂不可用，请检查项目状态；其他流程步骤仍可配置。"
        }
      ]
    }
  }
}
