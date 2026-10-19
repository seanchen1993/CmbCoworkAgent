import { createHash } from "node:crypto"
import type { BusinessModCatalog } from "../../../shared/business-mods"
import type { DevelopmentScope } from "../v2/development-session"
import { businessModPath, parseBusinessModCatalog } from "../../plugins/business-mod-manifest"

export interface BusinessDraftSettings {
  getSetting(key: string, fallback?: string): string
  compareAndSetSetting(key: string, before: string | undefined, value: string): boolean
}
export interface CreatorBusinessDraft {
  id: string
  name: string
  revision: number
  digest: string
  baseSource: { pluginId: string; digest: string }
  catalog: BusinessModCatalog
  files: Array<{ path: string; text: string }>
}
interface State {
  version: 1
  drafts: Array<{ id: string; versions: CreatorBusinessDraft[] }>
}
export class BusinessDraftLimitError extends Error {
  constructor(readonly reason: "drafts" | "versions") {
    super("BUSINESS_DRAFT_LIMIT")
  }
}
export function businessDraftLimitHint(reason: BusinessDraftLimitError["reason"]) {
  return reason === "versions"
    ? "此业务草稿已保留 8 个版本。先 read 取完整 files 和 catalog，再 inspect 原共享内核取得最新 inspectionId；用未占用的新草稿 id、revision:0、原 name、catalog.modules/extensions 和完整 files 保存。只换草稿 id，保留 Mod ID、技能名和资源路径；preview 使用新草稿返回的版本。原稿、已检查候选和已安装插件均保留。每个聊天最多 4 份业务草稿。"
    : "本聊天的 4 份业务草稿槽位已满，原稿和候选保留。仍可 read 完整源码；已有可组装版本可 preview/request_review，经原生确认导出含源码的插件 ZIP。需要继续编辑时，先保留完整 files/catalog 和未提交修改，在用户指定的新创造者聊天重新选择原共享内核并导入源码，或在个人源码副本中编辑后走原来源检查。不要自动删除旧稿、换聊天规避本次预算，也不要将未保存修改称为已保存。"
}
export const businessCreatorScopeKey = (scope: DevelopmentScope) =>
  createHash("sha256").update(JSON.stringify(scope)).digest("hex")
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Independent business source documents, including Python. Never enters the pure-function compiler. */
export class CreatorBusinessDrafts {
  constructor(private readonly settings: BusinessDraftSettings) {}
  private key(scope: DevelopmentScope) {
    return `mods-business-drafts-v1:${businessCreatorScopeKey(scope)}`
  }
  private readState(scope: DevelopmentScope) {
    const key = this.key(scope),
      raw = this.settings.getSetting(key, "")
    if (!raw) return { key, raw: undefined, state: { version: 1, drafts: [] } as State }
    if (Buffer.byteLength(raw) > 12 * 1024 * 1024) throw Error("BUSINESS_DRAFT_STORAGE_INVALID")
    const state = JSON.parse(raw) as State
    if (
      state.version !== 1 ||
      !Array.isArray(state.drafts) ||
      state.drafts.length > 4 ||
      new Set(state.drafts.map((item) => item.id)).size !== state.drafts.length
    )
      throw Error("BUSINESS_DRAFT_STORAGE_INVALID")
    for (const draft of state.drafts) {
      if (!Array.isArray(draft.versions) || !draft.versions.length || draft.versions.length > 8)
        throw Error("BUSINESS_DRAFT_STORAGE_INVALID")
      for (const [index, version] of draft.versions.entries()) {
        const value = this.validate(version)
        if (
          value.id !== draft.id ||
          value.revision !== index + 1 ||
          value.digest !== version.digest
        )
          throw Error("BUSINESS_DRAFT_STORAGE_INVALID")
      }
    }
    return { key, raw, state }
  }
  private validate(input: CreatorBusinessDraft): CreatorBusinessDraft {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(input.id) ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 80 ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1 ||
      !Array.isArray(input.files) ||
      !input.files.length ||
      input.files.length > 32
    )
      throw Error("BUSINESS_DRAFT_INVALID")
    if (
      !input.baseSource ||
      typeof input.baseSource.pluginId !== "string" ||
      !input.baseSource.pluginId ||
      input.baseSource.pluginId.length > 256 ||
      !/^[a-f0-9]{64}$/.test(input.baseSource.digest)
    )
      throw Error("BUSINESS_DRAFT_SOURCE_INVALID")
    const catalog = parseBusinessModCatalog(input.catalog)
    if (catalog.kernel || !catalog.kernelRef) throw Error("BUSINESS_DRAFT_KERNEL_REPLACEMENT")
    const ids = [...catalog.modules, ...(catalog.extensions ?? [])].map((item) => item.id)
    const skillRoots = catalog.modules.map((mod) => mod.skill.entry.slice(0, -"SKILL.md".length))
    let total = 0
    const files = input.files
      .map((file) => {
        const path = businessModPath(file.path)
        if (
          !skillRoots.some((root) => path.startsWith(root)) &&
          !ids.some((id) => path.startsWith(`mods/business/${id}/`))
        )
          throw Error("BUSINESS_DRAFT_NAMESPACE")
        if (
          !/\.(?:py|md|json|[cm]?[jt]sx?|css|txt|ya?ml)$/.test(path) ||
          typeof file.text !== "string" ||
          file.text.includes("\0") ||
          Buffer.byteLength(file.text) > 64 * 1024 ||
          Buffer.from(file.text).toString("utf8") !== file.text
        )
          throw Error("BUSINESS_DRAFT_FILE_INVALID")
        total += Buffer.byteLength(file.text)
        return { path, text: file.text }
      })
      .sort((a, b) => a.path.localeCompare(b.path, "en"))
    if (
      total > 256 * 1024 ||
      new Set(files.map((file) => file.path.toLowerCase())).size !== files.length
    )
      throw Error("BUSINESS_DRAFT_SOURCE_LIMIT")
    // Every claimed resource must be materialized from this author document, never a host path.
    const required = [
      ...catalog.modules.flatMap((mod) => [
        mod.skill.entry,
        ...mod.skill.resources,
        ...mod.resources
      ]),
      ...(catalog.extensions ?? []).flatMap((mod) => [
        mod.entry,
        ...mod.resources,
        ...(mod.skills ?? [])
      ])
    ]
    if (
      required.some(
        (path) => !files.some((file) => file.path === path || file.path.startsWith(`${path}/`))
      )
    )
      throw Error("BUSINESS_DRAFT_RESOURCE_MISSING")
    const data = {
      id: input.id,
      name: input.name,
      revision: input.revision,
      baseSource: { ...input.baseSource },
      catalog,
      files
    }
    return { ...data, digest: hash(data) }
  }
  list(scope: DevelopmentScope) {
    return this.readState(scope).state.drafts.map((draft) =>
      structuredClone(draft.versions.at(-1)!)
    )
  }
  read(scope: DevelopmentScope, id: string) {
    const draft = this.list(scope).find((item) => item.id === id)
    if (!draft) throw Error("BUSINESS_DRAFT_MISSING")
    return draft
  }
  save(
    scope: DevelopmentScope,
    input: Omit<CreatorBusinessDraft, "digest">,
    expectedRevision: number,
    guard: () => void
  ) {
    guard()
    const { key, raw, state } = this.readState(scope)
    const current = state.drafts.find((item) => item.id === input.id)
    if ((current?.versions.at(-1)?.revision ?? 0) !== expectedRevision)
      throw Error("BUSINESS_DRAFT_REVISION_CHANGED")
    if (!current && state.drafts.length >= 4) throw new BusinessDraftLimitError("drafts")
    if ((current?.versions.length ?? 0) >= 8) throw new BusinessDraftLimitError("versions")
    const draft = this.validate({ ...input, revision: expectedRevision + 1, digest: "" })
    if (current) current.versions.push(draft)
    else state.drafts.push({ id: draft.id, versions: [draft] })
    guard()
    if (!this.settings.compareAndSetSetting(key, raw, JSON.stringify(state)))
      throw Error("BUSINESS_DRAFT_CHANGED")
    return structuredClone(draft)
  }
}
