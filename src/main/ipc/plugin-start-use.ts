import { z } from "zod"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { PluginStartUseService } from "../plugins/plugin-start-use"

const inputSchema = z
  .object({
    threadId: z.string().min(1).max(200),
    expectedWorkspace: z.string().min(1).max(4096),
    pluginId: z.string().min(1).max(256),
    expected: z
      .object({
        name: z.string().min(1).max(256),
        version: z.string().min(1).max(64),
        digest: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional()
      })
      .strict()
  })
  .strict()

/** Discovery is read-only. Its result never grants creation, configuration or execution. */
export function registerPluginStartUseHandlers(
  ipc: IpcMain,
  service: PluginStartUseService,
  access: {
    trusted(event: IpcMainInvokeEvent): void
    normalizeWorkspace(workspace: string): string
    context(threadId: string): { workspace: string; assertCurrent(): void }
  }
): void {
  const register = (channel: string, enable: boolean) =>
    ipc.handle(channel, (event, raw: unknown) => {
      access.trusted(event)
      const parsed = inputSchema.safeParse(raw)
      if (!parsed.success) throw Error("PLUGIN_START_USE_INPUT_INVALID")
      const input = parsed.data
      const context = access.context(input.threadId)
      const expected = access.normalizeWorkspace(input.expectedWorkspace)
      const guard = () => {
        access.trusted(event)
        context.assertCurrent()
        if (context.workspace !== expected) throw Error("PLUGIN_START_USE_SCOPE_CHANGED")
      }
      guard()
      const current = { ...input, expectedWorkspace: context.workspace }
      return enable ? service.enable(current, guard) : service.prepare(current, guard)
    })
  register("plugins:prepareStartUse", false)
  register("plugins:enableStartUse", true)
}
