import { createHash } from "node:crypto"
import { lstatSync, realpathSync, type BigIntStats } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { BotDomainError } from "../../shared/bot-types"
import type { HarnessProjectContextItem } from "../harness-board/catalog-protocol"
import {
  assembleHarnessFeatureAgentContext,
  redactHarnessValue,
  normalizeHarnessAgentConfig,
  parseInspectCommand,
  replaceHarnessConfigPlaceholders
} from "../harness-board/agent-context-core"
import { normalizeHarnessAgentmdLoadStatus } from "../../shared/harness-board-types"
import { requireCompleteHarnessSessionContext } from "../harness-board/context-integrity"
import type { BotRuntimeRequest } from "./host"
import type { BotLocalReadAdmission } from "./local-tool-gate"
import { readBotModelSnapshot, type BotModelSnapshot } from "./model-config"
import { assertBotModelSnapshotCurrent } from "./model-config-fence"
import { botExecutionAuthorityFingerprint } from "./execution-authority"
import { BotUtilityProcess, type BotUtilityLauncher } from "./utility-process"
import { BotShellProcess } from "./shell-process"
import { BotProjectFiles } from "./project-files"
import { botProjectContext } from "./project-tools"
import { skillFileStamp } from "./skill-resource-files"
import { botExecutionConfigSchema } from "./shell-contract"
import { canonicalJson } from "./validation"
import {
  botHarnessSourcesSchema,
  botHarnessSkillScopeSchema,
  parseBotHarnessRunContext,
  type BotHarnessRunContext,
  type BotHarnessSourceRootIdentity,
  type BotHarnessSourceFence
} from "./harness-context-contract"
import { openStableFileHandle, readStableFileHandleBounded } from "../services/stable-file-handle"

type Approve = (
  id: string,
  action: unknown,
  operation: () => Promise<string>,
  beforeStart?: () => Promise<void>
) => Promise<string>
import type { BotStore } from "./store"
type Catalog = {
  context: HarnessProjectContextItem
  fences: BotHarnessSourceFence[]
  projectionDigest: string
  sourceRootIdentity: BotHarnessSourceRootIdentity
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
const digest = (value: unknown) =>
  createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(value))))
    .digest("hex")
const within = (root: string, path: string) => {
  const part = relative(root, path)
  return part === "" || (!part.startsWith("..") && !isAbsolute(part))
}
const changed = () =>
  new BotDomainError(
    "harness_context_changed",
    "项目绑定、工作目录或插件配置已变化，请重新发起任务"
  )
export function assertBotHarnessContext(
  context: Pick<BotHarnessRunContext, "fences" | "rootIdentities"> & {
    catalog?: BotHarnessRunContext["catalog"]
  }
): void {
  try {
    if (context.catalog) {
      const catalog = context.catalog
      const savedRoot = catalog.rootIdentity
      // Legacy pins already retain canonical file paths. Verify their declared
      // root mapping without inventing a historical directory identity.
      const expectedPath = savedRoot?.path ?? dirname(catalog.files[0]!.path)
      if (
        realpathSync(catalog.sources.root) !== expectedPath ||
        (savedRoot && savedRoot.declaredPath !== catalog.sources.root)
      )
        throw changed()
      const info = lstatSync(expectedPath, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (savedRoot &&
          (String(info.dev) !== savedRoot.device || String(info.ino) !== savedRoot.inode))
      )
        throw changed()
    }
    for (const root of context.rootIdentities) {
      const info = lstatSync(root.path, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        String(info.dev) !== root.device ||
        String(info.ino) !== root.inode ||
        realpathSync(root.declaredPath) !== root.path
      )
        throw changed()
      if (root.authorizedParentPath) {
        if (!within(root.authorizedParentPath, root.path)) throw changed()
        let current = root.authorizedParentPath
        for (const part of relative(current, root.path).split(sep).filter(Boolean)) {
          current = join(current, part)
          const segment = lstatSync(current)
          if (
            !segment.isDirectory() ||
            segment.isSymbolicLink() ||
            realpathSync(current) !== current
          )
            throw changed()
        }
      }
    }
    for (const fence of context.fences) {
      if (context.catalog?.files.some((source) => source.path === fence.path)) continue
      let info: BigIntStats | null = null
      try {
        info = lstatSync(fence.path, { bigint: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (
        (info ? skillFileStamp(info) : null) !== fence.stamp ||
        (info && (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n))
      )
        throw changed()
    }
  } catch {
    throw changed()
  }
}

/** Host-owned project preparation with Cmb parsing, Bot approvals and durable recovery. */
export class BotHarnessContextProvider {
  private readonly catalog: BotUtilityProcess
  private sourceConfiguration?: { stamp: string; sources: string }
  private readonly verifiedCatalogStamps = new Map<string, string>()
  private readonly verified = new WeakMap<object, { signature: string; inFlight?: Promise<void> }>()
  constructor(
    private readonly modelFile: string,
    private readonly shell = new BotShellProcess(),
    launcher: BotUtilityLauncher = { entry: join(__dirname, "bot-harness-catalog.js") }
  ) {
    this.catalog = new BotUtilityProcess(launcher, "项目上下文读取", 30_000)
  }
  /** Global stores can change for unrelated projects. Reparse only after their
   * stamps change, off the Host thread, and compare this binding's projection. */
  async assertCurrent(
    context: Pick<BotHarnessRunContext, "binding" | "fences" | "rootIdentities" | "catalog">,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted()
    assertBotModelSnapshotCurrent(this.modelFile)
    const modelStamp = skillFileStamp(lstatSync(this.modelFile, { bigint: true }))
    if (this.sourceConfiguration?.stamp !== modelStamp) {
      const snapshot = await readBotModelSnapshot(this.modelFile)
      this.sourceConfiguration = {
        stamp: modelStamp,
        sources: JSON.stringify(snapshot.harnessSources)
      }
    }
    if (this.sourceConfiguration.sources !== JSON.stringify(context.catalog.sources))
      throw changed()
    assertBotHarnessContext(context)
    const signature = () =>
      JSON.stringify(
        context.catalog.files.map((file) => {
          try {
            const info = lstatSync(file.path, { bigint: true })
            if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw changed()
            return skillFileStamp(info)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw changed()
          }
        })
      )
    const current = signature()
    const original = JSON.stringify(context.catalog.files.map((file) => file.stamp))
    const catalogKey = digest({
      sources: context.catalog.sources,
      project: context.binding.projectId,
      feature: context.binding.featureSlug ?? null,
      projection: context.catalog.projectionDigest
    })
    const cache = this.verified.get(context) ?? {
      signature: this.verifiedCatalogStamps.get(catalogKey) ?? original
    }
    this.verified.set(context, cache)
    if (cache.inFlight) await cache.inFlight
    if (cache.signature === current) return
    const verify = (async () => {
      try {
        const result = await this.catalog.invoke(
          { sources: context.catalog.sources, binding: context.binding },
          (value) => {
            if (
              !object(value) ||
              typeof value.projectionDigest !== "string" ||
              !Array.isArray(value.fences)
            )
              throw changed()
            return value as unknown as Catalog
          },
          signal
        )
        signal.throwIfAborted()
        assertBotHarnessContext(context)
        const files = new Map(result.fences.map((file) => [file.path, file]))
        if (
          result.projectionDigest !== context.catalog.projectionDigest ||
          JSON.stringify(context.catalog.files.map((file) => files.get(file.path)?.stamp)) !==
            signature()
        )
          throw changed()
        cache.signature = signature()
        this.verifiedCatalogStamps.delete(catalogKey)
        this.verifiedCatalogStamps.set(catalogKey, cache.signature)
        if (this.verifiedCatalogStamps.size > 256)
          this.verifiedCatalogStamps.delete(this.verifiedCatalogStamps.keys().next().value!)
      } catch {
        signal.throwIfAborted()
        throw changed()
      }
    })()
    cache.inFlight = verify
    try {
      await verify
    } finally {
      cache.inFlight = undefined
    }
  }
  /** Resolve visibility before the first task so project skills can be selected.
   * This reads installed metadata only; it runs no plugin command or Hook. */
  async refreshSkillScopes(
    store: BotStore,
    snapshot: BotModelSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    const bots = store.listBots().filter((bot) => bot.harnessBinding)
    if (!bots.length) return
    const sources = snapshot.harnessSources
      ? botHarnessSourcesSchema.parse(snapshot.harnessSources)
      : null
    const fingerprint = botExecutionAuthorityFingerprint(snapshot)
    for (const bot of bots) {
      signal.throwIfAborted()
      const binding = bot.harnessBinding!
      try {
        if (!sources || !bot.workspacePath) throw changed()
        const previous = store.db.exec(
          "SELECT scope FROM bot_harness_skill_scopes WHERE bot_id=?",
          [bot.id]
        )[0]?.values[0]
        if (previous) {
          const saved = botHarnessSkillScopeSchema.safeParse(JSON.parse(String(previous[0])))
          if (
            saved.success &&
            saved.data.sourceRoot === sources.root &&
            saved.data.workspacePath === bot.workspacePath &&
            JSON.stringify(saved.data.binding) === JSON.stringify(binding)
          ) {
            try {
              await this.assertCurrent(saved.data, signal)
              continue
            } catch {
              /* Rebuild a revoked grant. */
            }
          }
        }
        const result = await this.catalog.invoke(
          { sources, binding },
          (value) => {
            if (
              !object(value) ||
              !object(value.context) ||
              !Array.isArray(value.fences) ||
              typeof value.projectionDigest !== "string"
            )
              throw changed()
            return value as unknown as Catalog
          },
          signal
        )
        const plugin = result.context.plugin
        if (!plugin) throw changed()
        const primary = await BotProjectFiles.open(bot.workspacePath, [
          dirname(this.modelFile),
          sources.root
        ])
        const pluginRoot = await BotProjectFiles.open(plugin.path, [dirname(this.modelFile)])
        const scope = botHarnessSkillScopeSchema.parse({
          binding,
          workspacePath: bot.workspacePath,
          sourceRoot: sources.root,
          pluginId: plugin.id,
          pluginName: plugin.name,
          fences: result.fences,
          catalog: {
            sources,
            projectionDigest: result.projectionDigest,
            files: result.fences.slice(0, 4),
            rootIdentity: result.sourceRootIdentity
          },
          rootIdentities: [
            {
              path: primary.root,
              declaredPath: bot.workspacePath,
              device: primary.identity.dev,
              inode: primary.identity.ino
            },
            {
              path: pluginRoot.root,
              declaredPath: plugin.path,
              device: pluginRoot.identity.dev,
              inode: pluginRoot.identity.ino
            }
          ]
        })
        signal.throwIfAborted()
        assertBotHarnessContext(scope)
        if (
          botExecutionAuthorityFingerprint(await readBotModelSnapshot(this.modelFile)) !==
          fingerprint
        )
          throw changed()
        store.transaction(() => {
          const current = store.getBot(bot.id)
          if (
            current.workspacePath !== bot.workspacePath ||
            JSON.stringify(current.harnessBinding) !== JSON.stringify(binding)
          )
            throw changed()
          store.db.run(
            "INSERT INTO bot_harness_skill_scopes VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET scope=excluded.scope",
            [bot.id, JSON.stringify(scope)]
          )
        })
      } catch {
        signal.throwIfAborted()
        store.transaction(() =>
          store.db.run("DELETE FROM bot_harness_skill_scopes WHERE bot_id=?", [bot.id])
        )
      }
    }
  }
  async prepare(
    request: BotRuntimeRequest,
    snapshot: BotModelSnapshot,
    approve: Approve,
    check: () => void,
    admitRead?: (signal: AbortSignal) => Promise<BotLocalReadAdmission | undefined>
  ): Promise<BotHarnessRunContext | null> {
    const binding = request.bot.harnessBinding
    if (!binding || !this.shell.available) return null
    if (!request.bot.workspacePath || !snapshot.harnessSources)
      throw new BotDomainError(
        "harness_context_unavailable",
        "此后台尚未同步项目配置，请打开桌面应用后重试"
      )
    const sources = botHarnessSourcesSchema.parse(snapshot.harnessSources)
    const sourceWorkspace = request.worktree?.sourceWorkspacePath ?? request.bot.workspacePath
    const bindingDigest = digest({ binding, workspacePath: sourceWorkspace, sources })
    const readSaved = (runId: string) => {
      const row = request.store.db.exec(
        "SELECT context FROM bot_harness_run_contexts WHERE run_id=?",
        [runId]
      )[0]?.values[0]
      return row ? parseBotHarnessRunContext(JSON.parse(String(row[0]))) : null
    }
    const saved = readSaved(request.run.id)
    if (saved) {
      if (saved.bindingDigest !== bindingDigest) throw changed()
      await this.assertCurrent(saved, request.signal)
      return saved
    }
    const child = request.store.workflowChildren.metadata(request.run.id)
    if (child) {
      const parent = readSaved(child.parentLease.runId)
      if (!parent || parent.bindingDigest !== bindingDigest) throw changed()
      await this.assertCurrent(parent, request.signal)
      return this.pin(request, parent, sources.root)
    }
    const readCurrent = async () => {
      const admission = await admitRead?.(request.signal)
      check()
      admission?.assert()
    }
    await readCurrent()
    const result = await this.catalog.invoke(
      { sources, binding },
      (value) => {
        if (
          !object(value) ||
          !object(value.context) ||
          !Array.isArray(value.fences) ||
          typeof value.projectionDigest !== "string"
        )
          throw new Error("项目目录返回无效结果")
        return value as unknown as Catalog
      },
      request.signal
    )
    check()
    const source = result.context
    const project = source.project
    const plugin = source.plugin
    if (
      !plugin ||
      !source.configSnapshot?.value ||
      source.configSnapshot.error ||
      project.lifecycle.status !== "active" ||
      !plugin.enabled
    )
      throw changed()
    const deniedRoots = [dirname(this.modelFile), sources.root]
    const primary = await BotProjectFiles.open(sourceWorkspace, deniedRoots)
    const pluginDirectory = await BotProjectFiles.open(plugin.path, [dirname(this.modelFile)])
    const roots = [primary, pluginDirectory]
    const authorized = [primary.root]
    for (const path of binding.instructionWorkspacePaths) {
      const root = await BotProjectFiles.open(path, deniedRoots)
      if (!authorized.includes(root.root)) {
        authorized.push(root.root)
        roots.push(root)
      }
    }
    const rootIdentities: BotHarnessRunContext["rootIdentities"] = roots.map((root) => ({
      path: root.root,
      declaredPath:
        root === primary
          ? sourceWorkspace
          : root === pluginDirectory
            ? plugin.path
            : binding.instructionWorkspacePaths.find((path) => realpathSync(path) === root.root)!,
      device: root.identity.dev,
      inode: root.identity.ino
    }))
    const authority: BotHarnessRunContext = {
      version: 1,
      bindingDigest,
      binding,
      context: {},
      instructionPrompt: "",
      fences: result.fences,
      catalog: {
        sources,
        projectionDigest: result.projectionDigest,
        files: result.fences.slice(0, 4),
        rootIdentity: result.sourceRootIdentity
      },
      rootIdentities
    }
    const fingerprint = botExecutionAuthorityFingerprint(snapshot)
    const assertCurrent = async () => {
      check()
      if (
        botExecutionAuthorityFingerprint(await readBotModelSnapshot(this.modelFile)) !== fingerprint
      )
        throw changed()
      await this.assertCurrent(authority, request.signal)
      for (const root of roots) await root.assertCurrent()
      check()
    }
    await assertCurrent()
    const config = source.configSnapshot.value
    const inspectCommands = config.inspectCommands
    const platformCommands = object(inspectCommands) ? inspectCommands[process.platform] : undefined
    const commands = object(platformCommands) ? platformCommands : {}
    const command = (key: string) => {
      const value = commands[key]
      return typeof value === "string" ? value : ""
    }
    const secret = source.leanToken ?? ""
    const sanitize = (value: string) => (secret ? value.replaceAll(secret, "[已隐藏凭据]") : value)
    const render = (text: string) =>
      sanitize(
        replaceHarnessConfigPlaceholders(text, project, "run", pluginDirectory.root, {
          feature: binding.featureSlug,
          sessionWorkspacePath: sourceWorkspace,
          leanToken: ""
        })
      ).trim() || undefined
    const inspect = async (key: "session_context_inject" | "feature_status") => {
      const template = command(key)
      if (!template) return null
      const selected = source.selectedDeployUnits ?? []
      const invocation = parseInspectCommand(
        template,
        project,
        key === "feature_status" ? "run" : "sessionContext",
        pluginDirectory.root,
        {
          feature: binding.featureSlug,
          selectedDeployUnitsJson: JSON.stringify(selected),
          sessionWorkspacePath: sourceWorkspace,
          leanToken: secret
        }
      )
      const redacted = [invocation.executable, ...invocation.args]
        .map((value) => JSON.stringify(sanitize(value)))
        .join(" ")
      const action = {
        harnessInspect: {
          projectId: binding.projectId,
          featureId: binding.featureSlug ?? null,
          pluginId: plugin.id,
          key,
          configuration: digest({ template, fences: result.fences }),
          command: redacted,
          cwd: pluginDirectory.root,
          workspaceRoot: primary.root
        }
      }
      const id = `harness:${request.run.id}:${key}`
      const encoded = await approve(
        id,
        action,
        async () => {
          await assertCurrent()
          try {
            const protectedRoots = [
              dirname(this.modelFile),
              ...result.fences
                .filter((fence) => fence.stamp && fence.path.endsWith("leanstar-config.json"))
                .map((fence) => fence.path)
            ]
            const output = await this.shell.execute(
              {
                command: redacted,
                cwd: pluginDirectory.root,
                workspaceRoot: primary.root,
                runId: request.run.id,
                timeoutMs: 60_000,
                readOnly: true,
                protectedRoots,
                execution: botExecutionConfigSchema.parse(snapshot.execution),
                hook: { stdin: "", env: {}, invocation }
              },
              request.signal,
              undefined,
              async (guardSignal) => {
                guardSignal.throwIfAborted()
                await assertCurrent()
                guardSignal.throwIfAborted()
              }
            )
            if (!output.hook || output.exitCode !== 0 || output.truncated || output.capReached)
              throw new Error("inspect failed")
            const parsed: unknown = JSON.parse(output.hook.stdout)
            if (!object(parsed)) throw new Error("inspect format")
            // Sanitize while still in memory, before any effect or run context is persisted.
            const clean = JSON.stringify(
              redactHarnessValue(parsed, { sensitiveValues: secret ? [secret] : [] })
            )
            if (clean.length > 128_000 || Buffer.byteLength(clean) > 256 * 1024)
              throw new Error("inspect limit")
            await assertCurrent()
            return clean
          } catch {
            request.signal.throwIfAborted()
            throw new BotDomainError(
              "harness_inspect_uncertain",
              "项目插件检查未取得完整结果，请核对插件处理情况后重新发起任务"
            )
          }
        },
        assertCurrent
      )
      // A declined operation is not a prepared context.
      const receipt = request.store.effectResult(request.lease, id, action)
      if (!receipt || receipt.status !== "succeeded")
        throw new BotDomainError("harness_inspect_declined", "未授权项目插件检查，任务尚未开始")
      const value: unknown = JSON.parse(encoded)
      if (!object(value)) throw changed()
      return value
    }
    let session: Parameters<typeof assembleHarnessFeatureAgentContext>[0]["session"]
    if (binding.featureSlug && source.sessionContextInjectionSource === "plugin") {
      const value = await inspect("session_context_inject")
      session =
        value?.ok === true
          ? {
              prompt: requireCompleteHarnessSessionContext(
                typeof value.sessionContext === "string" ? value.sessionContext.trim() : ""
              ),
              agentmdLoadStatus: normalizeHarnessAgentmdLoadStatus(value.agentmdLoadStatus),
              agentConfig: normalizeHarnessAgentConfig(value.agentConfig)
            }
          : { warning: "插件未提供项目指令，已使用授权工作目录的 AGENTS.md" }
    }
    const mappings = [] as NonNullable<
      BotHarnessRunContext["context"]["additionalAgentsWorkspaceMappings"]
    >
    for (const mapping of session?.prompt?.trim() ? [] : (source.selectedDeployUnits ?? [])) {
      const owner = roots.find(
        (root) => authorized.includes(root.root) && within(root.root, mapping.localRepoPath)
      )
      if (!owner) continue
      if (mappings.length >= 16)
        throw new BotDomainError("harness_context_limit", "项目指令发布单元超过 16 个")
      // Lexical containment alone grants no capability: every directory component
      // must remain under the original root without a symlink/junction detour.
      await readCurrent()
      const target = await owner.openInstructionDirectory(mapping.localRepoPath)
      if (!roots.some((root) => root.root === target.root)) {
        roots.push(target)
        rootIdentities.push({
          path: target.root,
          declaredPath: mapping.localRepoPath,
          device: target.identity.dev,
          inode: target.identity.ino,
          authorizedParentPath: owner.root
        })
      }
      mappings.push({ ...mapping, localRepoPath: target.root })
    }
    const context = assembleHarnessFeatureAgentContext({
      staticPrompt: render(command("system_prompt_inject")),
      session,
      mappings,
      // Bot file tools remain rooted at primary. Extra roots provide instructions only.
      additionalRootsPrompt: mappings.length
        ? "Additional repositories provide project instructions only. File edits and commands remain restricted to the configured project root."
        : undefined,
      requestUserInputConfig: binding.requestUserInputConfig,
      identity: {
        pluginOutputDir: render(command("plugin_dir_hook")),
        systemId: project.systemId || undefined,
        pluginRoot: pluginDirectory.root,
        pluginId: plugin.id,
        pluginName: plugin.name,
        pluginWorkspace: project.workspacePath,
        featureId: binding.featureSlug,
        harnessProjectId: project.projectId,
        harnessAdapterName: plugin.name,
        harnessAdapterVersion: plugin.version,
        projectCode: project.projectCode,
        projectDir: project.projectDir || project.projectCode
      }
    })
    const profileConfig = context.agentConfig?.subagentConfig
    if (profileConfig) {
      if (profileConfig.customSubagentFiles.length > 16)
        throw new BotDomainError("harness_context_limit", "项目自定义角色超过 16 个")
      const files: string[] = []
      for (const declared of profileConfig.customSubagentFiles) {
        const path = resolve(pluginDirectory.root, declared)
        const owner = [pluginDirectory, ...roots.filter((root) => root !== pluginDirectory)].find(
          (root) => within(root.root, path)
        )
        if (!owner) throw new BotDomainError("harness_role_scope", "项目角色文件超出授权目录")
        await readCurrent()
        await owner.assertInstructionPath(path)
        const file = await openStableFileHandle(owner.root, path)
        try {
          const bytes = await readStableFileHandleBounded(file, 128 * 1024)
          if (secret && bytes.includes(Buffer.from(secret)))
            throw new BotDomainError("harness_role_secret", "项目角色文件含凭据，请移除后重试")
          await file.assertPathIdentity()
          await owner.assertInstructionPath(path)
          const identity = file.identity
          authority.fences.push({
            path: file.filePath,
            stamp: [
              identity.device,
              identity.inode,
              identity.size,
              identity.modifiedNs,
              identity.changedNs
            ].join(":"),
            sha256: createHash("sha256").update(bytes).digest("hex")
          })
          files.push(file.filePath)
        } finally {
          await file.handle.close()
        }
      }
      profileConfig.customSubagentFiles = files
    }
    const omitted = (source.selectedDeployUnits?.length ?? 0) - mappings.length
    if (omitted && context.enableAgentsPrompt)
      context.sessionContextInjectWarning = `另有 ${omitted} 个发布单元未获指令目录授权，未读取其文件。`
    let instructionPrompt = context.harnessAgentsPrompt ?? ""
    if (context.enableAgentsPrompt) {
      for (const path of [
        ...new Set([primary.root, ...mappings.map((mapping) => mapping.localRepoPath)])
      ]) {
        const remaining =
          128 * 1024 - Buffer.byteLength(instructionPrompt) - (instructionPrompt ? 2 : 0)
        if (remaining <= 0)
          throw new BotDomainError(
            "harness_context_limit",
            "项目指令超过读取限额，未省略指令或开始任务"
          )
        await readCurrent()
        const prompt = await botProjectContext(path, deniedRoots, remaining, true)
        instructionPrompt = [instructionPrompt, prompt].filter(Boolean).join("\n\n")
      }
    }
    const stage = binding.featureSlug ? await inspect("feature_status") : null
    const currentRun = stage && object(stage.run) ? stage.run : null
    const workflow = stage && object(stage.workflow) ? stage.workflow : null
    const node =
      workflow && Array.isArray(workflow.nodes)
        ? workflow.nodes.find(
            (value): value is Record<string, unknown> =>
              object(value) && value.id === currentRun?.currentNodeId
          )
        : null
    const runNode =
      currentRun && Array.isArray(currentRun.nodes)
        ? currentRun.nodes.find(
            (value): value is Record<string, unknown> =>
              object(value) && value.id === currentRun.currentNodeId
          )
        : null
    const status = runNode?.nodeStatus ?? currentRun?.currentNodeStatus
    const statusLabels: Record<string, string> = {
      not_started: "未开始",
      in_progress: "进行中",
      done: "已完成",
      blocked: "阻断",
      warning: "警告",
      error: "错误",
      skipped: "跳过",
      archived: "已归档"
    }
    const prepared = parseBotHarnessRunContext({
      ...authority,
      context,
      instructionPrompt: sanitize(instructionPrompt),
      ...(typeof node?.label === "string"
        ? { harnessNodeName: [node.group, node.label].filter(Boolean).join("-") }
        : {}),
      ...(typeof status === "string" && statusLabels[status]
        ? { harnessNodeStatus: statusLabels[status] }
        : {})
    })
    if (
      secret &&
      [secret, JSON.stringify(secret).slice(1, -1)].some((value) =>
        JSON.stringify(prepared).includes(value)
      )
    )
      throw new BotDomainError("harness_context_secret", "项目上下文含凭据，未保存或提交给模型")
    await assertCurrent()
    return this.pin(request, prepared, sources.root)
  }
  private pin(
    request: BotRuntimeRequest,
    prepared: BotHarnessRunContext,
    sourceRoot: string
  ): BotHarnessRunContext {
    return request.store.transaction(() => {
      request.store.assertLease(request.lease)
      const encoded = JSON.stringify(parseBotHarnessRunContext(prepared))
      request.store.db.run(
        "INSERT INTO bot_harness_run_contexts VALUES(?,?) ON CONFLICT(run_id) DO NOTHING",
        [request.run.id, encoded]
      )
      const saved = request.store.db.exec(
        "SELECT context FROM bot_harness_run_contexts WHERE run_id=?",
        [request.run.id]
      )[0]!.values[0]![0]
      const result = parseBotHarnessRunContext(JSON.parse(String(saved)))
      if (JSON.stringify(result) !== encoded) throw changed()
      const scope = botHarnessSkillScopeSchema.parse({
        sourceRoot,
        binding: result.binding,
        workspacePath: result.rootIdentities[0]!.declaredPath,
        pluginId: result.context.pluginId,
        pluginName: result.context.pluginName,
        fences: result.fences,
        catalog: result.catalog,
        rootIdentities: result.rootIdentities
      })
      request.store.db.run(
        "INSERT INTO bot_harness_skill_scopes VALUES(?,?) ON CONFLICT(bot_id) DO UPDATE SET scope=excluded.scope",
        [request.bot.id, JSON.stringify(scope)]
      )
      return result
    })
  }
}
