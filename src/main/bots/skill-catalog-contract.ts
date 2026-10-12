import { skillDependencyDeclaration } from "../../shared/skill-dependencies"
import { z } from "zod"
import { isAbsolute } from "node:path"

const path = z.string().min(1).max(8192).refine(isAbsolute, "技能来源必须是绝对路径")
export const BOT_SKILL_RESOURCE_ENTRIES = 512
export const botSkillResource = z
  .object({
    path: z.string().min(1).max(4096),
    kind: z.enum(["file", "directory"]),
    size: z.number().int().nonnegative(),
    stamp: z.string().min(1).max(300)
  })
  .strict()
export type BotSkillResource = z.infer<typeof botSkillResource>
export const botSkillCatalogSources = z
  .object({
    builtinSkillsDir: path,
    customSkillsDir: path,
    pluginsStorePath: path,
    disabledSkillsPath: path,
    disabledSkillsRevision: z.number().int().nonnegative(),
    globalRevision: z.number().int().nonnegative()
  })
  .strict()
export type BotSkillCatalogSources = z.infer<typeof botSkillCatalogSources>
export const BOT_EXTERNAL_SKILLS_LIMIT = 512
export const BOT_EXTERNAL_SKILL_BYTES = 256 * 1024
export const BOT_EXTERNAL_SKILLS_BYTES = 16 * 1024 * 1024
export const botExternalSkill = z
  .object({
    id: z.string().regex(/^desktop:[a-f0-9]{64}$/),
    catalogId: z.string().min(1).max(4096),
    name: z.string().min(1).max(100),
    description: z.string().max(4000),
    instructions: z.string().min(1).max(64000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    fileStamp: z.string().min(1).max(300),
    filePath: path,
    catalogPath: path,
    rootPath: path,
    resources: z.array(botSkillResource).max(BOT_SKILL_RESOURCE_ENTRIES),
    dependencies: skillDependencyDeclaration.optional(),
    compatibility: z.string().max(4000),
    pluginId: z.string().max(512).nullable(),
    pluginName: z.string().max(512).nullable(),
    isProjectModePlugin: z.boolean().optional(),
    source: z.enum(["user", "project"])
  })
  .strict()
export type BotExternalSkill = z.infer<typeof botExternalSkill>
export const botSkillCatalogSnapshot = z
  .object({
    skills: z.array(botExternalSkill).max(BOT_EXTERNAL_SKILLS_LIMIT),
    warnings: z.array(z.string().max(500)).max(50),
    truncated: z.boolean()
  })
  .strict()
export type BotSkillCatalogSnapshot = z.infer<typeof botSkillCatalogSnapshot>
