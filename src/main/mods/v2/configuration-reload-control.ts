import { ModFunctionError } from "../../../shared/mods/v2/contracts"

interface Control {
  workspace: string
  threadId: string
  controller: AbortController
}

/** Independent of runtime cache invalidation: stopped effects require an explicit retry. */
export class FunctionConfigurationReloadControl {
  private readonly stopped = new Map<string, string>()
  private readonly active = new Set<Control>()

  error(workspace: string, threadId: string): string | undefined {
    return this.stopped.get(JSON.stringify([workspace, threadId]))
  }

  begin(workspace: string, threadId: string) {
    const key = JSON.stringify([workspace, threadId])
    if (!this.stopped.has(key) && this.stopped.size >= 64)
      throw new ModFunctionError("MODS_CONFIG_RELOAD_CAPACITY")
    const control = { workspace, threadId, controller: new AbortController() }
    this.active.add(control)
    return {
      signal: control.controller.signal,
      failed: (error: unknown) =>
        this.stopped.set(key, error instanceof Error ? error.message : "MODS_CONFIG_RELOAD_FAILED"),
      applied: () => this.stopped.delete(key),
      finish: () => this.active.delete(control)
    }
  }

  cancel(workspace?: string, threadId?: string): void {
    for (const control of this.active)
      if (
        (workspace === undefined || control.workspace === workspace) &&
        (threadId === undefined || control.threadId === threadId)
      )
        control.controller.abort(new ModFunctionError("MODS_SCOPE_CHANGED"))
  }
}
