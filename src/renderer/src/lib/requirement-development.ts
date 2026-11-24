import type { Thread } from "@/types"
import type {
  RequirementPrdManifest,
  RequirementRecord
} from "@/components/requirement/requirement-data"
import { marketApi } from "@/api/market"
import {
  commitRequirementRelations,
  getRequirementRelations,
  setRequirementNavigation,
  useRequirementProductStore
} from "@/lib/requirement-product-store"

export const REQUIREMENT_DEVELOPMENT_PLUGIN = "AutobizDevOps_Plugin_Kanban_fullstack"
export type RequirementDevelopmentIntent = {
  action: "create-development"
  /** False when quick start only supplies development context and has no requirement conversation. */
  linkedToRequirement?: boolean
  requirementId: string
  requirementTitle: string
  prompt: string
  requirementFilePath: string
  prototypeFilePaths: string[]
  functionCount: number
  hasPrototype: boolean
}

export type RequirementDevelopmentOpenSessionIntent = {
  action: "open-session"
  threadId: string
  requirementTitle?: string
}

export type RequirementDevelopmentOnboardingIntent =
  | RequirementDevelopmentIntent
  | RequirementDevelopmentOpenSessionIntent

export type RequirementDevelopmentMetadata = {
  requirementId: string
  requirementTitle: string
  requirementFilePath: string
  prototypeFilePaths: string[]
  functionCount: number
  hasPrototype: boolean
}

export async function ensureRequirementDevelopmentPlugin(): Promise<void> {
  const installed = (await window.api.plugins.list()).some(
    (plugin) =>
      plugin.id === REQUIREMENT_DEVELOPMENT_PLUGIN || plugin.name === REQUIREMENT_DEVELOPMENT_PLUGIN
  )
  if (installed) return

  const response = await marketApi.getPlugins({ allowMockOnError: false, silent: true })
  const marketPlugin = response.data?.find(
    (item) =>
      item.name === REQUIREMENT_DEVELOPMENT_PLUGIN || item.id === REQUIREMENT_DEVELOPMENT_PLUGIN
  )
  if (!marketPlugin) throw new Error("应用市场中未找到需求开发插件")
  const result = await marketApi.downloadItem(
    marketPlugin.name,
    "plugin",
    false,
    false,
    marketPlugin
  )
  if (!result.success) throw new Error(result.error || "需求开发插件安装失败")
}

export function writeRequirementDevelopmentIntent(
  intent: RequirementDevelopmentOnboardingIntent
): void {
  setRequirementNavigation({ target: "development", intent })
}

export function clearRequirementDevelopmentIntent(): void {
  if (useRequirementProductStore.getState().navigation?.target === "development") {
    setRequirementNavigation(null)
  }
}

type RequirementDevelopmentThreadStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export function requirementDevelopmentFolderFromFilePath(filePath: string): string {
  const normalized = filePath.trim()
  return normalized ? normalized.replace(/[\\/][^\\/]+$/, "") : ""
}

export type RequirementDevelopmentAssociation = RequirementDevelopmentMetadata & {
  threadId: string
}

function readRequirementDevelopmentAssociations(
  storage: RequirementDevelopmentThreadStorage = localStorage
): Record<string, RequirementDevelopmentAssociation> {
  const associations: Record<string, RequirementDevelopmentAssociation> = {}
  for (const relations of Object.values(getRequirementRelations(storage).requirements)) {
    Object.assign(associations, relations.developmentThreads)
  }
  return associations
}

export function storeRequirementDevelopmentAssociation(
  threadId: string,
  metadata: RequirementDevelopmentMetadata,
  storage: RequirementDevelopmentThreadStorage = localStorage
): void {
  commitRequirementRelations((current) => {
    const existing = current.requirements[metadata.requirementId] ?? {
      designSessions: {},
      developmentThreads: {}
    }
    return {
      ...current,
      requirements: {
        ...current.requirements,
        [metadata.requirementId]: {
          ...existing,
          developmentThreads: {
            ...existing.developmentThreads,
            [threadId]: { ...metadata, threadId }
          }
        }
      }
    }
  }, storage)
}

export function removeRequirementDevelopmentAssociation(
  requirementId: string,
  storage: RequirementDevelopmentThreadStorage = localStorage
): void {
  commitRequirementRelations((current) => {
    const existing = current.requirements[requirementId]
    if (!existing || Object.keys(existing.developmentThreads).length === 0) return current
    const requirements = { ...current.requirements }
    if (Object.keys(existing.designSessions).length) {
      requirements[requirementId] = { ...existing, developmentThreads: {} }
    } else delete requirements[requirementId]
    return { ...current, requirements }
  }, storage)
}

export function findRequirementDevelopmentAssociation(
  requirementId: string,
  storage: RequirementDevelopmentThreadStorage = localStorage
): RequirementDevelopmentAssociation | null {
  return Object.values(
    getRequirementRelations(storage).requirements[requirementId]?.developmentThreads ?? {}
  )[0] ?? null
}

export function getStoredRequirementDevelopmentMetadata(
  threadId: string,
  storage: RequirementDevelopmentThreadStorage = localStorage
): RequirementDevelopmentMetadata | null {
  const association = readRequirementDevelopmentAssociations(storage)[threadId]
  return association ?? null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

export function getRequirementDevelopmentMetadata(
  thread: Thread | null | undefined
): RequirementDevelopmentMetadata | null {
  const value = asRecord(thread?.metadata?.requirementDevelopment)
  if (!value || typeof value.requirementId !== "string") return null
  return {
    requirementId: value.requirementId,
    requirementTitle: typeof value.requirementTitle === "string" ? value.requirementTitle : "",
    requirementFilePath:
      typeof value.requirementFilePath === "string" ? value.requirementFilePath : "",
    prototypeFilePaths: Array.isArray(value.prototypeFilePaths)
      ? value.prototypeFilePaths.filter((item): item is string => typeof item === "string")
      : [],
    functionCount:
      typeof value.functionCount === "number" && Number.isFinite(value.functionCount)
        ? Math.max(0, Math.floor(value.functionCount))
        : 0,
    hasPrototype:
      typeof value.hasPrototype === "boolean"
        ? value.hasPrototype
        : Array.isArray(value.prototypeFilePaths) && value.prototypeFilePaths.length > 0
  }
}

export function findRequirementDevelopmentThreads(
  requirementId: string,
  threads: Thread[]
): Thread[] {
  return threads
    .filter((thread) => getRequirementDevelopmentMetadata(thread)?.requirementId === requirementId)
    .sort((left, right) => right.updated_at.getTime() - left.updated_at.getTime())
}

function absoluteRequirementFilePath(workspacePath: string, filePath: string): string {
  if (/^(?:[a-zA-Z]:[\\/]|[/\\]{2}|\/)/.test(filePath)) return filePath
  const base = workspacePath.replace(/[\\/]+$/, "")
  const relative = filePath.replace(/^[\\/]+/, "")
  return `${base}/${relative}`
}

export function normalizeRequirementPrdFilePath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/").replace(/^\/+/, "")
  const prdMarker = normalized.toLowerCase().lastIndexOf("/prd/")
  if (prdMarker >= 0) return `/${normalized.slice(prdMarker + 1)}`
  return normalized.toLowerCase() === "prd" || normalized.toLowerCase().startsWith("prd/")
    ? `/${normalized}`
    : `/prd/${normalized}`
}

export function resolveRequirementPrdFilePath(
  requirementWorkspacePath: string,
  filePath: string
): string {
  if (/^(?:[a-zA-Z]:[\\/]|[/\\]{2}|\/)/.test(filePath)) return filePath
  const prdRelativePath = normalizeRequirementPrdFilePath(filePath).replace(/^\/+/, "")
  return absoluteRequirementFilePath(requirementWorkspacePath, prdRelativePath)
}

export function resolveRequirementDevelopmentFiles(
  requirement: RequirementRecord,
  manifest: RequirementPrdManifest | null,
  requirementWorkspacePath: string
): { requirementFilePath: string; prototypeFilePaths: string[] } {
  const current = manifest ?? requirement.prdManifest
  const requirementFilePath = resolveRequirementPrdFilePath(
    requirementWorkspacePath,
    current.prd.file
  )
  const prototypeFilePaths = [
    current.prd.htmlFile,
    ...current.functions.map((item) => item.htmlFile)
  ]
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => absoluteRequirementFilePath(requirementWorkspacePath, path))

  return { requirementFilePath, prototypeFilePaths: [...new Set(prototypeFilePaths)] }
}

export function buildRequirementDevelopmentPrompt(input: {
  title: string
  requirementFilePath: string
  prototypeFilePaths: string[]
}): string {
  const formatPath = (path: string): string => `\`${path.replace(/\\/g, "/")}\``
  const prototypeLines = input.prototypeFilePaths.length
    ? input.prototypeFilePaths.map((path) => `  - ${formatPath(path)}`).join("\n")
    : "  无"
  return `
需求名称：${input.title}
需求文件：${formatPath(input.requirementFilePath)}
原型设计文件：${prototypeLines}

`
}

export function isMissingRequirementThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /(?:^|:\s*)Thread not found(?:$|\s|:)/i.test(message)
}
