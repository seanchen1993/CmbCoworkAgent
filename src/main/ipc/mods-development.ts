import { z } from "zod"
import type { IpcMain, IpcMainInvokeEvent } from "electron"
import type { ModDevelopmentService } from "../mods/devtools/development-service"
import type { AuthoringScope } from "../../shared/mods/authoring"

const scope = z.object({
  threadId: z.string().min(1).max(200),
  expectedWorkspace: z.string().min(1).max(4096)
})
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const revision = z.number().int().min(1)

export function registerModsDevelopmentHandlers(
  ipc: IpcMain,
  service: ModDevelopmentService,
  trusted: (event: IpcMainInvokeEvent) => void,
  actions?: {
    undoComposition(input: AuthoringScope): Promise<unknown>
    cancelComposition(input: AuthoringScope): unknown
    undoTrial(input: AuthoringScope): Promise<unknown>
  }
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
    service.refreshReuse(input.threadId)
  )
  register("set-enabled", scope.extend({ enabled: z.boolean() }).strict(), (input) =>
    service.setEnabled(input.threadId, input.expectedWorkspace, input.enabled)
  )
  register("set-mode", scope.extend({ mode: z.enum(["normal", "creator"]) }).strict(), (input) =>
    service.setMode(input.threadId, input.expectedWorkspace, input.mode)
  )
  register(
    "approve",
    scope.extend({
      id,
      revision,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      sourceDigest: z.string().regex(/^[a-f0-9]{64}$/).optional()
    }).strict(),
    (input) =>
      service.approve(
        input.threadId,
        input.expectedWorkspace,
        input.id,
        input.revision,
        input.digest,
        input.sourceDigest
      )
  )
  register("stop", scope.extend({ id }).strict(), (input) =>
    service.stop(input.threadId, input.expectedWorkspace, input.id)
  )
  register("promote", scope.extend({ id, revision }).strict(), (input) =>
    service.promote(input.threadId, input.expectedWorkspace, input.id, input.revision)
  )
  register("request-reuse", scope.extend({ id, revision }).strict(), (input) => {
    if (service.status(input.threadId).workspace !== input.expectedWorkspace)
      throw Error("DEVELOPMENT_SCOPE_CHANGED")
    return service.requestReuse(input.threadId, input.id, input.revision)
  })
  register("approve-reuse", scope.extend({
    planId: z.string().uuid(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    compiledDigest: z.string().regex(/^[a-f0-9]{64}$/),
    targetProfileDigest: z.string().regex(/^[a-f0-9]{64}$/)
  }).strict(), input => service.approveReuse(input.threadId, input.expectedWorkspace, input))
  for (const name of ["undo-composition", "cancel-composition", "undo-trial"] as const) {
    register(name, scope.strict(), input => {
      if (!actions) throw Error("DEVELOPMENT_ACTION_UNAVAILABLE")
      if (name === "undo-composition") return actions.undoComposition(input)
      if (name === "cancel-composition") return actions.cancelComposition(input)
      return actions.undoTrial(input)
    })
  }
}
