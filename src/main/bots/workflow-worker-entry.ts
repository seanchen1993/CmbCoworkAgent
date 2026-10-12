import { Worker, isMainThread, parentPort } from "node:worker_threads"
import { runWorkflowEngine, type WorkflowEngineStore } from "../agent/workflow/engine"
import { createWorkflowRunState } from "../agent/workflow/run-state"
import { validateWorkflowScript } from "../agent/workflow/script"
import { sha256Hex } from "../agent/workflow/run-store"
import {
  workflowDecode,
  workflowEncode,
  workflowHostMessage,
  workflowWorkerMessage,
  workflowStatePatch,
  workflowAgentResult,
  workflowAgentRequest,
  workflowProgress,
  type WorkflowProcessInput
} from "./workflow-contract"
import type { z } from "zod"

// The supervisor stays responsive even when a script starves its isolate after
// await. Losing the Host terminates the entire process, including that isolate.
if (isMainThread) {
  let worker: Worker | undefined
  process.once("disconnect", () => process.exit(1))
  process.on("message", (raw: unknown) => {
    try {
      const message = workflowDecode(raw, workflowHostMessage)
      if (message.kind === "start") {
        if (worker) throw new Error("工作流已启动")
        worker = new Worker(__filename, {
          resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }
        })
        let queuedBytes = 0
        worker.on("message", (wire: unknown) => {
          if (typeof wire !== "string") return process.exit(1)
          queuedBytes += Buffer.byteLength(wire, "utf8")
          if (queuedBytes > 40 * 1024 * 1024) return process.exit(1)
          process.send?.(wire, (error) => {
            queuedBytes -= Buffer.byteLength(wire, "utf8")
            if (error) process.exit(1)
          })
        })
        worker.once("error", (error) => {
          process.send?.(
            workflowEncode({ kind: "error", error: error.message.slice(0, 4000) }),
            () => process.exit(1)
          )
        })
        worker.once("exit", (code) => {
          // done/error is acknowledged through the process IPC before termination.
          process.send?.(workflowEncode({ kind: "heartbeat" }), () => process.exit(code))
        })
      }
      if (!worker) throw new Error("工作流尚未启动")
      worker.postMessage(raw)
    } catch {
      process.exit(1)
    }
  })
} else {
  const port = parentPort!
  let started = false
  let waiting = false
  let sequence = 0
  let outbound = 0
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  const send = (message: z.infer<typeof workflowWorkerMessage>) => {
    // Bounds synchronous log/phase spam as well as the supervisor's queued bytes.
    if (++outbound > 50_000) throw new Error("工作流事件数量超出限制")
    port.postMessage(workflowEncode(message))
  }
  const heartbeat = setInterval(() => port.postMessage(workflowEncode({ kind: "heartbeat" })), 500)
  heartbeat.unref()
  const call = (
    request: z.infer<typeof import("./workflow-contract").workflowOperation>,
    signal?: AbortSignal
  ): Promise<unknown> => {
    if (pending.size >= 64) return Promise.reject(new Error("工作流同时请求过多"))
    signal?.throwIfAborted()
    const id = ++sequence
    const abort = () => send({ kind: "cancel", id })
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      send({ kind: "call", id, request })
      signal?.addEventListener("abort", abort, { once: true })
    }).finally(() => signal?.removeEventListener("abort", abort))
  }
  async function execute(input: WorkflowProcessInput): Promise<void> {
    const parsed = validateWorkflowScript(input.state.script)
    if (sha256Hex(input.state.script) !== input.state.scriptSha256)
      throw new Error("工作流脚本与已登记版本不符")
    const memory = createWorkflowRunState(input.state)
    let dirty = false
    const publishState = () => {
      if (!dirty) return
      const { state } = memory
      send({
        kind: "state",
        value: workflowStatePatch.parse({
          status: state.status,
          phases: state.phases,
          currentPhase: state.currentPhase,
          agents: state.agents,
          logs: state.logs,
          result: state.result,
          resultSidecarStatus: state.resultSidecarStatus,
          error: state.error,
          warning: state.warning,
          stats: state.stats,
          completedAt: state.completedAt
        })
      })
      dirty = false
    }
    const store: WorkflowEngineStore = {
      state: memory.state,
      update(mutator) {
        memory.update(mutator)
        dirty = true
      },
      appendJournal(value) {
        memory.appendJournal(value)
        send({ kind: "journal", value })
      },
      upsertAgent(value) {
        memory.upsertAgent(value)
        send({ kind: "agent", value })
      },
      async flush() {
        publishState()
        if ((await call({ op: "flush" })) !== true) throw new Error("工作流记录未持久保存")
        return true
      },
      async persistFullResult(content) {
        publishState()
        return (await call({ op: "result", content })) === true
      }
    }
    const result = await runWorkflowEngine({
      ...input,
      parsed,
      runStore: store,
      args: input.state.args,
      // All workspace operations are delegated. No project/credential path enters this process.
      workspacePath: ".",
      durableAgentCalls: true,
      signal: new AbortController().signal,
      isAwaitingApproval: () => waiting,
      subagentRunner: async ({ signal, ...request }) => {
        publishState()
        return workflowAgentResult.parse(
          await call({ op: "agent", input: workflowAgentRequest.parse(request) }, signal)
        )
      },
      files: {
        read: async (path) => (await call({ op: "read", path })) as string,
        exists: async (path) => (await call({ op: "exists", path })) as boolean,
        glob: async (path) => (await call({ op: "glob", path })) as string[],
        write: async (path, content) => {
          await call({ op: "write", path, content })
        },
        workflow: async (path) => (await call({ op: "workflow", path })) as string
      },
      emit(value) {
        publishState()
        send({ kind: "progress", value: workflowProgress.parse(value) })
      }
    })
    // The full output belongs to the Host's persisted sidecar, not an unbounded IPC response.
    send({ kind: "done", value: { ...result, result: store.state.result } })
  }
  port.on("message", (raw: unknown) => {
    try {
      const message = workflowDecode(raw, workflowHostMessage)
      if (message.kind === "start") {
        if (started) throw new Error("工作流重复启动")
        started = true
        send({ kind: "ready" })
        void execute(message.value)
          .catch((error: unknown) => {
            send({
              kind: "error",
              error: (error instanceof Error ? error.message : String(error)).slice(0, 4000)
            })
          })
          .finally(() => {
            clearInterval(heartbeat)
            port.close()
          })
      } else if (message.kind === "approval") waiting = message.waiting
      else {
        const handler = pending.get(message.id)
        if (!handler) throw new Error("工作流响应身份无效")
        pending.delete(message.id)
        if (message.error) {
          const error = new Error(message.error.message)
          error.name = message.error.name
          handler.reject(error)
        } else handler.resolve(message.value)
      }
    } catch {
      process.exit(1)
    }
  })
}
