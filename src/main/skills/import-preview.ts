import AdmZip from "adm-zip"
import { parseSkillDependencies } from "./dependencies"
import { createHash } from "node:crypto"
import { inflateRawSync } from "node:zlib"
import {
  SKILL_IMPORT_MARKDOWN_BYTES,
  SKILL_IMPORT_MAX_BYTES,
  type SkillImportPreview
} from "../../shared/skill-import"
import { decodeArchiveEntryName, selectRootSkillMarkdownEntry } from "./archive"
import { decodeSkillTextFile } from "./text-decoding"
import { parseSkillFrontmatter, getFrontmatterString } from "./frontmatter"
import { parseYamlFrontmatter } from "../utils/skill-identifiers"
import { parseSkillHookDocument } from "./hook-document"
import { BOT_SUPPORTED_SKILL_HOOK_EVENTS } from "../../shared/bot-skill-hooks"

const MAX_ENTRIES = 512
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024
const MAX_ENTRY_BYTES = 4 * 1024 * 1024

/** The original installer and import preview share this preflight. AdmZip's
 * positive declared size bounds its inflater; explicitly check the zero-size
 * case, where upstream omits maxOutputLength. Never execute imported content. */
export function inspectSkillImport(buffer: Buffer, fileName: string): SkillImportPreview {
  if (!buffer.length || buffer.length > SKILL_IMPORT_MAX_BYTES)
    throw new Error("技能文件为空或超过 5 MiB")
  let markdown: string
  let resourceCount = 0
  const hookFiles: { path: string; text: string }[] = []
  if (/\.md$/i.test(fileName)) {
    if (buffer.length > SKILL_IMPORT_MARKDOWN_BYTES) throw new Error("技能正文超过 256 KiB")
    markdown = decodeSkillTextFile(buffer, fileName)
  } else if (/\.zip$/i.test(fileName)) {
    const entries = new AdmZip(buffer).getEntries()
    if (!entries.length || entries.length > MAX_ENTRIES)
      throw new Error("技能包为空或超过 512 个文件和目录")
    const paths = new Map<string, boolean>()
    let total = 0
    const decoded = entries.map((entry) => {
      const decodedName = decodeArchiveEntryName(entry)
      const segments = decodedName.replace(/\/$/, "").split("/")
      if (
        entry.entryName.includes("\0") ||
        segments.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            // eslint-disable-next-line no-control-regex
            /[<>:"|?*\x00-\x1f]/.test(part) ||
            /[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)
        )
      )
        throw new Error("技能包含不适用于 Windows 的路径")
      const key = segments.join("/").normalize("NFC").toLowerCase()
      if (paths.has(key)) throw new Error("技能包中存在重复或仅大小写不同的路径")
      paths.set(key, entry.isDirectory)
      // Refuse links/special files instead of silently installing their payload.
      const mode = (entry.attr >>> 16) & 0xf000
      if (mode && mode !== 0x8000 && mode !== 0x4000)
        throw new Error("技能包不能包含链接或特殊文件")
      const size = entry.header.size
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES)
        throw new Error("技能包单个文件超过 4 MiB")
      total += size
      if (total > MAX_EXPANDED_BYTES) throw new Error("技能包解压后超过 16 MiB")
      if (entry.header.encrypted) throw new Error("请先解密技能包再导入")
      if (!entry.isDirectory && ![0, 8].includes(entry.header.method))
        throw new Error("技能包使用了不支持的压缩格式")
      if (!entry.isDirectory && size === 0 && entry.header.method === 8) {
        const compressed = entry.getCompressedData()
        if (compressed.length && inflateRawSync(compressed, { maxOutputLength: 1 }).length)
          throw new Error("技能包文件长度不一致")
      }
      return { entry, decodedName }
    })
    for (const key of paths.keys()) {
      const segments = key.split("/")
      for (let end = 1; end < segments.length; ++end)
        if (paths.get(segments.slice(0, end).join("/")) === false)
          throw new Error("技能包文件与目录路径冲突")
    }
    const root = selectRootSkillMarkdownEntry<(typeof decoded)[number]>(
      decoded,
      (item) => item.entry.isDirectory
    )
    if (!root) throw new Error("ZIP 文件必须包含 SKILL.md")
    if (root.entry.header.size > SKILL_IMPORT_MARKDOWN_BYTES)
      throw new Error("技能正文超过 256 KiB")
    markdown = decodeSkillTextFile(root.entry.getData(), root.decodedName)
    const prefix = root.decodedName.replace(/SKILL\.md$/i, "")
    for (const relative of ["hooks.json", "hooks/hooks.json"]) {
      const file = decoded.find(
        (item) => !item.entry.isDirectory && item.decodedName === prefix + relative
      )
      if (!file) continue
      if (file.entry.header.size > SKILL_IMPORT_MARKDOWN_BYTES)
        throw new Error("技能 Hook 配置超过 256 KiB")
      hookFiles.push({
        path: relative,
        text: new TextDecoder("utf-8", { fatal: true }).decode(file.entry.getData())
      })
    }
    resourceCount = decoded.filter(
      (item) => !item.entry.isDirectory && item !== root && item.decodedName.startsWith(prefix)
    ).length
  } else throw new Error("仅支持 .md 或 .zip 文件")
  markdown = markdown.replace(/^\uFEFF/, "")
  if (markdown.includes("\0")) throw new Error("技能正文不是有效文本")
  // Match the existing installer's name semantics; the full YAML parser reads
  // display-only dependency/Hook declarations, without changing permissions.
  const name = parseYamlFrontmatter(markdown).name?.trim()
  if (!name || name.length > 100) throw new Error("SKILL.md 必须包含不超过 100 字的 name 字段")
  const { frontmatter, body } = parseSkillFrontmatter(markdown)
  if (!body.trim()) throw new Error("技能正文不能为空")
  const hooks = [{ path: "SKILL.md", text: markdown }, ...hookFiles].flatMap((file) =>
    parseSkillHookDocument(file.text, file.path, { name, rootPath: "." })
  )
  if (hooks.length > 128) throw new Error("单个技能的 Hook 超过 128 项")
  const supported = new Set<string>(BOT_SUPPORTED_SKILL_HOOK_EVENTS)
  return {
    name,
    description: (getFrontmatterString(frontmatter, "description") ?? "").slice(0, 4000),
    compatibility: (getFrontmatterString(frontmatter, "compatibility") ?? "").slice(0, 4000),
    markdown,
    dependencies: parseSkillDependencies(markdown),
    resourceCount,
    hasHooks: Boolean(frontmatter.hooks) || hooks.length > 0,
    unsupportedBotHooks: [
      ...new Set(
        hooks.filter((hook) => hook.enabled && !supported.has(hook.event)).map((hook) => hook.event)
      )
    ],
    sha256: createHash("sha256").update(buffer).digest("hex")
  }
}
