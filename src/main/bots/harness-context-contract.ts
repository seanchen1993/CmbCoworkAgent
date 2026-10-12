import { z } from "zod"
import { isAbsolute } from "node:path"
import type { HarnessFeatureAgentContext } from "../harness-board/agent-context-core"
import { botHarnessBindingSchema } from "../../shared/bot-harness-context"
import type { BotHarnessBinding } from "../../shared/bot-harness-context"
const absolute = z.string().min(1).max(4096).refine(isAbsolute)
export const botHarnessSourcesSchema = z.object({ root: absolute }).strict()
export type BotHarnessSources = z.infer<typeof botHarnessSourcesSchema>
export interface BotHarnessSourceFence {
  path: string
  stamp: string | null
  sha256: string | null
}
export interface BotHarnessSourceRootIdentity {
  path: string
  declaredPath: string
  device: string
  inode: string
}
export interface BotHarnessRunContext {
  version: 1
  bindingDigest: string
  binding: BotHarnessBinding
  context: HarnessFeatureAgentContext
  instructionPrompt: string
  catalog: {
    sources: BotHarnessSources
    projectionDigest: string
    files: BotHarnessSourceFence[]
    rootIdentity?: BotHarnessSourceRootIdentity
  }
  fences: BotHarnessSourceFence[]
  rootIdentities: {
    path: string
    declaredPath: string
    device: string
    inode: string
    authorizedParentPath?: string
  }[]
  harnessNodeName?: string
  harnessNodeStatus?: string
}
export const botHarnessFencesSchema = z
  .array(
    z
      .object({
        path: absolute,
        stamp: z.string().max(512).nullable(),
        sha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable()
      })
      .strict()
  )
  .min(5)
  .max(24)
export const botHarnessRootsSchema = z
  .array(
    z
      .object({
        path: absolute,
        declaredPath: absolute,
        device: z.string().min(1).max(64),
        inode: z.string().min(1).max(64),
        authorizedParentPath: absolute.optional()
      })
      .strict()
  )
  .min(2)
  .max(34)
export const botHarnessCatalogFenceSchema = z
  .object({
    sources: botHarnessSourcesSchema,
    projectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(botHarnessFencesSchema.element).length(4),
    rootIdentity: z
      .object({
        path: absolute,
        declaredPath: absolute,
        device: z.string().min(1).max(64),
        inode: z.string().min(1).max(64)
      })
      .strict()
      .optional()
  })
  .strict()
export const botHarnessSkillScopeSchema = z
  .object({
    binding: botHarnessBindingSchema,
    workspacePath: absolute,
    sourceRoot: absolute,
    pluginId: z.string().min(1).max(512),
    pluginName: z.string().min(1).max(1024),
    fences: botHarnessFencesSchema,
    catalog: botHarnessCatalogFenceSchema,
    rootIdentities: botHarnessRootsSchema
  })
  .strict()
const optionalText = (max = 8192) => z.string().max(max).optional()
const contextSchema = z
  .object({
    systemPromptInject: optionalText(64_000),
    enableAgentsPrompt: z.boolean().optional(),
    harnessAgentsPrompt: optionalText(256_000),
    agentConfig: z
      .object({
        agentMode: z.enum(["solo", "multi", "agent_team", "workflow"]).optional(),
        subagentConfig: z
          .object({
            disabledBuiltinSubagents: z.array(z.string().max(512)).max(128),
            customSubagentFiles: z.array(z.string().max(4096)).max(128)
          })
          .strict()
          .optional(),
        toolConfig: z
          .object({ requestUserInput: botHarnessBindingSchema.shape.requestUserInputConfig })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    additionalAgentsWorkspacePaths: z.array(absolute).max(16).optional(),
    additionalAgentsWorkspaceMappings: z
      .array(
        z
          .object({
            deployUnitIdMapping: z.string().max(8192),
            deployUnitId: z.string().max(8192),
            localRepoPath: absolute,
            description: z.string().max(4096).optional()
          })
          .strict()
      )
      .max(16)
      .optional(),
    sessionContextInjectWarning: optionalText(1000),
    agentmdLoadStatus: z.array(z.record(z.string(), z.unknown())).max(128).optional(),
    pluginOutputDir: optionalText(4096),
    systemId: optionalText(512),
    pluginRoot: absolute.optional(),
    pluginId: optionalText(512),
    pluginName: optionalText(1024),
    pluginWorkspace: absolute.optional(),
    featureId: optionalText(512),
    harnessProjectId: optionalText(512),
    harnessAdapterName: optionalText(1024),
    harnessAdapterVersion: optionalText(512),
    projectCode: optionalText(2048),
    projectDir: optionalText(4096)
  })
  .strict()
export function parseBotHarnessRunContext(value: unknown): BotHarnessRunContext {
  const result = z
    .object({
      version: z.literal(1),
      bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
      binding: botHarnessBindingSchema,
      context: contextSchema,
      instructionPrompt: z.string().max(256_000),
      catalog: botHarnessCatalogFenceSchema,
      fences: botHarnessFencesSchema,
      rootIdentities: botHarnessRootsSchema,
      harnessNodeName: optionalText(2048),
      harnessNodeStatus: optionalText(512)
    })
    .strict()
    .parse(value)
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 384 * 1024)
    throw new Error("项目上下文超过保存限额")
  return result as BotHarnessRunContext
}
