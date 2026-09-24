import type { ModJson, ModObject } from "../types"
import { isModObject, ModFunctionError } from "./contracts"

export interface FunctionAgentInfo {
  id: string
  description: string
  type: string
  status: string
  parentId?: string
  spawnedBy?: string
  name?: string
}
export function validateFunctionAgentListInput(value: ModObject): void {
  if (Object.keys(value).length) throw new ModFunctionError("MODS_AGENT_LIST_ARGUMENTS")
}
export function validateFunctionAgentList(value: ModJson): asserts value is ModObject[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new ModFunctionError("MODS_AGENT_LIST_RESULT")
  const ids = new Set<string>()
  for (const row of value) {
    if (
      !isModObject(row) ||
      typeof row.id !== "string" ||
      !row.id ||
      row.id.length > 512 ||
      ids.has(row.id) ||
      typeof row.description !== "string" ||
      row.description.length > 4000 ||
      typeof row.type !== "string" ||
      !row.type ||
      row.type.length > 256 ||
      typeof row.status !== "string" ||
      !row.status ||
      row.status.length > 64 ||
      ["parentId", "spawnedBy", "name"].some(
        (key) =>
          row[key] !== undefined &&
          (typeof row[key] !== "string" || !row[key] || row[key].length > 512)
      )
    )
      throw new ModFunctionError("MODS_AGENT_LIST_RESULT")
    ids.add(row.id)
  }
}
