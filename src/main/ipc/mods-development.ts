import { z } from "zod"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ModDevelopmentService } from "../mods/devtools/development-service"

const scope = z.object({
  threadId: z.string().min(1).max(200),
  expectedWorkspace: z.string().min(1).max(4096)
})
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const revision = z.number().int().min(1)

export function registerModsDevelopmentHandlers(
  ipc: IpcMain,
  service: ModDevelopmentService,
  trusted: (event: IpcMainInvokeEvent) => void
) {
  const register = <S extends z.ZodType>(
    name: string,
    schema: S,
    run: (input: z.output<S>) => unknown
  ) => {
    ipc.handle(`mods:development:${name}`, (event, input: unknown) => {
      trusted(event)
      const parsed = schema.safeParse(input)
      if (!parsed.success) throw Error("DEVELOPMENT_INPUT")
      return run(parsed.data)
    })
  }
  register("status", z.object({ threadId: scope.shape.threadId }).strict(), (input) =>
    service.status(input.threadId)
  )
  register("set-enabled", scope.extend({ enabled: z.boolean() }).strict(), (input) =>
    service.setEnabled(input.threadId, input.expectedWorkspace, input.enabled)
  )
  register(
    "approve",
    scope.extend({ id, revision, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    (input) =>
      service.approve(
        input.threadId,
        input.expectedWorkspace,
        input.id,
        input.revision,
        input.digest
      )
  )
  register("stop", scope.extend({ id }).strict(), (input) =>
    service.stop(input.threadId, input.expectedWorkspace, input.id)
  )
  register("promote", scope.extend({ id, revision }).strict(), (input) =>
    service.promote(input.threadId, input.expectedWorkspace, input.id, input.revision)
  )
}
