import { executeBotWorktreeOperation } from "./worktree-operations"
import { botWorktreeOperation } from "./worktree-contract"
import {
  configureWorkflowWorktreeTimeoutMinutes,
  configureWorkflowWorktreeRemoveTimeoutMinutes
} from "../../shared/agent-runtime-limits"

if (!process.send) throw new Error("Worktree worker requires parent IPC")
const controller = new AbortController()
let started = false
const stop = () => controller.abort(new Error("工作区操作已取消，保留已有修改供核对"))
process.once("disconnect", stop)
process.once("SIGTERM", stop)
process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && "cancel" in message) {
    stop()
    return
  }
  if (started) return
  started = true
  void Promise.resolve()
    .then(() => {
      const input = botWorktreeOperation.parse(message)
      // Each worker accepts one request. Never alter the shared Host globals
      // when concurrent Bots use different configurations.
      configureWorkflowWorktreeTimeoutMinutes(input.timeouts?.createMinutes)
      configureWorkflowWorktreeRemoveTimeoutMinutes(input.timeouts?.removeMinutes)
      return executeBotWorktreeOperation(input, controller.signal)
    })
    .then((result) => {
      if (process.connected) process.send!({ result }, () => process.disconnect())
    })
    .catch((error: unknown) => {
      if (process.connected)
        process.send!({ error: error instanceof Error ? error.message : String(error) }, () =>
          process.disconnect()
        )
    })
})
