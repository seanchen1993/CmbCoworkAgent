import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type {
  KnowledgeBaseState,
  KnowledgeBaseStateItem,
  KnowledgeWorkspaceRole,
  KnowledgeWorkspaceState
} from "../../shared/knowledge-base-types"
import { getCmbCoworkAgentDataRoot } from "../app-data-root"

export interface CloudKnowledgeBase {
  idKey: string
  name: string
  description: string
  repoUrl: string
  sshUrl: string | null
  gitRef: string
}

export const KNOWLEDGE_WORKSPACE_ROLES: KnowledgeWorkspaceRole[] = ["read", "write"]
const KNOWLEDGE_STATE_FILE = "knowledge-state.json"

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function knowledgeStatePath(): string {
  return join(getCmbCoworkAgentDataRoot(), KNOWLEDGE_STATE_FILE)
}

export function knowledgeDirectory(idKey: string, role: KnowledgeWorkspaceRole): string {
  const root = resolve(getCmbCoworkAgentDataRoot(), "knowledge")
  const target = resolve(root, idKey)
  if (
    !idKey ||
    idKey !== idKey.trim() ||
    idKey.length > 40 ||
    /[<>:"/\\|?*]/.test(idKey) ||
    [...idKey].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    /[. ]$/.test(idKey) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(idKey) ||
    dirname(target) !== root ||
    target === root ||
    !KNOWLEDGE_WORKSPACE_ROLES.includes(role)
  ) {
    throw new Error("知识库 idKey 或工作区无法安全映射到本地目录")
  }
  return join(target, role)
}

export function normalizeGitRef(value: string): string {
  return value.trim() || "main"
}

function assertCloudGitUrl(value: string): void {
  if (
    !value ||
    value.startsWith("-") ||
    value.length > 2048 ||
    [...value].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  ) {
    throw new Error("知识库 Git 地址格式无效")
  }
  if (value.includes("://")) {
    try {
      const url = new URL(value)
      if (["https:", "http:", "ssh:", "git:"].includes(url.protocol) && url.hostname) return
    } catch {
      // Reject malformed sources before accepting the snapshot.
    }
  } else if (/^(?:[^@/:]+@)?[a-zA-Z0-9][a-zA-Z0-9._-]*:[^:].*$/.test(value)) {
    return
  }
  throw new Error("知识库 Git 地址格式无效")
}

export function parseCloudKnowledgeItems(value: unknown): CloudKnowledgeBase[] {
  if (!Array.isArray(value)) throw new Error("知识库配置 items 格式无效")
  const seen = new Set<string>()
  return value.map((raw) => {
    if (!isRecord(raw)) throw new Error("知识库配置项格式无效")
    if (
      typeof raw.idKey !== "string" ||
      typeof raw.name !== "string" ||
      typeof raw.description !== "string" ||
      typeof raw.repoUrl !== "string" ||
      typeof raw.gitRef !== "string" ||
      (raw.sshUrl !== null && typeof raw.sshUrl !== "string")
    ) {
      throw new Error("知识库配置项字段类型无效")
    }
    if (
      !raw.name ||
      raw.name !== raw.name.trim() ||
      raw.name.length > 128 ||
      raw.description.length > 300 ||
      raw.gitRef.length > 255
    ) {
      throw new Error("知识库配置项字段无效")
    }
    const { idKey, name, description, repoUrl } = raw
    const gitRef = normalizeGitRef(raw.gitRef)
    const sshUrl = raw.sshUrl || null
    assertCloudGitUrl(repoUrl)
    if (sshUrl !== null) assertCloudGitUrl(sshUrl)
    if (seen.has(idKey)) throw new Error(`知识库 idKey 重复：${idKey}`)
    knowledgeDirectory(idKey, "read")
    seen.add(idKey)
    return { idKey, name, description, repoUrl, sshUrl, gitRef }
  })
}

function parseWorkspaces(value: unknown): KnowledgeWorkspaceState[] {
  if (!Array.isArray(value) || value.length !== 2) throw new Error("知识库工作区格式无效")
  return KNOWLEDGE_WORKSPACE_ROLES.map((role) => {
    const matches = value.filter((item) => isRecord(item) && item.role === role)
    const item = matches[0]
    if (
      matches.length !== 1 ||
      !isRecord(item) ||
      !["not_downloaded", "success", "failed", "blocked"].includes(String(item.status)) ||
      (item.lastError !== null && typeof item.lastError !== "string")
    ) {
      throw new Error("知识库工作区状态无效")
    }
    return {
      role,
      status: item.status as KnowledgeWorkspaceState["status"],
      lastError: item.lastError
    }
  })
}

export async function readKnowledgeState(): Promise<KnowledgeBaseState | null> {
  let content: string
  try {
    content = await readFile(knowledgeStatePath(), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const parsed: unknown = JSON.parse(content)
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.knowledgeBases)) {
    throw new Error("knowledge-state.json 格式无效")
  }
  const rawItems = parsed.knowledgeBases
  const sources = parseCloudKnowledgeItems(rawItems)
  const knowledgeBases = sources.map((source, index): KnowledgeBaseStateItem => {
    const raw = rawItems[index]
    if (
      !isRecord(raw) ||
      raw.type !== "public" ||
      (raw.visibility !== "visible" && raw.visibility !== "unavailable")
    ) {
      throw new Error("知识库本地状态无效")
    }
    return {
      ...source,
      type: "public",
      visibility: raw.visibility,
      workspaces: parseWorkspaces(raw.workspaces)
    }
  })
  return { schemaVersion: 1, knowledgeBases }
}

export async function writeKnowledgeState(state: KnowledgeBaseState): Promise<void> {
  const path = knowledgeStatePath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8")
  await rename(temporary, path)
}

export function mergeCloudKnowledgeState(
  previous: KnowledgeBaseState | null,
  items: CloudKnowledgeBase[]
): KnowledgeBaseState {
  const previousById = new Map(previous?.knowledgeBases.map((item) => [item.idKey, item]) ?? [])
  const cloudIds = new Set(items.map((item) => item.idKey))
  const knowledgeBases = items.map((item): KnowledgeBaseStateItem => {
    const old = previousById.get(item.idKey)
    const sourceChanged = old && (old.repoUrl !== item.repoUrl || old.gitRef !== item.gitRef)
    return {
      ...item,
      type: "public",
      visibility: "visible",
      workspaces: KNOWLEDGE_WORKSPACE_ROLES.map((role) => {
        const workspace = old?.workspaces.find((entry) => entry.role === role)
        return workspace && !sourceChanged
          ? { ...workspace }
          : { role, status: "not_downloaded", lastError: null }
      })
    }
  })
  for (const old of previous?.knowledgeBases ?? []) {
    if (!cloudIds.has(old.idKey)) knowledgeBases.push({ ...old, visibility: "unavailable" })
  }
  return { schemaVersion: 1, knowledgeBases }
}

export async function isValidKnowledgeDirectory(
  idKey: string,
  role: KnowledgeWorkspaceRole
): Promise<boolean> {
  try {
    const directory = knowledgeDirectory(idKey, role)
    const [rootStats, gitStats] = await Promise.all([
      stat(directory),
      stat(join(directory, ".git"))
    ])
    return rootStats.isDirectory() && (gitStats.isDirectory() || gitStats.isFile())
  } catch {
    return false
  }
}
