import type { IpcMain, IpcMainInvokeEvent } from "electron"
import { z } from "zod"
import type { EditorNavigationBroker } from "../mods/v2/platform-editor-navigation"

const id = z.string().uuid()
const address = z.object({ id }).strict()
const ack = z
  .object({
    id,
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["preview-loaded", "failed"]),
    line: z.number().int().min(1).max(100000).optional(),
    column: z.number().int().min(1).max(100000).optional()
  })
  .strict()

/** Only the trusted renderer can redeem a main-owned, exact-sender navigation intent. */
export function registerEditorNavigationHandlers(
  ipc: Pick<IpcMain, "handle">,
  broker: EditorNavigationBroker,
  trusted: (event: IpcMainInvokeEvent) => void
) {
  const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
    const result = schema.safeParse(value)
    if (!result.success) throw Error("EDITOR_NAVIGATION_ARGUMENTS")
    return result.data
  }
  ipc.handle("mods:editor-navigation-accept", (event, input: unknown) => {
    trusted(event)
    return broker.accept(event.sender.id, parse(address, input).id)
  })
  ipc.handle("mods:editor-navigation-ack", (event, input: unknown) => {
    trusted(event)
    return broker.acknowledge(event.sender.id, parse(ack, input))
  })
  ipc.handle("mods:editor-navigation-close", (event, input: unknown) => {
    trusted(event)
    return broker.close(event.sender.id, parse(address, input).id)
  })
  ipc.handle("mods:editor-navigation-launch-external", (event, input: unknown) => {
    trusted(event)
    return broker.launchExternal(event.sender.id, parse(address, input).id)
  })
}
