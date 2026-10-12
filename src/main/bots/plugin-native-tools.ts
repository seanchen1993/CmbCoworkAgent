import { dirname, isAbsolute, relative, resolve } from "node:path"
import type { StructuredToolInterface } from "@langchain/core/tools"
import { ToolMessage } from "@langchain/core/messages"
import { BotDomainError } from "../../shared/bot-types"
import type { ModObject } from "../../shared/mods/types"
import { functionToolTarget } from "../mods/v2/tool-sdk"
import type { ToolPermissionResult } from "../../shared/tool-permission"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import type { BotExecutionConfig } from "./shell-contract"
import type { BotShellProcess } from "./shell-process"
import type { BotSkillHooks } from "./skill-hooks"
import { BotProjectFiles } from "./project-files"
import { botProjectTools } from "./project-tools"
import { botShellTools } from "./shell-tools"

type Approval = Parameters<typeof botShellTools>[5]
function resultObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>
  } catch {
    /* Hook feedback may be appended to an otherwise structured result. */
  }
  return undefined
}
export interface BotPluginNativeCall {
  id: string
  pluginId: string
  signal: AbortSignal
  check: () => void
}

/** SDK names retain Cmb's argument contract; actual writes and processes use
 * the same Bot tools, approvals and recovery evidence as ordinary tasks. */
export class BotPluginNativeTools {
  private readonly reads = new Map<string, string>()
  private constructor(
    private readonly request: BotRuntimeRequest,
    private readonly modelFile: string,
    private readonly execution: BotExecutionConfig | undefined,
    private readonly files: BotArtifacts,
    private readonly shell: BotShellProcess,
    private readonly approve: Approval,
    private readonly project: BotProjectFiles,
    private readonly tools: readonly StructuredToolInterface[],
    private readonly hooks?: BotSkillHooks
  ) {}

  static async open(
    request: BotRuntimeRequest,
    modelFile: string,
    execution: BotExecutionConfig | undefined,
    files: BotArtifacts,
    shell: BotShellProcess,
    approve: Approval,
    tools: readonly StructuredToolInterface[],
    hooks?: BotSkillHooks
  ): Promise<BotPluginNativeTools | undefined> {
    if (!request.bot.workspacePath) return undefined
    return new BotPluginNativeTools(
      request,
      modelFile,
      execution,
      files,
      shell,
      approve,
      await BotProjectFiles.open(request.bot.workspacePath, [dirname(modelFile)]),
      tools,
      hooks
    )
  }

  private path(value: unknown): string {
    if (typeof value !== "string") throw new Error("插件文件路径无效")
    return isAbsolute(value) ? relative(this.project.root, value) || "." : value
  }

  private key(pluginId: string, path: string): string {
    return JSON.stringify([pluginId, resolve(this.project.root, path.replaceAll("\\", "/"))])
  }

  observedRead(pluginId: string, path: string, sha256: string): void {
    this.reads.set(this.key(pluginId, path), sha256)
  }

  handles(target: string): boolean {
    return ["host:write_file", "host:edit_file", "host:execute", "host:task_output"].includes(
      target
    )
  }

  async query(target: string, args: Record<string, unknown>): Promise<ToolPermissionResult> {
    try {
      if (target === "host:write_file" || target === "host:edit_file") {
        if (!this.tools.some((tool) => tool.name === "project_edit"))
          throw new Error("文件修改未授权")
        await this.project.assertWritable(this.path(args.file_path))
      } else if (target === "host:execute") {
        if (!this.execution || !this.tools.some((tool) => tool.name === "execute"))
          throw new Error("命令执行未配置或未授权")
        if (
          args.cwd !== undefined &&
          resolve(this.project.root, String(args.cwd)) !== this.project.root
        )
          throw new Error("插件命令的 cwd 必须是此 Bot 的项目根目录")
        await this.project.assertReadable(".")
      } else if (
        target !== "host:task_output" ||
        !this.tools.some((tool) => tool.name === "task_output")
      )
        throw new Error("此 Bot 未提供该工具")
      return { decision: "allow" }
    } catch (error) {
      return {
        decision: "deny",
        reason: error instanceof Error ? error.message : "工具范围校验失败"
      }
    }
  }

  async invoke(target: string, args: ModObject, call: BotPluginNativeCall): Promise<unknown> {
    const name = target.slice("host:".length)
    const check = () => {
      call.signal.throwIfAborted()
      call.check()
    }
    const request = { ...this.request, signal: AbortSignal.any([this.request.signal, call.signal]) }
    const invocation = `sdk-native:${call.id}`
    let dispatched = false
    let failed = false
    const approve: Approval = (id, action, operation, beforeStart) =>
      this.approve(
        id,
        action,
        async () => {
          check()
          await this.project.assertReadable(".")
          check()
          return operation()
        },
        async () => {
          check()
          await this.project.assertReadable(".")
          await beforeStart?.()
          check()
        }
      )
    const execute = async (effective: Record<string, unknown>): Promise<string> => {
      check()
      // Hooks may change input; revalidate the original SDK contract before mapping it.
      const validated = functionToolTarget({ ...effective, tool: name } as ModObject).args
      const permission = await this.query(target, validated)
      check()
      if (permission.decision !== "allow") throw new Error(permission.reason ?? "工具未授权")
      this.request.store.toolOnce(
        this.request.lease,
        `${invocation}:input`,
        { target, args: validated },
        () => true
      )
      let selected: StructuredToolInterface | undefined
      let input: Record<string, unknown>
      if (name === "write_file" || name === "edit_file") {
        const path = this.path(validated.file_path)
        const expected = this.reads.get(this.key(call.pluginId, path))
        if (expected === undefined) {
          // No implicit read may turn a blind overwrite into an authorized update.
          if (name === "edit_file") throw new Error("修改现有文件前，请先通过 read_file 读取文件")
          await this.project.assertNewArtifact(path)
        }
        input = {
          path,
          expected_sha256: expected ?? null,
          ...(name === "write_file"
            ? { content: validated.content }
            : {
                old_text: validated.old_string,
                new_text: validated.new_string,
                replace_all: validated.replace_all ?? false
              })
        }
        selected = (
          await botProjectTools(
            request,
            this.files,
            check,
            approve,
            [dirname(this.modelFile)],
            this.project
          )
        ).find((tool) => tool.name === "project_edit")
      } else if (name === "execute") {
        input = {
          command: validated.command,
          timeout_seconds: 60,
          run_in_background: false,
          keep_alive: false
        }
        selected = botShellTools(
          request,
          this.modelFile,
          this.execution,
          this.files,
          check,
          approve,
          this.shell
        )[0]
      } else {
        input = { task_id: validated.task_id }
        selected = this.tools.find((tool) => tool.name === "task_output")
      }
      check()
      if (!selected) throw new BotDomainError("plugin_tool_unavailable", "插件工具不可用")
      dispatched = true
      const result: unknown = await selected.invoke(
        { type: "tool_call", id: invocation, name: selected.name, args: input },
        { signal: request.signal }
      )
      check()
      const text =
        typeof result === "string"
          ? result
          : ToolMessage.isInstance(result) && typeof result.content === "string"
            ? result.content
            : undefined
      if (text === undefined) throw new Error("插件工具返回格式无效")
      const parsed = resultObject(text)
      failed =
        (ToolMessage.isInstance(result) && result.status === "error") ||
        (typeof parsed?.exitCode === "number" && parsed.exitCode !== 0)
      if (name !== "task_output") {
        const effectId = `${name === "execute" ? "shell" : "project"}:${request.run.id}:${invocation}`
        // A declined approval has no effect receipt; it must not look like SDK success.
        failed ||= request.store.effectResult(request.lease, effectId)?.status !== "succeeded"
      }
      return text
    }
    check()
    const result = this.hooks
      ? await this.hooks.dispatchNative(name, args, invocation, execute)
      : await execute(args)
    check()
    const parsed = resultObject(result)
    if (!dispatched || failed) return { ...(parsed ?? { error: result }), isError: true }
    return parsed ?? result
  }
}
