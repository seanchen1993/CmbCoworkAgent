import { parseSkillDependencies } from "../skills/dependencies"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { realpath } from "node:fs/promises"
import {
  readSkillPluginCatalogPage,
  resolveSkillPreview,
  isSkillMetadataDisabled
} from "../skill-plugin-catalog/reader"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { parseSkillFrontmatter, getFrontmatterString } from "../skills/frontmatter"
import { normalizeSkillId } from "../skills/ids"
import { scanSkillResources, assertSkillResources } from "./skill-resource-files"
import {
  BOT_EXTERNAL_SKILLS_LIMIT,
  BOT_EXTERNAL_SKILL_BYTES,
  BOT_EXTERNAL_SKILLS_BYTES,
  botSkillCatalogSources,
  botExternalSkill,
  botSkillCatalogSnapshot,
  type BotExternalSkill,
  type BotSkillCatalogSnapshot
} from "./skill-catalog-contract"

/** Runs in a disposable process. Reuses Cmb's enabled-plugin/shadowing/disabled-id
 * rules and exact preview resolver; arbitrary caller paths never become skill grants.
 */
export async function readBotSkillCatalog(raw: unknown): Promise<BotSkillCatalogSnapshot> {
  const source = botSkillCatalogSources.parse(raw)
  const skills: BotExternalSkill[] = [],
    warnings: string[] = []
  let cursor: string | null = null,
    bytes = 0,
    truncated = false
  const warn = (message: string) => {
    if (warnings.length < 50) warnings.push(message.slice(0, 500))
  }
  const seen = new Set<string>()
  const disabled = new Set<string>()
  let disabledCursor: string | null = null
  do {
    const page = readSkillPluginCatalogPage(source, {
      kind: "disabled",
      limit: 128,
      cursor: disabledCursor
    })
    if (page.truncated) throw new Error("技能停用目录不完整")
    for (const id of page.disabledSkillIds) disabled.add(normalizeSkillId(id))
    disabledCursor = page.cursor
  } while (disabledCursor)
  do {
    const page = readSkillPluginCatalogPage(source, {
      kind: "skills",
      limit: 128,
      cursor
    })
    if (page.truncated) {
      truncated = true
      warn("部分技能超出 Cmb 目录读取范围，请检查技能设置。")
    }
    for (const metadata of page.skills) {
      if (isSkillMetadataDisabled(metadata, disabled)) continue
      if (skills.length >= BOT_EXTERNAL_SKILLS_LIMIT) {
        truncated = true
        warn("可同步技能已达到 512 项上限。")
        break
      }
      const catalogId = metadata.id || metadata.relativePath || metadata.name
      const id = `desktop:${createHash("sha256")
        .update(JSON.stringify([metadata.source, metadata.pluginId ?? null, catalogId]))
        .digest("hex")}`
      if (seen.has(id)) continue
      seen.add(id)
      try {
        const resolution = resolveSkillPreview(source, {
          id: catalogId,
          name: metadata.name,
          source: metadata.source,
          ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {})
        })
        if (!resolution) throw new Error("技能身份已变化")
        const file = await openStableFileHandle(dirname(resolution.filePath), resolution.filePath)
        try {
          const content = await readStableFileHandleBounded(file, BOT_EXTERNAL_SKILL_BYTES)
          const text = new TextDecoder("utf-8", { fatal: true }).decode(content)
          if (text.includes("\0")) throw new Error("技能不是有效文本")
          const parsed = parseSkillFrontmatter(text)
          const dependencies = parseSkillDependencies(text)
          const name = (getFrontmatterString(parsed.frontmatter, "name") || metadata.name).trim()
          if (name !== metadata.name.trim()) throw new Error("技能名称已变化")
          const candidate = botExternalSkill.parse({
            id,
            catalogId,
            name: name.slice(0, 100),
            description: metadata.description.slice(0, 4000),
            instructions: parsed.body.trim(),
            sha256: createHash("sha256").update(content).digest("hex"),
            fileStamp: [
              file.identity.device,
              file.identity.inode,
              file.identity.size,
              file.identity.modifiedNs,
              file.identity.changedNs
            ].join(":"),
            filePath: file.filePath,
            catalogPath: resolution.filePath,
            rootPath: file.rootPath,
            resources: await scanSkillResources(file.rootPath),
            ...(dependencies.source !== "none" || dependencies.state === "invalid"
              ? { dependencies }
              : {}),
            compatibility: (getFrontmatterString(parsed.frontmatter, "compatibility") || "").slice(
              0,
              4000
            ),
            pluginId: metadata.pluginId ?? null,
            pluginName: metadata.pluginName ?? null,
            isProjectModePlugin: metadata.isProjectModePlugin ?? false,
            source: metadata.source
          })
          // Re-resolve after asynchronous reads, including plugin disable/uninstall changes.
          const latest = resolveSkillPreview(source, {
            id: catalogId,
            name: metadata.name,
            source: metadata.source,
            ...(metadata.pluginId ? { pluginId: metadata.pluginId } : {})
          })
          if (!latest || (await realpath(latest.filePath)) !== file.filePath)
            throw new Error("技能来源已变化")
          await file.assertPathIdentity()
          assertSkillResources(candidate)
          const size = Buffer.byteLength(JSON.stringify(candidate), "utf8")
          if (bytes + size > BOT_EXTERNAL_SKILLS_BYTES) {
            truncated = true
            warn("可同步技能内容已达到 16 MiB 上限。")
            continue
          }
          bytes += size
          skills.push(candidate)
        } finally {
          await file.handle.close()
        }
      } catch {
        warn(`未同步「${metadata.name.slice(0, 150)}」：文件不可用、已变化或超出内容限制。`)
      }
    }
    cursor = page.cursor
  } while (cursor && skills.length < BOT_EXTERNAL_SKILLS_LIMIT)
  return botSkillCatalogSnapshot.parse({ skills, warnings, truncated })
}
