import { lstatSync, realpathSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { ModFunctionError } from "../../shared/mods/v2/contracts"
import { ManagedModPolicy, type ManagedModDeployment } from "../mods/policy-core"
import { ModRuntimeClient } from "../mods/runtime-client-core"
import { launchNodeModProcess } from "../mods/node-process"
import type { BotFunctionHost } from "./function-sessions"
import type { BotProjectFiles } from "./project-files"
import type { BotStore } from "./store"
import { readBotModelSnapshot } from "./model-config"
import { assertBotModelSnapshotCurrent } from "./model-config-fence"
import { botModsConfigurationDigest } from "./mods-configuration"
import { canonicalJson } from "./validation"

/** A resident surface can redraw and read its granted project. Model, command,
 * tool and connector execution still require an actual Bot run. No run object,
 * model credential, previous approval or transcript is retained here. */
export class BotFunctionPresentation {
  readonly host: BotFunctionHost
  private readonly policy: ManagedModPolicy
  private identity?: string
  private closed = false
  private checking?: Promise<void>
  get scope() {
    return { workspace: this.input.workspace, threadId: this.input.threadId }
  }

  constructor(
    private readonly input: {
      store: BotStore
      botId: string
      workspacePath: string
      modelRef: string | null
      connectors: string[]
      workspace: string
      threadId: string
      project: BotProjectFiles
      modelFile: string
      digest: string
      policy: ManagedModDeployment
      plugins: ReturnType<BotFunctionHost["plugins"]>
      policyEntry: string
    }
  ) {
    this.policy = new ManagedModPolicy(
      input.policy,
      new ModRuntimeClient(input.policyEntry, launchNodeModProcess)
    )
    const deny = (): never => {
      throw new ModFunctionError("MODS_UI_ACTION_REQUIRED")
    }
    const assert = (workspace: string, threadId: string) => {
      this.assertCurrent()
      if (workspace !== input.workspace || threadId !== input.threadId)
        throw new ModFunctionError("MODS_CALL_SCOPE_CHANGED")
    }
    this.host = {
      plugins: () => input.plugins,
      enabled: () => !this.closed,
      assertThread: assert,
      changed: () => {},
      publish: async (_workspace, value, signal) => {
        this.assertCurrent()
        const result = await this.policy.publish(value, undefined, signal)
        this.assertCurrent()
        return result
      },
      fileScope: (workspace, threadId) => {
        assert(workspace, threadId)
        return {
          workspace: input.project.root,
          assertLive: () => assert(workspace, threadId),
          queryTool: async (tool, args) => {
            assert(workspace, threadId)
            if (
              !["host:ls", "host:read_file"].includes(tool) ||
              this.policy.query(tool).decision === "deny"
            )
              return { decision: "deny" }
            const path = tool === "host:ls" ? args.path : args.file_path
            if (typeof path !== "string") return { decision: "deny" }
            try {
              await input.project.assertReadable(
                isAbsolute(path) ? relative(input.project.root, path) || "." : path
              )
            } catch {
              return { decision: "deny" }
            }
            assert(workspace, threadId)
            return { decision: "allow" }
          }
        }
      },
      callTool: deny,
      callMcp: deny,
      completeModel: deny,
      registeredTool: deny,
      listTools: deny,
      checkTool: deny,
      readSession: deny,
      compactSession: deny,
      abortTurn: deny,
      scheduleCommand: deny,
      assertToolNameAvailable: deny,
      filterTools: () => []
    }
  }

  private fileIdentity(): string {
    const info = lstatSync(this.input.modelFile, { bigint: true })
    if (!info.isFile()) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":")
  }

  private assertCurrent(): void {
    if (this.closed) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    assertBotModelSnapshotCurrent(this.input.modelFile)
    const bot = this.input.store.getBot(this.input.botId)
    const project = this.input.project.identity
    const root = lstatSync(project.root, { bigint: true })
    if (
      bot.workspacePath !== this.input.workspacePath ||
      bot.modelRef !== this.input.modelRef ||
      !this.input.store.getConversation(this.input.threadId).members.includes(bot.id) ||
      canonicalJson(bot.connectorIds ?? []) !== canonicalJson(this.input.connectors) ||
      this.identity !== this.fileIdentity() ||
      !root.isDirectory() ||
      String(root.dev) !== project.dev ||
      String(root.ino) !== project.ino ||
      realpathSync(this.input.workspacePath) !== project.root
    )
      throw new ModFunctionError("MODS_SCOPE_CHANGED")
  }

  async current(): Promise<void> {
    if (this.closed) throw new ModFunctionError("MODS_SCOPE_CHANGED")
    this.checking ??= (async () => {
      const identity = this.fileIdentity()
      if (identity !== this.identity) {
        const snapshot = await readBotModelSnapshot(this.input.modelFile)
        if (
          botModsConfigurationDigest(snapshot) !== this.input.digest ||
          identity !== this.fileIdentity()
        )
          throw new ModFunctionError("MODS_SCOPE_CHANGED")
        this.identity = identity
      }
      this.assertCurrent()
    })().finally(() => {
      this.checking = undefined
    })
    await this.checking
  }

  close(): void {
    this.closed = true
    this.policy.stop()
  }
}

/** Construct the factory outside a run's lexical environment. */
export function botFunctionPresentationFactory(
  input: ConstructorParameters<typeof BotFunctionPresentation>[0]
) {
  return () => new BotFunctionPresentation(input)
}
