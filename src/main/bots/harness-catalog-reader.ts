import { createHash } from "node:crypto"
import { lstat, realpath } from "node:fs/promises"
import { join } from "node:path"
import { readHarnessProjectContexts } from "../harness-board/catalog-reader"
import { FEATURE_V2_FILE } from "../harness-board/config-v2"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"
import { botHarnessBindingSchema } from "../../shared/bot-harness-context"
import { botHarnessSourcesSchema, type BotHarnessSourceFence } from "./harness-context-contract"
import { skillFileStamp } from "./skill-resource-files"

/** Reuse Cmb's authoritative catalog parsing in a disposable Node process. */
export async function readBotHarnessCatalog(raw: { sources: unknown; binding: unknown }) {
  const sources = botHarnessSourcesSchema.parse(raw.sources)
  const binding = botHarnessBindingSchema.parse(raw.binding)
  const root = await realpath(sources.root)
  const identity = await lstat(root, { bigint: true })
  if (!identity.isDirectory() || identity.isSymbolicLink()) throw new Error("项目配置目录无效")
  const sourceRootIdentity = {
    path: root,
    declaredPath: sources.root,
    device: String(identity.dev),
    inode: String(identity.ino)
  }
  const paths = [
    join(root, "harness-board-projects.json"),
    join(root, "plugins.json"),
    join(root, FEATURE_V2_FILE),
    join(root, "leanstar-config.json")
  ]
  const fences: BotHarnessSourceFence[] = []
  const capture = async (path: string, max: number) => {
    const info = await lstat(path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if (!info) {
      fences.push({ path, stamp: null, sha256: null })
      return
    }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n)
      throw new Error("项目配置不能使用链接")
    const file = await openStableFileHandle(root, path)
    try {
      const bytes = await readStableFileHandleBounded(file, max)
      await file.assertPathIdentity()
      fences.push({
        path,
        stamp: skillFileStamp(info),
        sha256: createHash("sha256").update(bytes).digest("hex")
      })
    } finally {
      await file.handle.close()
    }
  }
  await capture(paths[0]!, 32 * 1024 * 1024)
  await capture(paths[1]!, 32 * 1024 * 1024)
  await capture(paths[2]!, 32 * 1024 * 1024)
  await capture(paths[3]!, 64 * 1024)
  const context = readHarnessProjectContexts(
    paths[0]!,
    paths[1]!,
    [binding.projectId],
    512 * 1024,
    undefined,
    binding.featureSlug
      ? { featureSlug: binding.featureSlug, featureBindingStorePath: paths[2]! }
      : undefined,
    paths[3]!
  ).projects[binding.projectId]
  if (
    !context?.plugin ||
    !context.plugin.enabled ||
    context.configSnapshot?.error ||
    !context.configSnapshot?.value
  )
    throw new Error("项目或关联插件不可用")
  if (context.project.lifecycle.status !== "active") throw new Error("项目已归档")
  if (Number(context.configSnapshot.value.apiVersion) !== 1)
    throw new Error("项目插件与当前后台版本不兼容")
  // The plugin root has a separate authority from the private configuration root.
  const pluginRoot = await realpath(context.plugin.path)
  const configPath = join(pluginRoot, "board_core", "board_config.json")
  const file = await openStableFileHandle(pluginRoot, configPath)
  try {
    const bytes = await readStableFileHandleBounded(file, 1024 * 1024)
    await file.assertPathIdentity()
    const info = await lstat(configPath, { bigint: true })
    fences.push({
      path: configPath,
      stamp: skillFileStamp(info),
      sha256: createHash("sha256").update(bytes).digest("hex")
    })
  } finally {
    await file.handle.close()
  }
  for (const fence of fences) {
    const info = await lstat(fence.path, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null
      throw error
    })
    if ((info ? skillFileStamp(info) : null) !== fence.stamp)
      throw new Error("项目配置在读取期间变化")
  }
  const currentRoot = await lstat(root, { bigint: true })
  if (
    (await realpath(sources.root)) !== root ||
    currentRoot.dev !== identity.dev ||
    currentRoot.ino !== identity.ino
  )
    throw new Error("项目配置目录在读取期间变化")
  const projectionDigest = createHash("sha256")
    .update(
      JSON.stringify({
        project: {
          id: context.project.projectId,
          status: context.project.lifecycle.status,
          workspacePath: context.project.workspacePath,
          projectCode: context.project.projectCode,
          projectDir: context.project.projectDir,
          systemId: context.project.systemId,
          adapter: context.project["harness-adapter"]
        },
        plugin: {
          id: context.plugin.id,
          enabled: context.plugin.enabled,
          name: context.plugin.name,
          version: context.plugin.version,
          path: context.plugin.path
        },
        configuration: context.configSnapshot.value,
        feature: {
          slug: binding.featureSlug,
          selectedDeployUnits: context.selectedDeployUnits,
          sessionContextInjectionSource: context.sessionContextInjectionSource
        },
        tokenDigest: createHash("sha256")
          .update(context.leanToken ?? "")
          .digest("hex")
      })
    )
    .digest("hex")
  return { context, fences, projectionDigest, sourceRootIdentity }
}
