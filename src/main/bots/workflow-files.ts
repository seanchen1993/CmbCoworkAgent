import type { BotLocalReadAdmission } from "./local-tool-gate"
import type { BotRuntimeRequest } from "./host"
import type { BotArtifacts } from "./artifacts"
import { BotProjectFiles } from "./project-files"
import { BotDomainError } from "../../shared/bot-types"
import { botProjectChangeAction, commitBotProjectChange } from "./project-change"
import type { BotWorkflowStore } from "./workflow-store"
import type { BotWorkflowFileAccess } from "./workflow-process"
import { MAX_WORKFLOW_SCRIPT_BYTES } from "../agent/workflow/script"

/** File primitives keep the existing project's path, CAS, approval and backup
 * implementation. Calls sharing the parent lease serialize through approval. */
export async function botWorkflowFiles(input: {
  request: BotRuntimeRequest
  workflow: BotWorkflowStore
  artifacts: BotArtifacts
  browserOnly?: boolean
  computerOnly?: boolean
  deniedRoots: string[]
  check(): void
  assertCurrent?(): Promise<void>
  admitRead?(signal: AbortSignal): Promise<BotLocalReadAdmission | undefined>
  approve(id: string, action: unknown, operation: () => Promise<string>): Promise<string>
}): Promise<BotWorkflowFileAccess> {
  const { request, workflow, artifacts, check, approve } = input
  const { store, lease, bot } = request
  workflow.assertOwner(lease)
  if (input.browserOnly || input.computerOnly) {
    const reject = async (): Promise<never> => {
      check()
      throw new BotDomainError(
        "workflow_browser_files",
        input.computerOnly ? "应用子任务不能使用项目文件操作" : "浏览器任务不能使用项目文件操作"
      )
    }
    return {
      read: reject,
      workflow: reject,
      glob: reject,
      exists: reject,
      write: reject
    }
  }
  if (!bot.workspacePath) throw new Error("请先配置 Bot 的项目目录")
  const project = await BotProjectFiles.open(bot.workspacePath, input.deniedRoots)
  let tail: Promise<unknown> = Promise.resolve()
  const serialized = <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
    const next = tail.then(async () => {
      signal.throwIfAborted()
      check()
      await input.assertCurrent?.()
      await project.assertReadable(".")
      signal.throwIfAborted()
      check()
      const result = await operation()
      await input.assertCurrent?.()
      check()
      return result
    })
    tail = next.catch(() => {})
    return next
  }
  const read = (path: string, signal: AbortSignal, invocation: string, script = false) =>
    serialized(signal, async () => {
      const result = await workflow.observe(
        invocation,
        { op: script ? "workflow" : "read", path },
        async () => {
          const admission = await input.admitRead?.(signal)
          signal.throwIfAborted()
          admission?.assert()
          const file = await project.read(path)
          const max = script ? MAX_WORKFLOW_SCRIPT_BYTES : 1_048_576
          if (Buffer.byteLength(file.text, "utf8") > max)
            throw new Error(`文件内容超过 ${max} 字节`)
          signal.throwIfAborted()
          check()
          return file.text
        }
      )
      return result
    })
  return {
    read: (path, signal, invocation) => read(path, signal, invocation),
    workflow: (path, signal, invocation) => read(path, signal, invocation, true),
    glob: (pattern, signal, invocation) =>
      serialized(signal, () =>
        workflow.observe(invocation, { op: "glob", pattern }, async () => {
          const admission = await input.admitRead?.(signal)
          signal.throwIfAborted()
          admission?.assert()
          const paths = await project.glob(pattern, ".", () => {
            signal.throwIfAborted()
            check()
          })
          signal.throwIfAborted()
          check()
          return paths
        })
      ),
    exists: (path, signal, invocation) =>
      serialized(signal, () =>
        workflow.observe(invocation, { op: "exists", path }, async () => {
          const admission = await input.admitRead?.(signal)
          signal.throwIfAborted()
          admission?.assert()
          try {
            await project.assertReadable(path)
            signal.throwIfAborted()
            check()
            return true
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
            throw error
          }
        })
      ),
    write: (path, content, signal, invocation) =>
      serialized(signal, async () => {
        if (Buffer.byteLength(content, "utf8") > 1_048_576) throw new Error("工作流写入超过 1 MiB")
        const id = `workflow-file:${workflow.id}:${invocation}`
        store.toolOnce(lease, id, { path, content }, () => true)
        const previous = store.effectResult(lease, id)
        if (previous?.status === "succeeded") return
        if (previous)
          throw new BotDomainError(
            "effect_requires_review",
            "工作流写入已有失败或不确定记录，不能自动重复"
          )
        const outcome = await workflow.observe(
          invocation,
          { op: "write", path, content },
          async () => {
            const admission = await input.admitRead?.(signal)
            signal.throwIfAborted()
            admission?.assert()
            const current = await project.read(path).catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null
              throw error
            })
            const change = await project.prepare({
              path,
              content,
              expectedHash: current?.sha256 ?? null
            })
            signal.throwIfAborted()
            check()
            await approve(id, botProjectChangeAction(project.root, change), () =>
              commitBotProjectChange(request, artifacts, project, change, id, () => {
                signal.throwIfAborted()
                check()
              })
            )
            return {
              approved: store.effectResult(lease, id)?.status === "succeeded"
            }
          }
        )
        if (!outcome.approved) throw new Error("用户未批准工作流写入，文件未修改")
      })
  }
}
