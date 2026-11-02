import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  DESIGN_SYSTEM_MAX_BYTES,
  type DesignSystemDraft,
  type DesignSystemInfo
} from "../../../shared/design-system"

const REFERENCE = /^(user-[a-f0-9-]{36})-v([1-9]\d*)$/

export function validateDesignSystemContent(content: unknown): string {
  if (typeof content !== "string" || !content.trim()) throw new Error("设计规范内容不能为空")
  if (Buffer.byteLength(content, "utf8") > DESIGN_SYSTEM_MAX_BYTES)
    throw new Error("设计规范文件不能超过 1 MB")
  if (content.includes("\0") || content.includes("\ufffd"))
    throw new Error("请选择 UTF-8 编码的 Markdown 文本文件")
  return content.replace(/^\uFEFF/, "")
}

export function designSystemFileDraft(filename: string, content: string): DesignSystemDraft {
  if (!/\.md$/i.test(filename)) throw new Error("请选择 .md 格式的设计规范文件")
  const markdown = validateDesignSystemContent(content)
  return {
    name:
      markdown
        .match(/^#\s+(.+)$/m)?.[1]
        ?.trim()
        .slice(0, 80) || path.basename(filename, path.extname(filename)).slice(0, 80),
    content: markdown,
    source: "file"
  }
}

/** Each committed directory is an immutable revision; no mutable index can corrupt history. */
export class DesignSystemLibrary {
  constructor(readonly storageDir: string) {}

  private reference(id: string): { libraryId: string; version: number } {
    const match = typeof id === "string" ? id.match(REFERENCE) : null
    if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error("设计系统版本无效")
    return { libraryId: match[1], version: Number(match[2]) }
  }

  read(id: string): { info: DesignSystemInfo; content: string } {
    const { libraryId, version } = this.reference(id)
    const dir = path.join(this.storageDir, id)
    const markdownPath = path.join(dir, "DESIGN.md")
    const metadataPath = path.join(dir, "meta.json")
    for (const file of [dir, markdownPath, metadataPath]) {
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error("设计系统文件不能是符号链接")
    }
    const meta = JSON.parse(fs.readFileSync(metadataPath, "utf8")) as DesignSystemInfo
    const content = validateDesignSystemContent(fs.readFileSync(markdownPath, "utf8"))
    return {
      info: { ...meta, id, libraryId, version, ownership: "user", path: markdownPath },
      content
    }
  }

  /** Includes older revisions for existing sessions; pickers hide isLatest=false entries. */
  list(): DesignSystemInfo[] {
    if (!fs.existsSync(this.storageDir)) return []
    const systems: DesignSystemInfo[] = []
    for (const entry of fs.readdirSync(this.storageDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !REFERENCE.test(entry.name)) continue
      try {
        systems.push(this.read(entry.name).info)
      } catch {
        /* Ignore incomplete/corrupt entries. */
      }
    }
    const latest = new Map<string, number>()
    for (const item of systems)
      latest.set(item.libraryId!, Math.max(latest.get(item.libraryId!) || 0, item.version!))
    return systems
      .map((item) => ({ ...item, isLatest: item.version === latest.get(item.libraryId!) }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || b.version! - a.version!)
  }

  save(input: DesignSystemDraft): DesignSystemInfo {
    const content = validateDesignSystemContent(input?.content)
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 80)
      throw new Error("名称不能为空，且不能超过 80 个字符")
    let libraryId = `user-${randomUUID()}`
    let version = 1
    let previous: DesignSystemInfo | undefined
    if (input.baseId !== undefined) {
      previous = this.read(input.baseId).info
      const latest = this.list().find(
        (item) => item.libraryId === previous!.libraryId && item.isLatest
      )
      if (latest?.id !== input.baseId)
        throw new Error("此规范已有新版本，请返回库中打开最新版本后再修改")
      libraryId = previous.libraryId!
      version = previous.version! + 1
    }
    let sourceUrl = input.sourceUrl ?? previous?.sourceUrl
    if (sourceUrl) {
      const url = new URL(sourceUrl)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
        throw new Error("规范来源必须是有效的 HTTP 或 HTTPS 链接")
      url.search = ""
      url.hash = ""
      sourceUrl = url.href
    }
    const id = `${libraryId}-v${version}`
    const info: DesignSystemInfo = {
      id,
      libraryId,
      version,
      ownership: "user",
      isLatest: true,
      name: input.name.trim(),
      description:
        content
          .split(/\r?\n/)
          .find((line) => line.trim() && !line.startsWith("#"))
          ?.trim()
          .slice(0, 160) || "我的设计规范",
      source: ["file", "web", "builtin-copy", "manual"].includes(input.source || "")
        ? input.source
        : previous?.source || "manual",
      sourceUrl,
      updatedAt: Date.now(),
      path: path.join(this.storageDir, id, "DESIGN.md")
    }
    fs.mkdirSync(this.storageDir, { recursive: true })
    const staging = fs.mkdtempSync(path.join(this.storageDir, ".saving-"))
    try {
      fs.writeFileSync(path.join(staging, "DESIGN.md"), content, "utf8")
      fs.writeFileSync(path.join(staging, "meta.json"), JSON.stringify(info, null, 2), "utf8")
      fs.renameSync(staging, path.join(this.storageDir, id))
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
    return info
  }
}
