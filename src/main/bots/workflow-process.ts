import { createHash } from "node:crypto"
import { BoundedWorkerAdmission } from "../services/bounded-worker-admission"
import { canonicalJson } from "./validation"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import type { WorkflowEngineStore, WorkflowFileAccess } from "../agent/workflow/engine"
import type { WorkflowProgressEmitter, WorkflowSubagentRunner } from "../agent/workflow/types"
import type { BotUtilityLauncher } from "./utility-process"
import { botShellEnvironment } from "./shell-contract"
import {
  workflowStart,
  workflowDecode,
  workflowEncode,
  workflowWorkerMessage,
  workflowResult,
  workflowAgentResult,
  type WorkflowProcessInput
} from "./workflow-contract"
import { z } from "zod"

type Result = z.infer<typeof workflowResult>
const agentAdmission = new BoundedWorkerAdmission(4, 64, "Bot workflow agents")
export type BotWorkflowFileAccess = {
  [K in keyof WorkflowFileAccess]: (
    ...args: [...Parameters<WorkflowFileAccess[K]>, invocation: string]
  ) => ReturnType<WorkflowFileAccess[K]>
}
export interface BotWorkflowProcessPorts {
  store: WorkflowEngineStore
  files: BotWorkflowFileAccess
  agent: WorkflowSubagentRunner
  progress: WorkflowProgressEmitter
  /** Recheck the live run/lease and source policy before accepting every worker action. */
  check(): void
  isAwaitingApproval(): boolean
}

/** The Cmb deterministic engine in a disposable process. Privileged operations
 * and durability remain in Host callbacks; no credentials cross the boundary. */
export class BotWorkflowProcess {
  private readonly active = new Map<string, { queueId: string; background: boolean }>()
  private readonly admission = new BoundedWorkerAdmission(4, 64, "Bot workflows")
  isActive(queueId: string, includeBackground = true): boolean {
    return [...this.active.values()].some(
      (item) => item.queueId === queueId && (includeBackground || !item.background)
    )
  }
  constructor(
    private readonly launcher: BotUtilityLauncher = { entry: join(__dirname, "bot-workflow.js") },
    private readonly heartbeatTimeoutMs = 10_000
  ) {}

  async execute(
    input: WorkflowProcessInput,
    ports: BotWorkflowProcessPorts,
    signal: AbortSignal,
    background = false
  ): Promise<Result> {
    const request = workflowStart.parse(input)
    signal.throwIfAborted()
    ports.check()
    const identity = (state: WorkflowEngineStore["state"]) =>
      canonicalJson(
        JSON.parse(
          workflowEncode({
            id: state.runId,
            owner: state.threadId,
            source: state.scriptSha256,
            argsDefined: state.args !== undefined,
            args: state.args ?? null,
            journal: state.journal
          })
        )
      )
    if (identity(request.state) !== identity(ports.store.state))
      throw new Error("工作流输入与 Host 持久状态不匹配")
    if (this.active.size >= 68) throw new Error("工作流等待队列已满")
    if (this.active.has(request.state.runId)) throw new Error("该工作流正在执行或清理中")
    if (!existsSync(this.launcher.entry)) throw new Error("工作流构建产物缺失，请重新构建应用")
    const wire = workflowEncode({ kind: "start", value: request })
    this.active.set(request.state.runId, { queueId: request.state.threadId, background })
    const lifetime = new AbortController()
    const operationCounts = new Map<string, number>()
    const calls = new Map<number, { abort: AbortController; completion: Promise<void> }>()
    let release: (() => void) | undefined
    try {
      release = await this.admission.acquire(signal)
      signal.throwIfAborted()
      ports.check()
      return await new Promise<Result>((resolve, reject) => {
        const child = spawn(
          this.launcher.executable ?? process.execPath,
          ["--max-old-space-size=256", ...(this.launcher.execArgv ?? []), this.launcher.entry],
          {
            env: { ...botShellEnvironment(process.env), ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true
          }
        )
        let failure: Error | undefined, result: Result | undefined
        let ready = false,
          settled = false,
          lastHeartbeat = Date.now(),
          messages = 0,
          lastCall = 0
        let lastApproval: boolean | undefined
        const stop = (error: unknown) => {
          failure ??= error instanceof Error ? error : new Error(String(error))
          lifetime.abort(failure)
          child.kill("SIGKILL")
        }
        const abort = () => stop(signal.reason ?? new Error("工作流已取消"))
        signal.addEventListener("abort", abort, { once: true })
        const send = (value: unknown) => {
          if (lifetime.signal.aborted) return
          child.send(workflowEncode(value), (error) => {
            if (error) stop(error)
          })
        }
        const timer = setInterval(
          () => {
            try {
              ports.check()
              if (Date.now() - lastHeartbeat > (ready ? this.heartbeatTimeoutMs : 30_000))
                return stop(new Error("工作流脚本无响应，执行进程已终止"))
              const waiting = ports.isAwaitingApproval()
              if (waiting !== lastApproval) {
                lastApproval = waiting
                if (ready) send({ kind: "approval", waiting })
              }
            } catch (error) {
              stop(error)
            }
          },
          Math.min(1000, Math.max(50, this.heartbeatTimeoutMs / 4))
        )
        const finish = async () => {
          if (settled) return
          settled = true
          clearInterval(timer)
          signal.removeEventListener("abort", abort)
          lifetime.abort(new Error("工作流执行进程已结束"))
          // Wait for Host-owned effects to settle; process exit never means an
          // already dispatched write/API request may be silently replayed.
          await Promise.allSettled([...calls.values()].map((call) => call.completion))
          if (signal.aborted) reject(signal.reason ?? new Error("工作流已取消"))
          else if (failure) reject(failure)
          else if (!result) reject(new Error("工作流进程异常退出，需检查任务现场后恢复"))
          else resolve(result)
        }
        child.once("error", (error) => {
          failure = error
          void finish()
        })
        child.once("exit", () => {
          void finish()
        })
        child.on("message", (raw: unknown) => {
          if (lifetime.signal.aborted || settled) return
          try {
            ports.check()
            const message = workflowDecode(raw, workflowWorkerMessage)
            if (message.kind === "heartbeat") {
              lastHeartbeat = Date.now()
              return
            }
            if (++messages > 50_000) throw new Error("工作流通信数量超出限制")
            if (message.kind === "ready") {
              if (ready) throw new Error("工作流重复初始化")
              ready = true
              lastHeartbeat = Date.now()
              lastApproval = ports.isAwaitingApproval()
              send({ kind: "approval", waiting: lastApproval })
              return
            }
            if (!ready || result) throw new Error("工作流返回顺序无效")
            switch (message.kind) {
              case "error":
                stop(new Error(message.error))
                break
              case "done":
                result = message.value
                break
              case "state":
                ports.store.update((state) => {
                  // Explicit fields also clear optional values omitted by JSON.
                  Object.assign(state, message.value, {
                    result: message.value.result,
                    error: message.value.error,
                    warning: message.value.warning,
                    completedAt: message.value.completedAt,
                    resultSidecarStatus: message.value.resultSidecarStatus
                  })
                })
                break
              case "journal":
                ports.store.appendJournal(message.value)
                break
              case "agent":
                ports.store.upsertAgent(message.value)
                break
              case "progress":
                if (message.value.runId !== request.state.runId)
                  throw new Error("工作流进度身份无效")
                ports.progress(message.value)
                break
              case "cancel":
                calls.get(message.id)?.abort.abort(new Error("子任务已取消"))
                break
              case "call": {
                if (message.id <= lastCall || calls.size >= 64)
                  throw new Error("工作流调用身份或数量无效")
                lastCall = message.id
                const abort = new AbortController()
                const callSignal = AbortSignal.any([signal, lifetime.signal, abort.signal])
                const completion = Promise.resolve()
                  .then(async () => {
                    callSignal.throwIfAborted()
                    ports.check()
                    const operation = message.request
                    const identity = createHash("sha256")
                      .update(canonicalJson(operation))
                      .digest("hex")
                    const ordinal = operationCounts.get(identity) ?? 0
                    operationCounts.set(identity, ordinal + 1)
                    const invocation = `${identity}:${ordinal}`
                    let value: unknown
                    switch (operation.op) {
                      case "agent": {
                        const release = await agentAdmission.acquire(callSignal)
                        try {
                          callSignal.throwIfAborted()
                          ports.check()
                          value = workflowAgentResult.parse(
                            await ports.agent({ ...operation.input, signal: callSignal })
                          )
                        } finally {
                          release()
                        }
                        break
                      }
                      case "read":
                        value = z
                          .string()
                          .max(1_048_576)
                          .parse(await ports.files.read(operation.path, callSignal, invocation))
                        break
                      case "exists":
                        value = z
                          .boolean()
                          .parse(await ports.files.exists(operation.path, callSignal, invocation))
                        break
                      case "glob":
                        value = z
                          .array(z.string().max(4096))
                          .max(10_000)
                          .parse(await ports.files.glob(operation.path, callSignal, invocation))
                        break
                      case "workflow":
                        value = z
                          .string()
                          .max(524_288)
                          .parse(await ports.files.workflow(operation.path, callSignal, invocation))
                        break
                      case "write":
                        await ports.files.write(
                          operation.path,
                          operation.content,
                          callSignal,
                          invocation
                        )
                        value = null
                        break
                      case "flush":
                        value = await ports.store.flush()
                        break
                      case "result":
                        value = await ports.store.persistFullResult(operation.content)
                        break
                    }
                    callSignal.throwIfAborted()
                    ports.check()
                    send({ kind: "reply", id: message.id, value })
                  })
                  .catch((error: unknown) => {
                    if (lifetime.signal.aborted) return
                    send({
                      kind: "reply",
                      id: message.id,
                      error: {
                        name: (error instanceof Error ? error.name : "Error").slice(0, 100),
                        message: (error instanceof Error ? error.message : String(error)).slice(
                          0,
                          4000
                        )
                      }
                    })
                  })
                  .finally(() => calls.delete(message.id))
                calls.set(message.id, { abort, completion })
                break
              }
            }
          } catch (error) {
            stop(error)
          }
        })
        child.once("spawn", () => {
          if (signal.aborted) return abort()
          child.send(wire, (error) => {
            if (error) stop(error)
          })
        })
      })
    } finally {
      this.active.delete(request.state.runId)
      release?.()
    }
  }
}
