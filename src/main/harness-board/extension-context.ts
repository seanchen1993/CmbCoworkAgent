import type { ExtensionContextContract } from "../../shared/project-runtime"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative } from "node:path"
import { readPackageExtensionContract } from "../plugins/extension-contract"
import { readRuntimeScopedFile, runtimeRelativePath } from "./project-runtime/safe-files"
import { createAsyncMutex } from "../utils/fs"
import { isInternalHarnessProjectId } from "./internal-project-context"

type Operation = "session-context" | "sync-knowledge"
type Invocation = { executable: string; args: string[] }
const locks = new Map<string, { mutex: ReturnType<typeof createAsyncMutex>; users: number }>()
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)

/** Only a workspace's saved non-sensitive directory binding is accepted, never a model path. */
export interface ExtensionContextConfig {
  directoryBinding(name: string, key: string): Promise<string | undefined>
}
type DirectoryResolver = (
  sourceRoot: string,
  workspace: string,
  name: string,
  key: string,
  projectId?: string
) => Promise<string | undefined>
let directoryResolver: DirectoryResolver | undefined
type SourceAdmission = (sourceRoot: string, workspace: string, projectId: string) => Promise<() => void>
let sourceAdmission: SourceAdmission | undefined
export function configureExtensionContextDirectoryBinding(resolver?: DirectoryResolver, admit?: SourceAdmission): void {
  directoryResolver = resolver
  sourceAdmission = admit
}

/** Exact identity shared with read-only operation invalidation; this never allocates mutable data. */
export function extensionContextStorageKey(
  plugin: { name: string; version: string },
  boardBytes: Buffer,
  context: ExtensionContextContract,
  boundKnowledge?: string
): string {
  return hash(
    JSON.stringify([
      plugin.name,
      plugin.version,
      hash(boardBytes.toString("utf8")),
      context,
      boundKnowledge ?? "host-cache"
    ])
  )
}

/** Binds an admitted provider to host-owned mutable data; it never schedules a business stage. */
export async function prepareExtensionContext(input: {
  sourceRoot: string
  workspace: string
  dataRoot: string
  operation: Operation
  invocation: Invocation
  configuration?: ExtensionContextConfig
  /** Main-derived project identity for configuration reads before a model token exists. */
  projectId?: string
}) {
  const contract = readPackageExtensionContract(input.sourceRoot)
  const context = contract?.context
  const provider = context?.provider
  if (!provider || !(provider.operations as readonly Operation[]).includes(input.operation))
    return undefined
  const internalProject = input.projectId !== undefined && isInternalHarnessProjectId(input.projectId)
    ? input.projectId
    : undefined
  const assertCurrent = internalProject
    ? await sourceAdmission?.(input.sourceRoot, input.workspace, internalProject)
    : undefined
  if (internalProject && !assertCurrent)
    throw Error("COMPOSITION_CONTEXT_SOURCE_ADMISSION_REQUIRED")
  assertCurrent?.()
  if (!provider.entry) throw Error("EXTENSION_CONTEXT_ACTION_PROVIDER_ENTRY_UNSUPPORTED")
  const entry = runtimeRelativePath(provider.entry)
  if (!readRuntimeScopedFile(input.sourceRoot, entry, 512 * 1024).present)
    throw Error("EXTENSION_CONTEXT_PROVIDER_MISSING")
  const pluginFile = readRuntimeScopedFile(input.sourceRoot, "plugin.json", 65_536)
  const boardFile = readRuntimeScopedFile(input.sourceRoot, "board_core/board_config.json", 262_144)
  if (!pluginFile.present || !boardFile.present) throw Error("EXTENSION_CONTEXT_SOURCE_INVALID")
  const plugin = JSON.parse(pluginFile.bytes!.toString("utf8")) as Record<string, unknown>
  const board = JSON.parse(boardFile.bytes!.toString("utf8")) as Record<string, unknown>
  if (typeof plugin.name !== "string" || typeof plugin.version !== "string" || !record(board))
    throw Error("EXTENSION_CONTEXT_SOURCE_INVALID")
  const binding = context.knowledge.binding
  let boundKnowledge = binding
    ? await (input.configuration?.directoryBinding(plugin.name, binding) ??
        directoryResolver?.(input.sourceRoot, input.workspace, plugin.name, binding, input.projectId))
    : undefined
  // Directory bindings are read-only knowledge sources. With no binding value, the original
  // plugin-wide cache semantics remain; required knowledge is checked during actual loading.
  if (boundKnowledge) {
    if (!isAbsolute(boundKnowledge)) throw Error("EXTENSION_CONTEXT_CONFIGURATION_INVALID")
    boundKnowledge = await realpath(boundKnowledge)
    if (!(await lstat(boundKnowledge)).isDirectory())
      throw Error("EXTENSION_CONTEXT_CONFIGURATION_INVALID")
    const source = await realpath(input.sourceRoot)
    const knowledgeRelative = relative(source, boundKnowledge)
    if (
      !knowledgeRelative ||
      (!isAbsolute(knowledgeRelative) &&
        !knowledgeRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`))
    )
      throw Error("EXTENSION_CONTEXT_KNOWLEDGE_INSIDE_SOURCE")
    if (input.operation === "sync-knowledge")
      throw Error(
        "EXTENSION_CONTEXT_KNOWLEDGE_READONLY: 已绑定外部只读知识目录，不能同步写入。清除目录绑定后可使用平台独立缓存同步；外部目录内容会保留。"
      )
  }
  // Keep package revisions and workspace bindings separate; no runtime values enter the package.
  const identity = extensionContextStorageKey(
    { name: plugin.name, version: plugin.version },
    boardFile.bytes!,
    context,
    boundKnowledge
  )
  await mkdir(input.dataRoot, { recursive: true })
  const root = await realpath(input.dataRoot)
  const data = join(root, identity)
  await mkdir(data, { recursive: true })
  const actual = await realpath(data)
  if (relative(root, actual) !== identity || !(await lstat(data)).isDirectory())
    throw Error("EXTENSION_CONTEXT_DATA_SCOPE_CHANGED")
  let lock = locks.get(actual)
  if (!lock) {
    if (locks.size >= 128) throw Error("EXTENSION_CONTEXT_BUSY")
    lock = { mutex: createAsyncMutex(), users: 0 }
    locks.set(actual, lock)
  }
  lock.users++
  await lock.mutex.acquire()
  let released = false
  const release = () => {
    if (released) return
    released = true
    lock!.mutex.release()
    if (--lock!.users === 0) locks.delete(actual)
  }
  try {
    const configPath = join(actual, "board_config.json")
    assertCurrent?.()
    let existing: Record<string, unknown> | undefined
    try {
      const info = await lstat(configPath)
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 262_144)
        throw Error("EXTENSION_CONTEXT_DATA_INVALID")
      const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"))
      if (!record(parsed)) throw Error("EXTENSION_CONTEXT_DATA_INVALID")
      existing = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    let knowledgeRoot = boundKnowledge
    if (!knowledgeRoot) {
      knowledgeRoot = join(actual, "knowledge")
      await mkdir(knowledgeRoot, { recursive: true })
      if (relative(actual, await realpath(knowledgeRoot)) !== "knowledge")
        throw Error("EXTENSION_CONTEXT_DATA_SCOPE_CHANGED")
    }
    // Restore executable settings from immutable source. Only sync-owned data survives.
    const effective = structuredClone(board)
    if (Array.isArray(existing?.supported_deploy_units))
      effective.supported_deploy_units = existing.supported_deploy_units
    const commands = record(effective.inspectCommands) ? effective.inspectCommands : {}
    for (const config of Object.values(commands))
      if (record(config)) config.knowledge_path = knowledgeRoot
    const temporary = join(dirname(configPath), `config-${randomUUID()}.tmp`)
    await writeFile(temporary, `${JSON.stringify(effective, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    })
    await rename(temporary, configPath)
    const scriptIndex = input.invocation.args.findIndex((arg) => /\.py$/i.test(arg))
    if (
      scriptIndex < 0 ||
      !/^python(?:[\d.]*)?(?:\.exe)?$/i.test(input.invocation.executable.split(/[\\/]/).at(-1)!)
    )
      throw Error("EXTENSION_CONTEXT_INVOCATION_UNSUPPORTED")
    assertCurrent?.()
    return {
      ...(assertCurrent ? { assertCurrent } : {}),
      invocation: {
        ...input.invocation,
        args: [
          ...input.invocation.args.slice(0, scriptIndex),
          join(input.sourceRoot, entry),
          "--devclaw-operation",
          input.operation,
          "--",
          ...input.invocation.args.slice(scriptIndex + 1)
        ]
      },
      env: {
        DEVCLAW_PLUGIN_DATA_ROOT: actual,
        DEVCLAW_KNOWLEDGE_ROOT: knowledgeRoot,
        DEVCLAW_KNOWLEDGE_READONLY: boundKnowledge ? "1" : "0",
        DEVCLAW_RUNTIME_CONFIG_PATH: configPath,
        PYTHONDONTWRITEBYTECODE: "1"
      },
      release
    }
  } catch (error) {
    release()
    throw error
  }
}

/** Read-only UI projection of host data. Cached commands never become executable settings. */
export async function readExtensionContextProjection(input: {
  sourceRoot: string
  workspace: string
  dataRoot: string
  configuration?: ExtensionContextConfig
  projectId?: string
}) {
  const prepared = await prepareExtensionContext({
    ...input,
    operation: "session-context",
    invocation: { executable: "python", args: ["context.py"] }
  })
  if (!prepared) return undefined
  try {
    const value: unknown = JSON.parse(
      await readFile(prepared.env.DEVCLAW_RUNTIME_CONFIG_PATH, "utf8")
    )
    prepared.assertCurrent?.()
    if (!record(value)) throw Error("EXTENSION_CONTEXT_DATA_INVALID")
    const units = Array.isArray(value.supported_deploy_units)
      ? [
          ...new Set(
            value.supported_deploy_units.filter(
              (unit): unit is string =>
                typeof unit === "string" && unit.length > 0 && unit.length <= 512
            )
          )
        ].slice(0, 10000)
      : []
    return {
      knowledgeRoot: prepared.env.DEVCLAW_KNOWLEDGE_ROOT,
      readonly: prepared.env.DEVCLAW_KNOWLEDGE_READONLY === "1",
      supportedDeployUnits: units
    }
  } finally {
    prepared.release()
  }
}
