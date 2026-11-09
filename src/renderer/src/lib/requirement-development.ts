import type { Thread } from "@/types"
import type {
  RequirementPrdManifest,
  RequirementRecord
} from "@/components/requirement/requirement-data"
import { marketApi } from "@/api/market"

export const REQUIREMENT_DEVELOPMENT_PLUGIN = "AutobizDevOps_Plugin_Kanban_fullstack"
export const REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY = "requirement-development:onboarding"
export const REQUIREMENT_DEVELOPMENT_ONBOARDING_EVENT = "requirement-development:onboarding-change"

export type RequirementDevelopmentIntent = {
  action: "create-development"
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
  window.sessionStorage.setItem(REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY, JSON.stringify(intent))
}

export function clearRequirementDevelopmentIntent(): void {
  window.sessionStorage.removeItem(REQUIREMENT_DEVELOPMENT_ONBOARDING_KEY)
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

export function resolveRequirementDevelopmentFiles(
  requirement: RequirementRecord,
  manifest: RequirementPrdManifest | null,
  requirementWorkspacePath: string
): { requirementFilePath: string; prototypeFilePaths: string[] } {
  const current = manifest ?? requirement.prdManifest
  const requirementFilePath = absoluteRequirementFilePath(
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
  const prototypeLines = input.prototypeFilePaths.length
    ? input.prototypeFilePaths.map((path) => `  - ${path}`).join("\n")
    : "  - 未提供原型文件"
  return `${input.title}

请读取并理解本次需求的 PRD 与交互原型，并基于当前工作区完成对应功能的开发。

- 需求名称：${input.title}
- PRD 文件：${input.requirementFilePath}
- 原型文件：${prototypeLines}

开发目标：
1. 结合 PRD、原型和当前代码库，确认功能范围、页面交互及验收要求。
2. 在遵循现有项目结构、编码规范和组件体系的前提下完成实现。
3. 补充必要的测试或验证，并说明主要改动、验证结果及仍需确认的问题。
4. 不要修改与本需求无关的功能；遇到信息缺失或实现存在歧义时，请先向我确认。
`
}
