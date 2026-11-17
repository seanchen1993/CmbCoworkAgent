import { join } from "node:path"
import { getMarketContentStoredLimit } from "../services/market-content"
import { parseHarnessJsonBytesBounded, readHarnessJsonFileBounded } from "./async-json-store"
import { readRuntimeScopedFileAsync } from "./project-runtime/safe-files-async"

const KNOWLEDGE_MANIFEST = "agents.manifest.json"
const KNOWLEDGE_MANIFEST_MAX_BYTES = 1024 * 1024
const KNOWLEDGE_MANIFEST_LABEL = "系统约束清单"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function readScopedManifest(root: string): Promise<unknown | null> {
  // Inspect the canonical read checkout for protection without following an unverified leaf.
  const limit = getMarketContentStoredLimit(root, KNOWLEDGE_MANIFEST_MAX_BYTES)
  const { bytes } = await readRuntimeScopedFileAsync(root, KNOWLEDGE_MANIFEST, limit)
  return bytes ? parseHarnessJsonBytesBounded(bytes, KNOWLEDGE_MANIFEST_MAX_BYTES,
    KNOWLEDGE_MANIFEST_LABEL) : null
}

export async function readProjectKnowledgeDeployUnits(
  roots: readonly string[],
  mode: "uat" | "host" = "uat"
): Promise<string[]> {
  const deployUnitIds = new Set<string>()
  for (const root of roots) {
    const manifestPath = join(root, KNOWLEDGE_MANIFEST)
    try {
      const manifest = mode === "host"
        ? await readScopedManifest(root)
        : await readHarnessJsonFileBounded(
          manifestPath, KNOWLEDGE_MANIFEST_MAX_BYTES, KNOWLEDGE_MANIFEST_LABEL
        )
      if (!isRecord(manifest) || !Array.isArray(manifest.systems))
        throw new Error("系统约束清单缺少 systems 数组")

      const ids: string[] = []
      for (const system of manifest.systems) {
        if (!isRecord(system) || !Array.isArray(system.deployUnits))
          throw new Error("系统约束清单缺少 deployUnits 数组")
        for (const unit of system.deployUnits) {
          if (!isRecord(unit) || typeof unit.deployUnitId !== "string")
            throw new Error("系统约束清单的 deployUnitId 必须是字符串")
          const id = unit.deployUnitId.trim()
          if (id) ids.push(id)
        }
      }
      for (const id of ids) deployUnitIds.add(id)
    } catch (error) {
      console.warn("[HarnessBoard] 读取公共系统约束清单失败：", { manifestPath, error })
    }
  }
  return [...deployUnitIds]
}
