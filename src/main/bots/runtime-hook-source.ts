import { createHash } from "node:crypto"
import { lstatSync, opendirSync, realpathSync } from "node:fs"
import { lstat, opendir, realpath } from "node:fs/promises"
import { basename, isAbsolute, join, relative } from "node:path"
import { z } from "zod"
import { isSupportedHookEvent, type HookConfig } from "../hooks/types"
import { parseHookDocument } from "../hook-catalog/reader"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { BotDomainError } from "../../shared/bot-types"
import { skillFileStamp } from "./skill-resource-files"

const absolute = z.string().min(1).max(4096).refine(isAbsolute)
export const botRuntimeHookSources = z.object({ root: absolute }).strict()
export type BotRuntimeHookSources = z.infer<typeof botRuntimeHookSources>
export type BotConfiguredHook = HookConfig & {
  owner: "global" | "workspace" | "plugin"
  ownerId: string
  ownerName: string
  pluginId?: string
  pluginName?: string
}
type FileIdentity = { root: string; path: string; stamp: string | null; sha256: string | null }
type DirectoryIdentity = { path: string; identity: string | null; files: string[] }
export interface BotRuntimeHookCatalog {
  hooks: BotConfiguredHook[]
  files: FileIdentity[]
  directory: DirectoryIdentity | null
  roots: { path: string; declaredPath: string; identity: string }[]
}
const identity = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`
const changed = () =>
  new BotDomainError("hook_configuration_changed", "Hook 配置或来源已变化，请重新发起任务")
const within = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (!part.startsWith("..") && !isAbsolute(part))
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)

function enabledEntries(document: unknown, owner: BotConfiguredHook["owner"]): number {
  if (Array.isArray(document)) {
    if (document.some((row) => !object(row))) throw new Error("Hook 列表中存在无效配置")
    return document.filter((row) => row.enabled !== false).length
  }
  if (!object(document)) throw new Error("Hook 配置格式无效")
  const settings = object(document.hooks) ? document.hooks : document
  let count = 0
  for (const [event, groups] of Object.entries(settings)) {
    if (["description", "$schema"].includes(event)) continue
    // Function Mods share hooks/hooks.json but their modules are loaded by the
    // existing QuickJS manager, not by the command/HTTP/prompt Hook runner.
    if (
      owner === "plugin" &&
      settings === document &&
      event === "modules" &&
      Array.isArray(groups) &&
      groups.every((item) => typeof item === "string")
    )
      continue
    if (!Array.isArray(groups)) throw new Error("Hook 事件配置必须为列表")
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks)) throw new Error("Hook 匹配配置无效")
      for (const hook of group.hooks) {
        if (!object(hook)) throw new Error("Hook 检查配置无效")
        if (hook.enabled === false) continue
        if (!isSupportedHookEvent(event))
          throw new Error(`Hook 事件 ${event.slice(0, 100)} 暂不支持`)
        count++
      }
    }
  }
  return count
}

/** Execute from original configuration, never from the truncated UI catalog.
 * File roots come from desktop settings or the Bot's project, not model arguments. */
export async function readBotRuntimeHookCatalog(
  raw: unknown,
  workspacePath: string | null,
  signal: AbortSignal
): Promise<BotRuntimeHookCatalog> {
  const source = botRuntimeHookSources.parse(raw)
  const catalog: BotRuntimeHookCatalog = { hooks: [], files: [], directory: null, roots: [] }
  let totalBytes = 0
  const canonicalRoot = async (path: string) => {
    const canonical = await realpath(path)
    const info = await lstat(canonical, { bigint: true })
    if (!info.isDirectory()) throw new Error("Hook 来源不是目录")
    catalog.roots.push({ path: canonical, declaredPath: path, identity: identity(info) })
    return canonical
  }
  const read = async (root: string, path: string, limit = 256 * 1024): Promise<string | null> => {
    signal.throwIfAborted()
    if (!within(root, path)) throw new Error("Hook 配置超出所属目录")
    if (catalog.files.length >= 128) throw new Error("Hook 配置文件超过 128 个")
    const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (!info) {
      catalog.files.push({ root, path, stamp: null, sha256: null })
      return null
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
      throw new Error("Hook 配置不能使用链接或特殊文件")
    const file = await openStableFileHandle(root, path)
    try {
      const bytes = await readStableFileHandleBounded(file, limit)
      totalBytes += bytes.length
      if (totalBytes > 2 * 1024 * 1024) throw new Error("Hook 配置总量超过 2 MiB")
      const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      await file.assertPathIdentity()
      catalog.files.push({
        root,
        path,
        stamp: skillFileStamp(info),
        sha256: createHash("sha256").update(bytes).digest("hex")
      })
      return value
    } finally {
      await file.handle.close()
    }
  }
  const parseJson = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      throw new Error("Hook 配置不是有效 JSON，请检查原配置文件")
    }
  }
  const append = (
    text: string,
    owner: BotConfiguredHook["owner"],
    root: string,
    path: string,
    ownerId: string,
    ownerName: string
  ) => {
    let document = parseJson(text)
    if (owner === "workspace" && Array.isArray(document))
      throw new Error("项目 Hook 请使用单个配置对象或事件分组格式")
    // The parser's historical per-file limit is 512. Reject over-limit trees
    // before calling it, rather than quietly dropping checks at execution time.
    const nodes = [{ value: document, depth: 0 }]
    let entries = 0
    while (nodes.length) {
      const item = nodes.pop()!
      if (item.depth > 24 || ++entries > 8192) throw new Error("Hook 配置嵌套或条目过多")
      if (Array.isArray(item.value) && item.value.length > 128)
        throw new Error("单个 Hook 列表超过 128 项")
      if (item.value && typeof item.value === "object")
        for (const value of Object.values(item.value)) nodes.push({ value, depth: item.depth + 1 })
    }
    if (
      owner === "workspace" &&
      document &&
      typeof document === "object" &&
      !Array.isArray(document) &&
      "event" in document
    ) {
      const native = document as Record<string, unknown>
      const type =
        native.type ??
        (typeof native.url === "string"
          ? "http"
          : typeof native.prompt === "string"
            ? "prompt"
            : "command")
      document = [{ ...native, type }]
    }
    const expected = enabledEntries(document, owner)
    const hooks = parseHookDocument(
      document,
      ownerId,
      { enabled: true, createdAt: "", updatedAt: "" },
      {
        requireNativeId: owner === "global",
        preserveNativeDates: false,
        nativeFallbackForCommand: owner !== "global",
        nativeId: (hook, index) =>
          owner === "workspace"
            ? ownerId
            : owner === "plugin"
              ? `${ownerId}/${typeof hook.id === "string" ? hook.id : index}`
              : String(hook.id)
      }
    )
    if (hooks.filter((hook) => hook.enabled).length !== expected)
      throw new Error("Hook 配置含无法执行的检查，请检查事件、标识和处理器字段")
    const identities = new Set<string>()
    for (const hook of hooks) {
      const key = `${hook.event}:${hook.id}`
      if (identities.has(key)) throw new Error("Hook 标识重复，请为检查设置独立标识")
      identities.add(key)
    }
    for (const hook of hooks.filter((hook) => hook.enabled))
      catalog.hooks.push({
        ...hook,
        owner,
        ownerId,
        ownerName,
        hookSourceType: owner,
        hookSourceRoot: root,
        hookSourcePath: path,
        ...(owner === "plugin"
          ? { pluginId: ownerId.slice("plugin:".length), pluginName: ownerName, pluginRoot: root }
          : {})
      })
    if (catalog.hooks.length > 256) throw new Error("已启用 Hook 超过 256 项")
  }
  const root = await canonicalRoot(source.root)
  const globalPath = join(root, "hooks.json")
  const global = await read(root, globalPath)
  if (global !== null) append(global, "global", root, globalPath, "global", "全局 Hook")
  const pluginsPath = join(root, "plugins.json")
  const pluginText = await read(root, pluginsPath, 1024 * 1024)
  if (pluginText !== null) {
    const plugins = z
      .array(
        z.object({
          id: z.string().min(1).max(512),
          name: z.string().min(1).max(1024),
          path: absolute,
          enabled: z.boolean().default(true),
          hookCount: z.number().int().nonnegative().optional(),
          hookPath: z.string().min(1).max(4096).optional()
        })
      )
      .max(512)
      .parse(parseJson(pluginText))
    for (const plugin of plugins.filter((plugin) => plugin.enabled && plugin.hookCount !== 0)) {
      const pluginRoot = await canonicalRoot(plugin.path)
      const relativePath = plugin.hookPath ?? "hooks/hooks.json"
      if (
        isAbsolute(relativePath) ||
        relativePath
          .split(/[\\/]/)
          .some((part) => !part || part === ".." || part === "." || part.includes(":"))
      )
        throw new Error("插件 Hook 路径无效")
      const path = join(pluginRoot, relativePath)
      const text = await read(pluginRoot, path)
      if (text !== null)
        append(text, "plugin", pluginRoot, path, `plugin:${plugin.id}`, plugin.name)
    }
  }
  if (workspacePath) {
    const project = await canonicalRoot(workspacePath)
    const path = join(project, ".cmbdevclaw", "hooks")
    const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    catalog.directory = { path, identity: info ? identity(info) : null, files: [] }
    if (info) {
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
        throw new Error("项目 Hook 目录不能使用链接")
      const directory = await opendir(path)
      let count = 0
      for await (const entry of directory) {
        if (++count > 1024) throw new Error("项目 Hook 目录条目过多")
        if (entry.name.endsWith(".json")) catalog.directory.files.push(entry.name)
      }
      catalog.directory.files.sort()
      for (const name of catalog.directory.files) {
        const file = join(path, name),
          text = await read(project, file)
        if (text !== null)
          append(text, "workspace", project, file, `ws:${basename(name, ".json")}`, "项目 Hook")
      }
    }
  }
  signal.throwIfAborted()
  assertBotRuntimeHookCatalog(catalog)
  return catalog
}

/** Cheap pre-effect fence. New/deleted files, replacement and editing revoke the
 * accepted configuration; command content is never silently replaced mid-run. */
export function assertBotRuntimeHookCatalog(catalog: BotRuntimeHookCatalog): void {
  try {
    for (const root of catalog.roots) {
      const info = lstatSync(root.path, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        identity(info) !== root.identity ||
        realpathSync(root.path) !== root.path ||
        realpathSync(root.declaredPath) !== root.path
      )
        throw changed()
    }
    for (const file of catalog.files) {
      const info = (() => {
        try {
          return lstatSync(file.path, { bigint: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      })()
      if (!info) {
        if (file.stamp !== null) throw changed()
        continue
      }
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1n ||
        skillFileStamp(info) !== file.stamp ||
        realpathSync(file.path) !== file.path
      )
        throw changed()
    }
    const directory = catalog.directory
    if (directory) {
      const info = (() => {
        try {
          return lstatSync(directory.path, { bigint: true })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
          throw error
        }
      })()
      if (!info) {
        if (directory.identity !== null) throw changed()
      } else {
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          identity(info) !== directory.identity ||
          realpathSync(directory.path) !== directory.path
        )
          throw changed()
        const handle = opendirSync(directory.path),
          names: string[] = []
        let count = 0
        try {
          for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
            if (++count > 1024) throw changed()
            if (entry.name.endsWith(".json")) names.push(entry.name)
          }
        } finally {
          handle.closeSync()
        }
        if (JSON.stringify(names.sort()) !== JSON.stringify(directory.files)) throw changed()
      }
    }
  } catch {
    throw changed()
  }
}
