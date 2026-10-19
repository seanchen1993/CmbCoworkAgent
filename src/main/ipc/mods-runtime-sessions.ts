import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { ModFunctionError, isModObject } from "../../shared/mods/v2/contracts"
import type { FunctionModsManager } from "../mods/v2/manager"

interface Access {
  workspace: string
  incarnationKey: string
  title?: string
  assertCurrent(): void
}

export function registerRuntimeSessionHandlers(
  ipc: IpcMain,
  manager: FunctionModsManager,
  trusted: (event: IpcMainInvokeEvent) => void,
  access: (event: IpcMainInvokeEvent, threadId: string, writable: boolean) => Access
): void {
  const snapshot = (event: IpcMainInvokeEvent, currentThreadId?: string) => {
    trusted(event)
    const view = manager.runtimeSessions(currentThreadId)
    return {
      ...view,
      sessions: view.sessions.flatMap((session) => {
        try {
          const a = access(event, session.threadId, false)
          a.assertCurrent()
          if (a.workspace !== session.workspace) return []
          let writable = true
          try {
            access(event, session.threadId, true).assertCurrent()
          } catch {
            writable = false
          }
          return [
            {
              ...session,
              ...(a.title ? { title: a.title.slice(0, 200) } : {}),
              incarnationKey: a.incarnationKey,
              canRelease: writable && session.canRelease,
              canResume: writable && session.canResume,
              ...(!writable ? { blocker: "这段聊天为只读" } : {})
            }
          ]
        } catch {
          return []
        }
      })
    }
  }
  ipc.handle("mods:runtime-sessions", (event, currentThreadId: unknown) => {
    trusted(event)
    if (currentThreadId !== undefined) {
      if (typeof currentThreadId !== "string" || !currentThreadId || currentThreadId.length > 200)
        throw new ModFunctionError("MODS_RUNTIME_SESSION_ARGUMENTS")
      access(event, currentThreadId, false).assertCurrent()
    }
    return snapshot(event, currentThreadId)
  })
  for (const action of ["release", "resume"] as const) {
    ipc.handle(`mods:runtime-session-${action}`, async (event, input: unknown) => {
      if (
        !isModObject(input) ||
        typeof input.threadId !== "string" ||
        !input.threadId ||
        input.threadId.length > 200 ||
        typeof input.workspace !== "string" ||
        !input.workspace ||
        input.workspace.length > 4096 ||
        typeof input.incarnationKey !== "string" ||
        !input.incarnationKey ||
        input.incarnationKey.length > 4096 ||
        !Number.isSafeInteger(input.generation) ||
        Number(input.generation) < 1 ||
        Object.keys(input).some(
          (key) => !["threadId", "workspace", "generation", "incarnationKey"].includes(key)
        )
      )
        throw new ModFunctionError("MODS_RUNTIME_SESSION_ARGUMENTS")
      const a = access(event, input.threadId, true)
      const guard = () => {
        a.assertCurrent()
        if (input.workspace !== a.workspace || input.incarnationKey !== a.incarnationKey)
          throw new ModFunctionError("MODS_RUNTIME_SESSION_STALE")
      }
      guard()
      const controller = new AbortController()
      const lost = () => controller.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
      event.sender.once("destroyed", lost)
      try {
        await (
          action === "release" ? manager.releaseRuntimeSession : manager.resumeRuntimeSession
        ).call(
          manager,
          a.workspace,
          input.threadId,
          Number(input.generation),
          controller.signal,
          guard
        )
        guard()
        return snapshot(event, input.threadId)
      } finally {
        event.sender.removeListener("destroyed", lost)
      }
    })
  }
}
