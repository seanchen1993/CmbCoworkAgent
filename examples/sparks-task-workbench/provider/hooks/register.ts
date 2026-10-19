import type { On, JsonObject, Stream, ProcessChunk, ProcessResult } from "claude-code"

const taskIdSchema = { type: "string", minLength: 1, maxLength: 80 }
const resultSchema = {
  type: "object",
  properties: { taskId: taskIdSchema, status: { type: "string" } },
  required: ["taskId", "status"],
  additionalProperties: false
}
const taskSchema = {
  type: "object",
  properties: {
    taskId: taskIdSchema,
    title: { type: "string", maxLength: 100 },
    path: { type: "string", maxLength: 4096 },
    text: { type: "string", maxLength: 10000 },
    argv: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", maxLength: 2048 } }
  },
  required: ["taskId", "argv"],
  additionalProperties: false
}

/** No startup hook, model call or process executes during discovery/registration. */
export function register(on: On) {
  const tasks: JsonObject[] = []
  const jobs = new Map<
    string,
    {
      cancelled: boolean
      stream?: Stream<ProcessChunk, ProcessResult>
      done: Promise<void>
      finish(): void
    }
  >()
  on.capability(
    {
      apiVersion: "devclaw.capability/v1",
      id: "tasks",
      version: "1.0.0",
      title: "个人任务工作台提供者",
      scope: "conversation",
      stateSchema: {
        type: "object",
        properties: { tasks: { type: "array", maxItems: 8, items: { type: "object" } } },
        required: ["tasks"],
        additionalProperties: false
      },
      actions: [
        {
          id: "start",
          title: "执行已授权任务",
          inputSchema: taskSchema,
          outputSchema: resultSchema,
          requiredPermissions: ["clock.after", "platform.publish", "process.spawn", "fs.write"],
          cancellable: false,
          idempotency: "keyed"
        },
        {
          id: "cancel",
          title: "取消并等待任务退出",
          inputSchema: {
            type: "object",
            properties: { taskId: taskIdSchema },
            required: ["taskId"],
            additionalProperties: false
          },
          outputSchema: resultSchema,
          requiredPermissions: ["platform.publish", "process.spawn"],
          cancellable: false,
          idempotency: "keyed"
        }
      ]
    },
    {
      async act($, event) {
        const id = String(event.input.taskId)
        const publish = () =>
          $.platform.publish({
            id: "tasks",
            version: "1.0.0",
            target: { kind: "current" },
            value: { tasks }
          })
        if (event.action === "cancel") {
          const job = jobs.get(id),
            task = tasks.find((task) => task.id === id)
          if (!job || !task) throw Error("任务不存在；请先读取真实状态")
          job.cancelled = true
          // return waits for the existing process SDK's physical close acknowledgement.
          await job.stream?.return({ code: null, signal: null })
          await job.done
          return { taskId: id, status: String(task.status) }
        }
        if (jobs.has(id) || tasks.length >= 8) throw Error("任务身份已使用或已达到 8 项上限")
        // File writes retain the explicit native user action and physical write lease.
        if (typeof event.input.path === "string")
          await $.fs.write(event.input.path, String(event.input.text ?? ""))
        let finish!: () => void
        const job = {
          cancelled: false,
          stream: undefined as Stream<ProcessChunk, ProcessResult> | undefined,
          done: new Promise<void>((resolve) => {
            finish = resolve
          }),
          finish: () => finish()
        }
        jobs.set(id, job)
        const task: JsonObject = {
          id,
          title: event.input.title ?? id,
          status: "running",
          output: ""
        }
        tasks.push(task)
        await publish()
        $.clock.after(0, async () => {
          try {
            if (!job.cancelled) {
              const stream = $.process.spawn({ argv: event.input.argv as string[] })
              job.stream = stream
              for await (const chunk of stream) {
                task.output = (String(task.output) + chunk.text).slice(-1200)
                await publish()
              }
              const result = await stream.result
              task.status = job.cancelled ? "cancelled" : result.code === 0 ? "succeeded" : "failed"
              if (!job.cancelled && result.code !== 0) task.error = `进程退出码 ${result.code}`
            } else task.status = "cancelled"
          } catch (error) {
            task.status = job.cancelled ? "cancelled" : "failed"
            task.error = String(error).slice(0, 300)
          } finally {
            try {
              await publish()
            } finally {
              job.stream = undefined
              job.finish()
            }
          }
        })
        return { taskId: id, status: "running" }
      }
    }
  )
}
